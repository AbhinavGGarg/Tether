import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FloatingAssistant from "../components/FloatingAssistant";
import InterventionPopup from "../components/InterventionPopup";
import { endSession, markInterventionApplied, recordMetrics, startSession } from "../lib/api";

function WorkspacePage() {
  const navigate = useNavigate();

  const [learnerName, setLearnerName] = useState("");
  const [learnerDraft, setLearnerDraft] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [connected, setConnected] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [startError, setStartError] = useState("");

  const [context, setContext] = useState({
    domain: window.location.hostname,
    category: "unknown",
    activityType: "none_detected",
    confidence: 0
  });

  const [signal, setSignal] = useState({
    issueType: null,
    issueSeverity: null,
    procrastinationScore: 0,
    distractionScore: 0,
    lowFocusScore: 0,
    inefficiencyScore: 0,
    focusScore: 72,
    focusImprovementPct: 0
  });

  const [telemetry, setTelemetry] = useState({
    typingSpeed: 0,
    idleDurationMs: 0,
    pauseDurationMs: 0,
    repeatedActions: 0,
    deletionRate: 0,
    scrollSpeed: 0,
    tabSwitchesDelta: 0,
    timeOnTaskMs: 0,
    totalKeystrokes: 0
  });

  const [activeIntervention, setActiveIntervention] = useState(null);
  const [interventionHistory, setInterventionHistory] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [impactNote, setImpactNote] = useState("No intervention impact yet.");

  const sessionStartRef = useRef(Date.now());
  const lastInputRef = useRef(Date.now());
  const lastInteractionRef = useRef(Date.now());

  const keyEventsRef = useRef([]);
  const editEventsRef = useRef([]);
  const scrollEventsRef = useRef([]);

  const keystrokesDeltaRef = useRef(0);
  const totalKeystrokesRef = useRef(0);
  const tabSwitchesDeltaRef = useRef(0);
  const scrollDistanceDeltaRef = useRef(0);
  const lastScrollYRef = useRef(window.scrollY || 0);

  async function handleCreateSession() {
    const cleanName = learnerDraft.trim();
    if (!cleanName) {
      setStartError("Enter a learner name to begin.");
      return;
    }

    setStartingSession(true);
    setStartError("");

    try {
      const sessionResponse = await startSession(cleanName);
      setSessionId(sessionResponse.sessionId);
      setLearnerName(cleanName);
      setConnected(true);

      sessionStartRef.current = Date.now();
      lastInputRef.current = Date.now();
      lastInteractionRef.current = Date.now();

      keyEventsRef.current = [];
      editEventsRef.current = [];
      scrollEventsRef.current = [];
      keystrokesDeltaRef.current = 0;
      totalKeystrokesRef.current = 0;
      tabSwitchesDeltaRef.current = 0;
      scrollDistanceDeltaRef.current = 0;
      lastScrollYRef.current = window.scrollY || 0;

      setSignal({
        issueType: null,
        issueSeverity: null,
        procrastinationScore: 0,
        distractionScore: 0,
        lowFocusScore: 0,
        inefficiencyScore: 0,
        focusScore: 72,
        focusImprovementPct: 0
      });
      setImpactNote("No intervention impact yet.");
      setActiveIntervention(null);
      setInterventionHistory([]);
      setTimeline([]);
    } catch {
      setStartError("Could not start session. Try again.");
    } finally {
      setStartingSession(false);
    }
  }

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      const tenSecondsAgo = now - 10000;
      const twentySecondsAgo = now - 20000;

      keyEventsRef.current = keyEventsRef.current.filter((ts) => ts >= tenSecondsAgo);
      editEventsRef.current = editEventsRef.current.filter((event) => event.ts >= twentySecondsAgo);
      scrollEventsRef.current = scrollEventsRef.current.filter((event) => event.ts >= tenSecondsAgo);

      const repeatedEdits = editEventsRef.current.filter((event) => event.type === "delete").length;
      const insertCount = editEventsRef.current.filter((event) => event.type === "insert").length;
      const deleteCount = repeatedEdits;
      const scrollDistanceRecent = scrollEventsRef.current.reduce((sum, event) => sum + event.delta, 0);
      const scrollBursts = scrollEventsRef.current.filter((event) => event.delta > 140).length;

      const metrics = {
        typingSpeed: Number((keyEventsRef.current.length / 10).toFixed(2)),
        pauseDurationMs: now - lastInputRef.current,
        idleDurationMs: now - lastInteractionRef.current,
        repeatedEdits,
        repeatedActions: repeatedEdits + Math.floor(scrollBursts / 2),
        deletionRate: Number((deleteCount / Math.max(1, insertCount + deleteCount)).toFixed(2)),
        scrollSpeed: Number((scrollDistanceRecent / 10).toFixed(2)),
        scrollBursts,
        scrollDistance: Math.round(scrollDistanceDeltaRef.current),
        tabSwitchesDelta: tabSwitchesDeltaRef.current,
        timeOnTaskMs: now - sessionStartRef.current,
        keystrokesDelta: keystrokesDeltaRef.current,
        pageTitle: document.title,
        url: window.location.href,
        contextSample: `${document.title}\n${extractWorkingText().slice(0, 280)}`,
        pageTextSample: extractPageTextSample(),
        hasVideo: Boolean(document.querySelector("video")),
        hasEditable: Boolean(hasEditableSurface())
      };

      const realtime = recordMetrics(sessionId, metrics);

      if (realtime?.signal) {
        setSignal(realtime.signal);
      }
      if (realtime?.context) {
        setContext(realtime.context);
        if (realtime.context.activityType === "none_detected") {
          setActiveIntervention(null);
        }
      }
      if (realtime?.timeline) {
        setTimeline(realtime.timeline);
      }

      if (realtime?.intervention) {
        setActiveIntervention(realtime.intervention);
        setInterventionHistory((prev) => {
          if (prev.some((item) => item.id === realtime.intervention.id)) {
            return prev;
          }
          return [realtime.intervention, ...prev].slice(0, 8);
        });
      }

      setTelemetry({
        typingSpeed: metrics.typingSpeed,
        idleDurationMs: metrics.idleDurationMs,
        pauseDurationMs: metrics.pauseDurationMs,
        repeatedActions: metrics.repeatedActions,
        deletionRate: metrics.deletionRate,
        scrollSpeed: metrics.scrollSpeed,
        tabSwitchesDelta: metrics.tabSwitchesDelta,
        timeOnTaskMs: metrics.timeOnTaskMs,
        totalKeystrokes: totalKeystrokesRef.current
      });

      keystrokesDeltaRef.current = 0;
      tabSwitchesDeltaRef.current = 0;
      scrollDistanceDeltaRef.current = 0;
    }, 2000);

    return () => clearInterval(timer);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    function onKeyDown(event) {
      const trackable = event.key.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(event.key);
      if (!trackable) {
        return;
      }

      const now = Date.now();
      keyEventsRef.current.push(now);
      lastInputRef.current = now;
      lastInteractionRef.current = now;
      keystrokesDeltaRef.current += 1;
      totalKeystrokesRef.current += 1;

      if (event.key === "Backspace" || event.key === "Delete") {
        editEventsRef.current.push({ ts: now, type: "delete" });
      } else {
        editEventsRef.current.push({ ts: now, type: "insert" });
      }
    }

    function onScroll() {
      const now = Date.now();
      const currentY = window.scrollY || 0;
      const delta = Math.abs(currentY - lastScrollYRef.current);
      lastScrollYRef.current = currentY;
      scrollEventsRef.current.push({ ts: now, delta });
      scrollDistanceDeltaRef.current += delta;
      lastInteractionRef.current = now;
    }

    function onPointerDown() {
      lastInteractionRef.current = Date.now();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        tabSwitchesDeltaRef.current += 1;
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("visibilitychange", onVisibilityChange, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange, true);
    };
  }, [sessionId]);

  function handleInterventionAction(intervention, action) {
    if (!intervention || !sessionId) {
      return "";
    }

    const update = markInterventionApplied(sessionId, intervention.id, action);

    if (update?.signal) {
      setSignal(update.signal);
    }
    if (update?.timeline) {
      setTimeline(update.timeline);
    }

    setInterventionHistory((prev) =>
      prev.map((item) =>
        item.id === intervention.id
          ? {
              ...item,
              userAction: action,
              improvementNote: update?.intervention?.improvementNote || item.improvementNote
            }
          : item
      )
    );

    const beforeMinutes = estimateWastedMinutes(signal, telemetry);
    const improvementMap = {
      refocus_timer: 0.4,
      break_steps: 0.25,
      try_new_approach: 0.22,
      short_break: 0.18,
      resume_task: 0.2
    };

    const reductionWeight = improvementMap[action] || 0.2;
    const afterMinutes = Math.max(1, Math.round(beforeMinutes * (1 - reductionWeight)));
    const reduction = Math.max(0, Math.round(((beforeMinutes - afterMinutes) / Math.max(1, beforeMinutes)) * 100));

    setImpactNote(`Estimated time waste: ~${beforeMinutes}m -> ~${afterMinutes}m (${reduction}% reduction)`);

    if (action === "short_break" || action === "resume_task") {
      setActiveIntervention(null);
    }

    return resolveActionText(intervention, action, update?.intervention);
  }

  async function goToDashboard() {
    if (!sessionId) {
      return;
    }

    await endSession(sessionId);
    navigate(`/dashboard/${sessionId}`);
  }

  function openLiveResults() {
    if (!sessionId) {
      return;
    }
    window.open(`/dashboard/${sessionId}`, "_blank", "noopener,noreferrer");
  }

  const issueLabel = signal.issueType
    ? `${signal.issueType.replaceAll("_", " ")} (${signal.issueSeverity || "low"})`
    : "No active issue";

  const riskPct = Math.round(
    Math.max(
      signal.procrastinationScore || 0,
      signal.distractionScore || 0,
      signal.lowFocusScore || 0,
      signal.inefficiencyScore || 0
    ) * 100
  );

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <h1>Nudge</h1>
          <p>Context-aware real-time AI intervention system</p>
        </div>
        <div className="status-cluster">
          <span className={`status-pill ${connected ? "online" : "offline"}`}>
            {connected ? "Live Monitoring" : "Session not started"}
          </span>
          {learnerName ? <span className="status-pill online">Operator: {learnerName}</span> : null}
          {sessionId ? (
            <button className="btn btn-ghost" onClick={openLiveResults}>
              View your real live results
            </button>
          ) : null}
          {sessionId ? (
            <button className="btn btn-primary" onClick={goToDashboard}>
              End Session + Dashboard
            </button>
          ) : null}
        </div>
      </header>

      {!sessionId ? (
        <section className="panel">
          <h3>Create Operator Session</h3>
          <p>Start a session to run live detection, interventions, and impact tracking.</p>
          <div className="action-row">
            <input
              value={learnerDraft}
              onChange={(event) => setLearnerDraft(event.target.value)}
              placeholder="Operator name"
              className="session-input"
            />
            <button className="btn btn-primary" onClick={handleCreateSession} disabled={startingSession}>
              {startingSession ? "Starting..." : "Start Session"}
            </button>
          </div>
          {startError ? <p className="start-error">{startError}</p> : null}
        </section>
      ) : null}

      {sessionId ? (
        <section className="workspace-grid">
          <article className="panel panel-main">
            <h3>Live Context Engine</h3>

            <div className="timeline-box">
              <h4>Live Page Source</h4>
              <p>{window.location.href}</p>
              <p style={{ marginTop: 8 }}>
                {context.activityType === "none_detected"
                  ? "No supported context detected on this site yet."
                  : "Context detected from your current page and live behavior."}
              </p>
            </div>

            <div className="metric-grid">
              <Metric label="Activity" value={context.activityType} />
              <Metric label="Category" value={context.category} />
              <Metric label="Domain" value={context.domain} />
              <Metric label="Confidence" value={`${Math.round((context.confidence || 0) * 100)}%`} />
              <Metric label="Focus score" value={`${Math.round(signal.focusScore || 0)}%`} />
              <Metric label="Typing speed" value={`${telemetry.typingSpeed} keys/s`} />
              <Metric label="Idle" value={`${Math.round(telemetry.idleDurationMs / 1000)}s`} />
              <Metric label="Pause" value={`${Math.round(telemetry.pauseDurationMs / 1000)}s`} />
              <Metric label="Repeated actions" value={telemetry.repeatedActions} />
              <Metric label="Scroll speed" value={`${Math.round(telemetry.scrollSpeed)} px/s`} />
              <Metric label="Tab switches" value={telemetry.tabSwitchesDelta} />
              <Metric label="Time on task" value={`${Math.round(telemetry.timeOnTaskMs / 1000)}s`} />
            </div>

            <div className="signal-box">
              <h4>Current Issue</h4>
              <p>{issueLabel}</p>
              <div className="progress-track">
                <span style={{ width: `${Math.min(100, riskPct)}%` }} />
              </div>
            </div>

            <div className="impact-box">
              <h4>Impact System</h4>
              <p>{impactNote}</p>
            </div>
          </article>

          <aside className="panel panel-side">
            <h3>Decision Timeline</h3>
            <div className="timeline-box">
              {timeline.length === 0 ? <p>No events yet.</p> : null}
              {timeline.map((item) => (
                <div key={item.id} className="timeline-item">
                  <span>{formatEventType(item.eventType)}</span>
                  <p>{item.label}</p>
                </div>
              ))}
            </div>

            <div className="timeline-box">
              <h4>Intervention History</h4>
              {interventionHistory.length === 0 ? <p>No interventions yet.</p> : null}
              {interventionHistory.map((item) => (
                <div key={item.id} className="timeline-item">
                  <span>{item.type.replaceAll("_", " ")}</span>
                  <p>{item.what || item.message}</p>
                  {item.userAction ? <p>Action: {item.userAction.replaceAll("_", " ")}</p> : null}
                  {item.improvementNote ? <p>{item.improvementNote}</p> : null}
                </div>
              ))}
            </div>
          </aside>
        </section>
      ) : null}

      {sessionId ? (
        <FloatingAssistant
          context={context}
          signal={signal}
          intervention={activeIntervention || interventionHistory[0]}
          sessionId={sessionId}
        />
      ) : null}

      {sessionId && context.activityType !== "none_detected" ? (
        <InterventionPopup intervention={activeIntervention} onAction={handleInterventionAction} />
      ) : null}
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function resolveActionText(intervention, action, updatedIntervention) {
  const payloads = intervention.actionPayloads || {};

  if (updatedIntervention?.improvementNote) {
    return `${payloads[action] || intervention.nextAction} ${updatedIntervention.improvementNote}`;
  }

  return payloads[action] || intervention.nextAction;
}

function estimateWastedMinutes(signal, telemetry) {
  const friction = Math.max(
    signal.procrastinationScore || 0,
    signal.distractionScore || 0,
    signal.lowFocusScore || 0,
    signal.inefficiencyScore || 0
  );

  const base = Math.max(2, Math.round((telemetry.timeOnTaskMs || 0) / 60000));
  return Math.max(1, Math.round(base * (0.6 + friction)));
}

function extractPageTextSample() {
  const candidate =
    document.querySelector("main") || document.querySelector("article") || document.querySelector("section") || document.body;
  const text = (candidate?.innerText || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 700);
}

function extractWorkingText() {
  const active = document.activeElement;

  if (active instanceof HTMLTextAreaElement) {
    return active.value || "";
  }

  if (active instanceof HTMLInputElement) {
    const type = (active.type || "text").toLowerCase();
    if (["text", "search", "url", "email", "number"].includes(type)) {
      return active.value || "";
    }
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    return active.textContent || "";
  }

  return "";
}

function hasEditableSurface() {
  return Boolean(
    document.querySelector(
      "textarea, [contenteditable='true'], input[type='text'], input[type='search'], input:not([type])"
    )
  );
}

function formatEventType(eventType) {
  return String(eventType || "event").replaceAll("_", " ");
}

export default WorkspacePage;
