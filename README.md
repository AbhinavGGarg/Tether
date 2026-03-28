# Nudge

Real-time AI learning intervention system that observes behavior, detects risk patterns, and intervenes live with context-aware guidance.

## The Problem

Procrastination is a huge unsolved problem that affects many high school and college students today. Most learning tools are passive and only react after performance drops.

Nudge is built to intervene in the moment.

## What Nudge Does

Nudge monitors live work behavior across coding, studying, writing, and browsing contexts, then detects:

- distraction / inactivity
- low focus
- procrastination patterns
- inefficiency loops

When risk is detected, it triggers actionable interventions in real time.

## Why This Is Different

Nudge is not a passive tutor chatbot.

It is a behavior-first intervention system that:

- senses what is happening now
- explains why risk is increasing
- proposes the best next action
- tracks whether the action improved outcomes

## Core Features

- Context-aware behavior tracking:
  - typing speed
  - pause duration
  - idle duration
  - repeated actions / edit churn
  - tab switches
  - scroll behavior
  - time on task
- Strict inactivity detection:
  - 90s no activity trigger
  - "Distraction / Inactivity" intervention
  - 3-minute follow-up reminder when ignored
- Live intervention actions:
  - Lock In (2 min focus)
  - Resume Task
  - Ignore
  - Break into Steps
  - Try New Approach
- Grades & Risk module:
  - baseline grade + 6 course-grade slots
  - risk scoring and trend
  - outcome prediction
  - recovery actions
- Smart Nudges module:
  - notification mode control
  - reminder log
  - SMS reminder simulation
- Session dashboard:
  - intervention history
  - timeline
  - focus/risk improvement metrics

## Tech Stack

- Frontend: React + Vite + Recharts
- Backend: Node.js + Express + OpenAI SDK
- Extension: Chrome Extension (Manifest V3)
- Runtime storage: in-memory/local storage (hackathon optimized)

## Project Structure

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
      lib/api.js
      styles.css
    vercel.json
  extension/
    manifest.json
    icons/
      nudge-128.png
    src/
      background.js
      content.js
      popup.html
      popup.js
  .env.example
  package.json
```

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Configure environment

```bash
cp .env.example .env
```

Set at least:

- `OPENAI_API_KEY` (optional, recommended)
- `OPENAI_MODEL` (default `gpt-4.1-mini`)
- `PORT` (default `8787`)
- `CLIENT_ORIGIN` (default `http://localhost:5173`)
- `VITE_API_BASE` (default `http://localhost:8787`)

3. Run frontend + backend

```bash
npm run dev
```

- Frontend: [http://localhost:5173](http://localhost:5173)
- Backend: [http://localhost:8787](http://localhost:8787)

## Demo Flow

1. Start a session from the homepage.
2. Work normally for 20–30 seconds.
3. Stop all activity for ~90 seconds.
4. Observe "Distraction / Inactivity" intervention + notification.
5. Click **Lock In (2 min focus)**.
6. Watch risk/focus improve in timeline and dashboard.

## Backend API Snapshot

- `GET /api/health`
- `GET /api/context/profiles`
- `POST /api/session/start`
- `POST /api/session/:sessionId/metrics`
- `POST /api/session/:sessionId/intervention-action`
- `POST /api/session/:sessionId/end`
- `GET /api/session/:sessionId/summary`

## Chrome Extension MVP

The extension in `extension/` can:

- monitor behavior directly on websites,
- run live detection in a background worker,
- show interventions in an on-page floating widget,
- show metrics/timeline in popup view.

### Load Extension Locally

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `extension` folder
5. Reload any target tab

## Notification + SMS Notes

- Browser notifications are real when permission is granted.
- SMS is currently a simulation log (for hackathon demo flow).
- Production SMS can be added with Twilio in a backend worker.
