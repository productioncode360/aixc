require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ── Static folders ────────────────────────────────────────────────────────────
app.use("/admin", express.static(path.join(__dirname, "admin")));
app.use("/public-assets", express.static(path.join(__dirname, "public")));

// ── PWA: manifest.json, sw.js, icons — root pe serve karo ────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Analytics dashboard HTML ──────────────────────────────────────────────────
app.get("/analytics", (req, res) => {
  res.sendFile(path.join(__dirname, "analytics.html"));
});

// Make io available to routes
app.set("io", io);

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB Connected");
    const { schedulerTick } = require("./ainews");
    setInterval(() => schedulerTick(io), 30 * 1000);
    console.log("⏰ AI News Scheduler started (30s tick)");
  })
  .catch((err) => console.error("❌ DB Error:", err));

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);
});

app.use("/", require("./solvemcq"));
app.use("/", require("./public"));
const { router: ainewsRouter } = require("./ainews");
app.use("/", ainewsRouter);

// ── Analytics routes ──────────────────────────────────────────────────────────
const { router: analyticsRouter } = require("./analytics");
app.use("/", analyticsRouter);

server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));