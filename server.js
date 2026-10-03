// Heirloom server: static files + 4 small API routes. Node 18+, no dependencies.
// Runs in DEMO mode (sample Work Map, no vision) when ANTHROPIC_API_KEY is missing,
// and in text-only mode when no ElevenLabs agent is configured.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = ROOT;   // flat layout: the site files sit next to server.js

// Minimal .env loader
try {
  const env = await fs.readFile(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const XI_KEY = process.env.ELEVENLABS_API_KEY || "";
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";
const EXPERT_NAME = process.env.EXPERT_NAME || "Sabine";

const SAMPLE = JSON.parse(await fs.readFile(path.join(PUBLIC, "sample-workmap.json"), "utf8"));

// ---------- Claude helpers ----------
async function claude(system, content, maxTokens = 4000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content }] })
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content.map(b => b.text || "").join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0) throw new Error("No JSON in model output");
  return JSON.parse(text.slice(start, end + 1));
}

const RULE_SCHEMA = `Guardrail checks use these invoice fields: supplier (string), country (ISO code), category (equipment|freight|parts|office|service), amount (number, EUR), month (1-12), costCenter (string), asset (string).
Condition: {"field":..., "op": "eq|neq|gt|lt|empty|notempty|contains", "value":...}.
"when" = list of conditions that make the guardrail apply.
"require" = list of conditions that must hold before posting, OR a required action {"action":"hold"|"approve"} instead of posting.`;

const WORKMAP_SYSTEM = (EXPERT_NAME) => `You are the mapping brain of an AI apprentice. You receive a captured work session from an expert (${EXPERT_NAME}):
screen events (with mm:ss time, invoice snapshot), the spoken transcript, and answers the voice agent logged.
Turn it into a Work Map. Output ONLY JSON:
{
 "title": string, "expert": "${EXPERT_NAME}", "confirmed": false,
 "steps": [{"n":int,"t":"mm:ss","invoice":string|null,"title":short imperative,"screen":what was on screen,"decision":what changed,"reason":expert's own words or null,"reason_t":"mm:ss"|null,"judgment_call":bool,"guardrail_ids":[...]}],
 "guardrails": [{"id":"g1","kind":"limit|exception|stop_and_ask","title":short,"quote":expert's own words,"quote_t":"mm:ss","moment_t":"mm:ss","when":[...],"require":[...]}],
 "open_questions": [{"q": one short spoken question,"why":why it is unclear,"about_t":"mm:ss"}],
 "teachback": the whole process explained back in plain words, under 120 words, as "You ..." sentences
}
${RULE_SCHEMA}
Rules:
- Quotes must be the expert's real words from the transcript or answers. Never invent a reason. If a reason is missing, set reason null and add an open question.
- A judgment call is a decision that is not obvious from the screen (re-coding, holding, escalating, an exception).
- Ask at least 3 open questions the session did NOT answer: exceptions, thresholds, unseen cases, who decides, when to stop and ask.
- Every step and guardrail must point to a moment (mm:ss) that exists in the events.`;

const FINALIZE_SYSTEM = (EXPERT_NAME) => `You update a Work Map after the spoken debrief with the expert (${EXPERT_NAME}).
You receive the draft Work Map, the debrief transcript, logged answers and the expert's corrections to the teach-back.
Fill missing reasons and guardrails using the expert's own words (set quote_t / reason_t to "debrief mm:ss" when the words came from the debrief).
Apply every correction. Remove open questions that were answered; keep the rest.
Set "confirmed": true only if the expert confirmed the teach-back. Add "corrections_applied": [strings].
Rewrite "teachback" so it reflects the corrections. Keep the same JSON shape. ${RULE_SCHEMA} Output ONLY JSON.`;

const VISION_SYSTEM = `You watch an expert's shared screen, one frame every 1-2 seconds. Compare with the last known state and report only what CHANGED as events.
Output ONLY JSON: {"screen":"one line describing what is visible","events":[{"type":"invoice_opened|field_changed|button_clicked|navigation|other","invoice":string|null,"field":string|null,"from":string|null,"to":string|null,"desc":short}]}.
If nothing meaningful changed, return "events": []. Never output personal names of private people, emails, phone numbers, IBANs or addresses: write [REDACTED] instead.`;

// ---------- Routes ----------
async function route(req, body) {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/config") {
    return { demo: !ANTHROPIC_KEY, voice: !!AGENT_ID, expert: EXPERT_NAME, model: ANTHROPIC_KEY ? MODEL : null };
  }

  if (url.pathname === "/api/session") {
    if (!AGENT_ID) return { voice: false };
    if (!XI_KEY) return { voice: true, agentId: AGENT_ID }; // public agent
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(AGENT_ID)}`,
      { headers: { "xi-api-key": XI_KEY } });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${await r.text()}`);
    const { signed_url } = await r.json();
    return { voice: true, signedUrl: signed_url };
  }

  if (url.pathname === "/api/workmap" && req.method === "POST") {
    if (!ANTHROPIC_KEY) {
      const draft = structuredClone(SAMPLE);
      draft.confirmed = false; draft.corrections_applied = []; delete draft.sample; draft.demo = true;
      if (body.expert) draft.expert = body.expert;
      draft.open_questions = [
        { q: "You held the December invoice from Schäfer. Is that for every supplier, and who decides when to release it?", why: "Only one held invoice seen", about_t: "05:02" },
        { q: "What would you do with an equipment invoice under €5,000?", why: "Only saw one above the limit", about_t: "03:12" },
        { q: "If a supplier isn't in the system yet, what do you do?", why: "No unknown supplier in the session", about_t: "01:05" }
      ];
      return draft;
    }
    const { events = [], transcript = [], answers = [] } = body;
    return claude(WORKMAP_SYSTEM(body.expert || EXPERT_NAME), JSON.stringify({ events, transcript, answers }));
  }

  if (url.pathname === "/api/finalize" && req.method === "POST") {
    if (!ANTHROPIC_KEY) { const m = structuredClone(SAMPLE); delete m.sample; m.demo = true; if (body.expert) m.expert = body.expert; return m; }
    return claude(FINALIZE_SYSTEM(body.expert || EXPERT_NAME), JSON.stringify(body));
  }

  if (url.pathname === "/api/vision" && req.method === "POST") {
    if (!ANTHROPIC_KEY) return { screen: "", events: [] };
    const { frame, last = "" } = body; // frame: base64 jpeg without prefix
    return claude(VISION_SYSTEM, [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } },
      { type: "text", text: `Last known state: ${last || "none"}` }
    ], 800);
  }
  return null;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      let raw = ""; for await (const c of req) raw += c;
      const out = await route(req, raw ? JSON.parse(raw) : {});
      if (out === null) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const file = path.join(PUBLIC, path.normalize(p));
    const base = path.basename(file);
    if (!file.startsWith(PUBLIC) || base.startsWith(".")) { res.writeHead(403); return res.end(); }
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    if (code === 500) console.error(e);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => {
  console.log(`Heirloom running on http://localhost:${PORT}`);
  console.log(`  Work Map + vision: ${ANTHROPIC_KEY ? MODEL : "DEMO mode (no ANTHROPIC_API_KEY)"}`);
  console.log(`  Voice: ${AGENT_ID ? "ElevenLabs agent " + AGENT_ID : "text + browser speech (no ELEVENLABS_AGENT_ID)"}`);
});
