const express = require("express");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const path = require("path");

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Normalize helper — invisible chars + whitespace + trim ───────────────────
const norm = s => (s || '').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();

const SUBJECT_SPECIFIC_HINTS = {
  maths: `MATHS/REASONING SPECIFIC RULES — MANDATORY:
- ALLOWED topics: Percentage + Profit-Loss combo, SI/CI (compound interest 2+ years), Time-Work with efficiency fractions, Pipes-Cistern (fill+drain simultaneously), Ratio-Proportion with unknowns, Mixture-Alligation (multiple), Speed-Distance-Time (trains crossing, boats upstream, relative speed), Number System (divisibility, remainders, LCM/HCF applied), Geometry (circle theorems, triangle rules, area-perimeter combo), Trigonometry (standard angle values + height-distance applications).
- STRICTLY BANNED: "120 ÷ 8 = ?", "5000 - 2000 = ?", "what is 15×4", simple unitary method where answer is obvious in 2 seconds, "A has Rs 100 and spends Rs 30, how much is left?"
- EVERY math question must require at least 2-3 steps or a non-obvious formula.
- Wrong options must be common calculation mistakes (e.g., using simple interest formula for compound interest).`,

  history: `HISTORY SPECIFIC RULES — MANDATORY:
- USE: Governor-Generals/Viceroys + their specific acts/policies, Battle names + dates + significance (who won, what changed), Treaty names + years + terms, Social reform movements + founders + years + context, Architecture styles + dynasties + specific monuments, "Which statement is INCORRECT about X" type, Chronological ordering of events, "Who was the commander of X battle?", Revolt of 1857 details, Freedom struggle timeline events, Constitutional history (Government of India Acts 1919, 1935), Religious reform movements.
- Include "निम्नलिखित में से कौन सा कथन सही नहीं है" (which is NOT correct) type in at least 30% questions.
- Avoid: "Who was the first Prime Minister of India" — too basic.`,

  geography: `GEOGRAPHY SPECIFIC RULES — MANDATORY:
- USE: "Which river does NOT flow through X state" type, Tropic of Cancer + states it passes through (trick: count carefully), National parks + their specific states + main animals (confuse between similar parks), Soil types (laterite, black cotton, alluvial, red, mountain) + their exact regions, Mountain passes + which state/border they connect, Western Ghats vs Eastern Ghats differences, Monsoon patterns + seasons, Ocean currents (warm vs cold), "Which is the longest/highest/largest in India" with similar-looking options, Straits + which water bodies they connect, Biosphere reserves.
- Avoid: "Capital of Maharashtra is Mumbai" — too basic.`,

  polity: `POLITY SPECIFIC RULES — MANDATORY:
- USE: Specific Article numbers + exact content (not vague), Schedule numbers + what they contain (8th schedule = languages, 10th = anti-defection, etc.), Amendment numbers + what they changed (42nd, 44th, 52nd, 73rd, 74th, 86th, 91st, 101st GST), Fundamental Rights exceptions (Article 19 restrictions list), DPSPs that CAN be enforced via legislation, Emergency articles (352/356/360 — who declares, how revoked, effects), Writ types + when exactly each applies (Mandamus vs Certiorari distinction), Powers unique to President vs Governor differences, CAG/CEC/UPSC — appointment, removal, salary charged to which account, Panchayati Raj specific articles.
- "Which of the following is NOT a Fundamental Right" type = mandatory in every batch.
- Avoid: "Parliament has two houses" — too basic.`,

  science: `SCIENCE SPECIFIC RULES — MANDATORY:
- USE: Disease + causative agent exact type (bacterial/viral/fungal/protozoan — e.g., Malaria=Plasmodium=protozoan), Chemical formulas of compounds (NOT H2O/NaCl — use: Alum=KAl(SO4)2·12H2O, Bleaching powder=Ca(OCl)Cl, Plaster of Paris=CaSO4·½H2O, Baking soda=NaHCO3), Newton's/Faraday's/Ohm's laws with applied numericals, Mirror/Lens sign convention questions, pH of common substances (blood=7.4, gastric juice=2, milk=6.8), Vitamins + deficiency diseases + food sources, Periodic table trends (electronegativity/atomic radius increases/decreases direction), Plant/Animal cell organelle differences, Human body systems (digestive enzymes + where they act), Space missions + discoveries.
- Avoid: "Plants make food by photosynthesis" — too basic.`,

  economics: `ECONOMICS SPECIFIC RULES — MANDATORY:
- USE: Types of inflation (demand-pull, cost-push, structural, stagflation — what causes each), Monetary policy tools + what each controls (CRR = cash reserve with RBI, SLR = investment in govt securities, Repo = RBI lends to banks, Reverse Repo = banks lend to RBI), Union Budget terminology (fiscal deficit = total expenditure - total revenue excluding borrowings, revenue deficit, primary deficit = fiscal deficit - interest payments), GDP calculation methods (expenditure/income/product approach — what's included/excluded), Types of unemployment (frictional/structural/cyclical/seasonal/disguised — which sector has disguised?), WTO/IMF/World Bank/ADB — functions + headquarters + who heads, Banking terms (NBFC vs bank differences, NPA classification, Basel III norms), Niti Aayog vs Planning Commission differences.
- "Which statement about X is CORRECT" type = very important.`,

  currentaffairs: `CURRENT AFFAIRS SPECIFIC RULES — MANDATORY:
- USE: Recent appointments (CM, Governor, Ambassador, Head of constitutional body — trick with similar names), New government schemes + their ministry + launch year + target beneficiary (confuse between similar scheme names), International summits + host city + year + theme, Awards (Bharat Ratna, Padma, Nobel, Booker, Oscar — recent years — confuse categories), Sports records + who set them + year, New state/district creations + when, Constitutional/Parliamentary developments, New laws/bills passed + their key provisions, Important committee reports + their subject.
- Make wrong options confusing by using similar scheme names, similar city names, or transposing year/person.`,
};

function getSubjectHint(subject) {
  return SUBJECT_SPECIFIC_HINTS[subject] ||
    `For ${subject} subject: Questions should test deeper knowledge beyond surface-level facts.
MANDATORY: Use "which is NOT correct" type (at least 30%), chronological ordering, exception-based questions.
All 4 options must look plausible — never 3 obviously wrong + 1 correct.
Never ask trivially obvious questions that a casual reader would know.`;
}

const STATIC_SUBJECTS = {
  history:        "History",
  geography:      "Geography",
  polity:         "Polity & Governance",
  currentaffairs: "Current Affairs",
  maths:          "Maths & Reasoning",
  science:        "Science & Tech",
  economics:      "Economics",
  other:          "Other / General",
};

const CustomSubjectSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  label: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});
const CustomSubject = mongoose.modelNames().includes("CustomSubject")
  ? mongoose.model("CustomSubject")
  : mongoose.model("CustomSubject", CustomSubjectSchema);

async function getAllSubjects() {
  const custom = await CustomSubject.find().lean();
  const result = { ...STATIC_SUBJECTS };
  custom.forEach(c => { result[c.key] = c.label; });
  return result;
}

const RecordSchema = new mongoose.Schema({
  topic:   { type: String, required: true },
  subject: { type: String, default: "other" },
  savedAt: { type: Date, default: Date.now },
  data: [{
    question: String,
    options:  [String],
    answer:   String,
    section:  { type: String, default: "General Awareness" }
  }],
});

const NotificationSchema = new mongoose.Schema({
  type:    { type: String, default: "new_questions" },
  subject: String,
  topic:   String,
  count:   Number,
  message: String,
  savedAt: { type: Date, default: Date.now },
  readBy:  [String],
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
  content:  String,
  mcqs: [{
    question:    String,
    options:     [String],
    answer:      String,
    explanation: String,
  }],
  hasMcq:  { type: Boolean, default: false },
  savedAt: { type: Date, default: Date.now },
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

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "index.html"));
});

router.get("/api/subjects", async (req, res) => {
  try {
    res.json(await getAllSubjects());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/subject/add", async (req, res) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: "Label required" });
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (!key) return res.status(400).json({ error: "Invalid label" });
    const allSubjects = await getAllSubjects();
    if (allSubjects[key]) return res.status(409).json({ error: "Subject already exists", key, label: allSubjects[key] });
    const cs = await new CustomSubject({ key, label: label.trim() }).save();
    res.json({ status: "ok", key, label: cs.label });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "Subject already exists" });
    res.status(500).json({ error: e.message });
  }
});

router.post("/process", async (req, res) => {
  try {
    const rawText = (req.body.text || "").trim();
    if (!rawText) return res.json({ qa: [] });

    const cleanedText = rawText
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "($1)/($2)")
      .replace(/\^2/g, "²").replace(/\^3/g, "³")
      .replace(/\_{([^}]+)}/g, "_$1")
      .replace(/\^{([^}]+)}/g, "^$1")
      .replace(/([^=\s]+=[^=\s]+)\1+/g, "$1")
      .replace(/^\s*\(([A-Da-d])\)\s*/gm, "$1) ")
      .replace(/^\s*([A-Da-d])\.\s*/gm, "$1) ");

    const systemPrompt = `You are an EXPERT MCQ parser for Indian competitive exams (SSC, UPSC, NEET, JEE). You handle ALL formats perfectly.

Extract every MCQ from the input and return clean structured JSON.
Return ONLY: {"qa": [...]}

Each item must have:
- question: clean readable string
- options: array of exactly 4 strings
- answer: the FULL TEXT of the correct option
- section: one of "Reasoning" | "General Awareness" | "Quantitative Aptitude" | "English"

Section detection rules:
- Q1-25 = Reasoning (unless clearly English/Math)
- Q26-50 = General Awareness
- Q51-75 = Quantitative Aptitude
- Q76-100 = English
- Override by content: math symbols/₹ = Quantitative Aptitude, English grammar = English, blood relations/series = Reasoning

RULE: NEVER return empty string for answer. If no answer given, determine correct answer using your knowledge.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanedText },
      ],
      response_format: { type: "json_object" },
      max_tokens: 8000,
      temperature: 0.1,
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const VALID_SECTIONS = ["Reasoning", "General Awareness", "Quantitative Aptitude", "English"];

    const qa = (parsed.qa || [])
      .filter(q => q && q.question && q.question.trim().length > 3)
      .map(q => ({
        question: norm(q.question),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(o => norm(String(o || ""))) : [],
        answer: norm(q.answer),
        section: VALID_SECTIONS.includes(q.section) ? q.section : "General Awareness",
      }))
      .filter(q => q.options.length >= 2);

    res.json({ qa });
  } catch (e) {
    console.error("Parse error:", e);
    res.status(500).json({ error: "AI Parsing Failed: " + e.message });
  }
});

// ── SAVE — normalize on save ──────────────────────────────────────────────────
router.post("/api/save", async (req, res) => {
  try {
    const { topic, subject = "other", data } = req.body;
    const Model = subjectModel(subject);
    const existing = await Model.findOne({ topic, subject });

    const VALID_SECTIONS = ["Reasoning", "General Awareness", "Quantitative Aptitude", "English"];

    // ── FIX: normalize answer + options on every save ──────────────────────
    const normalizeQ = (q) => ({
      question: norm(q.question),
      options:  Array.isArray(q.options) ? q.options.map(norm) : [],
      answer:   norm(q.answer),
      section:  VALID_SECTIONS.includes(q.section) ? q.section : "General Awareness",
    });

    if (existing) {
      const existingQTexts = new Set(existing.data.map(q => norm(q.question).toLowerCase()));
      const newQs = (data || [])
        .filter(q => !existingQTexts.has(norm(q.question).toLowerCase()))
        .map(normalizeQ);

      if (newQs.length === 0) {
        return res.json({ status: "no_new", message: "Saare questions pehle se exist karte hain", collection: subject });
      }
      existing.data.push(...newQs);
      existing.savedAt = new Date();
      await existing.save();

      const notif = await new Notification({
        type: "new_questions", subject, topic,
        count: newQs.length,
        message: `${subject} — "${topic}" mein ${newQs.length} naye questions merge hue (${existing.data.length} total)`,
        savedAt: new Date(),
      }).save();
      const io = req.app.get("io");
      if (io) io.emit("new_notification", notif);

      return res.json({ status: "merged", added: newQs.length, total: existing.data.length, collection: subject });
    }

    const saveData = (data || []).map(normalizeQ);
    const record = await new Model({ topic, subject, data: saveData, savedAt: new Date() }).save();

    if (saveData.length > 0) {
      const notif = await new Notification({
        type: "new_questions", subject, topic,
        count: saveData.length,
        message: `${subject} — "${topic}" mein ${saveData.length} naye questions add hue`,
        savedAt: new Date(),
      }).save();
      const io = req.app.get("io");
      if (io) io.emit("new_notification", notif);
    }
    res.json({ status: "ok", collection: subject });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.get("/api/history", async (req, res) => {
  try {
    const allSubjects = await getAllSubjects();
    const keys = req.query.subject ? [req.query.subject] : Object.keys(allSubjects);
    const results = await Promise.all(keys.map(s => subjectModel(s).find().sort({ savedAt: -1 }).lean()));
    res.json(results.flat().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.delete("/api/history/:id", async (req, res) => {
  try {
    const allSubjects = await getAllSubjects();
    for (const s of Object.keys(allSubjects)) {
      const d = await subjectModel(s).findByIdAndDelete(req.params.id);
      if (d) return res.json({ status: "ok" });
    }
    res.status(404).json({ error: "Not found" });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.delete("/api/topic", async (req, res) => {
  try {
    const { subject, topic } = req.body;
    if (!subject || !topic) return res.status(400).json({ error: "subject and topic required" });
    const result = await subjectModel(subject).deleteMany({ topic });
    res.json({ status: "ok", deleted: result.deletedCount });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

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

router.post("/api/admin/teacher", async (req, res) => {
  try {
    const { subject, topic, count = 4, type = "mixed", existingQuestions = [] } = req.body;
    const allSubjects = await getAllSubjects();
    const subLabel = allSubjects[subject] || subject;
    const topicStr = topic ? `Topic: "${topic}"` : `Subject: ${subLabel} (any relevant topic)`;

    const typeInstr = {
      mcq:   "All questions must be MCQ with exactly 4 options.",
      fill:  "All questions must be Fill in the Blank.",
      tf:    "All True/False questions.",
      mixed: "Mix: 60% MCQ (4 options each), 20% Fill in Blank, 20% True/False.",
    }[type] || "Mix of MCQ, Fill in Blank, and True/False.";

    const dupNote = existingQuestions.length
      ? `\n\nDo NOT repeat or rephrase ANY of these ${existingQuestions.length} existing questions:\n${existingQuestions.slice(0, 50).map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

    const prompt = `Generate exactly ${count} questions for ${topicStr} (${subLabel}).
DIFFICULTY: SSC CGL / UPSC Prelims level.
${typeInstr}
${getSubjectHint(subject)}
Return ONLY a JSON object with key "questions" containing an array.
Each item: type, question, options, answer, explanation.
${dupNote}`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a SENIOR question paper setter for SSC CGL/CHSL, UPSC Prelims. You ALWAYS return valid JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2500,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "Teacher generation failed" });
  }
});

router.post("/api/smart-generate", async (req, res) => {
  try {
    const { subject, topic, count = 20, userPrompt = "", type = "mcq" } = req.body;
    const allSubjects = await getAllSubjects();
    const subLabel = allSubjects[subject] || subject;
    const startTime = Date.now();

    const Model = subjectModel(subject);
    const existing = topic
      ? await Model.find({ topic, subject }).lean()
      : await Model.find({ subject }).lean();
    const existingQs = existing.flatMap(r => r.data?.map(q => q.question) || []);

    const typeInstr = type === "mcq"
      ? "All MCQ with exactly 4 options."
      : type === "tf" ? "All True/False."
      : type === "fill" ? "All Fill in the Blank."
      : "Mix: 60% MCQ, 20% Fill, 20% T/F.";

    const userInstruction = userPrompt.trim() ? `\nADDITIONAL: ${userPrompt}` : "";
    const topicStr = topic ? `Topic: "${topic}"` : `Subject: ${subLabel}`;
    const dupNote = existingQs.length
      ? `\n\nDo NOT repeat these:\n${existingQs.slice(0, 80).map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "";

    const prompt = `Generate exactly ${count} UNIQUE questions for ${topicStr} (${subLabel}).
${typeInstr}
DIFFICULTY: SSC CGL / UPSC Prelims — moderate to hard.
${getSubjectHint(subject)}
${userInstruction}
Return ONLY JSON with key "questions". Each item: question, options, answer, explanation.
${dupNote}`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a SENIOR SSC/UPSC question paper setter. Return valid JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
    });

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(1);
    const raw = JSON.parse(completion.choices[0].message.content);
    const generated = raw.questions || [];

    const existingSet = new Set(existingQs.map(q => norm(q).toLowerCase()));
    const unique = generated.filter(q => !existingSet.has(norm(q.question).toLowerCase()));

    if (unique.length > 0) {
      // ── FIX: normalize on smart-gen save too ────────────────────────────
      const saveData = unique.map(q => ({
        question: norm(q.question),
        options:  (q.options || []).map(norm),
        answer:   norm(q.answer),
        section:  "General Awareness",
      }));
      const topicName = topic || `${subLabel} — Auto`;
      const existingRecord = await Model.findOne({ topic: topicName, subject });
      if (existingRecord) {
        const existingRSet = new Set(existingRecord.data.map(q => norm(q.question).toLowerCase()));
        const truly_new = saveData.filter(q => !existingRSet.has(norm(q.question).toLowerCase()));
        existingRecord.data.push(...truly_new);
        existingRecord.savedAt = new Date();
        await existingRecord.save();
      } else {
        await new Model({ topic: topicName, subject, data: saveData, savedAt: new Date() }).save();
      }

      const notif = await new Notification({
        type: "new_questions", subject,
        topic: topic || `${subLabel} — Auto`,
        count: unique.length,
        message: `🤖 Smart Gen: "${topic || subLabel}" mein ${unique.length} questions add hue`,
        savedAt: new Date(),
      }).save();
      const io = req.app.get("io");
      if (io) io.emit("new_notification", notif);
    }

    const usage = completion.usage || {};
    res.json({
      questions: unique,
      generated: generated.length,
      unique: unique.length,
      existingCount: existingQs.length,
      timeTaken,
      tokens: {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        total: usage.total_tokens || 0
      },
      saved: true,
    });
  } catch (e) {
    console.error("Smart generate error:", e);
    res.status(500).json({ error: "Smart generation failed: " + e.message });
  }
});

router.post("/api/duplicate-check", async (req, res) => {
  try {
    const { subject, topic } = req.body;
    if (!subject) return res.status(400).json({ error: "Subject required" });
    const Model = subjectModel(subject);
    const query = topic && topic !== "__all__" ? { topic, subject } : { subject };
    const records = await Model.find(query).lean();

    const questionMap = {};
    records.forEach(rec => {
      (rec.data || []).forEach((q, idx) => {
        const key = norm(q.question).toLowerCase();
        if (!questionMap[key]) questionMap[key] = [];
        questionMap[key].push({ recordId: rec._id.toString(), topic: rec.topic, qIndex: idx, question: q.question });
      });
    });

    const duplicates = Object.entries(questionMap)
      .filter(([, arr]) => arr.length > 1)
      .map(([, arr]) => ({ question: arr[0].question, occurrences: arr }));

    res.json({ duplicates, total: duplicates.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/duplicate-delete", async (req, res) => {
  try {
    const { subject, topic } = req.body;
    if (!subject) return res.status(400).json({ error: "Subject required" });
    const Model = subjectModel(subject);
    const query = topic && topic !== "__all__" ? { topic, subject } : { subject };
    const records = await Model.find(query);

    const seenQuestions = new Set();
    let deletedCount = 0;

    for (const rec of records) {
      const originalLength = rec.data.length;
      rec.data = rec.data.filter(q => {
        const key = norm(q.question).toLowerCase();
        if (seenQuestions.has(key)) return false;
        seenQuestions.add(key);
        return true;
      });
      if (rec.data.length < originalLength) {
        deletedCount += originalLength - rec.data.length;
        await rec.save();
      }
    }

    res.json({ status: "ok", deleted: deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/notifications", async (req, res) => {
  try {
    res.json(await Notification.find().sort({ savedAt: -1 }).limit(50));
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
    res.json(await QuizResult.find().sort({ takenAt: -1 }).limit(500));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

router.post("/api/news/ai-process", async (req, res) => {
  try {
    const { title, content } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are a professional news editor and SSC/UPSC content writer.
Given a title and raw content:
1. Rewrite the paragraph — same or MORE detail, never shorter. Write in Hindi-English mix.
2. If MCQs are present, extract them. If no MCQs, return empty array.
Return ONLY JSON: { "paragraph": "...", "mcqs": [] or [{question, options:[4], answer, explanation}] }`
        },
        { role: "user", content: `Title: ${title || "(no title)"}\n\nContent:\n${content}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "AI processing failed" });
  }
});

router.post("/api/news/gen-mcq", async (req, res) => {
  try {
    const { paragraph, count = 4 } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a SENIOR SSC/UPSC question maker. Return ONLY valid JSON with key 'mcqs' containing array of {question, options:[4 strings], answer, explanation}." },
        { role: "user", content: `Generate ${count} MCQs from this paragraph:\n\n${paragraph}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2500,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    res.status(500).json({ error: "MCQ generation failed" });
  }
});

router.post("/api/news", async (req, res) => {
  try {
    const { title, content, mcqs = [] } = req.body;
    // ── FIX: normalize news MCQ answers too ─────────────────────────────
    const normalizedMcqs = mcqs.map(q => ({
      ...q,
      answer:  norm(q.answer),
      options: (q.options || []).map(norm),
    }));
    const news = await new News({ title, content, mcqs: normalizedMcqs, hasMcq: normalizedMcqs.length > 0, savedAt: new Date() }).save();
    const notif = await new Notification({
      type: "news",
      message: `📰 New news: "${title}"${normalizedMcqs.length ? ` (+${normalizedMcqs.length} MCQs)` : ""}`,
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
    res.json(await News.find().sort({ savedAt: -1 }).limit(50));
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

// ── PUBLIC TOPICS API ─────────────────────────────────────────────────────────
router.get("/api/public/topics/:subject", async (req, res) => {
  try {
    const { subject } = req.params;
    const Model = subjectModel(subject);
    const records = await Model.find({ subject }).lean();
    const topicMap = {};
    records.forEach(r => {
      if (!topicMap[r.topic]) {
        topicMap[r.topic] = {
          count: 0,
          sections: { Reasoning: 0, "General Awareness": 0, "Quantitative Aptitude": 0, English: 0 }
        };
      }
      topicMap[r.topic].count += (r.data || []).length;
      (r.data || []).forEach(q => {
        const sec = q.section || "General Awareness";
        if (topicMap[r.topic].sections[sec] !== undefined) {
          topicMap[r.topic].sections[sec]++;
        }
      });
    });
    const topics = Object.entries(topicMap)
      .map(([topic, info]) => ({ topic, count: info.count, sections: info.sections }))
      .sort((a, b) => b.count - a.count);
    res.json(topics);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TOPIC QUESTIONS with section filter ───────────────────────────────────────
router.get("/api/topic-questions", async (req, res) => {
  try {
    const { subject, topic, section } = req.query;
    if (!subject || !topic) return res.status(400).json({ error: "subject and topic required" });
    const Model = subjectModel(subject);
    const records = await Model.find({ subject, topic }).lean();
    let questions = records.flatMap(r => r.data || []);
    if (section && section !== "all") {
      questions = questions.filter(q => q.section === section);
    }
    res.json({ questions, total: questions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;