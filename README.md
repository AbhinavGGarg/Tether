# Nudge

Real-time AI learning intervention system that observes student behavior in a coding workspace, detects confusion/knowledge gaps/inefficiency, and intervenes live with context-aware guidance.

## Why this is different

Nudge is not a passive tutor chatbot. It actively monitors decision-making signals and triggers targeted interventions during the learning process.

## Inspiration synthesis

This MVP combines patterns inspired by:

- **Minerva**: guided micro-lessons and actionable learning path generation.
- **Prereq**: concept dependency graph + prerequisite gap inference.
- **Percepta**: event-loop style real-time behavior sensing and instant contextual feedback.

## Core features

- Real-time coding workspace telemetry:
  - typing speed
  - pause duration
  - repeated edits
  - deletion churn
  - time on problem
- Detection engine for:
  - confusion
  - knowledge gaps tied to prerequisites
  - inefficiency
- OpenAI-powered intervention reasoning (with robust fallback if no API key).
- Live intervention popups with:
  - next best action
  - mini lesson
  - short example
  - quick practice
- Session dashboard with:
  - time wasted
  - struggled concepts
  - prerequisite gaps
  - intervention effectiveness
  - improvement suggestions

## Tech stack

- Frontend: React + Vite + Socket.IO client + Recharts + Framer Motion
- Backend: Node.js + Express + Socket.IO + OpenAI SDK
- Runtime: in-memory session store (hackathon-optimized)

## Project structure

```text
Nudge/
  backend/
    src/
      server.js
      detectionEngine.js
      aiService.js
      knowledgeGraph.js
      sessionStore.js
  frontend/
    src/
      pages/
        WorkspacePage.jsx
        DashboardPage.jsx
      components/
        InterventionPopup.jsx
        FloatingAssistant.jsx
      lib/api.js
      styles.css
  .env.example
  package.json
```

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Set at least:

- `OPENAI_API_KEY` (optional but recommended for live AI reasoning)
- `OPENAI_MODEL` (default `gpt-4.1-mini`)
- `VITE_API_BASE` (default `http://localhost:8787`)

3. Run frontend + backend:

```bash
npm run dev
```

- Frontend: [http://localhost:5173](http://localhost:5173)
- Backend: [http://localhost:8787](http://localhost:8787)

## Demo flow

1. Open workspace and start solving **Sum Even Numbers**.
2. Simulate being stuck:
   - pause for 10+ seconds,
   - make repeated deletions,
   - submit an incorrect attempt.
3. Observe live intervention popup.
4. Click **Apply Support Path** to inject targeted guidance.
5. Continue and submit improved attempt.
6. Click **End Session + Dashboard**.
7. Present outcome metrics and prerequisite gaps.

## API snapshot

- `GET /api/health`
- `GET /api/problems`
- `POST /api/session/start`
- `POST /api/session/attempt`
- `POST /api/session/:sessionId/end`
- `GET /api/session/:sessionId/summary`

Socket events:

- Client -> Server
  - `session:join`
  - `session:metrics`
  - `session:intervention-result`
- Server -> Client
  - `session:joined`
  - `session:signal`
  - `intervention`

## Hackathon notes

- This is optimized for demo impact and responsiveness.
- Detection thresholds are interpretable and easy to tune.
- Current storage is in-memory; production version can swap to Postgres/Redis.

## Chrome extension MVP

Nudge now includes a Chrome extension scaffold in `extension/` that:

- tracks typing/pauses/edit churn on pages you use,
- runs live issue detection in a background worker,
- shows interventions in an on-page floating widget,
- shows live metrics and intervention timeline in the extension popup.

### Load extension locally

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder from this repo.
5. Open any coding/study page and click the Nudge extension icon to see live status.
