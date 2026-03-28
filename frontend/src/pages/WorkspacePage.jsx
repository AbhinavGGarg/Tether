import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FloatingAssistant from "../components/FloatingAssistant";
import InterventionPopup from "../components/InterventionPopup";
import {
  endSession,
  fetchProblems,
  isRemoteMode,
  markInterventionApplied,
  recordMetrics,
  startSession,
  submitAttempt
} from "../lib/api";

const DEFAULT_MASTERY = {
  variables: 0.7,
  functions: 0.66,
  loops: 0.58,
  conditionals: 0.62,
  arrays: 0.68,
  recursion: 0.4
};

function WorkspacePage() {
  const navigate = useNavigate();

  const [learnerName, setLearnerName] = useState("Ava Chen");
  const [sessionId, setSessionId] = useState("");
  const [connected, setConnected] = useState(!isRemoteMode());
  const [problems, setProblems] = useState([]);
  const [selectedProblemId, setSelectedProblemId] = useState("");
  const [answer, setAnswer] = useState("");
  const [attemptResult, setAttemptResult] = useState(null);
  const [signal, setSignal] = useState({ issueType: null, issueSeverity: null, confusionScore: 0 });
  const [telemetry, setTelemetry] = useState({
    typingSpeed: 0,
    pauseDurationMs: 0,
    repeatedEdits: 0,
    deletionRate: 0,
    complexityScore: 0,
    timeOnProblemMs: 0,
    totalKeystrokes: 0
  });
  const [activeIntervention, setActiveIntervention] = useState(null);
  const [interventionHistory, setInterventionHistory] = useState([]);
  const [masteryMap, setMasteryMap] = useState(DEFAULT_MASTERY);

  const sessionStartRef = useRef(Date.now());
  const problemStartRef = useRef(Date.now());
  const lastInputRef = useRef(Date.now());
  const keyEventsRef = useRef([]);
  const editEventsRef = useRef([]);
  const keystrokesSinceSendRef = useRef(0);
  const totalKeystrokesRef = useRef(0);
  const currentTextRef = useRef("");

  const selectedProblem = useMemo(
    () => problems.find((problem) => problem.id === selectedProblemId) || null,
    [problems, selectedProblemId]
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const [problemResponse, sessionResponse] = await Promise.all([
        fetchProblems(),
        startSession(learnerName || "Demo Student")
      ]);

      if (cancelled) {
        return;
      }

      const list = problemResponse?.problems || [];
      setProblems(list);
      setSessionId(sessionResponse.sessionId);
      sessionStartRef.current = Date.now();
      setConnected(true);

      if (list[0]) {
        setSelectedProblemId(list[0].id);
        setAnswer("");
        currentTextRef.current = "";
      }
    }

    boot().catch((error) => {
      console.error(error);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !selectedProblemId) {
      return;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      const tenSecondsAgo = now - 10000;
      const twentySecondsAgo = now - 20000;

      keyEventsRef.current = keyEventsRef.current.filter((ts) => ts >= tenSecondsAgo);
      editEventsRef.current = editEventsRef.current.filter((event) => event.ts >= twentySecondsAgo);

      const pauseDurationMs = now - lastInputRef.current;
      const repeatedEdits = editEventsRef.current.filter((event) => event.type === "delete").length;
      const insertCount = editEventsRef.current.filter((event) => event.type === "insert").length;
      const deleteCount = repeatedEdits;
      const typingSpeed = Number((keyEventsRef.current.length / 10).toFixed(2));
      const deletionRate = Number((deleteCount / Math.max(1, insertCount + deleteCount)).toFixed(2));
      const complexityScore = estimateComplexity(answer);
      const nestedLoopSignals = /(for|while)[\s\S]{0,120}(for|while)/i.test(answer) ? 1 : 0;
      const timeOnProblemMs = now - problemStartRef.current;

      const metrics = {
        problemId: selectedProblemId,
        typingSpeed,
        pauseDurationMs,
        repeatedEdits,
        deletionRate,
        complexityScore,
        nestedLoopSignals,
        timeOnProblemMs,
        keystrokesDelta: keystrokesSinceSendRef.current
      };

      const realtime = recordMetrics(sessionId, metrics);
      if (realtime?.signal) {
        setSignal(realtime.signal);
      }
      if (realtime?.intervention) {
        setActiveIntervention(realtime.intervention);
        setInterventionHistory((prev) => [realtime.intervention, ...prev].slice(0, 6));
      }

      setTelemetry({
        typingSpeed,
        pauseDurationMs,
        repeatedEdits,
        deletionRate,
        complexityScore,
        timeOnProblemMs,
        totalKeystrokes: totalKeystrokesRef.current
      });

      keystrokesSinceSendRef.current = 0;
    }, 2000);

    return () => clearInterval(timer);
  }, [answer, selectedProblemId, sessionId]);

  useEffect(() => {
    if (!selectedProblem) {
      return;
    }

    setAnswer("");
    setAttemptResult(null);
    currentTextRef.current = "";
    problemStartRef.current = Date.now();
    lastInputRef.current = Date.now();
    keyEventsRef.current = [];
    editEventsRef.current = [];
    keystrokesSinceSendRef.current = 0;
  }, [selectedProblem]);

  function handleKeyDown(event) {
    const trackable = event.key.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(event.key);
    if (!trackable) {
      return;
    }

    const now = Date.now();
    keyEventsRef.current.push(now);
    lastInputRef.current = now;
    keystrokesSinceSendRef.current += 1;
    totalKeystrokesRef.current += 1;

    if (event.key === "Backspace" || event.key === "Delete") {
      editEventsRef.current.push({ ts: now, type: "delete" });
    }
  }

  function handleAnswerChange(event) {
    const nextValue = event.target.value;
    const now = Date.now();
    const prevLength = currentTextRef.current.length;

    if (nextValue.length > prevLength) {
      editEventsRef.current.push({ ts: now, type: "insert" });
    } else if (nextValue.length < prevLength) {
      editEventsRef.current.push({ ts: now, type: "delete" });
    }

    currentTextRef.current = nextValue;
    lastInputRef.current = now;
    setAnswer(nextValue);
  }

  async function handleSubmitAttempt() {
    if (!sessionId || !selectedProblemId) {
      return;
    }

    const result = await submitAttempt({
      sessionId,
      problemId: selectedProblemId,
      answer
    });

    setAttemptResult(result);

    if (result.mastery) {
      setMasteryMap(result.mastery);
    }
  }

  function applyIntervention(intervention) {
    if (!intervention) {
      return;
    }

    markInterventionApplied(sessionId, intervention.id);

    setAnswer((prev) => `${prev}\n\n// Intervention hint:\n// ${intervention.nextAction}\n// ${intervention.shortExample}`);
    setActiveIntervention(null);
  }

  function dismissIntervention() {
    setActiveIntervention(null);
  }

  async function goToDashboard() {
    if (!sessionId) {
      return;
    }

    await endSession(sessionId);
    navigate(`/dashboard/${sessionId}`);
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <h1>Nudge</h1>
          <p>Real-time intervention system for coding cognition</p>
        </div>
        <div className="status-cluster">
          <label className="name-input-wrap">
            Learner
            <input value={learnerName} onChange={(event) => setLearnerName(event.target.value)} />
          </label>
          <span className={`status-pill ${connected ? "online" : "offline"}`}>
            {connected ? "Live Monitoring" : "Starting"}
          </span>
          <button className="btn btn-primary" onClick={goToDashboard}>
            End Session + Dashboard
          </button>
        </div>
      </header>

      <section className="workspace-grid">
        <article className="panel panel-main">
          <div className="problem-tabs">
            {problems.map((problem) => (
              <button
                key={problem.id}
                className={`problem-chip ${problem.id === selectedProblemId ? "active" : ""}`}
                onClick={() => setSelectedProblemId(problem.id)}
              >
                <span>{problem.title}</span>
                <small>{problem.difficulty}</small>
              </button>
            ))}
          </div>

          <textarea
            className="code-editor"
            value={answer}
            onChange={handleAnswerChange}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />

          <div className="action-row">
            <button className="btn btn-primary" onClick={handleSubmitAttempt}>
              Check Attempt
            </button>
            {attemptResult ? (
              <span className={`attempt-badge ${attemptResult.isCorrect ? "good" : "warn"}`}>
                {attemptResult.isCorrect ? "Correct path" : "Needs revision"}: {attemptResult.feedback}
              </span>
            ) : null}
          </div>
        </article>

        <aside className="panel panel-side">
          <h3>Live Detection Feed</h3>
          <div className="metric-grid">
            <Metric label="Typing speed" value={`${telemetry.typingSpeed} keys/s`} />
            <Metric label="Pause" value={`${Math.round(telemetry.pauseDurationMs / 1000)}s`} />
            <Metric label="Repeated edits" value={telemetry.repeatedEdits} />
            <Metric label="Deletion rate" value={telemetry.deletionRate} />
            <Metric label="Complexity score" value={telemetry.complexityScore} />
            <Metric label="Total keystrokes" value={telemetry.totalKeystrokes} />
          </div>

          <div className="signal-box">
            <h4>Current issue signal</h4>
            <p>
              {signal.issueType ? `${signal.issueType} (${signal.issueSeverity})` : "No active issue"}
            </p>
            <div className="progress-track">
              <span style={{ width: `${Math.min(100, Math.round(signal.confusionScore * 100))}%` }} />
            </div>
          </div>

          <div className="mastery-box">
            <h4>Concept mastery</h4>
            {Object.entries(masteryMap).map(([concept, mastery]) => (
              <div className="mastery-row" key={concept}>
                <span>{concept}</span>
                <div className="progress-track">
                  <span style={{ width: `${Math.round(mastery * 100)}%` }} />
                </div>
                <strong>{Math.round(mastery * 100)}%</strong>
              </div>
            ))}
          </div>

          <div className="timeline-box">
            <h4>Intervention timeline</h4>
            {interventionHistory.length === 0 ? <p>No interventions yet.</p> : null}
            {interventionHistory.map((item) => (
              <div key={item.id} className="timeline-item">
                <span>{item.type}</span>
                <p>{item.message}</p>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <FloatingAssistant intervention={activeIntervention || interventionHistory[0]} />
      <InterventionPopup
        intervention={activeIntervention}
        onApply={applyIntervention}
        onDismiss={dismissIntervention}
      />
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

function estimateComplexity(code) {
  const lines = code.split("\n").filter((line) => line.trim()).length;
  const loops = (code.match(/\bfor\b|\bwhile\b/g) || []).length;
  const conditionals = (code.match(/\bif\b|\bswitch\b/g) || []).length;
  const functions = (code.match(/function\s+|=>/g) || []).length;
  const recursionHints = (code.match(/factorial\s*\(|sumEven\s*\(/g) || []).length > 1 ? 1 : 0;

  const raw = lines * 0.03 + loops * 0.16 + conditionals * 0.1 + functions * 0.08 + recursionHints * 0.12;
  return Number(Math.min(1, raw).toFixed(2));
}

export default WorkspacePage;
