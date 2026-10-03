# Heirloom

**The AI apprentice that learns why.**

**Live demo:** https://amaniamayreh315-jpg.github.io/hierlomm/

 Hack-Nation × ElevenLabs, Challenge 01: The AI Apprentice.

Heirloom watches an expert do real screen work, asks *why* at natural pauses, runs a short spoken debrief until the expert confirms "yes, that's how it works", turns it into a clickable **Work Map**, and then coaches a new hire on their own screen, stepping in before a guardrail is broken.

| Module | What it does |
|---|---|
| 1. Capture | Sandbox ERP + ElevenLabs voice agent. Screen events stream into the agent as context. A pause detector picks the moment and the question. |
| 2. Map | Claude merges events, transcript and answers into Work Map JSON, lists what is still unclear, and the agent runs the debrief and teach-back. |
| 3. Teach | Guardrails compile into checkable rules. Every save is checked; the voice tutor explains with the expert's own words and replays the screen moment. |

## Run it (2 minutes)

```bash
git clone <your repo> && cd heirloom
cp .env.example .env      # add keys (optional, see below)
npm start                 # Node 18+, no dependencies
open http://localhost:3000
```

It runs in three levels, so the demo never dies:

| Keys set | Mode |
|---|---|
| none | Questions spoken with browser speech, answers by voice (Talk button) or typed, Work Map from Sabine's sample session |
| `ANTHROPIC_API_KEY` | Real Work Map from your session + screen-share vision events |
| + `ELEVENLABS_AGENT_ID` (+ `ELEVENLABS_API_KEY` for private agents) | Full voice: interviewer, debrief and tutor |

## Put it online for free (GitHub Pages, 3 minutes)

The site files sit at the top of the repo, so GitHub Pages can serve them as they are.
GitHub → your repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder: `/ (root)` → **Save**.
After a minute the app is live at `https://<your-user>.github.io/heirloom/`, on HTTPS, so the microphone works.
To use the real ElevenLabs voice there, paste a **public** agent ID into `config.js`.

## Set up the ElevenLabs agent (10 minutes)

1. ElevenLabs → Agents → **Create agent** (blank). Name it *Heirloom*.
2. **System prompt**: paste `system-prompt.md`. **First message**: `{{first_message}}`.
3. **Voice**: a calm, warm voice. Turn on Expressive mode if available.
4. **LLM**: pick a fast model (e.g. Claude Sonnet or Gemini Flash). Speed matters more than size for timing.
5. **Turn-taking**: patient / longer turn timeout, so it doesn't jump in while the expert thinks.
6. **Client tools**: add the four tools in `client-tools.md`, each with *Wait for response* on.
7. Copy the **Agent ID** into `.env`. If the agent is private, also add your API key so the server can mint signed URLs.

## Demo script (3 minutes)

1. **Capture (60s).** "Sabine" starts a session and narrates while working. Open 4471, change cost center 4711 → 0400. Pause. The apprentice asks: *"You moved that one to capex. What made you do that?"* Answer: *"Equipment over five thousand euros is always capex."* Add the asset number. Hold 4472 (Schäfer) and pause: it asks who decides when to release it. Send 4473 (Brno) for approval. Say *"off the record"* once to show trust controls. Post 4474.
2. **Map (60s).** Finish task. The Work Map shows steps, judgment calls and guardrails, each linked to its screen moment and Sabine's own words. Start debrief: it asks 3 open questions, explains the process back, Sabine corrects one detail, confirms.
3. **Teach (60s).** Switch to Teach and play the new hire. Invoice 5102: €7,200 servo motor. They post it on opex. Blocked: *"Sabine would stop here. Why do you think?"* Replay her screen moment, fix to 0400, add an asset number, post. Progress shows mastered vs practise next.
4. **Close.** Export the Work Map as agent-ready guardrails. Moonshot slide.

## The Apprentice Test, answered

1. **When to ask.** Keyboard, mouse and mic activity reset a quiet timer. The agent is told about screen changes silently (`sendContextualUpdate`) and typing is signalled with `sendUserActivity`. It only speaks after a *decision event* (field changed, held, escalated, posted) followed by 2.5 s of no input and no speech. Budget: 5 questions per 10 minutes; the rest are deferred to the debrief.
2. **What to ask.** Questions are about the decision that just happened, never about what the screen shows. If the expert already explained it out loud ("because…", "always…"), the question is skipped. After two reason questions, the next one is forced to be about a guardrail (limit, exception, when to stop and ask).
3. **When it has understood.** Every step needs a reason in the expert's words and a screen moment. Anything missing becomes an open question. The debrief asks at least three, then explains the whole process back. It's done only when the expert says yes; corrections are logged on the map.
4. **Whether the new hire learned.** The tutor uses cases the expert never showed. Guardrails are executable rules checked before every save, so a wrong decision is caught deterministically, then explained in the expert's words. Progress shows mastered / fixed after a hint / practise next.
5. **Trust.** "Off the record" by voice or button pauses capture and mutes the mic. "Forget last 2 minutes" deletes events, transcript and frames. Emails, IBANs and phone numbers are redacted in the browser before anything is stored or sent; the vision prompt also redacts personal data. Raw video is never stored, only events and small thumbnails. Production: swap the regex for Microsoft Presidio.

## Stretch goals

- **Agent-ready guardrails**: *Export for AI agents* turns the Work Map into instructions an agent can load, with a hard stop rule.
- **Any language**: the expert can speak German; quotes are kept in the original and the tutor teaches in English (set the agent's language options).

## Architecture

```
Browser (index.html, app.js)            server.js (Node, no deps)
├─ Sandbox ERP ── DOM events ──┐        ├─ /api/session   → ElevenLabs signed URL
├─ Screen share ── frames ─────┼─────▶  ├─ /api/vision    → Claude: frame → events
├─ Pause detector ─ [PAUSE] ───┤        ├─ /api/workmap   → Claude: events+transcript → Work Map JSON
├─ ElevenLabs agent (voice) ◀──┘        └─ /api/finalize  → Claude: debrief → confirmed Work Map
└─ Rule engine (tutor) ◀── Work Map guardrails
```

Built by Amani Al-Amayreh (founder) during the hackathon, with help from Claude (Anthropic) for coding.
