import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FloatingAssistant from "../components/FloatingAssistant";
import InterventionPopup from "../components/InterventionPopup";
import { endSession, markInterventionApplied, recordMetrics, startSession } from "../lib/api";

const GRADE_OPTIONS = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"];
const RISK_LEVEL_ORDER = { Low: 1, Moderate: 2, High: 3 };

function WorkspacePage() {
  const navigate = useNavigate();

  const [learnerName, setLearnerName] = useState("");
  const [learnerDraft, setLearnerDraft] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [connected, setConnected] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [startError, setStartError] = useState("");

  const [activeTab, setActiveTab] = useState("live");
  const [gradesInput, setGradesInput] = useState({
    currentGrade: "B+",
    upcomingAssessment: "",
    gradePortalLink: ""
  });
  const [portalStatus, setPortalStatus] = useState("");
  const [riskAdjustment, setRiskAdjustment] = useState(0);
  const [riskTrend, setRiskTrend] = useState("stable");
  const [riskEvents, setRiskEvents] = useState([]);
  const [recoveryPlan, setRecoveryPlan] = useState([]);
  const [priorityTopics, setPriorityTopics] = useState([]);
  const [focusModeRunning, setFocusModeRunning] = useState(false);
  const [focusModeSeconds, setFocusModeSeconds] = useState(60);

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
  const previousRiskScoreRef = useRef(null);
  const previousRiskLevelRef = useRef(null);

  const keyEventsRef = useRef([]);
  const editEventsRef = useRef([]);
  const scrollEventsRef = useRef([]);

  const keystrokesDeltaRef = useRef(0);
  const totalKeystrokesRef = useRef(0);
  const tabSwitchesDeltaRef = useRef(0);
  const scrollDistanceDeltaRef = useRef(0);
  const lastScrollYRef = useRef(window.scrollY || 0);

  const riskState = useMemo(
    () =>
      computeGradesRiskState({
        currentGrade: gradesInput.currentGrade,
        upcomingAssessment: gradesInput.upcomingAssessment,
        signal,
        telemetry,
        context,
        riskAdjustment
      }),
    [gradesInput.currentGrade, gradesInput.upcomingAssessment, signal, telemetry, context, riskAdjustment]
  );

  const combinedTimeline = useMemo(() => {
    return [...timeline, ...riskEvents]
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
      .slice(0, 12);
  }, [timeline, riskEvents]);

  const enrichedActiveIntervention = useMemo(
    () => attachRiskToIntervention(activeIntervention, riskState),
    [activeIntervention, riskState]
  );

  const enrichedAssistantIntervention = useMemo(() => {
    const fallback = interventionHistory[0] || null;
    return attachRiskToIntervention(enrichedActiveIntervention || fallback, riskState);
  }, [enrichedActiveIntervention, interventionHistory, riskState]);

  const addRiskTimelineEvent = useCallback((eventType, label, details) => {
    setRiskEvents((prev) =>
      [
        {
          id: `risk-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          ts: Date.now(),
          eventType,
          label,
          details
        },
        ...prev
      ].slice(0, 30)
    );
  }, []);

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
      previousRiskScoreRef.current = null;
      previousRiskLevelRef.current = null;

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
      setRiskEvents([]);
      setRiskAdjustment(0);
      setRiskTrend("stable");
      setRecoveryPlan([]);
      setPriorityTopics([]);
      setFocusModeRunning(false);
      setFocusModeSeconds(60);
      setPortalStatus("");
      setActiveTab("live");
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

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const previousScore = previousRiskScoreRef.current;
    if (previousScore !== null) {
      if (riskState.score < previousScore - 0.04) {
        setRiskTrend("improving");
      } else if (riskState.score > previousScore + 0.04) {
        setRiskTrend("declining");
      } else {
        setRiskTrend("stable");
      }
    }
    previousRiskScoreRef.current = riskState.score;
  }, [riskState.score, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const previousLevel = previousRiskLevelRef.current;
    if (previousLevel && previousLevel !== riskState.level) {
      const prevValue = RISK_LEVEL_ORDER[previousLevel] || 0;
      const nextValue = RISK_LEVEL_ORDER[riskState.level] || 0;
      if (nextValue > prevValue) {
        addRiskTimelineEvent(
          "risk_level_increased",
          `Risk level increased to ${riskState.level}`,
          "Behavior + grade trend suggests higher academic risk."
        );
      } else if (nextValue < prevValue) {
        addRiskTimelineEvent(
          "risk_level_decreased",
          `Risk level improved to ${riskState.level}`,
          "Recent actions are reducing academic risk."
        );
      }
    }
    previousRiskLevelRef.current = riskState.level;
  }, [addRiskTimelineEvent, riskState.level, sessionId]);

  useEffect(() => {
    if (!focusModeRunning) {
      return;
    }

    const timer = window.setInterval(() => {
      setFocusModeSeconds((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          setFocusModeRunning(false);
          setRiskAdjustment((current) => Math.min(0.45, current + 0.12));
          addRiskTimelineEvent("focus_improved", "Focus improved", "Completed focus mode sprint.");
          setImpactNote("Focus mode completed. Focus improved by 40%.");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [addRiskTimelineEvent, focusModeRunning]);

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

    setImpactNote(
      `Estimated time waste: ~${beforeMinutes}m -> ~${afterMinutes}m (${reduction}% reduction). Current risk: ${riskState.level}.`
    );

    if (action === "refocus_timer") {
      addRiskTimelineEvent("focus_mode_started", "Focus mode started", "Triggered through intervention action.");
      setFocusModeRunning(true);
      setFocusModeSeconds(60);
    }

    if (action === "short_break" || action === "resume_task") {
      setActiveIntervention(null);
    }

    return resolveActionText(intervention, action, update?.intervention);
  }

  function handleAnalyzePortalLink() {
    const parsedGrade = parseGradeFromPortalLink(gradesInput.gradePortalLink);
    if (!gradesInput.gradePortalLink.trim()) {
      setPortalStatus("Add a grade portal link to simulate parsing.");
      return;
    }

    if (parsedGrade) {
      setGradesInput((prev) => ({ ...prev, currentGrade: parsedGrade }));
      setPortalStatus(`Parsed grade signal: ${parsedGrade}`);
      addRiskTimelineEvent("grade_parsed", `Portal grade parsed (${parsedGrade})`, "Grade portal link provided a grade signal.");
    } else {
      setPortalStatus("No grade token found in link. Using your selected grade.");
    }
  }

  function handleRiskAction(action) {
    if (!sessionId) {
      return;
    }

    if (action === "start_focus_mode") {
      if (!focusModeRunning) {
        setFocusModeRunning(true);
        setFocusModeSeconds(60);
        setRiskAdjustment((current) => Math.min(0.45, current + 0.08));
        addRiskTimelineEvent("focus_mode_started", "Focus mode started", "Started a 60-second sprint.");
      }
      return;
    }

    if (action === "create_recovery_plan") {
      const plan = buildRecoveryPlan(riskState, context, gradesInput.upcomingAssessment);
      setRecoveryPlan(plan);
      setRiskAdjustment((current) => Math.min(0.45, current + 0.09));
      addRiskTimelineEvent("recovery_plan_started", "Recovery plan started", "Generated a 3-step recovery plan.");
      return;
    }

    if (action === "show_priority_topics") {
      const topics = buildPriorityTopics(context, signal);
      setPriorityTopics(topics);
      setRiskAdjustment((current) => Math.min(0.45, current + 0.05));
      addRiskTimelineEvent("priority_topics_opened", "Priority topics generated", "Surfaced highest-impact topics.");
    }
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

  const behaviorRiskPct = Math.round(
    Math.max(
      signal.procrastinationScore || 0,
      signal.distractionScore || 0,
      signal.lowFocusScore || 0,
      signal.inefficiencyScore || 0
    ) * 100
  );

  const focusModeProgress = Math.max(0, Math.min(100, Math.round(((60 - focusModeSeconds) / 60) * 100)));

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
        <>
          <section className="module-tabs">
            <button
              className={`module-tab ${activeTab === "live" ? "active" : ""}`}
              onClick={() => setActiveTab("live")}
              type="button"
            >
              Live Interventions
            </button>
            <button
              className={`module-tab ${activeTab === "grades" ? "active" : ""}`}
              onClick={() => setActiveTab("grades")}
              type="button"
            >
              Grades & Risk
            </button>
          </section>

          {activeTab === "live" ? (
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
                    <span style={{ width: `${Math.min(100, behaviorRiskPct)}%` }} />
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
                  {combinedTimeline.length === 0 ? <p>No events yet.</p> : null}
                  {combinedTimeline.map((item) => (
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

          {activeTab === "grades" ? (
            <section className="workspace-grid">
              <article className="panel panel-main">
                <h3>Grades & Risk Intelligence</h3>

                <div className="risk-input-grid">
                  <label className="risk-field">
                    Current grade
                    <select
                      value={gradesInput.currentGrade}
                      onChange={(event) =>
                        setGradesInput((prev) => ({ ...prev, currentGrade: event.target.value }))
                      }
                    >
                      {GRADE_OPTIONS.map((grade) => (
                        <option key={grade} value={grade}>
                          {grade}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="risk-field">
                    Upcoming assessment (optional)
                    <input
                      type="text"
                      value={gradesInput.upcomingAssessment}
                      onChange={(event) =>
                        setGradesInput((prev) => ({ ...prev, upcomingAssessment: event.target.value }))
                      }
                      placeholder="e.g. Calculus Midterm - Apr 4"
                    />
                  </label>

                  <label className="risk-field risk-field-full">
                    Grade portal link (optional)
                    <input
                      type="text"
                      value={gradesInput.gradePortalLink}
                      onChange={(event) =>
                        setGradesInput((prev) => ({ ...prev, gradePortalLink: event.target.value }))
                      }
                      placeholder="Paste grade portal link to simulate parsing"
                    />
                  </label>
                </div>

                <div className="action-row">
                  <button className="btn btn-ghost" onClick={handleAnalyzePortalLink} type="button">
                    Parse Grade Link
                  </button>
                </div>
                {portalStatus ? <p className="monitor-note">{portalStatus}</p> : null}

                <div className="risk-dashboard">
                  <div className="risk-row">
                    <span className={`risk-pill ${riskClassName(riskState.level)}`}>{riskState.level} Risk</span>
                    <span className="risk-score">Risk score: {Math.round(riskState.score * 100)}%</span>
                    <span className={`risk-trend ${riskTrend}`}>Trend: {riskTrend}</span>
                  </div>
                  <p className="risk-outcome">{riskState.predictedOutcome}</p>
                </div>
              </article>

              <aside className="panel panel-side">
                <h3>AI Insight Panel</h3>
                <div className="timeline-box">
                  <p>
                    <strong>What:</strong> {riskState.explanation}
                  </p>
                  <p>
                    <strong>If this continues:</strong> {riskState.consequence}
                  </p>
                  <p>
                    <strong>Recommended next:</strong> {riskState.recommendation}
                  </p>
                </div>

                <div className="risk-actions">
                  <button className="btn btn-primary" onClick={() => handleRiskAction("start_focus_mode")} type="button">
                    Start Focus Mode
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleRiskAction("create_recovery_plan")}
                    type="button"
                  >
                    Create Recovery Plan
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleRiskAction("show_priority_topics")}
                    type="button"
                  >
                    Show Priority Topics
                  </button>
                </div>

                {focusModeRunning ? (
                  <div className="timeline-box">
                    <h4>Focus Mode Running</h4>
                    <p>{focusModeSeconds}s remaining in sprint.</p>
                    <div className="progress-track">
                      <span style={{ width: `${focusModeProgress}%` }} />
                    </div>
                  </div>
                ) : null}

                {recoveryPlan.length > 0 ? (
                  <div className="timeline-box">
                    <h4>Recovery Plan</h4>
                    {recoveryPlan.map((step, index) => (
                      <p key={step}>
                        {index + 1}. {step}
                      </p>
                    ))}
                  </div>
                ) : null}

                {priorityTopics.length > 0 ? (
                  <div className="timeline-box">
                    <h4>Priority Topics</h4>
                    {priorityTopics.map((topic) => (
                      <p key={topic}>• {topic}</p>
                    ))}
                  </div>
                ) : null}
              </aside>
            </section>
          ) : null}
        </>
      ) : null}

      {sessionId ? (
        <FloatingAssistant
          context={context}
          signal={signal}
          intervention={enrichedAssistantIntervention}
          sessionId={sessionId}
        />
      ) : null}

      {sessionId && context.activityType !== "none_detected" ? (
        <InterventionPopup intervention={enrichedActiveIntervention} onAction={handleInterventionAction} />
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

function computeGradesRiskState({ currentGrade, upcomingAssessment, signal, telemetry, context, riskAdjustment }) {
  const gradeRisk = gradeToRisk(currentGrade);
  const behaviorRisk = Math.max(
    signal.procrastinationScore || 0,
    signal.distractionScore || 0,
    signal.lowFocusScore || 0,
    signal.inefficiencyScore || 0
  );
  const wastedMinutes = estimateWastedMinutes(signal, telemetry);
  const wastedRisk = clamp01(wastedMinutes / 18);

  const activitySignal = clamp01(
    (Math.min(1.2, telemetry.typingSpeed || 0) / 1.2) * 0.55 +
      (1 - clamp01((telemetry.idleDurationMs || 0) / 45000)) * 0.45
  );
  const activityPenalty = clamp01(1 - activitySignal);

  const rawScore = gradeRisk * 0.36 + behaviorRisk * 0.34 + wastedRisk * 0.2 + activityPenalty * 0.1 - riskAdjustment;
  const score = clamp01(rawScore);

  let level = "Low";
  if (score >= 0.65) {
    level = "High";
  } else if (score >= 0.38) {
    level = "Moderate";
  }

  let predictedOutcome = `Your current pattern supports steady performance around ${currentGrade}.`;
  if (level === "Moderate") {
    predictedOutcome = `Based on your current grade (${currentGrade}) and recent behavior, continued interruptions may lower your next assessment performance.`;
  }
  if (level === "High") {
    predictedOutcome = `Your current pace suggests incomplete coverage before ${upcomingAssessment || "your next assessment"} unless focus stabilizes.`;
  }

  const explanation = `Current grade signal (${currentGrade}) plus ${context.activityType} behavior indicates ${level.toLowerCase()} academic risk.`;
  const consequence =
    level === "Low"
      ? "You are on track if consistency continues."
      : level === "Moderate"
        ? "Retention may drop and prep quality may become uneven."
        : "Key topics may remain under-practiced before your next graded check.";
  const recommendation =
    level === "Low"
      ? "Keep short focus blocks and checkpoint one takeaway each cycle."
      : level === "Moderate"
        ? "Use a focus sprint, then complete one targeted review block."
        : "Start a recovery plan now and prioritize high-impact topics first.";

  return {
    score,
    level,
    gradeLabel: currentGrade,
    predictedOutcome,
    explanation,
    consequence,
    recommendation
  };
}

function attachRiskToIntervention(intervention, riskState) {
  if (!intervention) {
    return null;
  }

  const whatBase = intervention.what || intervention.message || "";
  const whyBase = intervention.why || intervention.reason || "";
  const riskLine = `You are currently at ${riskState.level.toLowerCase()} risk based on your grade and session behavior.`;

  return {
    ...intervention,
    what: whatBase.includes("currently at") ? whatBase : `${whatBase} ${riskLine}`.trim(),
    why: whyBase.includes("grade") ? whyBase : `${whyBase} Current grade signal: ${riskState.gradeLabel}.`.trim()
  };
}

function buildRecoveryPlan(riskState, context, upcomingAssessment) {
  const target = upcomingAssessment || "next assessment";
  return [
    "Focus for 10 minutes on one objective with no tab switching.",
    `Review high-impact material in ${context.activityType === "none_detected" ? "your current course" : context.activityType}.`,
    `Attempt 1 practice problem and check progress before ${target}.`,
    `Apply the recommendation: ${riskState.recommendation}`
  ];
}

function buildPriorityTopics(context, signal) {
  const baseTopics = {
    coding: ["Core algorithms", "Debugging workflow", "Test case design"],
    writing: ["Thesis clarity", "Structure flow", "Evidence support"],
    studying: ["Active recall", "Concept mapping", "Practice questions"],
    watching: ["Key takeaways", "Action notes", "Checkpoint summaries"],
    reading: ["Main argument extraction", "Retention notes", "Decision checkpoints"],
    none_detected: ["Current assignment goals", "Upcoming test scope", "High-weight topics"]
  };

  const activity = context.activityType || "none_detected";
  const topics = baseTopics[activity] || baseTopics.none_detected;
  const issueHint = signal.issueType ? `Intervention target: ${signal.issueType.replaceAll("_", " ")}` : "No active issue";
  return [...topics, issueHint].slice(0, 4);
}

function gradeToRisk(grade) {
  const map = {
    A: 0.12,
    "A-": 0.18,
    "B+": 0.26,
    B: 0.34,
    "B-": 0.42,
    "C+": 0.52,
    C: 0.61,
    "C-": 0.68,
    D: 0.79,
    F: 0.92
  };
  return map[grade] ?? 0.4;
}

function riskClassName(level) {
  if (level === "Low") {
    return "low";
  }
  if (level === "Moderate") {
    return "moderate";
  }
  return "high";
}

function parseGradeFromPortalLink(link) {
  const clean = String(link || "").trim();
  if (!clean) {
    return null;
  }

  try {
    const parsed = new URL(clean);
    const gradeToken = parsed.searchParams.get("grade");
    if (GRADE_OPTIONS.includes(gradeToken)) {
      return gradeToken;
    }
  } catch {
    // Ignore parse failure and continue with regex extraction.
  }

  const match = clean.match(/\b(A-|A|B\+|B-|B|C\+|C-|C|D|F)\b/i);
  if (!match) {
    return null;
  }

  const normalized = match[1].toUpperCase();
  return GRADE_OPTIONS.includes(normalized) ? normalized : null;
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

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export default WorkspacePage;
