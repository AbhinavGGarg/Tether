const API_BASE = import.meta.env.VITE_API_BASE || "";
const REMOTE_MODE = Boolean(API_BASE);

const LOCAL_SESSION_PREFIX = "nudge:context-session:";

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
  session.contextsSeen[context.category] = (session.contextsSeen[context.category] || 0) + 1;
  session.metricsHistory.push({ ts: Date.now(), ...metrics, context });

  ingestMetrics(session, metrics);

  const issue = detectIssue(session, metrics, context);
  const signal = buildSignal(issue);

  let intervention = null;
  if (issue) {
    session.issueCounters[issue.type] = (session.issueCounters[issue.type] || 0) + 1;
    addTimeline(session, "issue_detected", `${capitalize(issue.type)} detected`, issue.reason);

    if (canEmitIntervention(session, issue.type)) {
      intervention = buildIntervention(issue, context);
      session.interventions.unshift(intervention);
      session.interventions = session.interventions.slice(0, 20);
      addTimeline(session, "intervention_triggered", intervention.title, intervention.message);
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
    intervention,
    context,
    timeline: session.timeline.slice(0, 8)
  };
}

function markInterventionApplied(sessionId, interventionId, action = "refocus") {
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
  target.applied = safeAction === "refocus";

  if (safeAction === "refocus") {
    simulateImprovement(session);
  }

  if (safeAction === "summarize") {
    target.generatedSummary = `Summary: ${target.message} Next step: ${target.nextAction}`;
  }

  const actionSnoozeMs = {
    show_fix: 60 * 1000,
    give_hint: 60 * 1000,
    refocus: 180 * 1000,
    summarize: 120 * 1000
  };

  if (target.type && actionSnoozeMs[safeAction]) {
    session.snoozedByType[target.type] = Date.now() + actionSnoozeMs[safeAction];
  }

  addTimeline(session, "user_action", `User selected ${actionLabel(safeAction)}`, target.title);
  writeSession(session);

  return {
    signal: session.lastSignal,
    context: session.lastContext,
    intervention: target,
    timeline: session.timeline.slice(0, 8)
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
      timeOnTaskMs: 0
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
  const isDecisionOsSurface =
    domain.includes("nudge-frontend") || domain.includes("decisionos") || domain.includes("vercel.app");

  const isCoding =
    includesAny(text, ["function", "class ", "console", "bug", "compile", "repository", "terminal"]) ||
    matchesAny(domain, ["github.com", "leetcode.com", "replit.com", "codesandbox.io", "stackblitz.com"]);

  const isWriting =
    (metrics.hasEditable && metrics.typingSpeed > 0.45) ||
    includesAny(text, ["draft", "paragraph", "essay", "outline", "document"]) ||
    matchesAny(domain, ["docs.google.com", "notion.so", "medium.com"]);

  const isWatching =
    metrics.hasVideo || matchesAny(domain, ["youtube.com", "vimeo.com", "netflix.com", "udemy.com"]);

  const isLearning =
    includesAny(text, ["lesson", "chapter", "quiz", "practice", "tutorial", "lecture"]) ||
    matchesAny(domain, ["coursera.org", "edx.org", "khanacademy.org", "wikipedia.org", "udemy.com"]);

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
  } else if (!isDecisionOsSurface && includesAny(text, ["article", "research", "blog", "paper", "report"])) {
    category = "consuming_content";
    activityType = "reading";
    confidence = 0.52;
  } else {
    category = "unknown";
    activityType = "none_detected";
    confidence = 0;
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
  if (context.activityType === "none_detected") {
    return null;
  }

  const hasMeaningfulActivity =
    session.aggregate.totalKeystrokes >= 8 ||
    session.aggregate.totalScrollDistance >= 1000 ||
    metrics.timeOnTaskMs > 45000;

  if (!hasMeaningfulActivity) {
    return null;
  }

  const pauseFactor = clamp(metrics.pauseDurationMs / 22000);
  const idleFactor = clamp(metrics.idleDurationMs / 30000);
  const repeatFactor = clamp(metrics.repeatedActions / 8);
  const deletionFactor = clamp(metrics.deletionRate * 1.8);
  const retriesFactor = clamp(metrics.repeatedEdits / 7);
  const tabFactor = clamp(metrics.tabSwitchesDelta / 3);
  const scrollBurstFactor = clamp(metrics.scrollBursts / 12);
  const lowTypingFactor = clamp((0.8 - metrics.typingSpeed) / 0.8);
  const slowProgress =
    metrics.timeOnTaskMs > 150000 && metrics.typingSpeed < 0.4 ? clamp(metrics.timeOnTaskMs / 420000) : 0;

  const confusionScore =
    pauseFactor * 0.35 + repeatFactor * 0.25 + retriesFactor * 0.2 + deletionFactor * 0.2;
  const distractionScore =
    tabFactor * 0.35 + idleFactor * 0.35 + scrollBurstFactor * 0.2 + lowTypingFactor * 0.1;
  const inefficiencyScore =
    slowProgress * 0.4 + repeatFactor * 0.35 + clamp(metrics.scrollSpeed / 1600) * 0.15 + lowTypingFactor * 0.1;

  const candidates = [
    {
      type: "confusion",
      threshold: 0.62,
      score: confusionScore,
      reason: `Stuck pattern detected while ${context.activityType}.`
    },
    {
      type: "distraction",
      threshold: 0.56,
      score: distractionScore,
      reason: `Attention drift detected during ${context.activityType}.`
    },
    {
      type: "inefficiency",
      threshold: 0.58,
      score: inefficiencyScore,
      reason: `Progress pattern looks inefficient for this context.`
    }
  ].sort((a, b) => b.score - a.score);

  const top = candidates[0];
  if (!top || top.score < top.threshold) {
    return null;
  }

  return {
    type: top.type,
    severity: severityFromScore(top.score),
    score: Number(top.score.toFixed(2)),
    reason: top.reason,
    diagnostics: {
      confusionScore: Number(confusionScore.toFixed(2)),
      distractionScore: Number(distractionScore.toFixed(2)),
      inefficiencyScore: Number(inefficiencyScore.toFixed(2)),
      pauseDurationMs: metrics.pauseDurationMs,
      idleDurationMs: metrics.idleDurationMs,
      repeatedActions: metrics.repeatedActions,
      tabSwitchesDelta: metrics.tabSwitchesDelta
    }
  };
}

function buildSignal(issue) {
  if (!issue) {
    return emptySignal();
  }

  return {
    issueType: issue.type,
    issueSeverity: issue.severity,
    confusionScore: issue.diagnostics.confusionScore,
    distractionScore: issue.diagnostics.distractionScore,
    inefficiencyScore: issue.diagnostics.inefficiencyScore
  };
}

function canEmitIntervention(session, issueType) {
  const now = Date.now();

  if ((session.snoozedByType[issueType] || 0) > now) {
    return false;
  }

  const unresolved = session.interventions.some((entry) => !entry.userAction && now - entry.ts < 4 * 60 * 1000);
  if (unresolved) {
    return false;
  }

  const cooldownByType = {
    confusion: 120000,
    distraction: 90000,
    inefficiency: 150000
  };

  const lastTs = session.lastInterventionByType[issueType] || 0;
  if (now - lastTs < (cooldownByType[issueType] || 90000)) {
    return false;
  }

  session.lastInterventionByType[issueType] = now;
  return true;
}

function buildIntervention(issue, context) {
  const templates = {
    coding: {
      confusion: {
        title: "Stuck While Coding",
        message: "You look blocked while coding.",
        nextAction: "Run one tiny test case before more edits.",
        fix: "Split into input -> expected output -> first failing line.",
        hint: "Start with the smallest failing case, not the full flow.",
        refocus: "Do a 90-second single-tab sprint.",
        summary: "Define current bug, expected output, and immediate next step."
      },
      distraction: {
        title: "Focus Drift During Coding",
        message: "Frequent switches are breaking your flow.",
        nextAction: "Close unrelated tabs for 90 seconds.",
        fix: "Keep only one task tab and one reference tab.",
        hint: "Complete one micro-goal before opening anything else.",
        refocus: "Set a timer for 90 seconds and continue only this task.",
        summary: "State your one coding objective for the next 90 seconds."
      },
      inefficiency: {
        title: "Inefficient Edit Loop",
        message: "You are editing repeatedly without progress.",
        nextAction: "Define one clear next action before typing.",
        fix: "State one target outcome, then implement directly.",
        hint: "Decide algorithm shape before details.",
        refocus: "Pause, breathe, then execute one planned step.",
        summary: "Summarize your immediate next action in one sentence."
      }
    },
    writing: {
      confusion: {
        title: "Clarity Drop Detected",
        message: "Your writing flow looks stuck.",
        nextAction: "Rewrite one sentence as subject + action + outcome.",
        fix: "Use one-line thesis before editing full paragraph.",
        hint: "Focus on one claim, then support it.",
        refocus: "Draft 2 sentences without editing.",
        summary: "Summarize your paragraph intent in one line."
      },
      distraction: {
        title: "Writing Focus Drift",
        message: "Context switching is reducing momentum.",
        nextAction: "Continue writing for 90 seconds only.",
        fix: "Disable notifications and keep cursor in document.",
        hint: "Momentum beats perfection during drafting.",
        refocus: "Do a 90-second no-edit sprint.",
        summary: "State what this paragraph should achieve."
      },
      inefficiency: {
        title: "Over-Editing Pattern",
        message: "You may be polishing too early.",
        nextAction: "Separate draft pass and edit pass.",
        fix: "60s draft sprint, then 30s edit sprint.",
        hint: "Finish ideas before polishing wording.",
        refocus: "Move to draft mode for the next minute.",
        summary: "Summarize key point before editing style."
      }
    },
    studying: {
      confusion: {
        title: "Comprehension Friction",
        message: "This section may not be sticking.",
        nextAction: "Summarize from memory in one sentence.",
        fix: "Read -> close -> recall one key idea.",
        hint: "If recall fails, re-read only heading + first sentence.",
        refocus: "Take 20 seconds and write one takeaway.",
        summary: "Summarize what matters most from this section."
      },
      distraction: {
        title: "Study Attention Drift",
        message: "Your focus appears to be dropping.",
        nextAction: "Set one concrete question this page should answer.",
        fix: "Use question-led reading to reduce drift.",
        hint: "Define the objective before continuing.",
        refocus: "Run a 60-second focused recall sprint.",
        summary: "Summarize your study objective for this block."
      },
      inefficiency: {
        title: "Low-Return Study Loop",
        message: "You may be consuming without extraction.",
        nextAction: "Capture 2 takeaways now.",
        fix: "Convert passive review into active recall.",
        hint: "Ask yourself one question and answer without notes.",
        refocus: "Pause and write two bullet takeaways.",
        summary: "Summarize the top two ideas in plain language."
      }
    },
    watching: {
      confusion: {
        title: "Passive Watching Detected",
        message: "You might be watching without retention.",
        nextAction: "Pause and note one key point.",
        fix: "Checkpoint every key concept with one sentence.",
        hint: "Pause briefly after each major idea.",
        refocus: "Choose continue 3 minutes or switch intentionally.",
        summary: "Summarize what the last 2 minutes explained."
      },
      distraction: {
        title: "Viewing Focus Drift",
        message: "Switching behavior is increasing.",
        nextAction: "Commit to 3 focused minutes.",
        fix: "Remove side tabs and continue intentionally.",
        hint: "Intentional viewing beats background consumption.",
        refocus: "Set a 3-minute focus timer.",
        summary: "Summarize your reason for watching this now."
      },
      inefficiency: {
        title: "Low-Return Consumption",
        message: "Content intake may be low-yield.",
        nextAction: "Capture 2 practical takeaways.",
        fix: "Takeaways turn content into action.",
        hint: "Ask: what will I do differently after this?",
        refocus: "Pause and record one action item.",
        summary: "Summarize one actionable takeaway."
      }
    },
    reading: {
      confusion: {
        title: "Reading Friction Spotted",
        message: "You may be rereading the same part.",
        nextAction: "Paraphrase this section in one sentence.",
        fix: "Reread heading + first sentence, then paraphrase.",
        hint: "Focus on main claim, not details first.",
        refocus: "Set one question for this page.",
        summary: "Summarize the key idea in plain language."
      },
      distraction: {
        title: "Browsing Drift Detected",
        message: "Scrolling and switching have increased.",
        nextAction: "Decide one objective for this page.",
        fix: "Question-led reading keeps browsing purposeful.",
        hint: "Ask what answer you need before continuing.",
        refocus: "Do a 60-second objective-first pass.",
        summary: "Summarize why this page matters to your goal."
      },
      inefficiency: {
        title: "Low Progress Pattern",
        message: "You may be consuming without extracting value.",
        nextAction: "Write one insight and one next action.",
        fix: "Use 1 insight + 1 action per page.",
        hint: "Extraction beats passive consumption.",
        refocus: "Pause and capture one key insight now.",
        summary: "Summarize one insight and one action item."
      }
    }
  };

  const byActivity = templates[context.activityType] || templates.reading;
  const pick = byActivity[issue.type] || templates.reading[issue.type] || templates.reading.confusion;

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
    diagnostics: issue.diagnostics,
    title: pick.title,
    message: pick.message,
    nextAction: pick.nextAction,
    actionPayloads: {
      show_fix: pick.fix,
      give_hint: pick.hint,
      refocus: pick.refocus,
      summarize: pick.summary
    }
  };
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
  const timeWastedMs = Math.min(
    durationMs,
    session.aggregate.totalIdleMs + session.aggregate.repeatedActionBursts * 4000
  );

  const contextBreakdown = Object.entries(session.contextsSeen)
    .map(([context, count]) => ({ context, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const refocusActions = session.interventions.filter((entry) => entry.userAction === "refocus").length;
  const interventionEffectiveness = session.interventions.length
    ? Number((refocusActions / session.interventions.length).toFixed(2))
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

function capitalize(value) {
  if (!value) {
    return "";
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
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
  return raw ? JSON.parse(raw) : null;
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
