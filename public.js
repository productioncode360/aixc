const express = require("express");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const path = require("path");

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Analytics logHit — lazy require to avoid circular deps
function logHit(data) {
  try { require("./analytics").logHit(data); } catch(e) {}
}

// ── Static base subjects ──────────────────────────────────────────────────────
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

// ── Dynamic custom subjects ───────────────────────────────────────────────────
const CustomSubjectSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true },
  label:   { type: String, required: true },
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

// ── Normalize helper — invisible chars + whitespace + trim ───────────────────
const norm = s => (s || '').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Record schema ─────────────────────────────────────────────────────────────
const RecordSchema = new mongoose.Schema({
  topic:   String,
  subject: String,
  savedAt: { type: Date, default: Date.now },
  data:    [{ question: String, options: [String], answer: String, section: { type: String, default: "General Awareness" } }],
});

const subjectModel = (s) => {
  if (mongoose.modelNames().includes(s)) return mongoose.model(s);
  return mongoose.model(s, RecordSchema, s);
};

// ── Public HTML ───────────────────────────────────────────────────────────────
router.get("/public", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "public.html"));
});

// ── All subjects with question counts ─────────────────────────────────────────
router.get("/api/public/subjects", async (req, res) => {
  try {
    const allSubjects = await getAllSubjects();
    const result = await Promise.all(
      Object.entries(allSubjects).map(async ([key, label]) => {
        const records = await subjectModel(key).find().lean();
        const qCount = records.reduce((s, r) => s + (r.data?.length || 0), 0);
        return { key, label, recordCount: records.length, questionCount: qCount };
      })
    );
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Topics for a subject ──────────────────────────────────────────────────────
router.get("/api/public/topics/:subject", async (req, res) => {
  try {
    const records = await subjectModel(req.params.subject).find({}, "topic data").lean();
    res.json(records.map(r => ({ topic: r.topic, count: r.data?.length || 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quiz questions — POST ─────────────────────────────────────────────────────
router.post("/api/public/quiz/:subject", async (req, res) => {
  try {
    const { subject } = req.params;
    const { count = 100, topics = null, exclude = [], section = null } = req.body;
    const filterTopics = topics?.length ? topics : null;
    const excludeSet = new Set(exclude);

    let allQ = [];
    let allQWithExcluded = [];

    // ── FIX: normalize answer + options when fetching ──────────────────────
    const fetchFrom = async (key) => {
      let query = subjectModel(key).find();
      if (filterTopics) query = subjectModel(key).find({ topic: { $in: filterTopics } });
      const records = await query.lean();
      records.forEach(r => r.data.forEach(q => {
        // FIX: answer letter (A/B/C/D) → full option text convert karo
        const OPTS_MAP = ['A','B','C','D','E'];
        const normOpts = (q.options || []).map(norm);
        const answerLetter = (q.answer || '').trim().toUpperCase();
        const ansIdx = OPTS_MAP.indexOf(answerLetter);
        const resolvedAnswer = (ansIdx >= 0 && normOpts[ansIdx])
          ? normOpts[ansIdx]          // letter → full text
          : norm(q.answer);           // already full text, just normalize
        const item = {
          ...q,
          subject: key,
          topic: r.topic,
          answer:  resolvedAnswer,
          options: normOpts,
          question: norm(q.question),
        };
        allQWithExcluded.push(item);
        if (!excludeSet.has(q.question)) allQ.push(item);
      }));
    };

    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    if (subject === "mixed") {
      const allSubjects = await getAllSubjects();
      for (const key of Object.keys(allSubjects)) await fetchFrom(key);
    } else {
      await fetchFrom(subject);
    }

    if (!allQWithExcluded.length) return res.json({ questions: [], message: "no_questions" });

    // Section filter
    if (section && section !== 'all') {
      allQ = allQ.filter(q => q.section === section);
      allQWithExcluded = allQWithExcluded.filter(q => q.section === section);
    }

    if (allQ.length === 0) {
      return res.json({ questions: shuffle(allQWithExcluded).slice(0, count), message: "all_done" });
    }

    if (allQ.length < count) {
      const newQSet = new Set(allQ.map(q => q.question));
      const extras = shuffle(allQWithExcluded.filter(q => !newQSet.has(q.question)));
      const needed = count - allQ.length;
      allQ = [...allQ, ...extras.slice(0, needed)];
    }

    res.json({ questions: shuffle(allQ).slice(0, count), message: "ok" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quiz questions — GET (backward compat) ────────────────────────────────────
router.get("/api/public/quiz/:subject", async (req, res) => {
  try {
    const { subject } = req.params;
    const count = parseInt(req.query.count) || 20;
    const filterTopics = req.query.topics ? req.query.topics.split("|||") : null;
    let allQ = [];

    // ── FIX: normalize answer + options when fetching ──────────────────────
    const fetchFrom = async (key) => {
      let query = subjectModel(key).find();
      if (filterTopics) query = subjectModel(key).find({ topic: { $in: filterTopics } });
      const records = await query.lean();
      records.forEach(r => r.data.forEach(q => {
        const OPTS_MAP2 = ['A','B','C','D','E'];
        const normOpts2 = (q.options || []).map(norm);
        const ansLetter2 = (q.answer || '').trim().toUpperCase();
        const ansIdx2 = OPTS_MAP2.indexOf(ansLetter2);
        const resolvedAns2 = (ansIdx2 >= 0 && normOpts2[ansIdx2])
          ? normOpts2[ansIdx2]
          : norm(q.answer);
        allQ.push({
          ...q,
          subject: key,
          topic: r.topic,
          answer:  resolvedAns2,
          options: normOpts2,
          question: norm(q.question),
        });
      }));
    };

    if (subject === "mixed") {
      const allSubjects = await getAllSubjects();
      for (const key of Object.keys(allSubjects)) await fetchFrom(key);
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

// ── Short AI explanation ──────────────────────────────────────────────────────
// ── Detect if question needs Tavily (recent/latest content) ─────────────────
function needsTavily(question, section) {
  if (section === 'Reasoning' || section === 'Quantitative Aptitude' || section === 'English') {
    return false;
  }
  const q = (question || '').toLowerCase();
  // Year 2024+ present → always Tavily
  if (/202[4-9]/.test(q)) return true;
  // Recent keywords Hindi/English
  if (/हाल ही में|हालिया|ताज़ा|नवीनतम/.test(q)) return true;
  if (/\brecently appointed\b|\blatest appointment\b/.test(q)) return true;
  // Appointments/elections ONLY with recent year
  if (/appointed|elected|नियुक्त|निर्वाचित/.test(q) && /202[3-9]/.test(q)) return true;
  // Sports events ONLY with recent year
  if (/championship|tournament|world cup|olympics|asian games/.test(q) && /202[3-9]/.test(q)) return true;
  // Space missions (recent by nature)
  if (/\bnglv\b|gaganyaan|chandrayaan-3|aditya-l1/.test(q)) return true;
  return false;
}

async function tavilySearch(query) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        search_depth: 'basic',
        max_results: 5,
        days: 365,
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.results || [])
      .map(r => r.title + ': ' + (r.content || r.snippet || '').slice(0, 300))
      .join('\n\n');
  } catch (e) {
    return '';
  }
}

// ── Short explain — smart: Tavily for recent, Groq only for static ────────────
router.post("/api/public/short-explain", async (req, res) => {
  try {
    const { question, answer, section } = req.body;
    let context = '';
    let usedTavily = false;

    if (needsTavily(question, section)) {
      // Search for recent context
      context = await tavilySearch(question.slice(0, 200));
      usedTavily = !!context;
    }

    const systemPrompt = usedTavily
      ? `You are an SSC/UPSC expert. Use the search context below to explain why the answer is correct.
Give exactly 2 lines in Hinglish. Be specific with facts.
Search context:\n${context}`
      : `You are an SSC/UPSC expert. Explain in exactly 2 lines (Hinglish) why this answer is correct. Be specific.`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Q: ${question}\nAnswer: ${answer}` }
      ],
      max_tokens: 120,
    });
    const tokens = completion.usage?.total_tokens || 0;
    // Log this hit
    logHit({ type: usedTavily ? "tavily" : "groq", endpoint: "short-explain", question, section, tokens, tavilyHit: usedTavily, groqHit: true });
    res.json({ text: completion.choices[0].message.content, usedTavily, tokens });
  } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// ── AI Chat ───────────────────────────────────────────────────────────────────
router.post("/api/public/chat", async (req, res) => {
  try {
    const { messages, questionContext } = req.body;
    let tavilyCtx = '';

    // If question context exists and needs Tavily, fetch context
    if (questionContext && needsTavily(questionContext.question, questionContext.section)) {
      tavilyCtx = await tavilySearch(questionContext.question.slice(0, 200));
    }

    let sys;
    if (questionContext) {
      sys = `You are an expert SSC/UPSC teacher. Student is asking about:
Question: ${questionContext.question}
Options: ${questionContext.options?.join(", ")}
Correct Answer: ${questionContext.answer}
${tavilyCtx ? `\nLatest search context:\n${tavilyCtx}\n` : ''}
Explain deeply with examples and memory tricks. Hindi-English mix. Remember the full conversation.
If this is a recent event (2024/2025), use the search context for accurate facts.`;
    } else {
      sys = `You are an expert SSC/UPSC teacher. Help the student understand topics. Hindi-English mix. Give detailed answers with memory tricks.`;
    }

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: sys }, ...messages],
      max_tokens: 600,
    });
    const chatTokens = completion.usage?.total_tokens || 0;
    const usedTavilyChat = !!tavilyCtx;
    logHit({ type: usedTavilyChat ? "tavily" : "groq", endpoint: "chat", question: questionContext?.question || "", section: questionContext?.section || "", tokens: chatTokens, tavilyHit: usedTavilyChat, groqHit: true });
    res.json({ reply: completion.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: "Chat failed" }); }
});

// ── News MCQ quiz ─────────────────────────────────────────────────────────────
router.get("/api/public/news-quiz", async (req, res) => {
  try {
    const NewsModel = mongoose.modelNames().includes("News")
      ? mongoose.model("News")
      : mongoose.model("News", new mongoose.Schema({ title:String, content:String, mcqs:[{question:String,options:[String],answer:String,explanation:String}], hasMcq:Boolean, savedAt:Date }));
    const newsList = await NewsModel.find({ hasMcq: true }).sort({ savedAt: -1 }).lean();
    const allQ = newsList.flatMap(n => (n.mcqs||[]).map(q => ({
      ...q,
      answer:  norm(q.answer),
      options: (q.options || []).map(norm),
      topic: n.title,
      subject: "news",
      newsId: n._id
    })));
    for (let i = allQ.length-1; i>0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [allQ[i],allQ[j]] = [allQ[j],allQ[i]];
    }
    res.json(allQ.slice(0, parseInt(req.query.count)||20));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── News articles ─────────────────────────────────────────────────────────────
router.get("/api/public/news-articles", async (req, res) => {
  try {
    const NewsModel = mongoose.modelNames().includes("News")
      ? mongoose.model("News")
      : mongoose.model("News", new mongoose.Schema({title:String,content:String,mcqs:Array,hasMcq:Boolean,savedAt:Date}));
    const news = await NewsModel.find().sort({ savedAt: -1 }).lean();
    res.json(news);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get("/api/notifications", async (req, res) => {
  try {
    const NotificationModel = mongoose.modelNames().includes("Notification")
      ? mongoose.model("Notification")
      : mongoose.model("Notification", new mongoose.Schema({ type:String, subject:String, topic:String, count:Number, message:String, savedAt:Date, readBy:[String] }));
    res.json(await NotificationModel.find().sort({ savedAt: -1 }).limit(50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Results save ──────────────────────────────────────────────────────────────
router.post("/api/results/save", async (req, res) => {
  try {
    const QuizResult = mongoose.modelNames().includes("QuizResult")
      ? mongoose.model("QuizResult")
      : mongoose.model("QuizResult", new mongoose.Schema({ subject:String, correct:Number, wrong:Number, skip:Number, total:Number, pct:Number, timeUsed:String, takenAt:{ type:Date, default:Date.now } }));
    const result = await new QuizResult({ ...req.body, takenAt: new Date() }).save();
    res.json({ status: "ok", id: result._id });
  } catch (e) { res.status(500).send(e.message); }
});

// ── News (public read) ────────────────────────────────────────────────────────
router.get("/api/news", async (req, res) => {
  try {
    const NewsModel = mongoose.modelNames().includes("News")
      ? mongoose.model("News")
      : mongoose.model("News", new mongoose.Schema({title:String,content:String,mcqs:Array,hasMcq:Boolean,savedAt:Date}));
    res.json(await NewsModel.find().sort({ savedAt: -1 }).limit(50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;