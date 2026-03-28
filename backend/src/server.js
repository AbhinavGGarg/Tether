import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import { generateIntervention } from "./aiService.js";
import { buildSignal, classifyContext, detectIssue, normalizeMetrics } from "./detectionEngine.js";
import { CONTEXT_PROFILES } from "./knowledgeGraph.js";
import { SessionStore } from "./sessionStore.js";

dotenv.config({ path: new URL("../../.env", import.meta.url) });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8787);
const clientOrigin = process.env.CLIENT_ORIGIN || "*";

const store = new SessionStore();

app.use(cors({ origin: clientOrigin === "*" ? true : clientOrigin }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "Nudge backend", version: "3.0.0" });
});

app.get("/api/context/profiles", (_req, res) => {
  res.json({ profiles: CONTEXT_PROFILES });
});

app.post("/api/session/start", (req, res) => {
  const learnerName = req.body?.learnerName || req.body?.operatorName || "Operator";
  const session = store.createSession(learnerName);

  res.json({
    sessionId: session.id,
    startedAt: session.startedAt,
    context: session.lastContext,
    signal: session.lastSignal
  });
});

app.post("/api/session/:sessionId/end", (req, res) => {
  const { sessionId } = req.params;
  const session = store.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  store.endSession(sessionId);
  return res.json({ ok: true });
});

app.post("/api/session/:sessionId/metrics", async (req, res) => {
  const { sessionId } = req.params;
  const session = store.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const metrics = normalizeMetrics(req.body?.metrics || req.body || {});
  const context = classifyContext(metrics);
  const updated = store.ingestMetrics(sessionId, metrics, context);

  if (!updated) {
    return res.status(404).json({ error: "Session not found" });
  }

  const issue = detectIssue(updated, metrics, context);
  const signal = buildSignal(issue);
  store.setSignal(sessionId, signal);

  let intervention = null;

  if (issue) {
    store.recordIssue(sessionId, issue);

    if (store.canEmitIntervention(sessionId, issue.type)) {
      const generated = await generateIntervention({
        issue,
        context,
        metrics,
        sessionSnapshot: updated
      });

      intervention = store.addIntervention(sessionId, {
        type: issue.type,
        severity: issue.severity,
        reason: issue.reason,
        diagnostics: issue.diagnostics,
        contextCategory: context.category,
        activityType: context.activityType,
        ...generated
      });
    }
  }

  const latest = store.getSession(sessionId);

  return res.json({
    ok: true,
    signal: latest?.lastSignal,
    context: latest?.lastContext,
    intervention,
    timeline: latest?.timeline.slice(0, 8) || []
  });
});

app.post("/api/session/:sessionId/intervention-action", (req, res) => {
  const { sessionId } = req.params;
  const { interventionId, action } = req.body || {};

  const session = store.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  if (!interventionId) {
    return res.status(400).json({ error: "interventionId is required" });
  }

  const intervention = store.markInterventionAction(sessionId, interventionId, action);
  const latest = store.getSession(sessionId);

  return res.json({
    ok: true,
    intervention,
    signal: latest?.lastSignal,
    context: latest?.lastContext,
    timeline: latest?.timeline.slice(0, 8) || []
  });
});

app.get("/api/session/:sessionId/summary", (req, res) => {
  const summary = store.getSummary(req.params.sessionId);
  if (!summary) {
    return res.status(404).json({ error: "Session not found" });
  }

  return res.json(summary);
});

app.listen(port, () => {
  console.log(`Nudge backend running at http://localhost:${port}`);
});
