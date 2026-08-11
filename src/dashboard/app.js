// src/dashboard/app.js
// MemPeek recall dashboard client. Vanilla JS, no framework.
// Connects to /api/events (SSE) and renders the three panels live:
//   (a) full recall list, (b) in-context items, (c) token-savings counter + sparkline

const $ = (id) => document.getElementById(id);
const recallList = $("recall-list");
const ctxList = $("ctx-list");
const savedNum = $("saved-num");
const savedCount = $("saved-count");
const recallCountEl = $("recall-count");
const ctxCountEl = $("ctx-count");
const connEl = $("conn");
const connText = $("conn-text");
const spark = $("spark");
const ctx = spark.getContext("2d");

// ---- language toggle ----
function setLang(lang) {
  document.documentElement.lang = lang;
  $("lang-zh").classList.toggle("active", lang === "zh-CN");
  $("lang-en").classList.toggle("active", lang === "en");
  try { localStorage.setItem("mempeek-lang", lang); } catch {}
}
$("lang-zh").addEventListener("click", () => setLang("zh-CN"));
$("lang-en").addEventListener("click", () => setLang("en"));
try {
  const saved = localStorage.getItem("mempeek-lang");
  setLang(saved === "en" ? "en" : "zh-CN");
} catch { setLang("zh-CN"); }

// ---- helpers ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 0) d = 0;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(ts).toLocaleDateString();
}
function truncate(s, n = 240) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---- state ----
let allEntries = [];     // newest first
let inContextIds = new Set();
let matchedIds = new Set();
let savings = { total: 0, count: 0, series: [] };

// ---- rendering ----
function rowHtml(entry, opts = {}) {
  const matched = matchedIds.has(entry.id);
  const inCtx = entry.in_context === true || entry.in_context === 1;
  const flash = opts.flash ? " flash" : "";
  const badges = [];
  if (inCtx) badges.push(`<span class="badge ctx">in context</span>`);
  if (matched) badges.push(`<span class="badge recall">just recalled</span>`);
  const score = opts.score != null ? `<span class="score">sim ${opts.score.toFixed(3)}</span>` : "";
  return `<div class="row${flash}" data-id="${escapeHtml(entry.id)}">
    <div>
      <div class="content">${escapeHtml(truncate(entry.content))}</div>
      <div class="meta">
        <span>${escapeHtml(entry.session_id || "default")}</span>
        <span>·</span>
        <span>${relTime(entry.ts)}</span>
        ${badges.length ? `<span>·</span>${badges.join("")}` : ""}
        ${score}
      </div>
    </div>
  </div>`;
}

function renderRecall() {
  if (!allEntries.length) {
    recallList.innerHTML = `<div class="empty">${document.documentElement.lang === "en"
      ? "No memories yet. Entries appear here after the agent calls <code>mempeek.write</code>."
      : "还没有记忆。agent 调用 <code>mempeek.write</code> 写入后会出现在这里。"}</div>`;
  } else {
    recallList.innerHTML = allEntries.map((e) => rowHtml(e)).join("");
  }
  recallCountEl.textContent = String(allEntries.length);
}

function renderInContext() {
  const items = allEntries.filter((e) => e.in_context === true || e.in_context === 1);
  if (!items.length) {
    ctxList.innerHTML = `<div class="empty">${document.documentElement.lang === "en"
      ? "Entries the agent flagged <code>in_context:true</code> show up here."
      : "agent 标记为 <code>in_context:true</code> 的条目会显示在这里。"}</div>`;
  } else {
    ctxList.innerHTML = items.map((e) => rowHtml(e)).join("");
  }
  ctxCountEl.textContent = String(items.length);
}

function renderSavings() {
  savedNum.firstChild ? (savedNum.firstChild.nodeValue = String(savings.total || 0)) : (savedNum.textContent = String(savings.total || 0));
  // rebuild with unit span
  savedNum.innerHTML = `${(savings.total || 0).toLocaleString()}<span class="unit">tokens</span>`;
  savedCount.textContent = `${savings.count || 0} readbacks`;
  drawSpark(savings.series || []);
}

function drawSpark(series) {
  const w = spark.width, h = spark.height;
  ctx.clearRect(0, 0, w, h);
  if (!series.length) {
    ctx.fillStyle = "#6e6e73";
    ctx.font = "13px Inter, sans-serif";
    ctx.fillText(document.documentElement.lang === "en" ? "awaiting first readback…" : "等待首次回看…", 12, h / 2 + 4);
    return;
  }
  const max = Math.max(1, ...series.map((p) => p.saved));
  const stepX = series.length > 1 ? w / (series.length - 1) : 0;
  // cumulative line
  let cum = 0;
  const pts = series.map((p, i) => {
    cum += p.saved;
    return [i * stepX, h - (cum / Math.max(1, savings.total)) * (h - 8) - 4];
  });
  // gradient stroke
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#8985ff");
  grad.addColorStop(1, "#2dc79a");
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(...p) : ctx.lineTo(...p)));
  ctx.stroke();
  // fill under
  ctx.lineTo(pts[pts.length - 1][0], h);
  ctx.lineTo(pts[0][0], h);
  ctx.closePath();
  ctx.fillStyle = "rgba(137,133,255,0.10)";
  ctx.fill();
  // dots
  ctx.fillStyle = "#2dc79a";
  pts.forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, Math.PI * 2); ctx.fill(); });
}

function applySnapshot(snap) {
  allEntries = (snap.entries || []).slice();
  allEntries.sort((a, b) => b.ts - a.ts);
  inContextIds = new Set((snap.inContext || []).map((e) => e.id));
  savings = { total: snap.savings?.total ?? 0, count: snap.savings?.count ?? 0, series: snap.savings?.series ?? [] };
  renderRecall();
  renderInContext();
  renderSavings();
}

// ---- SSE ----
let es = null;
let reconnectTimer = null;

function setConn(state) {
  connEl.classList.remove("live", "down");
  if (state === "live") { connEl.classList.add("live"); connText.textContent = document.documentElement.lang === "en" ? "live" : "已连接"; }
  else if (state === "down") { connEl.classList.add("down"); connText.textContent = document.documentElement.lang === "en" ? "disconnected" : "已断开"; }
  else { connText.textContent = document.documentElement.lang === "en" ? "connecting…" : "连接中…"; }
}

function connect() {
  setConn("connecting");
  es = new EventSource("/api/events");
  es.addEventListener("open", () => setConn("live"));
  es.addEventListener("snapshot", (ev) => {
    const data = JSON.parse(ev.data);
    applySnapshot(data);
  });
  es.addEventListener("write", (ev) => {
    const data = JSON.parse(ev.data);
    const entry = data.entry;
    if (!allEntries.find((e) => e.id === entry.id)) {
      allEntries.unshift(entry);
      allEntries.sort((a, b) => b.ts - a.ts);
    }
    renderRecall();
    renderInContext();
    // flash the new row
    requestAnimationFrame(() => {
      const el = recallList.querySelector(`[data-id="${CSS.escape(entry.id)}"]`);
      if (el) el.classList.add("flash");
    });
  });
  es.addEventListener("recall", (ev) => {
    const data = JSON.parse(ev.data);
    matchedIds = new Set((data.entries || []).map((e) => e.id));
    renderRecall();
    // auto-clear the "just recalled" badges after 8s
    setTimeout(() => { matchedIds = new Set(); renderRecall(); }, 8000);
  });
  es.addEventListener("savings", (ev) => {
    const data = JSON.parse(ev.data);
    savings = { total: data.total ?? savings.total, count: data.count ?? savings.count, series: savings.series };
    // The snapshot carries the full series; incremental savings events only
    // update totals + append the latest point to keep the sparkline growing.
    if (data.lastSaved && data.ts) {
      savings.series = [...(savings.series || []), { ts: data.ts, saved: data.lastSaved }];
    }
    renderSavings();
  });
  es.addEventListener("snapshot", (ev) => {
    // a snapshot refreshes the full series too
    const data = JSON.parse(ev.data);
    savings = { total: data.savings?.total ?? savings.total, count: data.savings?.count ?? savings.count, series: data.savings?.series ?? savings.series };
    renderSavings();
  });
  es.addEventListener("error", () => {
    setConn("down");
    es.close();
    es = null;
    reconnectTimer = setTimeout(connect, 2000);
  });
}

// initial REST backfill (in case SSE is slow) then connect
async function boot() {
  try {
    const [e, c, s] = await Promise.all([
      fetch("/api/entries").then((r) => r.json()),
      fetch("/api/in-context").then((r) => r.json()),
      fetch("/api/savings").then((r) => r.json()),
    ]);
    applySnapshot({ entries: e.entries || [], inContext: c.entries || [], savings: s });
  } catch { /* SSE will fill in */ }
  connect();
}
boot();

// expose for console debugging
window.__mempeek = { get state() { return { allEntries, savings, matchedIds }; } };
