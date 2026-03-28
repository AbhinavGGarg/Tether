import { useState } from "react";

function FloatingAssistant({ context, signal, intervention, sessionId }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isClosed, setIsClosed] = useState(false);

  const issueText = signal?.issueType
    ? `${signal.issueType.replaceAll("_", " ")} (${signal.issueSeverity || "low"})`
    : "No active issue";

  const focusScore = Math.round(signal?.focusScore || 0);

  if (isClosed) {
    return (
      <button className="assistant-reopen" onClick={() => setIsClosed(false)}>
        Open Nudge
      </button>
    );
  }

  if (isCollapsed) {
    return (
      <aside className="floating-assistant collapsed" aria-live="polite">
        <div className="assistant-head">
          <div className="assistant-title">Nudge Live</div>
          <div className="assistant-controls">
            <button type="button" onClick={() => setIsCollapsed(false)} aria-label="Expand assistant">
              +
            </button>
            <button type="button" onClick={() => setIsClosed(true)} aria-label="Close assistant">
              x
            </button>
          </div>
        </div>
        <p className="assistant-summary">
          <strong>Issue:</strong> {issueText}
        </p>
        <p className="assistant-summary">
          <strong>Focus:</strong> {focusScore}%
        </p>
      </aside>
    );
  }

  return (
    <aside className="floating-assistant" aria-live="polite">
      <div className="assistant-head">
        <div className="assistant-title">Nudge Live</div>
        <div className="assistant-controls">
          <button type="button" onClick={() => setIsCollapsed(true)} aria-label="Collapse assistant">
            -
          </button>
          <button type="button" onClick={() => setIsClosed(true)} aria-label="Close assistant">
            x
          </button>
        </div>
      </div>

      <p className="assistant-summary">
        {context?.activityType || "none_detected"} on {context?.domain || "unknown"} • {context?.category || "unknown"}
      </p>
      <p className="assistant-summary">
        <strong>Current signal:</strong> {issueText}
      </p>
      <p className="assistant-summary">
        <strong>Focus score:</strong> {focusScore}%
      </p>

      {intervention ? (
        <ul className="assistant-list">
          <li>
            <strong>What:</strong> {intervention.what || intervention.message}
          </li>
          <li>
            <strong>Why:</strong> {intervention.why || intervention.reason}
          </li>
          <li>
            <strong>Next:</strong> {intervention.nextAction}
          </li>
        </ul>
      ) : null}

      {sessionId ? (
        <div style={{ marginTop: 10 }}>
          <a className="btn btn-ghost" href={`/dashboard/${sessionId}`} target="_blank" rel="noreferrer noopener">
            View your real live results
          </a>
        </div>
      ) : null}
    </aside>
  );
}

export default FloatingAssistant;
