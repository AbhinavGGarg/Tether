const tabSessions = new Map();

const LIVE_RESULTS_URL = "https://nudge-frontend-ten.vercel.app";

const SESSION_COOLDOWN_MS = {
  procrastination: 90000,
  distraction: 80000,
  low_focus: 100000,
  inefficiency: 110000
};

const ACTION_SNOOZE_MS = {
  refocus_timer: 180000,
  break_steps: 90000,
  try_new_approach: 90000,
  short_break: 120000,
  resume_task: 60000
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nudge_ready: true, nudge_version: "3.0.0" });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabSessions.delete(tabId);
  chrome.storage.local.remove([`nudge_tab_${tabId}`]).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "NUDGE_METRICS") {
    handleMetricsMessage(message, sender)
      .then((payload) => sendResponse(payload))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "NUDGE_ACTION") {
    handleActionMessage(message, sender)
      .then((payload) => sendResponse(payload))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "NUDGE_GET_TAB_STATE") {
    const key = `nudge_tab_${message.tabId}`;
    chrome.storage.local.get([key], (result) => {
      sendResponse({ ok: true, state: result[key] || null });
    });
    return true;
  }
});

async function handleMetricsMessage(message, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false };
  }

  const session = ensureSession(tabId, sender?.tab?.url || "", sender?.tab?.title || "");
  const metrics = normalizeMetrics(message.metrics || {}, sender?.tab);
  const context = classifyContext(metrics, sender?.tab);

  session.context = context;
  session.updatedAt = Date.now();

  ingestMetrics(session, metrics);

  const detection = detectIssue(session, metrics, context);
  const issue = detection.issue;
  const signal = buildSignal(issue, detection.diagnostics, session.lastSignal);

  let intervention = null;
  if (issue) {
    bumpIssueCounters(session, issue.type);
    addTimeline(session, "issue_detected", `${humanizeIssue(issue.type)} detected`, issue.reason);

    if (canEmitIntervention(session, issue.type)) {
      intervention = buildIntervention(issue, context, detection.diagnostics);
      session.interventions.unshift(intervention);
      session.interventions = session.interventions.slice(0, 20);

      addTimeline(session, "intervention_triggered", intervention.title, intervention.what);

      chrome.tabs
        .sendMessage(tabId, {
          type: "NUDGE_INTERVENTION",
          intervention,
          signal,
          context,
          timeline: session.timeline.slice(0, 10)
        })
        .catch(() => {});
    }
  }

  session.lastSignal = signal;
  await persistState(tabId, session);

  return {
    ok: true,
    signal,
    intervention,
    context,
    timeline: session.timeline.slice(0, 10),
    liveResultsUrl: LIVE_RESULTS_URL
  };
}

async function handleActionMessage(message, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false };
  }

  const session = ensureSession(tabId, sender?.tab?.url || "", sender?.tab?.title || "");
  const interventionId = message.interventionId;
  const action = normalizeAction(message.action);
  const target = session.interventions.find((entry) => entry.id === interventionId);

  if (!target) {
    return {
      ok: true,
      signal: session.lastSignal,
      context: session.context,
      timeline: session.timeline.slice(0, 10),
      liveResultsUrl: LIVE_RESULTS_URL
    };
  }

  target.userAction = action;
  target.respondedAt = Date.now();
  target.applied = ["refocus_timer", "break_steps", "try_new_approach", "resume_task"].includes(action);

  if (ACTION_SNOOZE_MS[action] && target.type) {
    session.snoozedByType[target.type] = Date.now() + ACTION_SNOOZE_MS[action];
  }

  const improvementPct = simulateImprovement(session, target.type, action);
  if (improvementPct > 0) {
    target.improvementNote = `Focus improved by ${improvementPct}%`;
  }

  addTimeline(session, "user_action", `User selected ${actionLabel(action)}`, `${humanizeIssue(target.type)} intervention`);

  if (action === "refocus_timer") {
    addTimeline(session, "focus_timer_started", "User started focus timer", "60-second refocus sprint started");
  }

  if (action === "resume_task") {
    addTimeline(session, "focus_restored", "Focus improved", `Focus improved by ${improvementPct}%`);
  }

  session.updatedAt = Date.now();
  await persistState(tabId, session);

  return {
    ok: true,
    signal: session.lastSignal,
    context: session.context,
    intervention: target,
    timeline: session.timeline.slice(0, 10),
    liveResultsUrl: LIVE_RESULTS_URL
  };
}

function ensureSession(tabId, url, title) {
  if (tabSessions.has(tabId)) {
    const existing = tabSessions.get(tabId);
    existing.url = url || existing.url;
    existing.title = title || existing.title;
    return existing;
  }

  const session = {
    tabId,
    url,
    title,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    context: {
      domain: domainFromUrl(url),
      url,
      pageTitle: title || "",
      category: "unknown",
      activityType: "none_detected",
      confidence: 0,
      evidence: []
    },
    aggregate: {
      totalKeystrokes: 0,
      totalTabSwitches: 0,
      totalScrollDistance: 0,
      totalIdleMs: 0,
      timeOnTaskMs: 0,
      totalDetections: 0
    },
    issueCounters: {
      procrastination: 0,
      distraction: 0,
      low_focus: 0,
      inefficiency: 0
    },
    interventions: [],
    timeline: [],
    lastInterventionByType: {},
    snoozedByType: {},
    lastSignal: {
      issueType: null,
      issueSeverity: null,
      procrastinationScore: 0,
      distractionScore: 0,
      lowFocusScore: 0,
      inefficiencyScore: 0,
      focusScore: 72,
      focusImprovementPct: 0
    },
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

  addTimeline(session, "session_started", "Live monitoring started", domainFromUrl(url));

  tabSessions.set(tabId, session);
  return session;
}

function normalizeMetrics(metrics, tab) {
  return {
    typingSpeed: numberOrZero(metrics.typingSpeed),
    pauseDurationMs: numberOrZero(metrics.pauseDurationMs),
    idleDurationMs: numberOrZero(metrics.idleDurationMs),
    repeatedActions: numberOrZero(metrics.repeatedActions),
    repeatedEdits: numberOrZero(metrics.repeatedEdits),
    deletionRate: numberOrZero(metrics.deletionRate),
    scrollSpeed: numberOrZero(metrics.scrollSpeed),
    scrollBursts: numberOrZero(metrics.scrollBursts),
    scrollDistance: numberOrZero(metrics.scrollDistance),
    tabSwitchesDelta: numberOrZero(metrics.tabSwitchesDelta),
    timeOnTaskMs: numberOrZero(metrics.timeOnTaskMs),
    keystrokesDelta: numberOrZero(metrics.keystrokesDelta),
    contextSample: String(metrics.contextSample || ""),
    pageTextSample: String(metrics.pageTextSample || ""),
    pageTitle: String(metrics.pageTitle || tab?.title || ""),
    url: String(metrics.url || tab?.url || ""),
    hasVideo: Boolean(metrics.hasVideo),
    hasEditable: Boolean(metrics.hasEditable)
  };
}

function ingestMetrics(session, metrics) {
  session.aggregate.totalKeystrokes += metrics.keystrokesDelta;
  session.aggregate.totalTabSwitches += metrics.tabSwitchesDelta;
  session.aggregate.totalScrollDistance += metrics.scrollDistance;
  session.aggregate.totalIdleMs += metrics.idleDurationMs;
  session.aggregate.timeOnTaskMs = Math.max(session.aggregate.timeOnTaskMs, metrics.timeOnTaskMs);

  session.lastMetrics = {
    typingSpeed: metrics.typingSpeed,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    scrollSpeed: metrics.scrollSpeed,
    tabSwitchesDelta: metrics.tabSwitchesDelta,
    totalKeystrokes: session.aggregate.totalKeystrokes
  };
}

function classifyContext(metrics, tab) {
  const url = metrics.url || tab?.url || "";
  const domain = domainFromUrl(url);
  const text = `${metrics.pageTitle} ${metrics.contextSample} ${metrics.pageTextSample}`.toLowerCase();
  const isNudgeSurface = domain.includes("nudge-frontend") || domain.includes("vercel.app");

  const evidence = [];

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
    evidence.push("Code context signal");
  } else if (isWriting) {
    category = "writing";
    activityType = "writing";
    confidence = 0.72;
    evidence.push("Active writing behavior");
  } else if (isWatching) {
    category = "consuming_content";
    activityType = "watching";
    confidence = 0.66;
    evidence.push("Video context signal");
  } else if (isLearning) {
    category = "learning";
    activityType = "studying";
    confidence = 0.7;
    evidence.push("Learning context signal");
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
    confidence: Number(confidence.toFixed(2)),
    evidence: evidence.slice(0, 3)
  };
}

function detectIssue(session, metrics, context) {
  const baseDiagnostics = {
    procrastinationScore: 0,
    distractionScore: 0,
    lowFocusScore: 0,
    inefficiencyScore: 0,
    focusScore: session.lastSignal?.focusScore || 72,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    tabSwitchesDelta: metrics.tabSwitchesDelta
  };

  if (context.activityType === "none_detected") {
    return { issue: null, diagnostics: baseDiagnostics };
  }

  const pauseFactor = clamp(metrics.pauseDurationMs / 22000);
  const idleFactor = clamp(metrics.idleDurationMs / 45000);
  const repeatFactor = clamp(metrics.repeatedActions / 8);
  const retriesFactor = clamp(metrics.repeatedEdits / 7);
  const tabFactor = clamp(metrics.tabSwitchesDelta / 3);
  const lowTypingFactor = clamp((0.9 - metrics.typingSpeed) / 0.9);
  const activityVariance = clamp(
    Math.abs(metrics.typingSpeed - (session.lastMetrics?.typingSpeed || 0)) / 1.2 + metrics.scrollBursts / 10
  );

  const progressSignal = clamp((metrics.keystrokesDelta + metrics.scrollDistance / 400) / 8);
  const lowProgressFactor = clamp(1 - progressSignal);

  const procrastinationScore = tabFactor * 0.45 + activityVariance * 0.35 + lowProgressFactor * 0.2;
  const distractionScore = idleFactor * 0.6 + pauseFactor * 0.25 + lowTypingFactor * 0.15;
  const lowFocusScore = lowTypingFactor * 0.4 + pauseFactor * 0.35 + repeatFactor * 0.25;
  const inefficiencyScore = repeatFactor * 0.45 + retriesFactor * 0.3 + lowProgressFactor * 0.25;

  const focusPenalty =
    procrastinationScore * 0.28 + distractionScore * 0.32 + lowFocusScore * 0.22 + inefficiencyScore * 0.18;
  const focusScore = Math.round(Math.max(0, Math.min(100, 100 - focusPenalty * 85)));

  const diagnostics = {
    procrastinationScore: Number(procrastinationScore.toFixed(2)),
    distractionScore: Number(distractionScore.toFixed(2)),
    lowFocusScore: Number(lowFocusScore.toFixed(2)),
    inefficiencyScore: Number(inefficiencyScore.toFixed(2)),
    focusScore,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    tabSwitchesDelta: metrics.tabSwitchesDelta
  };

  if (metrics.idleDurationMs > 45000) {
    return {
      issue: {
        type: "distraction",
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
    },
    {
      type: "low_focus",
      score: lowFocusScore,
      threshold: 0.57,
      reason: "Typing speed dropped and pauses increased. You may be losing focus."
    },
    {
      type: "inefficiency",
      score: inefficiencyScore,
      threshold: 0.6,
      reason: "You are repeating actions without visible progress."
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
      score: Number(top.score.toFixed(2)),
      severity: severityFromScore(top.score),
      reason: top.reason
    },
    diagnostics
  };
}

function buildSignal(issue, diagnostics, previousSignal = null) {
  const priorFocus = previousSignal?.focusScore || 72;

  if (!issue) {
    return {
      issueType: null,
      issueSeverity: null,
      procrastinationScore: diagnostics?.procrastinationScore || 0,
      distractionScore: diagnostics?.distractionScore || 0,
      lowFocusScore: diagnostics?.lowFocusScore || 0,
      inefficiencyScore: diagnostics?.inefficiencyScore || 0,
      focusScore: diagnostics?.focusScore || priorFocus,
      focusImprovementPct: 0
    };
  }

  return {
    issueType: issue.type,
    issueSeverity: issue.severity,
    procrastinationScore: diagnostics?.procrastinationScore || 0,
    distractionScore: diagnostics?.distractionScore || 0,
    lowFocusScore: diagnostics?.lowFocusScore || 0,
    inefficiencyScore: diagnostics?.inefficiencyScore || 0,
    focusScore: diagnostics?.focusScore || priorFocus,
    focusImprovementPct: 0
  };
}

function canEmitIntervention(session, issueType) {
  const now = Date.now();

  if ((session.snoozedByType[issueType] || 0) > now) {
    return false;
  }

  const unresolvedIntervention = session.interventions.some(
    (entry) => !entry.userAction && now - entry.ts < 3 * 60 * 1000
  );
  if (unresolvedIntervention) {
    return false;
  }

  const lastTs = session.lastInterventionByType[issueType] || 0;
  if (now - lastTs < (SESSION_COOLDOWN_MS[issueType] || 90000)) {
    return false;
  }

  session.lastInterventionByType[issueType] = now;
  return true;
}

function buildIntervention(issue, context, diagnostics) {
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
    low_focus: {
      title: "Low Focus Signal",
      what: "Your activity slowed down with longer pauses.",
      why: "Reduced momentum can indicate cognitive fatigue.",
      nextAction: "Reset with one small next action and execute immediately."
    },
    inefficiency: {
      title: "Inefficiency Pattern",
      what: "You are repeating actions without clear progress.",
      why: "Repetition without outcomes wastes effort and time.",
      nextAction: "Change strategy and target a measurable next result."
    }
  };

  const pick = templates[issue.type] || templates.low_focus;

  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
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
    actionPayloads: {
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
    refocus_timer: 40,
    break_steps: 25,
    try_new_approach: 22,
    short_break: 18,
    resume_task: 20
  };

  const scoreDrop = {
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
  next.lowFocusScore = Number(Math.max(0, (next.lowFocusScore || 0) - drop).toFixed(2));
  next.inefficiencyScore = Number(Math.max(0, (next.inefficiencyScore || 0) - drop).toFixed(2));

  next.focusScore = Math.min(100, Math.round((next.focusScore || 65) + pct));
  next.focusImprovementPct = pct;

  const maxScore = Math.max(
    next.procrastinationScore || 0,
    next.distractionScore || 0,
    next.lowFocusScore || 0,
    next.inefficiencyScore || 0
  );

  if (!issueType || issueType === next.issueType) {
    if (maxScore < 0.45) {
      next.issueType = null;
      next.issueSeverity = null;
    }
  }

  session.lastSignal = next;
  return pct;
}

function bumpIssueCounters(session, issueType) {
  session.issueCounters[issueType] = (session.issueCounters[issueType] || 0) + 1;
}

function addTimeline(session, eventType, label, details) {
  session.timeline.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    ts: Date.now(),
    eventType,
    label,
    details
  });

  session.timeline = session.timeline.slice(0, 50);
}

async function persistState(tabId, session) {
  const key = `nudge_tab_${tabId}`;
  await chrome.storage.local.set({
    [key]: {
      tabId,
      url: session.url,
      title: session.title,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      context: session.context,
      aggregate: session.aggregate,
      issueCounters: session.issueCounters,
      lastSignal: session.lastSignal,
      lastMetrics: session.lastMetrics,
      interventions: session.interventions,
      timeline: session.timeline,
      liveResultsUrl: LIVE_RESULTS_URL
    },
    nudge_last_tab: tabId,
    nudge_last_update: Date.now()
  });
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

function humanizeIssue(issueType) {
  return String(issueType || "issue").replaceAll("_", " ");
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function matchesAny(domain, patterns) {
  return patterns.some((entry) => domain.includes(entry));
}

function includesAny(text, tokens) {
  return tokens.some((token) => text.includes(token));
}

function actionLabel(action) {
  const labels = {
    refocus_timer: "Refocus (Start 60s timer)",
    break_steps: "Break into Steps",
    try_new_approach: "Try New Approach",
    short_break: "Take Short Break",
    resume_task: "Resume Task"
  };
  return labels[action] || "Resume Task";
}

function normalizeAction(action) {
  const mapping = {
    show_suggestion: "break_steps",
    try_action: "resume_task",
    ignore: "short_break",
    show_fix: "break_steps",
    give_hint: "try_new_approach",
    refocus: "refocus_timer",
    summarize: "resume_task"
  };

  const resolved = mapping[action] || action;
  if (["refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task"].includes(resolved)) {
    return resolved;
  }

  return "resume_task";
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function clamp(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
