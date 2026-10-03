// Heirloom front end: Capture → Work Map → Teach.
// Works three ways: full (server + Claude + ElevenLabs), text mode (no voice agent:
// browser speech + typed answers), and static demo (no server: sample Work Map).

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const euro = n => "€" + Number(n).toLocaleString("de-DE");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const QUIET_MS = 1200;      // any input this recent = expert is working
const PAUSE_MS = 2500;      // idle this long after a decision = natural pause
const BUDGET = 5;           // max live questions per 10 minutes
const WINDOW_MS = 10 * 60 * 1000;
const KEY = "heirloom.v1";

const COST_CENTERS = { "4711": "4711 · Opex – production", "0400": "0400 · Capex – equipment", "4200": "4200 · Opex – logistics", "4900": "4900 · Opex – admin" };
const EXPERT_CASES = [
  { id: "4471", supplier: "Kraus Maschinenbau GmbH", country: "DE", desc: "CNC spindle unit", category: "equipment", amount: 7850, date: "2026-12-04", costCenter: "4711" },
  { id: "4472", supplier: "Schäfer Logistik GmbH", country: "DE", desc: "December freight", category: "freight", amount: 1240, date: "2026-12-09", costCenter: "4200" },
  { id: "4473", supplier: "Brno Components s.r.o.", country: "CZ", desc: "Bearing housings", category: "parts", amount: 3300, date: "2026-12-10", costCenter: "4711" },
  { id: "4474", supplier: "Bürowelt Stuttgart", country: "DE", desc: "Office supplies", category: "office", amount: 186, date: "2026-12-11", costCenter: "4900" }
];
const TRAINEE_CASES = [
  { id: "5102", supplier: "Hessler Antriebstechnik AG", country: "DE", desc: "Servo motor package", category: "equipment", amount: 7200, date: "2026-12-14", costCenter: "4711" },
  { id: "5103", supplier: "Schäfer Logistik GmbH", country: "DE", desc: "December freight", category: "freight", amount: 980, date: "2026-12-15", costCenter: "4200" },
  { id: "5104", supplier: "Brno Components s.r.o.", country: "CZ", desc: "Gear blanks", category: "parts", amount: 2150, date: "2026-12-16", costCenter: "4711" },
  { id: "5105", supplier: "Bürowelt Stuttgart", country: "DE", desc: "Printer toner", category: "office", amount: 214, date: "2026-12-16", costCenter: "4900" }
];

// ---------- config + API ----------
let CONFIG = { demo: true, voice: false, expert: "Sabine", learner: "" };
let HAS_SERVER = false;
let SAMPLE = null;

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// ---------- who is using it ----------
const PKEY = "heirloom.profile";
let PROFILE = (() => { try { return JSON.parse(localStorage.getItem(PKEY)); } catch { return null; } })();
const TE = () => (S.workmap || SAMPLE || {}).expert || "Sabine";   // the expert the tutor quotes
function applyProfile() {
  if (!PROFILE) return;
  if (PROFILE.role === "expert") CONFIG.expert = PROFILE.name; else CONFIG.learner = PROFILE.name;
  $("who").hidden = false;
  $("whoName").innerHTML = `Hi, <b>${esc(PROFILE.name)}</b> · ${PROFILE.role === "expert" ? "expert" : "new hire"}`;
}

// ---------- persisted session ----------
const fresh = () => ({ t0: null, events: [], transcript: [], answers: [], frames: [], debrief: [], workmap: null });
let S = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { return fresh(); } })();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch { try { localStorage.setItem(KEY, JSON.stringify({ ...S, frames: [] })); } catch {} }
}
const secs = () => S.t0 ? Math.floor((Date.now() - S.t0) / 1000) : 0;
const fmt = s => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
const toSecs = t => { const m = String(t || "").match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : 0; };

// Redact personal data before it is stored or sent anywhere
const redact = s => String(s ?? "")
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[EMAIL]")
  .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g, "[IBAN]")
  .replace(/\+?\d[\d\s/-]{8,}\d/g, "[PHONE]");

// ---------- voice ----------
// iPad and iPhone only allow speech that starts inside a tap, so prime it synchronously.
function unlockSpeech() {
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch {}
}
const Voice = {
  convo: null, speaking: false,
  async start({ phase, context, first, tools = {}, onLine, onMode }) {
    await this.stop();
    if (!CONFIG.voice) { if (first) this.say(first, onLine); return false; }
    const s = HAS_SERVER ? await api("/api/session") : { agentId: CONFIG.agentId };
    const { Conversation } = await import("https://esm.sh/@elevenlabs/client");
    this.convo = await Conversation.startSession({
      ...(s.signedUrl ? { signedUrl: s.signedUrl } : { agentId: s.agentId }),
      dynamicVariables: { phase, context, expert_name: phase === "tutor" ? TE() : CONFIG.expert, learner_name: CONFIG.learner || "there", first_message: first },
      clientTools: tools,
      onMessage: m => onLine?.(m.source === "ai" ? "agent" : "user", m.message),
      onModeChange: m => { this.speaking = m.mode === "speaking"; onMode?.(this.speaking); },
      onError: e => console.error("Voice error", e),
      onDisconnect: () => { this.convo = null; this.speaking = false; }
    });
    return true;
  },
  context(text) { try { this.convo?.sendContextualUpdate(text); } catch {} },
  cue(text) { try { this.convo?.sendUserMessage(text); } catch {} },
  activity() { try { this.convo?.sendUserActivity?.(); } catch {} },
  volume() { try { return this.convo?.getInputVolume?.() ?? 0; } catch { return 0; } },
  mute(on) { try { this.convo?.setMicMuted?.(on); } catch {} },
  say(text, onLine, after) {
    onLine?.("agent", text);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.onstart = () => { this.speaking = true; };
      u.lang = (PROFILE && PROFILE.lang) || "en-US";
      u.onend = () => { this.speaking = false; after?.(); };
      u.onerror = () => { this.speaking = false; };
      speechSynthesis.speak(u);
    } catch {}
  },
  async stop() { try { await this.convo?.endSession(); } catch {} this.convo = null; this.speaking = false; try { speechSynthesis.cancel(); } catch {} }
};

// ---------- microphone (browser speech recognition, used when there is no voice agent) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const Mic = {
  rec: null, btn: null,
  listen(btn, note, onFinal) {
    if (this.rec) { this.stop(); return; }
    if (!SR) { showMicNote(note, "This browser can't listen. Type your answer instead, or open the live site in Safari or Chrome."); return; }
    let finalText = "";
    const r = new SR();
    r.lang = (PROFILE && PROFILE.lang) || "en-US";
    r.interimResults = true; r.continuous = false;
    r.onresult = e => {
      let interim = "";
      for (const res of e.results) { if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript; }
      markActivity(); cap.last = Date.now();
      btn.querySelector("span").textContent = (finalText + interim).slice(-28) || "Listening…";
    };
    r.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture")
        showMicNote(note, "The microphone is blocked here. Open the live site to talk, or type your answer.");
      else if (e.error === "no-speech") showMicNote(note, "I didn't hear anything. Tap Talk and speak a bit louder.");
    };
    r.onend = () => { this.reset(); if (finalText.trim()) onFinal(finalText.trim()); };
    try { r.start(); } catch (e) { showMicNote(note, "The microphone is blocked here. Open the live site to talk, or type your answer."); return; }
    this.rec = r; this.btn = btn;
    btn.setAttribute("aria-pressed", "true"); btn.querySelector("span").textContent = "Listening…";
    if (note) note.hidden = true;
  },
  stop() { try { this.rec?.stop(); } catch {} },
  reset() { if (this.btn) { this.btn.setAttribute("aria-pressed", "false"); this.btn.querySelector("span").textContent = "Talk"; } this.rec = null; this.btn = null; }
};
function showMicNote(note, msg) { if (note) { note.hidden = false; note.textContent = msg; } }

// ---------- shared ERP widget ----------
const snapshot = c => ({ invoice: c.id, supplier: c.supplier, amount: c.amount, category: c.category, costCenter: c.costCenter, asset: c.asset, status: c.status });

function makeERP({ list, form, title, onEvent, onAction, onOpen }) {
  let cases = [], current = null;
  const STATUS = { open: "Open", held: "Held", posted: "Posted", approval: "In approval" };
  function renderList() {
    list.innerHTML = "";
    for (const c of cases) {
      const b = document.createElement("button");
      b.setAttribute("aria-current", c.id === current ? "true" : "false");
      b.innerHTML = `<span class="id">${c.id}</span><span class="amt">${euro(c.amount)}</span><span class="sup">${esc(c.supplier)}</span><span><span class="pill ${c.status}">${STATUS[c.status]}</span></span>`;
      b.onclick = () => open(c.id);
      list.appendChild(b);
    }
  }
  function open(id, quiet) {
    current = id;
    const c = cases.find(x => x.id === id);
    if (!quiet) { onEvent?.("invoice_opened", { invoice: id, snapshot: snapshot(c) }, false); onOpen?.(c); }
    title.textContent = "Invoice " + id;
    const off = c.status !== "open" ? "disabled" : "";
    form.innerHTML = `
      <dl class="meta">
        <div><dt>Supplier</dt><dd>${esc(c.supplier)}</dd></div>
        <div><dt>Country</dt><dd>${c.country}</dd></div>
        <div><dt>Description</dt><dd>${esc(c.desc)}</dd></div>
        <div><dt>Category</dt><dd>${c.category}</dd></div>
        <div><dt>Amount</dt><dd>${euro(c.amount)}</dd></div>
        <div><dt>Invoice date</dt><dd>${c.date}</dd></div>
      </dl>
      <div class="fields">
        <label>Cost center<select data-k="costCenter" ${off}>${Object.entries(COST_CENTERS).map(([k, v]) => `<option value="${k}" ${k === c.costCenter ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Asset number<input data-k="asset" placeholder="e.g. AN-2026-0187" ${off}></label>
      </div>
      <label>Note<textarea data-k="note" rows="2" ${off}></textarea></label>
      <div class="actions">
        <button class="btn primary" data-a="post" ${off}>Post invoice</button>
        <button class="btn" data-a="hold" ${off}>Hold</button>
        <button class="btn" data-a="approve" ${off}>Send for 2nd approval</button>
      </div>`;
    const LABEL = { costCenter: "cost center", asset: "asset number", note: "note" };
    form.querySelectorAll("[data-k]").forEach(el => {
      const k = el.dataset.k;
      if (el.tagName !== "SELECT") el.value = c[k] || "";
      let before = c[k] || "";
      el.addEventListener("input", () => { c[k] = el.value; });
      el.addEventListener("change", () => {
        c[k] = el.value;
        if (el.value !== before) {
          onEvent?.("field_changed", { invoice: c.id, field: LABEL[k], from: before, to: k === "note" ? redact(el.value) : el.value, snapshot: snapshot(c) }, true);
          before = el.value;
        }
      });
    });
    form.querySelectorAll("[data-a]").forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (onAction && onAction(c, a) === false) return;   // blocked by tutor
      c.status = { post: "posted", hold: "held", approve: "approval" }[a];
      onEvent?.({ post: "invoice_posted", hold: "invoice_held", approve: "sent_for_approval" }[a], { invoice: c.id, snapshot: snapshot(c) }, true);
      open(c.id, true);
      const next = cases.find(x => x.status === "open");
      if (next) setTimeout(() => open(next.id), 400);
    });
    renderList();
  }
  return {
    load(list) { cases = structuredClone(list).map(c => ({ ...c, asset: "", note: "", status: "open" })); current = null; open(cases[0].id, true); },
    open, get cases() { return cases; }
  };
}

function describe(e) {
  switch (e.type) {
    case "invoice_opened": return `Invoice ${e.invoice} opened`;
    case "field_changed": return `${e.invoice}: ${e.field} ${e.from || "empty"} → ${e.to || "empty"}`;
    case "invoice_posted": return `${e.invoice} posted`;
    case "invoice_held": return `${e.invoice} held`;
    case "sent_for_approval": return `${e.invoice} sent for 2nd approval`;
    case "question_moment": return `Pause → asked: “${e.question}”`;
    case "question_skipped": return `Pause → skipped, already explained out loud`;
    case "deferred": return `Question budget used → saved for debrief`;
    case "off_record": return e.on ? "Off the record, capture paused" : "Back on the record";
    case "guardrail_caught": return `Stopped ${e.invoice}: ${e.rule}`;
    case "screen": return `Screen: ${e.desc}`;
    default: return e.desc || e.type;
  }
}
function logRow(box, t, text, cls = "") {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = `<time>${t}</time><span></span>`;
  d.lastChild.textContent = text;
  box.prepend(d);
}

// =====================================================================
// 1. CAPTURE
// =====================================================================
const cap = { running: false, pending: null, asked: [], last: Date.now(), off: false, ping: 0, stream: null, timer: null, prevSig: null, lastScreen: "" };
const cERP = makeERP({ list: $("cList"), form: $("cForm"), title: $("cTitle"), onEvent: capEvent });
cERP.load(EXPERT_CASES);

function capEvent(type, data = {}, decision = false) {
  if (!cap.running) return;
  if (cap.off && type !== "off_record") return;
  const ev = { s: secs(), t: fmt(secs()), type, ...data };
  S.events.push(ev); save();
  logRow($("cLog"), ev.t, describe(ev), type);
  if (["invoice_opened", "field_changed", "invoice_posted", "invoice_held", "sent_for_approval", "screen"].includes(type)) {
    Voice.context(`[SCREEN ${ev.t}] ${describe(ev)}`);
  }
  if (decision) cap.pending = ev;
}

function markActivity() {
  cap.last = Date.now();
  if (cap.running && Date.now() - cap.ping > 1000) { cap.ping = Date.now(); Voice.activity(); }
}
["keydown", "pointerdown", "wheel", "input"].forEach(t => document.addEventListener(t, markActivity, { passive: true }));

function onCapLine(who, text) {
  if (cap.off) return;
  const line = { s: secs(), t: fmt(secs()), speaker: who === "agent" ? "apprentice" : CONFIG.expert, text: redact(text) };
  S.transcript.push(line); save();
  logRow($("cLog"), line.t, `${line.speaker}: ${line.text}`, "said");
  if (who === "user") {
    cap.last = Date.now();
    // Already explained out loud? Then the screen + transcript answer it: skip the question.
    if (cap.pending && /because|always|never|every|weil|immer|nie|rule|limit|policy/i.test(text)) cap.pending.explained = true;
  }
}

function pickQuestion(e) {
  const needGuardrail = cap.asked.length >= 2 && !cap.asked.some(a => a.kind === "guardrail");
  let q;
  if (e.type === "field_changed" && e.field === "cost center") q = { kind: "reason", text: `You moved ${e.invoice} from ${e.from} to ${e.to}. What made you do that?` };
  else if (e.type === "field_changed" && e.field === "asset number") q = { kind: "guardrail", text: `Would you ever book that without an asset number? Who gives you the number?` };
  else if (e.type === "field_changed") q = { kind: "reason", text: `What did you just note on ${e.invoice}, and why?` };
  else if (e.type === "invoice_held") q = { kind: "guardrail", text: `You held ${e.invoice}. Is that for every supplier, and who decides when to release it?` };
  else if (e.type === "sent_for_approval") q = { kind: "guardrail", text: `Why does ${e.invoice} need a second approval? Is there a limit?` };
  else if (e.type === "invoice_posted") q = { kind: "guardrail", text: `You posted ${e.invoice} straight away. What would have made you stop and ask someone?` };
  else q = { kind: "reason", text: `You changed ${e.field || "something"} on screen. Why that step?` };
  if (needGuardrail && q.kind !== "guardrail") q = { kind: "guardrail", text: q.text + " And is there a limit where you'd stop and ask someone?" };
  return q;
}

function capTick() {
  if (!cap.running) return;
  if (Voice.volume() > 0.06) cap.last = Date.now();   // expert is talking
  const idle = Date.now() - cap.last;
  cap.asked = cap.asked.filter(a => Date.now() - a.at < WINDOW_MS);
  $("cBudget").textContent = `${cap.asked.length}/${BUDGET} questions · ${fmt(secs())}`;
  let dot = "dot", text = "Listening";
  if (cap.off) { dot = "dot off"; text = "Off the record. Nothing is captured"; }
  else if (Voice.speaking) { dot = "dot speak"; text = "Apprentice is speaking"; }
  else if (idle < QUIET_MS) { dot = "dot work"; text = "Expert is working, staying quiet"; }
  else if (cap.pending && idle >= PAUSE_MS) {
    const e = cap.pending; cap.pending = null;
    if (e.explained) capEvent("question_skipped", { invoice: e.invoice });
    else if (cap.asked.length >= BUDGET) { const q = pickQuestion(e); S.answers.push({ s: secs(), t: fmt(secs()), phase: "deferred", kind: q.kind, question: q.text }); capEvent("deferred", { invoice: e.invoice }); }
    else {
      const q = pickQuestion(e);
      cap.asked.push({ at: Date.now(), kind: q.kind });
      capEvent("question_moment", { invoice: e.invoice, question: q.text, kind: q.kind, about: e.t });
      cap.lastQuestion = q.text;
      $("cSlot").innerHTML = `<div class="card"><small>Asked at a natural pause · ${q.kind}</small><span class="qtext">${esc(q.text)}</span><div class="actions" style="margin-top:8px"><button class="btn small hear"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg> Hear it again</button></div></div>`;
      $("cSlot").querySelector(".hear").onclick = () => Voice.say(q.text);
      $("cSlot").scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (Voice.convo) Voice.cue(`[PAUSE] Natural pause now. Ask this in your own words, max 20 words, then listen: ${q.text}`);
      else { $("cAnswerRow").hidden = false; Voice.say(q.text, null, () => { if (SR && !Mic.rec) Mic.listen($("cMic"), $("cMicNote"), sendCapAnswer); }); }
    }
  }
  else if (cap.pending) { dot = "dot work"; text = "Decision seen, waiting for a pause"; }
  else if (idle >= PAUSE_MS) { dot = "dot ask"; text = "Paused. Nothing new to ask about"; }
  $("cDot").className = dot; $("cStatus").textContent = text;
}
setInterval(capTick, 250);

const captureTools = {
  log_answer: async ({ kind = "reason", quote = "", about = "" }) => {
    S.answers.push({ s: secs(), t: fmt(secs()), phase: "capture", kind, quote: redact(quote), about }); save();
    return "logged";
  },
  off_record: async ({ on }) => { setOff(on === true || on === "true"); return cap.off ? "Capture paused" : "Capture resumed"; }
};

$("cStart").onclick = async () => {
  unlockSpeech();
  if (cap.running) return;
  S = { ...fresh(), workmap: S.workmap };
  S.t0 = Date.now(); save();
  $("cLog").innerHTML = ""; $("cSlot").innerHTML = "";
  cERP.load(EXPERT_CASES);
  cap.running = true; cap.asked = []; cap.pending = null; cap.last = Date.now();
  $("cStart").textContent = "Recording…"; $("cStart").disabled = true;
  try {
    const voiced = await Voice.start({
      phase: "capture",
      context: `${CONFIG.expert} processes month-end supplier invoices in a sandbox ERP. Screen events arrive as [SCREEN] updates.`,
      first: `Hi ${CONFIG.expert}, I'm your apprentice. Work as usual. I'll stay quiet and only ask when you pause.`,
      tools: captureTools, onLine: onCapLine
    });
    $("cAnswerRow").hidden = voiced;
  } catch (e) { alertCard($("cSlot"), "Voice did not start: " + e.message + ". Continuing in text mode."); $("cAnswerRow").hidden = false; }
  cERP.open(cERP.cases[0].id);
};

function sendCapAnswer(text) { $("cAnswer").value = text; $("cSend").click(); }
$("cMic").onclick = () => Mic.listen($("cMic"), $("cMicNote"), sendCapAnswer);
$("cSend").onclick = () => {
  const v = $("cAnswer").value.trim(); if (!v) return;
  onCapLine("user", v);
  S.answers.push({ s: secs(), t: fmt(secs()), phase: "capture", kind: "reason", question: cap.lastQuestion || "", quote: redact(v) }); save();
  $("cAnswer").value = "";
  if (!Voice.convo) Voice.say(`Got it, thanks ${CONFIG.expert}.`, onCapLine);
};
$("cAnswer").addEventListener("keydown", e => { if (e.key === "Enter") $("cSend").click(); });

function setOff(on) {
  if (on === cap.off) return;
  if (!on) { cap.off = false; capEvent("off_record", { on: false }); }
  else { capEvent("off_record", { on: true }); cap.off = true; cap.pending = null; }
  Voice.mute(cap.off);
  $("cOff").setAttribute("aria-pressed", String(cap.off));
  $("cOff").textContent = cap.off ? "Back on the record" : "Off the record";
}
$("cOff").onclick = () => setOff(!cap.off);

$("cForget").onclick = () => {
  const cut = secs() - 120;
  for (const k of ["events", "transcript", "answers", "frames"]) S[k] = S[k].filter(x => x.s < cut);
  save();
  $("cLog").innerHTML = "";
  [...S.events.map(e => [e.s, e.t, describe(e), e.type]), ...S.transcript.map(l => [l.s, l.t, `${l.speaker}: ${l.text}`, "said"])]
    .sort((a, b) => a[0] - b[0]).forEach(([, t, txt, cls]) => logRow($("cLog"), t, txt, cls));
  logRow($("cLog"), fmt(secs()), "Last 2 minutes deleted", "off_record");
};

// Optional screen share: frames → change detection → vision model → events
$("cShare").onclick = async () => {
  if (cap.stream) { cap.stream.getTracks().forEach(t => t.stop()); return; }
  try {
    cap.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
  } catch (e) { alertCard($("cSlot"), "Screen sharing was not started. The ERP events still work."); return; }
  const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, srcObject: cap.stream });
  await video.play();
  $("cShare").textContent = "Stop sharing";
  cap.stream.getVideoTracks()[0].addEventListener("ended", () => { clearInterval(cap.timer); cap.stream = null; $("cShare").textContent = "Share screen"; });
  const canvas = document.createElement("canvas"), small = document.createElement("canvas");
  small.width = 32; small.height = 18;
  cap.timer = setInterval(async () => {
    if (!cap.running || cap.off || !video.videoWidth) return;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(video, 0, 0, 32, 18);
    const px = sctx.getImageData(0, 0, 32, 18).data, sig = [];
    for (let i = 0; i < px.length; i += 4) sig.push((px[i] + px[i + 1] + px[i + 2]) / 3);
    const diff = cap.prevSig ? sig.reduce((a, v, i) => a + (Math.abs(v - cap.prevSig[i]) > 12 ? 1 : 0), 0) / sig.length : 1;
    cap.prevSig = sig;
    if (diff < 0.02) return;   // nothing changed, don't spend a model call
    const w = 960, h = Math.round(video.videoHeight * w / video.videoWidth);
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    const thumb = document.createElement("canvas"); thumb.width = 320; thumb.height = Math.round(h / 3);
    thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
    S.frames.push({ s: secs(), t: fmt(secs()), img: thumb.toDataURL("image/jpeg", 0.6) });
    if (S.frames.length > 40) S.frames.shift();
    save();
    if (!HAS_SERVER || CONFIG.demo) return;
    try {
      const r = await api("/api/vision", { frame: canvas.toDataURL("image/jpeg", 0.7).split(",")[1], last: cap.lastScreen });
      cap.lastScreen = r.screen || cap.lastScreen;
      for (const e of r.events || []) capEvent("screen", { source: "vision", invoice: e.invoice, field: e.field, from: e.from, to: e.to, desc: redact(e.desc || e.type) }, ["field_changed", "button_clicked"].includes(e.type));
    } catch (e) { console.warn("vision", e); }
  }, 1500);
};

$("cFinish").onclick = async () => {
  if (!S.events.length) { alertCard($("cSlot"), "Start a session and process a few invoices first, or load Sabine's sample map in the Work Map tab."); return; }
  cap.running = false; $("cStart").textContent = "Start session"; $("cStart").disabled = false;
  await Voice.stop();
  if (cap.stream) cap.stream.getTracks().forEach(t => t.stop());
  showTab("map");
  $("wmTitle").textContent = "Building the Work Map…";
  try {
    S.workmap = HAS_SERVER
      ? await api("/api/workmap", { expert: CONFIG.expert, events: S.events.map(({ snapshot, ...e }) => ({ ...e, snapshot })), transcript: S.transcript, answers: S.answers })
      : draftFromSample();
  } catch (e) { alert2("Work Map failed: " + e.message + ". Showing the sample instead."); S.workmap = draftFromSample(); }
  save(); selected = 0; renderMap(); openDebrief();
};

function draftFromSample() {
  const d = structuredClone(SAMPLE);
  d.confirmed = false; d.corrections_applied = []; d.expert = CONFIG.expert; delete d.sample; d.demo = true;
  d.open_questions = [
    { q: "You held the December invoice from Schäfer. Is that for every supplier, and who decides when to release it?", why: "Only one held invoice seen", about_t: "05:02" },
    { q: "What would you do with an equipment invoice under €5,000?", why: "Only saw one above the limit", about_t: "03:12" },
    { q: "If a supplier isn't in the system yet, what do you do?", why: "No unknown supplier in the session", about_t: "01:05" }
  ];
  return d;
}
function alertCard(slot, msg) { slot.innerHTML = `<div class="card stop">${esc(msg)}</div>`; }
function alert2(msg) { $("modeBanner").hidden = false; $("modeBanner").textContent = msg; }

// =====================================================================
// 2. WORK MAP + DEBRIEF
// =====================================================================
let selected = 0;
const rulesNow = () => (S.workmap?.guardrails?.length ? S.workmap.guardrails : SAMPLE.guardrails);

function screenMoment(t, invoice, hl) {
  const s = toSecs(t);
  const wmNow = S.workmap || SAMPLE;
  const live = !(wmNow.sample || wmNow.demo);   // sample/demo maps have no recorded session behind them
  const ev = live ? [...S.events].reverse().find(e => e.s <= s + 2 && e.snapshot && (!invoice || e.invoice === invoice)) : null;
  const fr = live ? [...S.frames].reverse().find(f => f.s <= s + 2 && f.s >= s - 6) : null;
  const base = EXPERT_CASES.find(c => c.id === invoice);
  const snap = ev?.snapshot || (base && { ...base, asset: hl === "asset" ? "AN-2026-0187" : "", costCenter: hl ? "0400" : base.costCenter, status: "open" });
  return `<div class="screen">
    <span>${esc(t)}${invoice ? " · invoice " + esc(invoice) : ""}</span>
    ${fr ? `<img src="${fr.img}" alt="Expert screen at ${esc(t)}">` : ""}
    ${snap ? `<span>${esc(snap.supplier)} · ${euro(snap.amount)} · ${esc(snap.category)}</span>
      <span class="${hl === "cc" ? "hl" : ""}">cost center ${esc(snap.costCenter)}</span>
      <span class="${hl === "asset" ? "hl" : ""}">asset ${esc(snap.asset || "—")}</span>
      <span>status ${esc(snap.status)}</span>` : ""}
  </div>`;
}

function renderMap() {
  const wm = S.workmap;
  const badge = $("mapBadge");
  if (!wm) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.className = "badge" + (wm.confirmed ? " ok" : "");
  badge.textContent = wm.confirmed ? "Confirmed" : "Draft";
  $("wmTitle").textContent = wm.title + (wm.sample ? "" : "");
  const steps = wm.steps || [], g = wm.guardrails || [];
  $("wmStats").innerHTML = [
    `${steps.length} steps`, `${steps.filter(s => s.judgment_call).length} judgment calls`, `${g.length} guardrails`,
    `${(wm.open_questions || []).length} open questions`
  ].map(x => `<span class="pill">${x}</span>`).join("") +
    `<span class="badge ${wm.confirmed ? "ok" : ""}">${wm.confirmed ? "Teach-back confirmed by " + esc(wm.expert) : "Teach-back not confirmed yet"}</span>`;
  $("wmTimeline").innerHTML = "";
  steps.forEach((s, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<button aria-current="${i === selected}"><time>${esc(s.t)}</time><span class="mark ${s.judgment_call ? "j" : ""}">${s.n}</span>
      <span><span class="t">${esc(s.title)}</span><br><span class="s">${esc(s.decision)}${s.judgment_call ? " · judgment call" : ""}</span></span></button>`;
    li.firstChild.onclick = () => { selected = i; renderMap(); };
    $("wmTimeline").appendChild(li);
  });
  const s = steps[selected];
  if (!s) { $("wmDetail").innerHTML = ""; return; }
  const cite = t => String(t || "").startsWith("debrief") ? `${esc(wm.expert)}, ${esc(t)}` : `${esc(wm.expert)}, live question at ${esc(t)}`;
  const hl = /cost/i.test(s.title + s.decision) ? "cc" : /asset/i.test(s.title + s.decision) ? "asset" : "";
  const gs = g.filter(x => (s.guardrail_ids || []).includes(x.id));
  $("wmDetail").innerHTML = `
    <dl class="kv">
      <dt>Step</dt><dd>${s.n} of ${steps.length}: ${esc(s.title)}</dd>
      <dt>Screen moment</dt><dd>${screenMoment(s.t, s.invoice, hl)}<span class="note" style="padding:0">${esc(s.screen)}</span></dd>
      <dt>Decision</dt><dd>${esc(s.decision)}</dd>
      <dt>Reason</dt><dd>${s.reason ? `<div class="quote">“${esc(s.reason)}”<cite>${cite(s.reason_t)}</cite></div>` : `<span class="badge">Not explained yet, in the debrief queue</span>`}</dd>
      <dt>Guardrails</dt><dd style="display:grid;gap:8px">${gs.length ? gs.map(x => `<div class="guard"><span class="k">${esc(String(x.kind).replace(/_/g, " "))}</span><b>${esc(x.title)}</b><span class="quote" style="font-size:15px">“${esc(x.quote)}”<cite>${cite(x.quote_t)} · screen ${esc(x.moment_t)}</cite></span></div>`).join("") : `<span class="note" style="padding:0">None for this step</span>`}</dd>
    </dl>`;
}

$("wmSample").onclick = () => { S.workmap = structuredClone(SAMPLE); save(); selected = 2; renderMap(); $("wmDebriefBox").hidden = true; };

$("wmExport").onclick = async () => {
  const wm = S.workmap; if (!wm) return;
  const cond = c => c.action ? `action must be "${c.action}" (do not post)` : `${c.field} ${c.op} ${c.value ?? ""}`.trim();
  const md = `# Procedure: ${wm.title}
Learned from ${wm.expert}. Teach-back ${wm.confirmed ? "confirmed" : "NOT confirmed"}.

## Steps
${(wm.steps || []).map(s => `${s.n}. ${s.title}. ${s.decision}.${s.reason ? ` Why: "${s.reason}"` : ""}`).join("\n")}

## Guardrails (check before every save)
${(wm.guardrails || []).map(g => `- [${g.kind}] ${g.title}
  - When: ${(g.when || []).map(cond).join(" AND ")}
  - Require: ${(g.require || []).map(cond).join(" AND ")}
  - Expert: "${g.quote}"`).join("\n")}

## Stop rule
If a case matches no step above, or a guardrail cannot be checked, stop and hand it to a human.
`;
  const box = $("wmExportBox"); box.hidden = false; box.value = md;
  try { await navigator.clipboard.writeText(md); $("wmExport").textContent = "Copied"; setTimeout(() => $("wmExport").textContent = "Export for AI agents", 1500); }
  catch { box.select(); }
};

// Debrief
let corrections = [];
function openDebrief() {
  const wm = S.workmap; if (!wm) return;
  $("wmDebriefBox").hidden = false; corrections = [];
  const oq = wm.open_questions || [];
  $("dbStatus").textContent = wm.confirmed ? "confirmed" : `${oq.length} open questions`;
  $("dbQuestions").innerHTML = oq.map((q, i) => `<div class="oq"><span>${i + 1}. ${esc(q.q)}</span><span class="note" style="padding:0">${esc(q.why || "")}</span>
    <input data-q="${i}" placeholder="${CONFIG.voice ? "Answered by voice" : "Type the expert's answer"}"></div>`).join("");
  $("dbTeachback").textContent = wm.teachback ? "Teach-back: " + wm.teachback : "";
  $("dbConfirmRow").hidden = !!wm.confirmed;
}
$("wmDebrief").onclick = async () => {
  unlockSpeech();
  if (!S.workmap) { alert2("Build or load a Work Map first."); return; }
  openDebrief();
  const wm = S.workmap, oq = wm.open_questions || [];
  $("dbDot").className = "dot speak"; $("dbText").textContent = "Debrief running";
  try {
    const voiced = await Voice.start({
      phase: "debrief",
      context: JSON.stringify({ open_questions: oq.map(q => q.q), steps: (wm.steps || []).map(s => `${s.n}. ${s.title}: ${s.decision}`), teachback_draft: wm.teachback }),
      first: `Thanks ${CONFIG.expert}. I have ${oq.length} questions about things I didn't see, then I'll explain the whole process back to you.`,
      tools: {
        log_answer: async ({ kind = "reason", quote = "", about = "" }) => {
          S.answers.push({ s: secs(), t: "debrief " + fmt(secs()), phase: "debrief", kind, quote: redact(quote), about }); save();
          return "logged";
        },
        debrief_done: async ({ confirmed, corrections: c = "" }) => { if (c) corrections.push(c); await finalize(confirmed === true || confirmed === "true"); return "Work Map updated"; }
      },
      onLine: (who, text) => { S.debrief.push({ t: fmt(secs()), speaker: who === "agent" ? "apprentice" : CONFIG.expert, text: redact(text) }); save(); $("dbText").textContent = (who === "agent" ? "Apprentice: " : CONFIG.expert + ": ") + text; }
    });
    if (!voiced) { $("dbDot").className = "dot"; $("dbText").textContent = "Text mode: type the answers, then confirm the teach-back"; if (oq[0]) Voice.say(oq[0].q); }
  } catch (e) { $("dbText").textContent = "Voice did not start: " + e.message; }
};
$("dbMic").onclick = () => Mic.listen($("dbMic"), $("dbMicNote"), text => {
  const empty = [...document.querySelectorAll("[data-q]")].find(i => !i.value.trim());
  if (empty) { empty.value = text; const next = [...document.querySelectorAll("[data-q]")].find(i => !i.value.trim()); const q = next && S.workmap.open_questions?.[+next.dataset.q]; if (q) Voice.say(q.q); else Voice.say("Thanks. Read my explanation below. Is that how it works?"); }
  else { $("dbCorrection").value = text; }
});
$("dbCorrect").onclick = () => {
  const v = $("dbCorrection").value.trim(); if (!v) return;
  corrections.push(v); $("dbCorrection").value = "";
  $("dbTeachback").textContent += `\n\nCorrection noted: ${v}`;
};
$("dbConfirm").onclick = () => finalize(true);

async function finalize(confirmed) {
  document.querySelectorAll("[data-q]").forEach(inp => {
    const q = S.workmap.open_questions?.[+inp.dataset.q];
    if (inp.value.trim()) S.answers.push({ t: "debrief", phase: "debrief", kind: "reason", question: q?.q, quote: redact(inp.value.trim()) });
  });
  $("dbText").textContent = "Updating the Work Map…";
  try {
    S.workmap = HAS_SERVER
      ? await api("/api/finalize", { expert: CONFIG.expert, workmap: S.workmap, debrief_transcript: S.debrief, answers: S.answers, corrections, confirmed })
      : { ...structuredClone(SAMPLE), sample: false, demo: true, expert: CONFIG.expert, corrections_applied: corrections.length ? corrections : SAMPLE.corrections_applied, confirmed };
  } catch (e) { $("dbText").textContent = "Update failed: " + e.message; return; }
  save(); await Voice.stop();
  $("dbDot").className = "dot ask"; $("dbText").textContent = confirmed ? `Confirmed by ${CONFIG.expert}. The tutor can use this map now.` : "Saved, not confirmed yet";
  renderMap(); openDebrief();
}

// =====================================================================
// 3. TEACH
// =====================================================================
const fieldVal = (inv, f) => f === "month" ? Number(String(inv.date).slice(5, 7)) : inv[f];
function cond(inv, c) {
  const v = fieldVal(inv, c.field), s = String(v ?? "").trim().toLowerCase(), want = String(c.value ?? "").toLowerCase();
  switch (c.op) {
    case "eq": return s === want;
    case "neq": return s !== want;
    case "gt": return Number(v) > Number(c.value);
    case "lt": return Number(v) < Number(c.value);
    case "empty": return !s;
    case "notempty": return !!s;
    case "contains": return s.includes(want);
    default: return false;
  }
}
const applies = (r, inv) => (r.when || []).every(c => cond(inv, c));
const passes = (r, inv, action) => (r.require || []).every(q => q.action ? action === q.action : (action !== "post" || cond(inv, q)));

const tut = { mastery: {}, opened: new Set(), on: false };
const tERP = makeERP({ list: $("tList"), form: $("tForm"), title: $("tTitle"), onEvent: teachEvent, onAction: teachAction, onOpen: teachOpen });

function teachEvent(type, data) {
  const t = fmt(secs());
  if (type === "field_changed") logRow($("tLog"), t, describe({ type, ...data }));
  if (["invoice_posted", "invoice_held", "sent_for_approval"].includes(type)) {
    logRow($("tLog"), t, describe({ type, ...data }));
    if (tERP.cases.every(c => c.status !== "open")) teachDone();
  }
}
function teachOpen(c) {
  if (!tut.on || c.status !== "open" || tut.opened.has(c.id)) return;
  tut.opened.add(c.id);
  const q = `${CONFIG.learner ? CONFIG.learner + ", before" : "Before"} you start: what do you think ${TE()} would do with invoice ${c.id}?`;
  $("tSlot").innerHTML = (tut.keep || "") + `<div class="card"><small>Predict the next decision</small>${esc(q)}</div>`;
  tut.keep = "";
  if (Voice.convo) Voice.cue(`[OPENED] Invoice ${c.id}: ${c.desc}, ${euro(c.amount)}, ${c.supplier} (${c.country}), category ${c.category}. Ask the trainee to predict the key decision. One short question, don't give the answer.`);
}
function teachAction(c, action) {
  const rel = rulesNow().filter(r => applies(r, c));
  const broken = rel.find(r => !passes(r, c, action));
  const t = fmt(secs());
  if (broken) {
    tut.mastery[broken.id] = "practice"; tut.lastStop = broken;
    logRow($("tLog"), t, `Stopped ${c.id}: ${broken.title}`, "guardrail_caught");
    $("tSlot").innerHTML = `<div class="card stop"><b>${esc(TE())} would stop here.</b> Why do you think?
      <blockquote>“${esc(broken.quote)}”</blockquote>
      <div class="actions"><button class="btn small hear" id="tHear"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg> Hear it</button><button class="btn" id="tReplay">Replay ${esc(TE())}'s screen moment</button></div><div id="tReplayBox" style="margin-top:8px"></div></div>`;
    $("tReplay").onclick = () => replay(broken.id);
    $("tHear").onclick = () => Voice.say(`${TE()} would stop here. Why do you think? ${TE()} says: ${broken.quote}`);
    $("tSlot").scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (Voice.convo) Voice.cue(`[STOP] The trainee tried to ${action === "post" ? "post" : action} invoice ${c.id} (${c.desc}, ${euro(c.amount)}, cost center ${c.costCenter}, asset "${c.asset || "none"}"). This breaks: ${broken.title}. ${TE()}'s words: "${broken.quote}". Say "${TE()} would stop here. Why do you think?", wait, then explain with her words.`);
    else { $("tAnswerRow").hidden = false; Voice.say(`${TE()} would stop here. Why do you think?`, null, () => { if (SR && !Mic.rec) Mic.listen($("tMic"), $("tMicNote"), t => { $("tAnswer").value = t; $("tSend").click(); }); }); }
    renderMastery();
    return false;
  }
  for (const r of rel) {
    tut.mastery[r.id] = tut.mastery[r.id] === "practice" ? "fixed" : "mastered";
  }
  if (rel.length) {
    const r = rel[0];
    tut.keep = `<div class="card"><small>Right call</small>That's what ${esc(TE())} does. “${esc(r.quote)}”</div>`;
    $("tSlot").innerHTML = tut.keep;
    if (Voice.convo) Voice.cue(`[CORRECT] The trainee handled invoice ${c.id} correctly (${r.title}). Praise in under 10 words and add ${TE()}'s reason in her words.`);
  } else { tut.keep = ""; $("tSlot").innerHTML = ""; }
  renderMastery();
  return true;
}
function replay(id) {
  const wm = S.workmap || SAMPLE;
  const r = rulesNow().find(x => x.id === id);
  const step = (wm.steps || []).find(s => (s.guardrail_ids || []).includes(id));
  const hl = id === "g1" ? "cc" : id === "g2" ? "asset" : "";
  $("tReplayBox").innerHTML = screenMoment(r?.moment_t || step?.t || "", step?.invoice, hl) +
    `<span class="note" style="padding:0">${esc(step ? step.screen + ". " + step.decision : "")}</span>`;
}
function renderMastery() {
  const L = { untested: "Not seen yet", practice: "Practise next", fixed: "Fixed after a hint", mastered: "Mastered" };
  const C = { mastered: "posted", fixed: "approval", practice: "held", untested: "" };
  $("tMastery").innerHTML = `<b>Progress</b>` + rulesNow().map(r => {
    const s = tut.mastery[r.id] || "untested";
    return `<div><span>${esc(r.title)}</span><span class="pill ${C[s]}">${L[s]}</span></div>`;
  }).join("");
}
function teachDone() {
  const rules = rulesNow();
  const good = rules.filter(r => tut.mastery[r.id] === "mastered").map(r => r.title);
  const work = rules.filter(r => ["practice", "fixed"].includes(tut.mastery[r.id])).map(r => r.title);
  $("tSlot").innerHTML = `<div class="card"><small>Round complete</small>
    <b>Mastered:</b> ${esc(good.join(", ") || "nothing yet")}<br><b>Practise next:</b> ${esc(work.join(", ") || "nothing, ready for real invoices")}</div>`;
  if (Voice.convo) Voice.cue(`[DONE] Round complete. Mastered: ${good.join("; ") || "none"}. Needs practice: ${work.join("; ") || "none"}. Summarise in two sentences and suggest what to practise next.`);
}
function teachReset() { tut.mastery = {}; tut.opened = new Set(); tERP.load(TRAINEE_CASES); $("tSlot").innerHTML = ""; $("tLog").innerHTML = ""; renderMastery(); }
$("tReset").onclick = teachReset;
$("tStart").onclick = async () => {
  unlockSpeech();
  teachReset(); tut.on = true; if (!S.t0) S.t0 = Date.now();
  $("tDot").className = "dot speak"; $("tStatus").textContent = "Tutor watching. Guardrails are checked before every save";
  const wm = S.workmap || SAMPLE;
  try {
    const voiced = await Voice.start({
      phase: "tutor",
      context: JSON.stringify({ steps: (wm.steps || []).map(s => `${s.n}. ${s.title}: ${s.decision}. Why: ${s.reason || "?"}`), guardrails: rulesNow().map(g => `${g.title}: "${g.quote}"`) }),
      first: `Hi ${CONFIG.learner || "there"}! I learned this process from ${TE()}. Work the queue the way you think is right. I'll step in if something looks off.`,
      tools: { replay_moment: async ({ rule_id }) => { replay(rule_id); return "Shown on screen"; } },
      onLine: (who, text) => logRow($("tLog"), fmt(secs()), (who === "agent" ? "tutor: " : "you: ") + text, "said")
    });
    $("tAnswerRow").hidden = voiced;
  } catch (e) { alertCard($("tSlot"), "Voice did not start: " + e.message + ". The tutor still checks every save."); }
  tERP.open(tERP.cases[0].id);
};
$("tMic").onclick = () => Mic.listen($("tMic"), $("tMicNote"), text => { $("tAnswer").value = text; $("tSend").click(); });
$("tSend").onclick = () => {
  const v = $("tAnswer").value.trim(); if (!v) return;
  logRow($("tLog"), fmt(secs()), (CONFIG.learner || "you") + ": " + v, "said"); $("tAnswer").value = "";
  if (!Voice.convo && tut.lastStop) { const r = tut.lastStop; tut.lastStop = null; const reply = `Good thinking. ${TE()} put it like this: ${r.quote} Fix it, then save again.`; Voice.say(reply, (w, t) => logRow($("tLog"), fmt(secs()), "tutor: " + t, "said")); }
};
$("tAnswer").addEventListener("keydown", e => { if (e.key === "Enter") $("tSend").click(); });

// =====================================================================
// tabs + boot
// =====================================================================
function showWelcome() {
  for (const n of ["capture", "map", "teach"]) $("view-" + n).hidden = true;
  $("view-welcome").hidden = false; $("tabs").hidden = true; $("who").hidden = true;
  if (PROFILE) { $("wName").value = PROFILE.name; $("wEmail").value = PROFILE.email; if (PROFILE.lang) $("wLang").value = PROFILE.lang; }
  $("wName").focus({ preventScroll: true });
}
$("wForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("wName").value.trim(), email = $("wEmail").value.trim();
  const role = document.querySelector('input[name="role"]:checked').value;
  $("wNameErr").textContent = name ? "" : "Enter your name so the apprentice can address you.";
  $("wEmailErr").textContent = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "" : "Enter a valid email, like you@company.com.";
  if (!name || $("wEmailErr").textContent) return;
  PROFILE = { name: name.slice(0, 40), email, role, lang: $("wLang").value };
  try { localStorage.setItem(PKEY, JSON.stringify(PROFILE)); } catch {}
  if (role === "expert") CONFIG.expert = PROFILE.name; else CONFIG.learner = PROFILE.name;
  applyProfile();
  $("view-welcome").hidden = true; $("tabs").hidden = false;
  showTab(role === "expert" ? "capture" : "teach");
});
$("wName").addEventListener("input", () => $("wNameErr").textContent = "");
$("wEmail").addEventListener("input", () => $("wEmailErr").textContent = "");
$("whoSwitch").onclick = async () => { await Voice.stop(); cap.running = false; $("cStart").disabled = false; $("cStart").textContent = "Start session"; showWelcome(); };

function showTab(name) {
  $("view-welcome").hidden = true;
  for (const n of ["capture", "map", "teach"]) {
    $("view-" + n).hidden = n !== name;
    $("tab-" + n).setAttribute("aria-selected", String(n === name));
  }
  if (name === "map") renderMap();
  if (name === "teach") renderMastery();
  try { history.replaceState(null, "", "#" + name); } catch {}
}
$("tab-capture").onclick = () => showTab("capture");
$("tab-map").onclick = () => showTab("map");
$("tab-teach").onclick = () => showTab("teach");

(async function boot() {
  SAMPLE = await fetch("sample-workmap.json").then(r => r.json());
  try { const c = await api("/api/config"); if (typeof c.demo !== "boolean") throw new Error("no server"); CONFIG = { ...CONFIG, ...c }; HAS_SERVER = true; } catch { HAS_SERVER = false; }
  const agentId = (window.HEIRLOOM_CONFIG || {}).elevenLabsAgentId || "";
  if (!HAS_SERVER && agentId) { CONFIG.voice = true; CONFIG.agentId = agentId; }
  const notes = [];
  if (!HAS_SERVER && !CONFIG.voice) notes.push("Demo build: the apprentice talks with your browser's voice and listens when you tap Talk. The Work Map uses Sabine's sample session.");
  if (!HAS_SERVER && CONFIG.voice) notes.push("Live voice: the ElevenLabs agent talks and listens. The Work Map uses Sabine's sample session.");
  else {
    if (!CONFIG.voice) notes.push("Text mode: no ElevenLabs agent set, so questions use your browser's voice and answers are typed.");
    if (CONFIG.demo) notes.push("Demo mode: no Claude key, so the Work Map uses Sabine's sample.");
  }
  if (!("speechSynthesis" in window)) notes.push("Sound is not available in this browser, so read the questions on screen.");
  if (notes.length) { $("modeBanner").hidden = false; $("modeBanner").textContent = notes.join(" "); }
  applyProfile();
  tERP.load(TRAINEE_CASES); renderMastery(); renderMap();
  if (!PROFILE) return showWelcome();
  const h = location.hash.replace("#", "");
  showTab(["capture", "map", "teach"].includes(h) ? h : (PROFILE.role === "learner" ? "teach" : "capture"));
})();
