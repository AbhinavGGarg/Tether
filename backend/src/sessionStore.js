import { v4 as uuidv4 } from "uuid";

const ISSUE_COOLDOWN_MS = {
  confusion: 120000,
  distraction: 90000,
  inefficiency: 150000
};

const ACTION_SNOOZE_MS = {
  show_fix: 60000,
  give_hint: 60000,
  refocus: 180000,
  summarize: 120000
};

class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  createSession(learnerName = "Operator") {
    const id = uuidv4();
    const session = {
      id,
      learnerName,
      startedAt: Date.now(),
      endedAt: null,
      metricsHistory: [],
      interventions: [],
      timeline: [],
      contextsSeen: {},
      issueCounters: {
        confusion: 0,
        distraction: 0,
        inefficiency: 0
      },
      aggregate: {
        totalKeystrokes: 0,
        totalTabSwitches: 0,
        totalScrollDistance: 0,
        totalIdleMs: 0,
        repeatedActionBursts: 0,
        timeOnTaskMs: 0,
        totalDetections: 0
      },
      lastInterventionByType: {},
      snoozedByType: {},
      lastSignal: emptySignal(),
      lastContext: emptyContext(),
      lastMetrics: {
        typingSpeed: 0,
        pauseDurationMs: 0,
        idleDurationMs: 0,
        repeatedActions: 0,
        scrollSpeed: 0,
        tabSwitchesDelta: 0,
        totalKeystrokes: 0
      }
    };

    addTimeline(session, "session_started", "Live monitoring started", "Nudge session initialized");
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  ingestMetrics(sessionId, metrics, context) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    session.metricsHistory.push({ ts: Date.now(), ...metrics, context });

    session.lastContext = context;
    session.contextsSeen[context.category] = (session.contextsSeen[context.category] || 0) + 1;

    session.aggregate.totalKeystrokes += metrics.keystrokesDelta;
    session.aggregate.totalTabSwitches += metrics.tabSwitchesDelta;
    session.aggregate.totalScrollDistance += metrics.scrollDistance;
    session.aggregate.totalIdleMs += metrics.idleDurationMs;
    session.aggregate.timeOnTaskMs = Math.max(session.aggregate.timeOnTaskMs, metrics.timeOnTaskMs);

    if (metrics.repeatedActions >= 5) {
      session.aggregate.repeatedActionBursts += 1;
    }

    session.lastMetrics = {
      typingSpeed: metrics.typingSpeed,
      pauseDurationMs: metrics.pauseDurationMs,
      idleDurationMs: metrics.idleDurationMs,
      repeatedActions: metrics.repeatedActions,
      scrollSpeed: metrics.scrollSpeed,
      tabSwitchesDelta: metrics.tabSwitchesDelta,
      totalKeystrokes: session.aggregate.totalKeystrokes
    };

    return session;
  }

  setSignal(sessionId, signal) {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    session.lastSignal = signal;
  }

  recordIssue(sessionId, issue) {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    session.issueCounters[issue.type] = (session.issueCounters[issue.type] || 0) + 1;
    session.aggregate.totalDetections += 1;
    addTimeline(session, "issue_detected", `${capitalize(issue.type)} detected`, issue.reason);
  }

  canEmitIntervention(sessionId, issueType) {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const now = Date.now();

    if ((session.snoozedByType[issueType] || 0) > now) {
      return false;
    }

    const unresolved = session.interventions.some(
      (entry) => !entry.userAction && now - entry.ts < 4 * 60 * 1000
    );
    if (unresolved) {
      return false;
    }

    const lastTs = session.lastInterventionByType[issueType] || 0;
    if (now - lastTs < (ISSUE_COOLDOWN_MS[issueType] || 90000)) {
      return false;
    }

    session.lastInterventionByType[issueType] = now;
    return true;
  }

  addIntervention(sessionId, intervention) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const entry = {
      id: uuidv4(),
      ts: Date.now(),
      applied: false,
      userAction: null,
      ...intervention
    };

    session.interventions.unshift(entry);
    session.interventions = session.interventions.slice(0, 20);

    addTimeline(session, "intervention_triggered", entry.title, entry.message);
    return entry;
  }

  markInterventionAction(sessionId, interventionId, rawAction) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const action = normalizeAction(rawAction);
    const target = session.interventions.find((entry) => entry.id === interventionId);

    if (!target) {
      return null;
    }

    target.userAction = action;
    target.respondedAt = Date.now();
    target.applied = action === "refocus";

    if (action === "summarize") {
      target.generatedSummary = `Summary: ${target.message} Next step: ${target.nextAction}`;
    }

    if (action === "refocus") {
      simulateImprovement(session);
    }

    if (ACTION_SNOOZE_MS[action] && target.type) {
      session.snoozedByType[target.type] = Date.now() + ACTION_SNOOZE_MS[action];
    }

    addTimeline(session, "user_action", `User selected ${actionLabel(action)}`, target.title);

    return target;
  }

  endSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }

    if (!session.endedAt) {
      session.endedAt = Date.now();
      addTimeline(session, "session_ended", "Session ended", "Dashboard generated");
    }
  }

  getSummary(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const endedAt = session.endedAt || Date.now();
    const durationMs = endedAt - session.startedAt;

    const timeWastedMs = Math.min(
      durationMs,
      session.aggregate.totalIdleMs + session.aggregate.repeatedActionBursts * 4000
    );

    const contextBreakdown = Object.entries(session.contextsSeen)
      .map(([context, count]) => ({ context, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const resolvedCount = session.interventions.filter((entry) => entry.userAction === "refocus").length;
    const interventionEffectiveness = session.interventions.length
      ? Number((resolvedCount / session.interventions.length).toFixed(2))
      : 0;

    return {
      sessionId: session.id,
      learnerName: session.learnerName,
      startedAt: session.startedAt,
      endedAt,
      durationMs,
      timeWastedMs,
      issueCounters: session.issueCounters,
      contextBreakdown,
      interventions: session.interventions,
      timeline: session.timeline,
      interventionEffectiveness,
      behaviorSnapshot: computeBehaviorSnapshot(session),
      improvementSuggestions: buildImprovementSuggestions(session, contextBreakdown)
    };
  }
}

function computeBehaviorSnapshot(session) {
  const avgIdleMs = session.metricsHistory.length
    ? session.metricsHistory.reduce((sum, entry) => sum + (entry.idleDurationMs || 0), 0) / session.metricsHistory.length
    : 0;

  const focusScore = Math.max(
    0,
    100 - Math.min(80, avgIdleMs / 600 + session.aggregate.totalTabSwitches * 2 + session.issueCounters.distraction * 4)
  );

  const momentumScore = Math.max(
    0,
    100 - Math.min(75, session.issueCounters.inefficiency * 6 + session.aggregate.repeatedActionBursts * 3)
  );

  const clarityScore = Math.max(
    0,
    100 - Math.min(75, session.issueCounters.confusion * 7 + session.issueCounters.distraction * 2)
  );

  return {
    focusScore: Math.round(focusScore),
    momentumScore: Math.round(momentumScore),
    clarityScore: Math.round(clarityScore)
  };
}

function buildImprovementSuggestions(session, contextBreakdown) {
  const suggestions = [];
  const topContext = contextBreakdown[0]?.context;

  if (topContext) {
    suggestions.push(`Primary context: ${topContext}. Set one objective before each work block.`);
  }

  if ((session.issueCounters.distraction || 0) > 0) {
    suggestions.push("Use 90-second single-task focus sprints when drift appears.");
  }

  if ((session.issueCounters.confusion || 0) > 0) {
    suggestions.push("When stuck, summarize what you know and what is missing in one sentence.");
  }

  if ((session.issueCounters.inefficiency || 0) > 0) {
    suggestions.push("Switch from reactive edits to one clear next action before acting.");
  }

  if (suggestions.length === 0) {
    suggestions.push("Strong session. Keep using short checkpoints to preserve momentum.");
  }

  return suggestions.slice(0, 4);
}

function simulateImprovement(session) {
  session.lastSignal = {
    ...session.lastSignal,
    issueType: null,
    issueSeverity: null,
    confusionScore: Number(Math.max(0, (session.lastSignal.confusionScore || 0) - 0.25).toFixed(2)),
    distractionScore: Number(Math.max(0, (session.lastSignal.distractionScore || 0) - 0.25).toFixed(2)),
    inefficiencyScore: Number(Math.max(0, (session.lastSignal.inefficiencyScore || 0) - 0.25).toFixed(2))
  };
}

function addTimeline(session, eventType, label, details) {
  session.timeline.unshift({
    id: uuidv4(),
    ts: Date.now(),
    eventType,
    label,
    details
  });

  session.timeline = session.timeline.slice(0, 60);
}

function emptySignal() {
  return {
    issueType: null,
    issueSeverity: null,
    confusionScore: 0,
    distractionScore: 0,
    inefficiencyScore: 0
  };
}

function emptyContext() {
  return {
    domain: "unknown",
    url: "",
    pageTitle: "",
    category: "unknown",
    activityType: "none_detected",
    confidence: 0,
    evidence: []
  };
}

function normalizeAction(action) {
  const mapping = {
    show_suggestion: "show_fix",
    try_action: "refocus",
    ignore: "summarize"
  };

  const resolved = mapping[action] || action;
  if (["show_fix", "give_hint", "refocus", "summarize"].includes(resolved)) {
    return resolved;
  }

  return "refocus";
}

function actionLabel(action) {
  const labels = {
    show_fix: "Show Fix",
    give_hint: "Give Hint",
    refocus: "Refocus",
    summarize: "Summarize"
  };

  return labels[action] || "Refocus";
}

function capitalize(value) {
  if (!value) {
    return "";
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

export { SessionStore };
