const API_BASE = import.meta.env.VITE_API_BASE || "";
const REMOTE_MODE = Boolean(API_BASE);

const LOCAL_SESSION_PREFIX = "nudge:context-session:";
const STRICT_INACTIVITY_MS = 60 * 1000;

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

function isRemoteMode() {
  return REMOTE_MODE;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `Request failed: ${response.status}`);
  }

  return response.json();
}

async function fetchProblems() {
  return { problems: [] };
}

async function submitAttempt() {
  return {
    isCorrect: false,
    inefficient: false,
    feedback: "Attempt evaluation is disabled in context-aware mode."
  };
}

async function startSession(learnerName) {
  if (REMOTE_MODE) {
    try {
      const remote = await api("/api/session/start", {
        method: "POST",
        body: JSON.stringify({ learnerName })
      });
      ensureLocalSession(remote.sessionId, learnerName, remote.startedAt);
      return remote;
    } catch {
      return startLocalSession(learnerName);
    }
  }

  return startLocalSession(learnerName);
}

async function endSession(sessionId) {
  if (REMOTE_MODE) {
    try {
      await api(`/api/session/${sessionId}/end`, { method: "POST" });
    } catch {
      // Fall back to local session closing.
    }
  }

  localEndSession(sessionId);
  return { ok: true };
}

function recordMetrics(sessionId, rawMetrics) {
  const session = readSession(sessionId);
  if (!session) {
    return {
      signal: emptySignal(),
      intervention: null,
      context: emptyContext(),
      timeline: []
    };
  }

  const metrics = normalizeMetrics(rawMetrics);
  const context = classifyContext(metrics);

  session.lastContext = context;
  session.contextsSeen[context.activityType] = (session.contextsSeen[context.activityType] || 0) + 1;
  session.metricsHistory.push({ ts: Date.now(), ...metrics, context });
  session.metricsHistory = session.metricsHistory.slice(-200);

  ingestMetrics(session, metrics);
  processIgnoredReminderFollowUp(session, metrics);

  const detection = detectIssue(session, metrics, context);
  const issue = detection.issue;
  const signal = buildSignal(issue, detection.diagnostics, session.lastSignal);

  let intervention = null;
  if (issue) {
    session.issueCounters[issue.type] = (session.issueCounters[issue.type] || 0) + 1;
    addTimeline(session, "issue_detected", `${humanizeIssue(issue.type)} detected`, issue.reason);

    if (canEmitIntervention(session, issue)) {
      intervention = sanitizeIntervention(buildIntervention(issue, context, detection.diagnostics));
      session.interventions.unshift(intervention);
      session.interventions = session.interventions.slice(0, 20);
      session.pendingIgnoredReminder = null;
      addTimeline(session, "intervention_triggered", intervention.title, intervention.what);

      if (intervention.strategy === "inactivity_strict") {
        dispatchBrowserNotification("Nudge Alert", "You stopped working. Get back in for 2 minutes.");
        addTimeline(
          session,
          "reminder_sent",
          "Reminder sent: Resume session",
          "Inactivity reminder notification triggered."
        );
      }
    }
  }

  session.lastSignal = signal;
  session.lastMetrics = {
    typingSpeed: metrics.typingSpeed,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    scrollSpeed: metrics.scrollSpeed,
    tabSwitchesDelta: metrics.tabSwitchesDelta,
    totalKeystrokes: session.aggregate.totalKeystrokes
  };

  writeSession(session);

  return {
    signal,
    intervention: sanitizeIntervention(intervention),
    context,
    timeline: session.timeline.slice(0, 10)
  };
}

function markInterventionApplied(sessionId, interventionId, action = "resume_task") {
  const session = readSession(sessionId);
  if (!session) {
    return null;
  }

  const target = session.interventions.find((entry) => entry.id === interventionId);
  if (!target) {
    return null;
  }

  const safeAction = normalizeAction(action);
  target.userAction = safeAction;
  target.respondedAt = Date.now();
  target.applied = ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "resume_task"].includes(safeAction);

  const snoozeKey = target.strategy === "inactivity_strict" ? "inactivity" : target.type;
  if (ACTION_SNOOZE_MS[safeAction] && snoozeKey) {
    session.snoozedByType[snoozeKey] = Date.now() + ACTION_SNOOZE_MS[safeAction];
  }

  const improvementPct = simulateImprovement(session, target.type, safeAction);
  if (improvementPct > 0) {
    target.improvementNote = `Focus improved by ${improvementPct}%`;
  }

  addTimeline(
    session,
    "user_action",
    `User selected ${actionLabel(safeAction)}`,
    `${humanizeIssue(target.type)} intervention`
  );

  if (safeAction === "lock_in_2m") {
    addTimeline(session, "focus_timer_started", "User started 2-minute lock-in", "120-second focus sprint started");
    session.pendingIgnoredReminder = null;
    session.inactivityReminderStopped = false;
  }

  if (safeAction === "refocus_timer") {
    addTimeline(session, "focus_timer_started", "User started focus timer", "60-second refocus sprint started");
  }

  if (safeAction === "ignore" && target.strategy === "inactivity_strict") {
    session.pendingIgnoredReminder = {
      interventionId: target.id,
      dueAt: Date.now() + 3 * 60 * 1000
    };
    session.inactivityReminderStopped = false;
    addTimeline(
      session,
      "user_ignored",
      "User ignored reminder",
      "Follow-up reminder scheduled in 3 minutes."
    );
  }

  if (safeAction === "resume_task") {
    session.pendingIgnoredReminder = null;
    session.inactivityReminderStopped = false;
  }

  if (improvementPct > 0) {
    addTimeline(session, "focus_improved", "Focus improved", `Focus improved by ${improvementPct}%`);
  }

  writeSession(session);

  return {
    signal: session.lastSignal,
    context: session.lastContext,
    intervention: target,
    timeline: session.timeline.slice(0, 10)
  };
}

async function fetchSummary(sessionId) {
  const localSession = readSession(sessionId);
  if (localSession) {
    return localFetchSummary(sessionId);
  }

  if (REMOTE_MODE) {
    try {
      return await api(`/api/session/${sessionId}/summary`);
    } catch {
      return localFetchSummary(sessionId);
    }
  }

  return localFetchSummary(sessionId);
}

function startLocalSession(learnerName = "Learner") {
  const sessionId = createSessionId();
  const startedAt = Date.now();
  const session = createSessionObject(sessionId, learnerName, startedAt);
  writeSession(session);
  return { sessionId, startedAt };
}

function ensureLocalSession(sessionId, learnerName = "Learner", startedAt = Date.now()) {
  const existing = readSession(sessionId);
  if (existing) {
    return existing;
  }

  const session = createSessionObject(sessionId, learnerName, startedAt);
  writeSession(session);
  return session;
}

function createSessionObject(sessionId, learnerName, startedAt) {
  return {
    id: sessionId,
    learnerName,
    startedAt,
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
    },
    pendingIgnoredReminder: null,
    inactivityReminderStopped: false
  };
}

function normalizeMetrics(raw = {}) {
  return {
    typingSpeed: numberOrZero(raw.typingSpeed),
    pauseDurationMs: numberOrZero(raw.pauseDurationMs),
    idleDurationMs: numberOrZero(raw.idleDurationMs),
    repeatedActions: numberOrZero(raw.repeatedActions),
    repeatedEdits: numberOrZero(raw.repeatedEdits),
    deletionRate: numberOrZero(raw.deletionRate),
    scrollSpeed: numberOrZero(raw.scrollSpeed),
    scrollBursts: numberOrZero(raw.scrollBursts),
    scrollDistance: numberOrZero(raw.scrollDistance),
    tabSwitchesDelta: numberOrZero(raw.tabSwitchesDelta),
    timeOnTaskMs: numberOrZero(raw.timeOnTaskMs),
    keystrokesDelta: numberOrZero(raw.keystrokesDelta),
    pageTitle: String(raw.pageTitle || document.title || ""),
    url: String(raw.url || window.location.href || ""),
    contextSample: String(raw.contextSample || ""),
    pageTextSample: String(raw.pageTextSample || ""),
    hasVideo: Boolean(raw.hasVideo),
    hasEditable: Boolean(raw.hasEditable)
  };
}

function ingestMetrics(session, metrics) {
  session.aggregate.totalKeystrokes += metrics.keystrokesDelta;
  session.aggregate.totalTabSwitches += metrics.tabSwitchesDelta;
  session.aggregate.totalScrollDistance += metrics.scrollDistance;
  session.aggregate.totalIdleMs += metrics.idleDurationMs;
  session.aggregate.timeOnTaskMs = Math.max(session.aggregate.timeOnTaskMs, metrics.timeOnTaskMs);

  if (metrics.repeatedActions >= 5) {
    session.aggregate.repeatedActionBursts += 1;
  }
}

function classifyContext(metrics) {
  const url = metrics.url;
  const domain = domainFromUrl(url);
  const text = `${metrics.pageTitle} ${metrics.contextSample} ${metrics.pageTextSample}`.toLowerCase();
  const isNudgeSurface = domain.includes("nudge-frontend") || domain.includes("nudge") || domain.includes("vercel.app");

  const isCoding =
    matchesAny(domain, ["github.com", "leetcode.com", "replit.com", "stackblitz.com", "codesandbox.io"]) ||
    includesAny(text, ["function", "class ", "terminal", "compile", "debug", "repository"]);

  const isWriting =
    (metrics.hasEditable && metrics.typingSpeed > 0.45) ||
    matchesAny(domain, ["docs.google.com", "notion.so", "medium.com", "substack.com"]) ||
    includesAny(text, ["draft", "essay", "paragraph", "outline", "document"]);

  const isWatching = metrics.hasVideo || matchesAny(domain, ["youtube.com", "vimeo.com", "udemy.com", "netflix.com"]);

  const isLearning =
    matchesAny(domain, ["coursera.org", "edx.org", "khanacademy.org", "udemy.com", "wikipedia.org"]) ||
    includesAny(text, ["lesson", "tutorial", "quiz", "practice", "chapter", "lecture"]);

  let category = "unknown";
  let activityType = "none_detected";
  let confidence = 0;

  if (isCoding) {
    category = "problem_solving";
    activityType = "coding";
    confidence = 0.8;
  } else if (isWriting) {
    category = "writing";
    activityType = "writing";
    confidence = 0.72;
  } else if (isWatching) {
    category = "consuming_content";
    activityType = "watching";
    confidence = 0.66;
  } else if (isLearning) {
    category = "learning";
    activityType = "studying";
    confidence = 0.7;
  } else if (!isNudgeSurface && includesAny(text, ["article", "research", "blog", "paper", "report"])) {
    category = "consuming_content";
    activityType = "reading";
    confidence = 0.52;
  }

  return {
    domain,
    url,
    pageTitle: metrics.pageTitle,
    category,
    activityType,
    confidence: Number(confidence.toFixed(2))
  };
}

function detectIssue(session, metrics, context) {
  const baseDiagnostics = {
    procrastinationScore: 0,
    distractionScore: 0,
    focusScore: session.lastSignal?.focusScore || 72,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    tabSwitchesDelta: metrics.tabSwitchesDelta
  };

  const pauseFactor = clamp(metrics.pauseDurationMs / 22000);
  const idleFactor = clamp(metrics.idleDurationMs / 45000);
  const tabFactor = clamp(metrics.tabSwitchesDelta / 3);
  const activityVariance = clamp(
    Math.abs(metrics.typingSpeed - (session.lastMetrics?.typingSpeed || 0)) / 1.2 + metrics.scrollBursts / 10
  );

  const progressSignal = clamp((metrics.keystrokesDelta + metrics.scrollDistance / 400) / 8);
  const lowProgressFactor = clamp(1 - progressSignal);

  const procrastinationScore = tabFactor * 0.45 + activityVariance * 0.35 + lowProgressFactor * 0.2;
  const distractionScore = idleFactor * 0.7 + pauseFactor * 0.3;

  const focusPenalty = procrastinationScore * 0.45 + distractionScore * 0.55;
  const focusScore = Math.round(Math.max(0, Math.min(100, 100 - focusPenalty * 85)));

  const diagnostics = {
    procrastinationScore: Number(procrastinationScore.toFixed(2)),
    distractionScore: Number(distractionScore.toFixed(2)),
    focusScore,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    tabSwitchesDelta: metrics.tabSwitchesDelta
  };

  const inactivityStrict =
    metrics.pauseDurationMs >= STRICT_INACTIVITY_MS &&
    metrics.idleDurationMs >= STRICT_INACTIVITY_MS &&
    metrics.keystrokesDelta === 0 &&
    metrics.scrollDistance === 0 &&
    metrics.tabSwitchesDelta === 0;

  if (inactivityStrict) {
    diagnostics.distractionScore = Math.max(diagnostics.distractionScore, 0.92);
    diagnostics.focusScore = Math.min(diagnostics.focusScore, 28);

    return {
      issue: {
        type: "inactivity",
        strategy: "inactivity_strict",
        displayType: "Inactivity",
        score: Number(diagnostics.distractionScore.toFixed(2)),
        severity: "high",
        reason: "You've been inactive for 60 seconds."
      },
      diagnostics
    };
  }

  if (context.activityType === "none_detected") {
    return { issue: null, diagnostics };
  }

  const noFreshActivity =
    metrics.keystrokesDelta === 0 &&
    metrics.scrollDistance === 0 &&
    metrics.tabSwitchesDelta === 0;

  if (noFreshActivity && metrics.idleDurationMs < STRICT_INACTIVITY_MS) {
    return { issue: null, diagnostics };
  }

  if (metrics.idleDurationMs > STRICT_INACTIVITY_MS) {
    return {
      issue: {
        type: "distraction",
        displayType: "Distraction",
        score: diagnostics.distractionScore,
        severity: severityFromScore(diagnostics.distractionScore),
        reason: "No activity detected for an extended stretch."
      },
      diagnostics
    };
  }

  const meaningfulActivity =
    session.aggregate.totalKeystrokes >= 8 ||
    session.aggregate.totalScrollDistance >= 1000 ||
    metrics.timeOnTaskMs > 30000;

  if (!meaningfulActivity) {
    return { issue: null, diagnostics };
  }

  const candidates = [
    {
      type: "procrastination",
      score: procrastinationScore,
      threshold: 0.56,
      reason: "You switched contexts multiple times recently. You may be procrastinating."
    },
    {
      type: "distraction",
      score: distractionScore,
      threshold: 0.58,
      reason: "No activity trend suggests attention drift. Are you still working?"
    }
  ].sort((a, b) => b.score - a.score);

  const top = candidates[0];
  if (!top || top.score < top.threshold) {
    return { issue: null, diagnostics };
  }

  session.aggregate.totalDetections += 1;

  return {
    issue: {
      type: top.type,
      displayType: humanizeIssue(top.type),
      severity: severityFromScore(top.score),
      score: Number(top.score.toFixed(2)),
      reason: top.reason,
      diagnostics
    },
    diagnostics
  };
}

function buildSignal(issue, diagnostics, previousSignal = null) {
  const priorFocus = previousSignal?.focusScore || 72;

  if (!issue) {
    return {
      issueType: null,
      issueDisplayType: null,
      issueSeverity: null,
      statusLabel: "Live monitoring",
      procrastinationScore: diagnostics?.procrastinationScore || 0,
      distractionScore: diagnostics?.distractionScore || 0,
      focusScore: diagnostics?.focusScore || priorFocus,
      focusImprovementPct: 0
    };
  }

  return {
    issueType: issue.type,
    issueDisplayType: issue.displayType || humanizeIssue(issue.type),
    issueSeverity: issue.severity,
    statusLabel: issue.type === "distraction" ? "Distraction detected" : `${humanizeIssue(issue.type)} detected`,
    procrastinationScore: diagnostics?.procrastinationScore || 0,
    distractionScore: diagnostics?.distractionScore || 0,
    focusScore: diagnostics?.focusScore || priorFocus,
    focusImprovementPct: 0
  };
}

function canEmitIntervention(session, issue) {
  if (!issue?.type) {
    return false;
  }

  const issueKey = issue.strategy === "inactivity_strict" ? "inactivity" : issue.type;
  if (issue.strategy === "inactivity_strict" && session.inactivityReminderStopped) {
    return false;
  }
  const now = Date.now();

  if ((session.snoozedByType[issueKey] || 0) > now) {
    return false;
  }

  const unresolved = session.interventions.some((entry) => !entry.userAction && now - entry.ts < 3 * 60 * 1000);
  if (unresolved) {
    return false;
  }

  const lastTs = session.lastInterventionByType[issueKey] || 0;
  if (now - lastTs < (ISSUE_COOLDOWN_MS[issueKey] || 90000)) {
    return false;
  }

  session.lastInterventionByType[issueKey] = now;
  return true;
}

function buildIntervention(issue, context, diagnostics) {
  if (issue.strategy === "inactivity_strict") {
    return {
      id: createSessionId(),
      ts: Date.now(),
      applied: false,
      userAction: null,
      type: issue.type,
      strategy: issue.strategy,
      severity: issue.severity,
      contextCategory: context.category,
      activityType: context.activityType,
      reason: issue.reason,
      diagnostics,
      title: "Distraction / Inactivity",
      message: "You've been inactive for 60 seconds. You may be losing focus.",
      what: "You've been inactive for 60 seconds. You may be losing focus.",
      why: "No typing, interaction, or activity was detected for 60 seconds.",
      nextAction: "Lock back in for 2 minutes to regain momentum.",
      actions: ["lock_in_2m", "resume_task", "ignore"],
      actionPayloads: {
        lock_in_2m: "Start a 2-minute focus sprint and avoid switching tasks.",
        resume_task: "Resume your current task now and complete one concrete step.",
        ignore: "No action taken. A follow-up reminder will arrive in 3 minutes."
      },
      impactBefore: "Risk increased due to inactivity.",
      impactAfter: "Focus can improve by ~40%"
    };
  }

  const templates = {
    procrastination: {
      title: "Procrastination Pattern Detected",
      what: "You switched contexts multiple times recently.",
      why: "Frequent context switching often signals avoidance of the current task.",
      nextAction: "Pick one concrete outcome and stay on it for 60 seconds."
    },
    distraction: {
      title: "Distraction Detected",
      what: "No activity was detected for a while.",
      why: "Extended inactivity usually means attention drift.",
      nextAction: "Run a short focus sprint or take a quick intentional break."
    },
    inactivity: {
      title: "Inactivity Detected",
      what: "No keyboard, click, or scrolling activity was detected.",
      why: "Extended inactivity usually means attention drift away from the task.",
      nextAction: "Lock in for 2 minutes and complete one concrete step."
    }
  };

  const pick = templates[issue.type] || templates.distraction;

  return {
    id: createSessionId(),
    ts: Date.now(),
    applied: false,
    userAction: null,
    type: issue.type,
    severity: issue.severity,
    contextCategory: context.category,
    activityType: context.activityType,
    reason: issue.reason,
    diagnostics,
    title: pick.title,
    message: `${pick.what} ${pick.why}`,
    what: pick.what,
    why: pick.why,
    nextAction: pick.nextAction,
    actions: ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task"],
    actionPayloads: {
      lock_in_2m: "Start a 2-minute focus sprint and avoid switching tasks.",
      refocus_timer: "Start a 60-second single-task sprint and block all distractions.",
      break_steps: "Break the task into 3 tiny steps and execute step one now.",
      try_new_approach: "Use a different strategy and test one fresh approach.",
      short_break: "Take a 90-second reset, then return with one clear objective.",
      resume_task: "Resume now and finish one concrete outcome before switching."
    },
    impactBefore: "High drift risk detected",
    impactAfter: "Focus can improve by ~40%"
  };
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

function localEndSession(sessionId) {
  const session = readSession(sessionId);
  if (!session) {
    return;
  }
  session.endedAt = Date.now();
  writeSession(session);
}

function localFetchSummary(sessionId) {
  const session = readSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const endedAt = session.endedAt || Date.now();
  const durationMs = endedAt - session.startedAt;

  const issueWeight =
    (session.issueCounters.procrastination || 0) * 3000 +
    (session.issueCounters.distraction || 0) * 3500 +
    (session.issueCounters.inactivity || 0) * 3000;

  const timeWastedMs = Math.min(durationMs, session.aggregate.totalIdleMs + session.aggregate.repeatedActionBursts * 4000 + issueWeight);

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

  const behaviorSnapshot = computeBehaviorSnapshot(session);

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
    behaviorSnapshot,
    improvementSuggestions: buildImprovementSuggestions(session, contextBreakdown)
  };
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
    100 -
      Math.min(
        80,
        session.aggregate.repeatedActionBursts * 3 +
          (session.issueCounters.inactivity || 0) * 4
      )
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

  if (topContext && topContext !== "none_detected") {
    suggestions.push(`Primary context: ${topContext}. Set one objective before each work block.`);
  }

  if ((session.issueCounters.procrastination || 0) > 0) {
    suggestions.push("Use short single-task sprints to reduce context switching.");
  }

  if ((session.issueCounters.distraction || 0) > 0) {
    suggestions.push("When inactivity appears, run a 2-minute lock-in sprint immediately.");
  }

  if ((session.issueCounters.inactivity || 0) > 0) {
    suggestions.push("Use Lock In right away when inactivity appears to restore momentum.");
  }

  if (suggestions.length === 0) {
    suggestions.push("Strong session. Keep using quick checkpoints to preserve momentum.");
  }

  return suggestions.slice(0, 4);
}

function addTimeline(session, eventType, label, details) {
  session.timeline.unshift({
    id: createSessionId(),
    ts: Date.now(),
    eventType,
    label,
    details
  });

  session.timeline = session.timeline.slice(0, 50);
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
    confidence: 0
  };
}

function severityFromScore(score) {
  if (score >= 0.82) {
    return "high";
  }
  if (score >= 0.68) {
    return "medium";
  }
  return "low";
}

function normalizeAction(action) {
  const mapping = {
    ignore: "ignore"
  };

  const resolved = mapping[action] || action;
  if (
    ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task", "ignore"].includes(
      resolved
    )
  ) {
    return resolved;
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

function humanizeIssue(issueType) {
  return String(issueType || "issue").replaceAll("_", " ");
}

function matchesAny(domain, patterns) {
  return patterns.some((entry) => domain.includes(entry));
}

function includesAny(text, tokens) {
  return tokens.some((token) => text.includes(token));
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function clamp(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function numberOrZero(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return 0;
}

function processIgnoredReminderFollowUp(session, metrics) {
  const userReturned =
    metrics.keystrokesDelta > 0 ||
    metrics.scrollDistance > 0 ||
    metrics.tabSwitchesDelta > 0 ||
    metrics.idleDurationMs < 10000;

  if (session.inactivityReminderStopped && userReturned) {
    session.inactivityReminderStopped = false;
    addTimeline(session, "user_returned", "User returned to task", "Inactivity reminder sequence reset.");
  }

  const pending = session.pendingIgnoredReminder;
  if (!pending) {
    return;
  }

  if (userReturned) {
    addTimeline(session, "user_returned", "User returned to task", "Follow-up inactivity reminder canceled.");
    session.pendingIgnoredReminder = null;
    session.inactivityReminderStopped = false;
    return;
  }

  if (Date.now() < pending.dueAt) {
    return;
  }

  dispatchBrowserNotification("Nudge Alert", "You stopped working. Get back in for 2 minutes.");
  addTimeline(
    session,
    "reminder_sent",
    "Second reminder sent: Resume session",
    "Inactivity was ignored for 3 minutes. This is the final reminder."
  );

  session.lastSignal = {
    ...(session.lastSignal || {}),
    issueType: "inactivity",
    issueDisplayType: "Inactivity",
    issueSeverity: "high",
    statusLabel: "Inactivity detected",
    distractionScore: Math.max(session.lastSignal?.distractionScore || 0, 0.94),
    focusScore: Math.min(session.lastSignal?.focusScore || 72, 28)
  };

  session.pendingIgnoredReminder = null;
  session.inactivityReminderStopped = true;
}

function dispatchBrowserNotification(title, body) {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return;
  }

  if (Notification.permission !== "granted") {
    return;
  }

  new Notification(title, { body });
}

function sanitizeSessionState(session) {
  if (!session || typeof session !== "object") {
    return session;
  }

  const interventions = Array.isArray(session.interventions)
    ? session.interventions.map((entry) => sanitizeIntervention(entry)).filter(Boolean)
    : [];

  return {
    ...session,
    interventions
  };
}

function sanitizeIntervention(rawIntervention) {
  if (!rawIntervention || typeof rawIntervention !== "object") {
    return null;
  }

  const normalizedActions = normalizeInterventionActions(rawIntervention.actions);
  const actionPayloads = rawIntervention.actionPayloads && typeof rawIntervention.actionPayloads === "object"
    ? rawIntervention.actionPayloads
    : {};

  return {
    ...rawIntervention,
    actions: normalizedActions,
    actionPayloads
  };
}

function normalizeInterventionActions(actions) {
  const source = Array.isArray(actions) && actions.length
    ? actions
    : ["lock_in_2m", "resume_task", "ignore"];

  const normalized = source
    .map((action) => String(action || ""))
    .filter((action) =>
      ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task", "ignore"].includes(
        action
      )
    );

  return normalized.length ? Array.from(new Set(normalized)) : ["resume_task"];
}

function createSessionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function readSession(sessionId) {
  if (typeof localStorage === "undefined") {
    return null;
  }

  const raw = localStorage.getItem(`${LOCAL_SESSION_PREFIX}${sessionId}`);
  if (!raw) {
    return null;
  }

  try {
    return sanitizeSessionState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSession(session) {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(`${LOCAL_SESSION_PREFIX}${session.id}`, JSON.stringify(session));
}

export {
  endSession,
  fetchProblems,
  fetchSummary,
  isRemoteMode,
  markInterventionApplied,
  recordMetrics,
  startSession,
  submitAttempt
};
