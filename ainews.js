const express = require("express");
const mongoose = require("mongoose");
const Groq = require("groq-sdk");

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TAVILY_KEY = process.env.TAVILY_API_KEY;

// ── Schemas ───────────────────────────────────────────────────────────────────

const AiNewsScheduleSchema = new mongoose.Schema({
  prompt:         { type: String, required: true },
  daily:          { type: Boolean, default: false },
  scheduledAt:    { type: Date, required: true },
  otherDelayHrs:  { type: Number, default: 0 },
  lastRun:        { type: Date, default: null },
  status:         { type: String, default: "pending" },
  createdAt:      { type: Date, default: Date.now },
});

const AiNewsResultSchema = new mongoose.Schema({
  prompt:   String,
  topics:   [{ title: String, summary: String, source: String, url: String, category: String }],
  tokens:   { input: Number, output: Number, total: Number },
  timeTaken: String,
  savedAt:  { type: Date, default: Date.now },
});

const AiNewsPendingSchema = new mongoose.Schema({
  resultId:  { type: mongoose.Schema.Types.ObjectId, ref: "AiNewsResult" },
  prompt:    String,
  topics:    [{ title: String, summary: String, source: String, url: String, category: String }],
  sendAfter: { type: Date, required: true },
  sent:      { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const AiNewsSchedule = mongoose.modelNames().includes("AiNewsSchedule")
  ? mongoose.model("AiNewsSchedule")
  : mongoose.model("AiNewsSchedule", AiNewsScheduleSchema);

const AiNewsResult = mongoose.modelNames().includes("AiNewsResult")
  ? mongoose.model("AiNewsResult")
  : mongoose.model("AiNewsResult", AiNewsResultSchema);

const AiNewsPending = mongoose.modelNames().includes("AiNewsPending")
  ? mongoose.model("AiNewsPending")
  : mongoose.model("AiNewsPending", AiNewsPendingSchema);

// ── Core: Tavily search + Groq summarize ─────────────────────────────────────
async function fetchAndSummarize(prompt) {
  const startTime = Date.now();

  // Tavily search
  let searchResults = [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query: prompt,
        search_depth: "advanced",
        max_results: 20,
        include_answer: false,
        days: 3,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      searchResults = data.results || [];
    }
  } catch (e) {
    console.error("Tavily failed:", e.message);
  }

  // Sort newest first
  searchResults.sort((a, b) => {
    const ta = a.published_date ? new Date(a.published_date).getTime() : 0;
    const tb = b.published_date ? new Date(b.published_date).getTime() : 0;
    return tb - ta;
  });

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const contextText = searchResults.length
    ? searchResults.map((r, i) => {
        const pub = r.published_date ? " [" + r.published_date + "]" : "";
        const body = (r.content || r.snippet || "").slice(0, 500);
        return "[" + (i + 1) + "] " + r.title + pub + "\n" + body + "\nURL: " + (r.url || "");
      }).join("\n\n---\n\n")
    : "NO SEARCH RESULTS — use your own knowledge for today's most important news.";

  // ── FIXED SYSTEM PROMPT — no useless restrictions ─────────────────────────
  const systemPrompt = `You are an expert Indian news analyst and SSC/UPSC content creator. Today is ${today}.

The user wants: "${prompt}"

YOUR JOB:
- Give the most IMPORTANT and RECENT news/updates related to the user's query
- Use the search results as primary source, but also use your own knowledge to fill gaps
- Each topic must have a DETAILED, informative summary — not just 1-2 lines, give proper context
- Cover as many relevant topics as found — minimum 5, no maximum limit
- Most important/recent news first
- Write summaries in Hinglish (Hindi+English mix) — detailed and informative
- Include key facts, numbers, dates, names wherever relevant
- For exam news: include exam dates, vacancy count, eligibility, important dates
- For current affairs: include full context — who, what, when, where, why

QUALITY RULES:
- Each summary should be 3-5 sentences with proper details
- Never give vague or empty summaries
- If search results are poor, use your knowledge of recent events
- Be specific — give actual names, numbers, dates

Return ONLY valid JSON:
{
  "topics": [
    {
      "title": "Clear headline max 15 words",
      "summary": "Detailed 3-5 sentence Hinglish summary with full context, numbers, dates, names",
      "source": "source site name or empty string",
      "url": "exact URL from search result or empty string",
      "category": "exam OR local OR national OR international OR sports OR economy OR politics OR science OR entertainment"
    }
  ]
}`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Search results:\n\n" + contextText },
    ],
    response_format: { type: "json_object" },
    max_tokens: 6000,
    temperature: 0.2,
  });

  const timeTaken = ((Date.now() - startTime) / 1000).toFixed(1);
  const usage = completion.usage || {};
  const tokens = {
    input:  usage.prompt_tokens     || 0,
    output: usage.completion_tokens || 0,
    total:  usage.total_tokens      || 0,
  };

  let topics = [];
  try {
    const parsed = JSON.parse(completion.choices[0].message.content);
    topics = (parsed.topics || []).slice(0, 40);
  } catch (e) {
    console.error("Groq parse error:", e.message);
  }

  return { topics, tokens, timeTaken };
}

// ── Execute job ───────────────────────────────────────────────────────────────
async function executeNewsJob(prompt, io, otherDelayHrs = 0) {
  const result = await fetchAndSummarize(prompt);

  const saved = await new AiNewsResult({
    prompt,
    topics:    result.topics,
    tokens:    result.tokens,
    timeTaken: result.timeTaken,
    savedAt:   new Date(),
  }).save();

  const Notification = mongoose.model("Notification");

  // Send notification
  if (result.topics.length > 0) {
    const titles = result.topics.slice(0, 3).map(t => "• " + t.title).join(" | ");
    const notif = await new Notification({
      type:    "news",
      message: "📰 News [" + prompt + "]: " + result.topics.length + " updates — " + titles,
      savedAt: new Date(),
    }).save();
    if (io) io.emit("new_notification", notif);
  }

  // Emit to panel
  if (io) io.emit("ainews_result", {
    resultId:  saved._id,
    prompt,
    topics:    result.topics,
    tokens:    result.tokens,
    timeTaken: result.timeTaken,
  });

  return { resultId: saved._id, ...result };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/api/ainews/fetch", async (req, res) => {
  try {
    const { prompt, otherDelayHrs = 0 } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: "Prompt required" });
    const result = await executeNewsJob(prompt.trim(), req.app.get("io"), otherDelayHrs);
    res.json(result);
  } catch (e) {
    console.error("AI News fetch error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/ainews/paragraph", async (req, res) => {
  try {
    const { title, summary } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are an expert SSC/UPSC content writer. 
Write a detailed, informative paragraph in Hinglish (Hindi+English mix) about this news topic.
Include: full context, key facts, numbers, dates, names, significance for exams.
Length: 200-300 words. Be specific and factual.`
        },
        { role: "user", content: "Title: " + title + "\nSummary: " + summary },
      ],
      max_tokens: 800, temperature: 0.3,
    });
    const u = completion.usage || {};
    res.json({
      paragraph: completion.choices[0].message.content,
      tokens: { input: u.prompt_tokens||0, output: u.completion_tokens||0, total: u.total_tokens||0 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/api/ainews/mcq", async (req, res) => {
  try {
    const { paragraph, count = 4 } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Generate SSC/UPSC level MCQs from the given paragraph.
Return ONLY JSON: { "mcqs": [{question, options:[4 strings], answer, explanation}] }
- answer must be the FULL TEXT of correct option (not just A/B/C/D)
- All 4 options must look plausible
- Explanation in Hinglish`
        },
        { role: "user", content: "Generate " + count + " MCQs:\n\n" + paragraph },
      ],
      response_format: { type: "json_object" }, max_tokens: 2500, temperature: 0.2,
    });
    const u = completion.usage || {};
    const d = JSON.parse(completion.choices[0].message.content);
    res.json({ mcqs: d.mcqs||[], tokens: { input: u.prompt_tokens||0, output: u.completion_tokens||0, total: u.total_tokens||0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/ainews/results", async (req, res) => {
  try { res.json(await AiNewsResult.find().sort({ savedAt: -1 }).limit(20).lean()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/api/ainews/results/:id", async (req, res) => {
  try { await AiNewsResult.findByIdAndDelete(req.params.id); res.json({ status: "ok" }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/ainews/pending", async (req, res) => {
  try { res.json(await AiNewsPending.find({ sent: false }).sort({ sendAfter: 1 }).lean()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/ainews/schedules", async (req, res) => {
  try { res.json(await AiNewsSchedule.find().sort({ scheduledAt: 1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/api/ainews/schedules", async (req, res) => {
  try {
    const { prompt, scheduledAt, daily = false, otherDelayHrs = 0 } = req.body;
    if (!prompt?.trim() || !scheduledAt) return res.status(400).json({ error: "prompt and scheduledAt required" });
    const newTime = new Date(scheduledAt);
    if (isNaN(newTime.getTime())) return res.status(400).json({ error: "Invalid time" });
    const existing = await AiNewsSchedule.find({ status: "pending" }).lean();
    for (const job of existing) {
      if (Math.abs(new Date(job.scheduledAt) - newTime) / 60000 < 2)
        return res.status(409).json({ error: "2 minute gap required. Conflict: " + new Date(job.scheduledAt).toLocaleTimeString("hi-IN") });
    }
    const job = await new AiNewsSchedule({ prompt: prompt.trim(), scheduledAt: newTime, daily, otherDelayHrs }).save();
    res.json({ status: "ok", job });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/api/ainews/schedules/:id", async (req, res) => {
  try { await AiNewsSchedule.findByIdAndDelete(req.params.id); res.json({ status: "ok" }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scheduler tick (every 30s) ────────────────────────────────────────────────
async function schedulerTick(io) {
  const now = new Date();

  try {
    const due = await AiNewsSchedule.find({ status: "pending", scheduledAt: { $lte: now } });
    for (const job of due) {
      try {
        await AiNewsSchedule.findByIdAndUpdate(job._id, { status: "running" });
        await executeNewsJob(job.prompt, io, job.otherDelayHrs || 0);
        if (job.daily) {
          const next = new Date(job.scheduledAt);
          next.setDate(next.getDate() + 1);
          await AiNewsSchedule.findByIdAndUpdate(job._id, { status: "pending", scheduledAt: next, lastRun: now });
        } else {
          await AiNewsSchedule.findByIdAndUpdate(job._id, { status: "done", lastRun: now });
        }
      } catch (e) {
        console.error("Scheduler job failed:", e.message);
        await AiNewsSchedule.findByIdAndUpdate(job._id, { status: "failed", lastRun: now });
      }
    }
  } catch (e) { console.error("Scheduler tick error:", e.message); }
}

module.exports = { router, schedulerTick };