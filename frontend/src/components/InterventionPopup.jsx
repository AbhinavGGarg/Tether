import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const FOCUS_TIMER_SECONDS = 60;

function InterventionPopup({ intervention, onAction }) {
  const [detailText, setDetailText] = useState("");
  const [timerRunning, setTimerRunning] = useState(false);
  const [remaining, setRemaining] = useState(FOCUS_TIMER_SECONDS);

  useEffect(() => {
    setDetailText("");
    setTimerRunning(false);
    setRemaining(FOCUS_TIMER_SECONDS);
  }, [intervention?.id]);

  useEffect(() => {
    if (!timerRunning) {
      return undefined;
    }

    const id = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(id);
          setTimerRunning(false);
          setDetailText("Focus restored. Focus improved by 40%.");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [timerRunning]);

  const tone = useMemo(() => {
    if (!intervention?.type) {
      return "green";
    }
    if (["procrastination", "distraction"].includes(intervention.type)) {
      return "red";
    }
    if (["low_focus", "inefficiency"].includes(intervention.type)) {
      return "yellow";
    }
    return "green";
  }, [intervention?.type]);

  const toneStyle =
    tone === "red"
      ? { borderColor: "rgba(239,68,68,0.45)", boxShadow: "0 24px 54px rgba(127,29,29,0.24)" }
      : tone === "yellow"
        ? { borderColor: "rgba(245,158,11,0.45)", boxShadow: "0 24px 54px rgba(120,53,15,0.2)" }
        : { borderColor: "rgba(34,197,94,0.45)", boxShadow: "0 24px 54px rgba(21,128,61,0.2)" };

  function handleAction(action) {
    if (!intervention || !onAction) {
      return;
    }

    const nextDetail = onAction(intervention, action);
    if (nextDetail) {
      setDetailText(nextDetail);
    }

    if (action === "refocus_timer") {
      setTimerRunning(true);
      setRemaining(FOCUS_TIMER_SECONDS);
    }
  }

  const timerPct = Math.round(((FOCUS_TIMER_SECONDS - remaining) / FOCUS_TIMER_SECONDS) * 100);

  return (
    <AnimatePresence>
      {intervention ? (
        <motion.aside
          key={intervention.id}
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 220, damping: 22 }}
          className="intervention-toast"
          style={toneStyle}
        >
          <div className="intervention-tag">Live Intervention</div>
          <h3>{intervention.title}</h3>

          <div className="intervention-why">
            <p>
              <strong>What:</strong> {intervention.what || intervention.message}
            </p>
            <p>
              <strong>Why:</strong> {intervention.why || intervention.reason}
            </p>
            <p>
              <strong>Next:</strong> {intervention.nextAction}
            </p>
          </div>

          <div className="intervention-impact">
            <strong>Impact Estimate:</strong> {intervention.impactBefore || "High drift risk"} {" -> "}
            {intervention.impactAfter || "Focus improves after action"}
          </div>

          {timerRunning ? (
            <div className="intervention-detail">
              <strong>Refocus timer:</strong> {remaining}s remaining
              <div className="progress-track" style={{ marginTop: 8 }}>
                <span
                  style={{
                    width: `${timerPct}%`,
                    background: "linear-gradient(90deg, #0ea5e9, #22c55e)"
                  }}
                />
              </div>
            </div>
          ) : null}

          <div className="intervention-actions">
            <button className="btn btn-primary" onClick={() => handleAction("refocus_timer")} disabled={timerRunning}>
              Refocus (Start 60s timer)
            </button>
            <button className="btn btn-ghost" onClick={() => handleAction("break_steps")} disabled={timerRunning}>
              Break into Steps
            </button>
            <button className="btn btn-ghost" onClick={() => handleAction("try_new_approach")} disabled={timerRunning}>
              Try New Approach
            </button>
            <button className="btn btn-ghost" onClick={() => handleAction("short_break")} disabled={timerRunning}>
              Take Short Break
            </button>
            <button className="btn btn-primary" onClick={() => handleAction("resume_task")}>
              Resume Task
            </button>
          </div>

          {detailText ? <div className="intervention-detail">{detailText}</div> : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export default InterventionPopup;
