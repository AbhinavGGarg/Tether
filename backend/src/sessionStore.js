import { v4 as uuidv4 } from "uuid";

const ISSUE_COOLDOWN_MS = {
  procrastination: 90000,
  distraction: 80000,
  inactivity: 90000
};

const ACTION_SNOOZE_MS = {
  lock_in_2m: 180000,
  refocus_timer: 180000,
  break_steps: 90000,
  try_new_approach: 90000,
  short_break: 120000,
  ignore: 180000,
  resume_task: 60000
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
        procrastination: 0,
        distraction: 0,
        inactivity: 0
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
    if (!session || !issueType) {
      return false;
    }

    const now = Date.now();

    if ((session.snoozedByType[issueType] || 0) > now) {
      return false;
    }

    const unresolved = session.interventions.some((entry) => !entry.userAction && now - entry.ts < 3 * 60 * 1000);
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
    target.applied = ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "resume_task"].includes(action);

    if (ACTION_SNOOZE_MS[action] && target.type) {
      session.snoozedByType[target.type] = Date.now() + ACTION_SNOOZE_MS[action];
    }

    const improvementPct = simulateImprovement(session, target.type, action);
    if (improvementPct > 0) {
      target.improvementNote = `Focus improved by ${improvementPct}%`;
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

    const issueWeight =
      (session.issueCounters.procrastination || 0) * 3000 +
      (session.issueCounters.distraction || 0) * 3500 +
      (session.issueCounters.inactivity || 0) * 3000;

    const timeWastedMs = Math.min(
      durationMs,
      session.aggregate.totalIdleMs + session.aggregate.repeatedActionBursts * 4000 + issueWeight
    );

    const contextBreakdown = Object.entries(session.contextsSeen)
      .map(([context, count]) => ({ context, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const successfulActions = session.interventions.filter((entry) =>
      ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "resume_task"].includes(entry.userAction)
    ).length;

    const interventionEffectiveness = session.interventions.length
      ? Number((successfulActions / session.interventions.length).toFixed(2))
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
    100 -
      Math.min(
        85,
        avgIdleMs / 550 +
          session.aggregate.totalTabSwitches * 2 +
          (session.issueCounters.distraction || 0) * 4 +
          (session.issueCounters.procrastination || 0) * 3
      )
  );

  const momentumScore = Math.max(
    0,
    100 - Math.min(80, session.aggregate.repeatedActionBursts * 3 + (session.issueCounters.inactivity || 0) * 4)
  );

  const clarityScore = Math.max(
    0,
    100 - Math.min(80, (session.issueCounters.inactivity || 0) * 6 + (session.issueCounters.distraction || 0) * 3)
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

  if ((session.issueCounters.procrastination || 0) > 0) {
    suggestions.push("Use short single-task sprints to reduce context switching.");
  }

  if ((session.issueCounters.distraction || 0) > 0) {
    suggestions.push("When distraction appears, run a short lock-in sprint immediately.");
  }

  if ((session.issueCounters.inactivity || 0) > 0) {
    suggestions.push("After long idle periods, resume with one concrete next action.");
  }

  if (suggestions.length === 0) {
    suggestions.push("Strong session. Keep using quick checkpoints to preserve momentum.");
  }

  return suggestions.slice(0, 4);
}

function simulateImprovement(session, issueType, action) {
  const next = { ...(session.lastSignal || {}) };

  const improvements = {
    lock_in_2m: 40,
    refocus_timer: 40,
    break_steps: 25,
    try_new_approach: 22,
    short_break: 18,
    resume_task: 20
  };

  const scoreDrop = {
    lock_in_2m: 0.4,
    refocus_timer: 0.4,
    break_steps: 0.25,
    try_new_approach: 0.22,
    short_break: 0.18,
    resume_task: 0.2
  };

  const pct = improvements[action] || 0;
  const drop = scoreDrop[action] || 0;

  next.procrastinationScore = Number(Math.max(0, (next.procrastinationScore || 0) - drop).toFixed(2));
  next.distractionScore = Number(Math.max(0, (next.distractionScore || 0) - drop).toFixed(2));
  next.focusScore = Math.min(100, Math.round((next.focusScore || 65) + pct));
  next.focusImprovementPct = pct;

  const maxScore = Math.max(next.procrastinationScore || 0, next.distractionScore || 0);

  if (!issueType || issueType === next.issueType) {
    if (maxScore < 0.45) {
      next.issueType = null;
      next.issueDisplayType = null;
      next.issueSeverity = null;
      next.statusLabel = "Live monitoring";
    }
  }

  session.lastSignal = next;
  return pct;
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
    issueDisplayType: null,
    issueSeverity: null,
    statusLabel: "Live monitoring",
    procrastinationScore: 0,
    distractionScore: 0,
    focusScore: 72,
    focusImprovementPct: 0
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
  if (
    ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task", "ignore"].includes(
      action
    )
  ) {
    return action;
  }

  return "resume_task";
}

function actionLabel(action) {
  const labels = {
    lock_in_2m: "Lock In (2 min focus)",
    refocus_timer: "Refocus (Start 60s timer)",
    break_steps: "Break into Steps",
    try_new_approach: "Try New Approach",
    short_break: "Take Short Break",
    resume_task: "Resume Task",
    ignore: "Ignore"
  };

  return labels[action] || "Resume Task";
}

function capitalize(value) {
  if (!value) {
    return "";
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

export { SessionStore };
