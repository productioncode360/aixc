// analytics.js
// Tracks: Tavily API hits, Groq API hits, token usage per question, subject/topic stats

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

// ── Schema ────────────────────────────────────────────────────────────────────
const ApiHitSchema = new mongoose.Schema({
  type:        { type: String, enum: ["tavily", "groq"], required: true },
  endpoint:    { type: String, default: "short-explain" }, // short-explain / chat / ainews
  question:    { type: String, default: "" },
  section:     { type: String, default: "" },
  subject:     { type: String, default: "" },
  topic:       { type: String, default: "" },
  tokens:      { type: Number, default: 0 },  // Groq tokens used
  tavilyHit:   { type: Boolean, default: false },
  groqHit:     { type: Boolean, default: false },
  hitAt:       { type: Date, default: Date.now },
});

const ApiHit = mongoose.modelNames().includes("ApiHit")
  ? mongoose.model("ApiHit")
  : mongoose.model("ApiHit", ApiHitSchema);

// ── Log a hit (called from publicRouter) ─────────────────────────────────────
async function logHit({ type, endpoint, question, section, subject, topic, tokens, tavilyHit, groqHit }) {
  try {
    await new ApiHit({ type, endpoint, question: (question||"").slice(0,200), section, subject, topic, tokens: tokens||0, tavilyHit: !!tavilyHit, groqHit: !!groqHit, hitAt: new Date() }).save();
  } catch(e) {
    // silent fail — don't break main flow
  }
}

// ── Analytics API ─────────────────────────────────────────────────────────────

// Summary stats
router.get("/api/analytics/summary", async (req, res) => {
  try {
    const total      = await ApiHit.countDocuments();
    const tavilyTotal = await ApiHit.countDocuments({ tavilyHit: true });
    const groqTotal  = await ApiHit.countDocuments({ groqHit: true });
    const tokensAgg  = await ApiHit.aggregate([{ $group: { _id: null, total: { $sum: "$tokens" } } }]);
    const totalTokens = tokensAgg[0]?.total || 0;

    // Today stats
    const today = new Date(); today.setHours(0,0,0,0);
    const tavilyToday = await ApiHit.countDocuments({ tavilyHit: true, hitAt: { $gte: today } });
    const groqToday   = await ApiHit.countDocuments({ groqHit: true,   hitAt: { $gte: today } });

    // By section
    const bySectionRaw = await ApiHit.aggregate([
      { $group: { _id: "$section", count: { $sum: 1 }, tavily: { $sum: { $cond: ["$tavilyHit", 1, 0] } }, groq: { $sum: { $cond: ["$groqHit", 1, 0] } } } },
      { $sort: { count: -1 } }
    ]);

    // By endpoint
    const byEndpointRaw = await ApiHit.aggregate([
      { $group: { _id: "$endpoint", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Recent 20 hits
    const recent = await ApiHit.find().sort({ hitAt: -1 }).limit(20).lean();

    // Top token-consuming questions
    const topTokens = await ApiHit.find({ tokens: { $gt: 0 } }).sort({ tokens: -1 }).limit(10).lean();

    res.json({
      total, tavilyTotal, groqTotal, totalTokens,
      tavilyToday, groqToday,
      bySection: bySectionRaw,
      byEndpoint: byEndpointRaw,
      recent, topTokens
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Subject-topic breakdown from DB
router.get("/api/analytics/subjects", async (req, res) => {
  try {
    // Get all custom + static subjects from CustomSubject model if exists
    const STATIC = { history:"History", geography:"Geography", polity:"Polity & Governance", currentaffairs:"Current Affairs", maths:"Maths & Reasoning", science:"Science & Tech", economics:"Economics", other:"Other / General" };

    const RecordSchema = new mongoose.Schema({ topic: String, subject: String, savedAt: Date, data: [{ question: String, options: [String], answer: String, section: String }] }, { strict: false });

    const subjectModel = (s) => mongoose.modelNames().includes(s) ? mongoose.model(s) : mongoose.model(s, RecordSchema, s);

    let allSubjects = { ...STATIC };
    try {
      const CS = mongoose.modelNames().includes("CustomSubject") ? mongoose.model("CustomSubject") : null;
      if (CS) { const customs = await CS.find().lean(); customs.forEach(c => { allSubjects[c.key] = c.label; }); }
    } catch(e) {}

    const result = [];
    for (const [key, label] of Object.entries(allSubjects)) {
      try {
        const records = await subjectModel(key).find().lean();
        if (!records.length) continue;
        const topics = [];
        let totalQ = 0, tavilyQ = 0, groqQ = 0;

        for (const rec of records) {
          const qs = rec.data || [];
          totalQ += qs.length;
          let tCount = 0, gCount = 0;

          // Count how many questions in this topic would use Tavily
          qs.forEach(q => {
            const sec = q.section || '';
            const needsT = needsTavilyServer(q.question, sec);
            if (needsT) tCount++; else gCount++;
          });
          tavilyQ += tCount;
          groqQ += gCount;

          topics.push({ topic: rec.topic, count: qs.length, tavily: tCount, groq: gCount });
        }
        result.push({ key, label, totalQ, tavilyQ, groqQ, topics });
      } catch(e) { /* skip */ }
    }

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear analytics
router.delete("/api/analytics/clear", async (req, res) => {
  try { await ApiHit.deleteMany({}); res.json({ status: "ok" }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Same detection logic as frontend/publicRouter ─────────────────────────────
function needsTavilyServer(question, section) {
  if (section === 'Reasoning' || section === 'Quantitative Aptitude' || section === 'English') return false;
  const q = (question || '').toLowerCase();
  if (/202[4-9]/.test(q)) return true;
  if (/हाल ही में|हालिया|ताज़ा|नवीनतम/.test(q)) return true;
  if (/\brecently appointed\b|\blatest appointment\b/.test(q)) return true;
  if (/appointed|elected|नियुक्त|निर्वाचित/.test(q) && /202[3-9]/.test(q)) return true;
  if (/championship|tournament|world cup|olympics|asian games/.test(q) && /202[3-9]/.test(q)) return true;
  if (/\bnglv\b|gaganyaan|chandrayaan-3|aditya-l1/.test(q)) return true;
  return false;
}

module.exports = { router, logHit };