const express = require("express");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const path = require("path");

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SUBJECTS = {
  history:        "History",
  geography:      "Geography",
  polity:         "Polity & Governance",
  currentaffairs: "Current Affairs",
  maths:          "Maths & Reasoning",
  science:        "Science & Tech",
  economics:      "Economics",
  other:          "Other / General",
};

// ── Schemas ───────────────────────────────────────────────────────────────────
const RecordSchema = new mongoose.Schema({
  topic:   { type: String, required: true },
  subject: { type: String, enum: Object.keys(SUBJECTS), default: "other" },
  savedAt: { type: Date, default: Date.now },
  data: [{ question: String, options: [String], answer: String }],
});

const NotificationSchema = new mongoose.Schema({
  type:    { type: String, default: "new_questions" }, // new_questions | news
  subject: String,
  topic:   String,
  count:   Number,
  message: String,
  savedAt: { type: Date, default: Date.now },
  readBy:  [String], // socket ids or 'all'
});

const QuizResultSchema = new mongoose.Schema({
  subject:   String,
  topic:     String,
  correct:   Number,
  wrong:     Number,
  skip:      Number,
  total:     Number,
  pct:       Number,
  timeUsed:  String,
  takenAt:   { type: Date, default: Date.now },
});

const NewsSchema = new mongoose.Schema({
  title:    String,
  content:  String,          // paragraph content
  mcqs:     [{               // extracted MCQs (optional)
    question: String,
    options:  [String],
    answer:   String,
    explanation: String,
  }],
  hasMcq:   { type: Boolean, default: false },
  savedAt:  { type: Date, default: Date.now },
});

const subjectModel = (subject) => {
  if (mongoose.modelNames().includes(subject)) return mongoose.model(subject);
  return mongoose.model(subject, RecordSchema, subject);
};

const Notification = mongoose.modelNames().includes("Notification")
  ? mongoose.model("Notification")
  : mongoose.model("Notification", NotificationSchema);

const QuizResult = mongoose.modelNames().includes("QuizResult")
  ? mongoose.model("QuizResult")
  : mongoose.model("QuizResult", QuizResultSchema);

const News = mongoose.modelNames().includes("News")
  ? mongoose.model("News")
  : mongoose.model("News", NewsSchema);

// ── Admin HTML ────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "index.html"));
});

// ── Parse MCQ ─────────────────────────────────────────────────────────────────
router.post("/process", async (req, res) => {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a quiz parser. Return ONLY a JSON object with key 'qa' containing an array. Each item must have: 'question' (string), 'options' (array of 4 strings), 'answer' (string — the correct option text)." },
        { role: "user", content: req.body.text },
      ],
      response_format: { type: "json_object" },
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "AI Parsing Failed" });
  }
});

// ── Save questions + emit notification ───────────────────────────────────────
router.post("/api/save", async (req, res) => {
  try {
    const { topic, subject = "other", data } = req.body;
    const Model = subjectModel(subject);
    const record = await new Model({ topic, subject, data, savedAt: new Date() }).save();

    // Save notification
    const notif = await new Notification({
      type: "new_questions",
      subject,
      topic,
      count: data.length,
      message: `${SUBJECTS[subject] || subject} — "${topic}" mein ${data.length} naye questions add hue`,
      savedAt: new Date(),
    }).save();

    // Emit to all connected clients
    const io = req.app.get("io");
    if (io) io.emit("new_notification", notif);

    res.json({ status: "ok", collection: subject });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Get all history ───────────────────────────────────────────────────────────
router.get("/api/history", async (req, res) => {
  try {
    const keys = req.query.subject ? [req.query.subject] : Object.keys(SUBJECTS);
    const results = await Promise.all(keys.map(s => subjectModel(s).find().sort({ savedAt: -1 }).lean()));
    res.json(results.flat().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Delete single record by ID ────────────────────────────────────────────────
router.delete("/api/history/:id", async (req, res) => {
  try {
    for (const s of Object.keys(SUBJECTS)) {
      const d = await subjectModel(s).findByIdAndDelete(req.params.id);
      if (d) return res.json({ status: "ok" });
    }
    res.status(404).json({ error: "Not found" });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Delete by topic name within a subject ─────────────────────────────────────
router.delete("/api/topic", async (req, res) => {
  try {
    const { subject, topic } = req.body;
    if (!subject || !topic) return res.status(400).json({ error: "subject and topic required" });
    const Model = subjectModel(subject);
    const result = await Model.deleteMany({ topic });
    res.json({ status: "ok", deleted: result.deletedCount });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── AI Story/Guide ────────────────────────────────────────────────────────────
router.post("/story", async (req, res) => {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a brilliant SSC/UPSC teacher. Explain MCQs in Hindi/English mix. For each question explain WHY the answer is correct with memory tricks. Be concise and exam-focused." },
        { role: "user", content: JSON.stringify(req.body.data) },
      ],
    });
    res.json({ story: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: "Guide generation failed" });
  }
});

// ── Admin AI Chat ─────────────────────────────────────────────────────────────
router.post("/api/admin/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are an expert SSC/UPSC/School teacher and tutor. Answer deeply in Hindi-English mix. Remember everything the student says. Give examples, memory tricks, and explanations." },
        ...messages,
      ],
      max_tokens: 700,
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: "Chat failed" });
  }
});

// ── AI Teacher ────────────────────────────────────────────────────────────────
router.post("/api/admin/teacher", async (req, res) => {
  try {
    const { subject, topic, count = 4, type = "mixed", existingQuestions = [] } = req.body;
    const subLabel = SUBJECTS[subject] || subject;
    const topicStr = topic ? `Topic: "${topic}"` : `Subject: ${subLabel} (any topic)`;
    const typeInstr = {
      mcq: "All questions must be MCQ (4 options).",
      fill: "All questions must be Fill in the Blank.",
      tf: "All questions must be True/False.",
      mixed: "Mix of MCQ (4 options), Fill in the Blank, and True/False questions.",
    }[type] || "Mix of MCQ, Fill in Blank, and True/False.";
    const dupNote = existingQuestions.length
      ? `\n\nIMPORTANT: Do NOT repeat or rephrase any of these existing questions:\n${existingQuestions.slice(0, 50).map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";
    const prompt = `Generate exactly ${count} questions for ${topicStr} (${subLabel}).\n${typeInstr}\nReturn ONLY a JSON object with key "questions" containing an array.\nEach item must have:\n- "type": "mcq" | "fill" | "tf"\n- "question": string\n- "options": array (4 for mcq, ["True","False"] for tf, [] for fill)\n- "answer": correct answer string\n- "explanation": 1-2 line explanation in Hindi-English mix${dupNote}`;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are an expert question paper maker for Indian competitive exams. Always return valid JSON only, no extra text." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "Teacher generation failed" });
  }
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get("/api/notifications", async (req, res) => {
  try {
    const notifs = await Notification.find().sort({ savedAt: -1 }).limit(50);
    res.json(notifs);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.post("/api/notifications/clear", async (req, res) => {
  try {
    await Notification.updateMany({}, { $set: { readBy: ["all"] } });
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Quiz Results (save from public portal) ────────────────────────────────────
router.post("/api/results/save", async (req, res) => {
  try {
    const result = await new QuizResult({ ...req.body, takenAt: new Date() }).save();
    res.json({ status: "ok", id: result._id });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.get("/api/results", async (req, res) => {
  try {
    const results = await QuizResult.find().sort({ takenAt: -1 }).limit(500);
    res.json(results);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── AI: Process news content → extract paragraph + MCQs ──────────────────────
router.post("/api/news/ai-process", async (req, res) => {
  try {
    const { title, content } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: `You are a professional news editor and SSC/UPSC content writer. Given a title and raw content:

1. Rewrite the paragraph — same or MORE detail, never shorter. Make it clear, well-structured, informative. Keep all facts intact. Write in Hindi-English mix (Hinglish) naturally.
2. If MCQs are present in the raw content, extract them properly.
3. If no MCQs exist, return empty array for mcqs.

Return ONLY a JSON object:
{
  "paragraph": "rewritten full paragraph (same or longer than original)",
  "mcqs": [] or [{question, options:[4 strings], answer, explanation}]
}` },
        { role: "user", content: `Title: ${title||"(no title)"}\n\nContent:\n${content}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "AI processing failed" });
  }
});

// ── AI: Generate MCQs from paragraph ─────────────────────────────────────────
router.post("/api/news/gen-mcq", async (req, res) => {
  try {
    const { paragraph, count = 4 } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are an SSC/UPSC question maker. Generate MCQs from the given paragraph. Return ONLY JSON with key 'mcqs' containing array. Each item: {question, options:[4 strings], answer, explanation (Hindi-English mix, 1-2 lines)}." },
        { role: "user", content: `Generate ${count} SSC/UPSC level MCQs from this paragraph:\n\n${paragraph}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "MCQ generation failed" });
  }
});

// ── News CRUD ─────────────────────────────────────────────────────────────────
router.post("/api/news", async (req, res) => {
  try {
    const { title, content, mcqs = [] } = req.body;
    const news = await new News({ title, content, mcqs, hasMcq: mcqs.length > 0, savedAt: new Date() }).save();
    const notif = await new Notification({
      type: "news",
      message: `📰 New news: "${title}"${mcqs.length ? ` (+${mcqs.length} MCQs)` : ""}`,
      savedAt: new Date(),
    }).save();
    const io = req.app.get("io");
    if (io) io.emit("new_notification", notif);
    res.json({ status: "ok", id: news._id });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.get("/api/news", async (req, res) => {
  try {
    const news = await News.find().sort({ savedAt: -1 }).limit(50);
    res.json(news);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.delete("/api/news/:id", async (req, res) => {
  try {
    await News.findByIdAndDelete(req.params.id);
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

module.exports = router;