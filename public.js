const express = require("express");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const path = require("path");

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SUBJECTS = {
  history: "History",
  geography: "Geography",
  polity: "Polity & Governance",
  currentaffairs: "Current Affairs",
  maths: "Maths & Reasoning",
  science: "Science & Tech",
  economics: "Economics",
  other: "Other / General",
};

const RecordSchema = new mongoose.Schema({
  topic: String,
  subject: String,
  savedAt: { type: Date, default: Date.now },
  data: [{ question: String, options: [String], answer: String }],
});

const subjectModel = (s) => {
  if (mongoose.modelNames().includes(s)) return mongoose.model(s);
  return mongoose.model(s, RecordSchema, s);
};

router.get("/public", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "public.html"));
});

router.get("/api/public/subjects", async (req, res) => {
  try {
    const result = await Promise.all(
      Object.entries(SUBJECTS).map(async ([key, label]) => {
        const records = await subjectModel(key).find().lean();
        const qCount = records.reduce((s, r) => s + (r.data?.length || 0), 0);
        return { key, label, recordCount: records.length, questionCount: qCount };
      })
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/public/topics/:subject", async (req, res) => {
  try {
    const records = await subjectModel(req.params.subject).find({}, "topic data").lean();
    res.json(records.map(r => ({ topic: r.topic, count: r.data?.length || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST version to handle large exclude lists without 431 error
router.post("/api/public/quiz/:subject", async (req, res) => {
  try {
    const { subject } = req.params;
    const { count = 20, topics = null, exclude = [] } = req.body;
    const filterTopics = topics?.length ? topics : null;
    const excludeSet = new Set(exclude);

    let allQ = [];
    let allQWithExcluded = []; // fallback pool

    const fetchFrom = async (key) => {
      let query = subjectModel(key).find();
      if (filterTopics) query = subjectModel(key).find({ topic: { $in: filterTopics } });
      const records = await query.lean();
      records.forEach(r => r.data.forEach(q => {
        const item = { ...q, subject: key, topic: r.topic };
        allQWithExcluded.push(item);
        if (!excludeSet.has(q.question)) allQ.push(item);
      }));
    };

    if (subject === "mixed") {
      for (const key of Object.keys(SUBJECTS)) await fetchFrom(key);
    } else {
      await fetchFrom(subject);
    }

    // Shuffle helper
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    if (!allQWithExcluded.length) return res.json({ questions: [], message: "no_questions" });

    // If not enough new questions, fill rest with wrong-answered from excluded
    if (allQ.length === 0) {
      // All done — return shuffled pool with message
      return res.json({ questions: shuffle(allQWithExcluded).slice(0, count), message: "all_done" });
    }

    if (allQ.length < count) {
      // Some new, fill rest from excluded pool (not already in allQ)
      const newQSet = new Set(allQ.map(q => q.question));
      const extras = shuffle(allQWithExcluded.filter(q => !newQSet.has(q.question)));
      const needed = count - allQ.length;
      allQ = [...allQ, ...extras.slice(0, needed)];
    }

    res.json({ questions: shuffle(allQ).slice(0, count), message: "ok" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Keep GET for backward compat (no exclude)
router.get("/api/public/quiz/:subject", async (req, res) => {
  try {
    const { subject } = req.params;
    const count = parseInt(req.query.count) || 20;
    const filterTopics = req.query.topics ? req.query.topics.split("|||") : null;
    let allQ = [];
    const fetchFrom = async (key) => {
      let query = subjectModel(key).find();
      if (filterTopics) query = subjectModel(key).find({ topic: { $in: filterTopics } });
      const records = await query.lean();
      records.forEach(r => r.data.forEach(q => allQ.push({ ...q, subject: key, topic: r.topic })));
    };
    if (subject === "mixed") {
      for (const key of Object.keys(SUBJECTS)) await fetchFrom(key);
    } else {
      await fetchFrom(subject);
    }
    if (!allQ.length) return res.json([]);
    for (let i = allQ.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allQ[i], allQ[j]] = [allQ[j], allQ[i]];
    }
    res.json(allQ.slice(0, Math.min(count, allQ.length)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/api/public/short-explain", async (req, res) => {
  try {
    const { question, answer } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Give 1-2 line explanation of why this answer is correct. Hindi-English mix. Very concise." },
        { role: "user", content: `Q: ${question}\nAnswer: ${answer}` }
      ],
      max_tokens: 100,
    });
    res.json({ text: completion.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});

router.post("/api/public/chat", async (req, res) => {
  try {
    const { messages, questionContext } = req.body;
    const sys = questionContext
      ? `You are an expert SSC/UPSC teacher. Student is asking about:\nQuestion: ${questionContext.question}\nOptions: ${questionContext.options?.join(", ")}\nCorrect Answer: ${questionContext.answer}\nExplain deeply with examples and memory tricks. Hindi-English mix. Remember the full conversation.`
      : `You are an expert SSC/UPSC teacher. Help the student understand topics. Hindi-English mix.`;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: sys }, ...messages],
      max_tokens: 600,
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: "Chat failed" }); }
});

// ── News quiz questions (only news with MCQs) ─────────────────────────────────
router.get("/api/public/news-quiz", async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const NewsModel = mongoose.modelNames().includes("News")
      ? mongoose.model("News")
      : mongoose.model("News", new mongoose.Schema({ title:String, content:String, mcqs:[{question:String,options:[String],answer:String,explanation:String}], hasMcq:Boolean, savedAt:Date }));
    const newsList = await NewsModel.find({ hasMcq: true }).sort({ savedAt: -1 }).lean();
    // Flatten all MCQs with source news title
    const allQ = newsList.flatMap(n => (n.mcqs||[]).map(q => ({
      ...q, topic: n.title, subject: "news", newsId: n._id
    })));
    // Shuffle
    for (let i = allQ.length-1; i>0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [allQ[i],allQ[j]] = [allQ[j],allQ[i]];
    }
    res.json(allQ.slice(0, parseInt(req.query.count)||20));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── News articles (all news for reading) ─────────────────────────────────────
router.get("/api/public/news-articles", async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const NewsModel = mongoose.modelNames().includes("News") ? mongoose.model("News") : mongoose.model("News", new mongoose.Schema({title:String,content:String,mcqs:Array,hasMcq:Boolean,savedAt:Date}));
    const news = await NewsModel.find().sort({ savedAt: -1 }).lean();
    res.json(news);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;