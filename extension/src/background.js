const tabSessions = new Map();

const SESSION_COOLDOWN_MS = {
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nudge_ready: true, nudge_version: "2.0.0" });
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
  const issue = detectIssue(session, metrics, context);
  const signal = buildSignal(issue, metrics);

  let intervention = null;
  if (issue) {
    bumpIssueCounters(session, issue.type);
    addTimeline(
      session,
      "issue_detected",
      `${capitalize(issue.type)} detected`,
      `${context.activityType} on ${context.domain}`
    );

    if (canEmitIntervention(session, issue.type)) {
      intervention = buildIntervention(issue, context);
      session.interventions.unshift(intervention);
      session.interventions = session.interventions.slice(0, 14);

      addTimeline(session, "intervention_triggered", intervention.title, intervention.message);

      chrome.tabs
        .sendMessage(tabId, {
          type: "NUDGE_INTERVENTION",
          intervention,
          signal,
          context,
          timeline: session.timeline.slice(0, 8)
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
    timeline: session.timeline.slice(0, 8)
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
      timeline: session.timeline.slice(0, 8)
    };
  }

  target.userAction = action;
  target.respondedAt = Date.now();
  target.applied = action === "refocus";

  if (action === "refocus") {
    simulateImprovement(session, target.type);
  }

  if (ACTION_SNOOZE_MS[action] && target.type) {
    session.snoozedByType[target.type] = Date.now() + ACTION_SNOOZE_MS[action];
  }

  addTimeline(
    session,
    "user_action",
    `User selected ${actionLabel(action)}`,
    `${capitalize(target.type)} intervention`
  );

  session.updatedAt = Date.now();
  await persistState(tabId, session);

  return {
    ok: true,
    signal: session.lastSignal,
    context: session.context,
    intervention: target,
    timeline: session.timeline.slice(0, 8)
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
      confusion: 0,
      distraction: 0,
      inefficiency: 0
    },
    interventions: [],
    timeline: [],
    lastInterventionByType: {},
    snoozedByType: {},
    lastSignal: {
      issueType: null,
      issueSeverity: null,
      confusionScore: 0,
      distractionScore: 0,
      inefficiencyScore: 0
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
  const isDecisionOsSurface =
    domain.includes("nudge-frontend") || domain.includes("decisionos") || domain.includes("vercel.app");

  const codingSignals = [
    "function",
    "class ",
    "const ",
    "leetcode",
    "github",
    "stackblitz",
    "replit",
    "codesandbox",
    "terminal"
  ];
  const learningSignals = [
    "course",
    "lesson",
    "quiz",
    "tutorial",
    "lecture",
    "chapter",
    "practice"
  ];
  const writingSignals = ["draft", "paragraph", "essay", "outline", "document", "notion", "docs"];

  const evidence = [];

  const isCoding = matchesAny(domain, [
    "github.com",
    "leetcode.com",
    "replit.com",
    "stackblitz.com",
    "codesandbox.io"
  ]) || includesAny(text, codingSignals);

  const isWatching = metrics.hasVideo || matchesAny(domain, ["youtube.com", "udemy.com", "vimeo.com", "netflix.com"]);
  const isWriting =
    (metrics.hasEditable && metrics.typingSpeed > 0.45) ||
    matchesAny(domain, ["docs.google.com", "notion.so", "medium.com"]) ||
    includesAny(text, writingSignals);
  const isLearning = matchesAny(domain, [
    "khanacademy.org",
    "coursera.org",
    "edx.org",
    "udemy.com",
    "wikipedia.org"
  ]) || includesAny(text, learningSignals);

  let category = "unknown";
  let activityType = "none_detected";
  let confidence = 0;

  if (isCoding) {
    category = "problem_solving";
    activityType = "coding";
    evidence.push("Code-like tokens detected");
    confidence = 0.8;
  } else if (isWriting) {
    category = "writing";
    activityType = "writing";
    evidence.push("Active writing behavior");
    confidence = 0.72;
  } else if (isWatching) {
    category = "consuming_content";
    activityType = "watching";
    evidence.push("Video consumption context");
    confidence = 0.66;
  } else if (isLearning) {
    category = "learning";
    activityType = "studying";
    evidence.push("Educational context signal");
    confidence = 0.7;
  } else if (!isDecisionOsSurface && includesAny(text, ["article", "research", "blog", "paper", "report"])) {
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
  if (context.activityType === "none_detected") {
    return null;
  }

  const totalKeystrokes = session.aggregate.totalKeystrokes;
  const totalScrollDistance = session.aggregate.totalScrollDistance;
  const meaningfulActivity = totalKeystrokes >= 8 || totalScrollDistance >= 1000 || metrics.timeOnTaskMs > 45000;

  if (!meaningfulActivity) {
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
  const slowProgress = metrics.timeOnTaskMs > 150000 && metrics.typingSpeed < 0.4 ? clamp(metrics.timeOnTaskMs / 420000) : 0;

  const confusionScore =
    pauseFactor * 0.35 + repeatFactor * 0.25 + retriesFactor * 0.2 + deletionFactor * 0.2;
  const distractionScore =
    tabFactor * 0.35 + idleFactor * 0.35 + scrollBurstFactor * 0.2 + lowTypingFactor * 0.1;
  const inefficiencyScore =
    slowProgress * 0.4 + repeatFactor * 0.35 + clamp(metrics.scrollSpeed / 1600) * 0.15 + lowTypingFactor * 0.1;

  const candidates = [
    {
      type: "confusion",
      score: confusionScore,
      threshold: 0.62,
      reason: `Behavior suggests a stuck moment while ${context.activityType}.`
    },
    {
      type: "distraction",
      score: distractionScore,
      threshold: 0.56,
      reason: `Attention drift detected during ${context.activityType}.`
    },
    {
      type: "inefficiency",
      score: inefficiencyScore,
      threshold: 0.58,
      reason: `Progress appears inefficient for the current context.`
    }
  ].sort((a, b) => b.score - a.score);

  const top = candidates[0];
  if (!top || top.score < top.threshold) {
    return null;
  }

  session.aggregate.totalDetections += 1;

  return {
    type: top.type,
    score: Number(top.score.toFixed(2)),
    severity: severityFromScore(top.score),
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
    return {
      issueType: null,
      issueSeverity: null,
      confusionScore: 0,
      distractionScore: 0,
      inefficiencyScore: 0
    };
  }

  return {
    issueType: issue.type,
    issueSeverity: issue.severity,
    confusionScore: issue.diagnostics?.confusionScore || 0,
    distractionScore: issue.diagnostics?.distractionScore || 0,
    inefficiencyScore: issue.diagnostics?.inefficiencyScore || 0
  };
}

function canEmitIntervention(session, issueType) {
  const now = Date.now();

  if ((session.snoozedByType[issueType] || 0) > now) {
    return false;
  }

  const unresolvedIntervention = session.interventions.some(
    (entry) => !entry.userAction && now - entry.ts < 4 * 60 * 1000
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

function buildIntervention(issue, context) {
  const templates = {
    coding: {
      confusion: {
        title: "Stuck While Coding",
        message: "You look blocked. Want a targeted hint for the next step?",
        nextAction: "Write one tiny test input, then solve only that case.",
        fix: "Use smallest-case debugging: input -> expected output -> first failing line.",
        hint: "Start with one edge case and prove it works before scaling up.",
        refocus: "Do a 90-second single-tab sprint on only one bug.",
        summary: "Summarize the bug, expected output, and next line to edit."
      },
      distraction: {
        title: "Focus Drift During Coding",
        message: "You switched context a lot. Want a 90-second focus sprint?",
        nextAction: "Set one micro-goal: finish one function, then re-check.",
        fix: "Keep one task tab and one reference tab open only.",
        hint: "Complete one micro-goal before opening another tab.",
        refocus: "Start a 90-second focus sprint with a single objective.",
        summary: "Summarize your one coding objective for the next 90 seconds."
      },
      inefficiency: {
        title: "Simpler Path Available",
        message: "Your workflow looks repetitive. Want a faster strategy?",
        nextAction: "Define one clear next action before editing more.",
        fix: "State one target outcome, then implement directly.",
        hint: "Optimize for one complete pass over multiple partial edits.",
        refocus: "Pause for 20 seconds and commit to one planned step.",
        summary: "Summarize your immediate next action."
      }
    },
    writing: {
      confusion: {
        title: "Clarity Dip Detected",
        message: "This writing pass looks stuck. Want a clarity nudge?",
        nextAction: "Rewrite one sentence with subject + action + outcome.",
        fix: "Try the one-line thesis method before editing the full paragraph.",
        hint: "Focus on one claim, then support it with one concrete detail.",
        refocus: "Write two new sentences without editing.",
        summary: "Summarize your paragraph intent in one sentence."
      },
      distraction: {
        title: "Writing Focus Slipping",
        message: "Frequent context switching detected. Resume with a quick anchor?",
        nextAction: "Write the next 2 sentences without editing.",
        fix: "Draft first, polish second. Keep momentum for 2 minutes.",
        hint: "Momentum matters more than perfect phrasing during drafting.",
        refocus: "Set a 2-minute no-edit sprint.",
        summary: "Summarize what this paragraph should deliver."
      },
      inefficiency: {
        title: "Revision Loop Detected",
        message: "You are revising repeatedly. Want a cleaner workflow?",
        nextAction: "Separate drafting and editing into two short passes.",
        fix: "Run a 60-second draft sprint, then one 30-second edit sprint.",
        hint: "Finish idea flow before polishing wording.",
        refocus: "Switch to draft mode for one minute.",
        summary: "Summarize your next draft pass objective."
      }
    },
    studying: {
      confusion: {
        title: "Comprehension Check",
        message: "This section may be unclear. Want a quick understanding check?",
        nextAction: "Summarize the section in one sentence from memory.",
        fix: "Use read -> close -> recall for one key idea right now.",
        hint: "If recall is hard, re-read just the heading and first sentence.",
        refocus: "Take 20 seconds and write one takeaway.",
        summary: "Summarize what you just learned without looking."
      },
      distraction: {
        title: "Attention Drift During Study",
        message: "Attention is dropping. Want a short reset?",
        nextAction: "Take 20 seconds, breathe, then capture one key takeaway.",
        fix: "Write one bullet for what matters most before continuing.",
        hint: "Define a single question this page should answer.",
        refocus: "Run a 60-second focused recall sprint.",
        summary: "Summarize your study objective for this block."
      },
      inefficiency: {
        title: "Study Loop Detected",
        message: "Progress is slow. Want a more efficient tactic?",
        nextAction: "Switch to active recall for 60 seconds.",
        fix: "Ask yourself one question and answer without looking at notes.",
        hint: "Extraction beats passive rereading.",
        refocus: "Pause and capture two concrete takeaways.",
        summary: "Summarize one idea and one next step."
      }
    },
    watching: {
      confusion: {
        title: "Passive Watching Detected",
        message: "Want to lock in this content with a quick checkpoint?",
        nextAction: "Pause and write one sentence about the last 2 minutes.",
        fix: "Set a pause-every-key-idea rule for better retention.",
        hint: "Checkpoint once per concept, not at random moments.",
        refocus: "Commit to 3 focused minutes or intentionally switch tasks.",
        summary: "Summarize the last two minutes in one line."
      },
      distraction: {
        title: "Viewing Focus Drift",
        message: "You are switching often. Continue or change task intentionally?",
        nextAction: "Choose: finish 3 more minutes or switch with purpose.",
        fix: "Intentional switch beats accidental scrolling. Choose one path now.",
        hint: "Make a binary decision: continue this or close it.",
        refocus: "Set a 3-minute timer and stay on this page.",
        summary: "Summarize why this content matters right now."
      },
      inefficiency: {
        title: "Low-Return Consumption",
        message: "You may be consuming without extraction. Want a faster loop?",
        nextAction: "Capture 2 takeaways before continuing.",
        fix: "Takeaways convert passive content into usable knowledge.",
        hint: "Ask what you will do differently after this video.",
        refocus: "Pause and write one action item.",
        summary: "Summarize one actionable takeaway."
      }
    },
    reading: {
      confusion: {
        title: "Reading Friction Spotted",
        message: "You might be rereading. Want a quick comprehension move?",
        nextAction: "Paraphrase this section in one sentence.",
        fix: "If paraphrasing is hard, reread only the heading and first sentence.",
        hint: "Focus on the main claim, not every detail first.",
        refocus: "Set one question this page should answer.",
        summary: "Summarize the key idea in plain language."
      },
      distraction: {
        title: "Browsing Drift Detected",
        message: "Scrolling and switching increased. Re-anchor now?",
        nextAction: "Define one question this page should answer.",
        fix: "Question-led reading keeps browsing purposeful.",
        hint: "Keep one objective visible while browsing.",
        refocus: "Do a 60-second objective-first pass.",
        summary: "Summarize why this page matters to your goal."
      },
      inefficiency: {
        title: "Low Progress Pattern",
        message: "You may be reading without extracting value. Want a tactical reset?",
        nextAction: "Write one key point and one next action.",
        fix: "Use 1 insight + 1 action per page for faster outcomes.",
        hint: "Turn each page into one concrete decision.",
        refocus: "Pause and capture one insight now.",
        summary: "Summarize one insight and one next action."
      }
    }
  };

  const byActivity = templates[context.activityType] || templates.reading;
  const pick = byActivity[issue.type] || templates.reading[issue.type] || templates.reading.confusion;

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
    diagnostics: issue.diagnostics,
    title: pick.title,
    message: pick.message,
    nextAction: pick.nextAction,
    actionPayloads: {
      show_fix: pick.fix,
      give_hint: pick.hint,
      refocus: pick.refocus,
      summarize: pick.summary
    },
    impactBefore: "~5 min likely wasted",
    impactAfter: "~2 min after intervention"
  };
}

function simulateImprovement(session, issueType) {
  const next = { ...(session.lastSignal || {}) };

  if (!issueType || !next.issueType) {
    return;
  }

  next.confusionScore = Number(Math.max(0, (next.confusionScore || 0) - 0.2).toFixed(2));
  next.distractionScore = Number(Math.max(0, (next.distractionScore || 0) - 0.2).toFixed(2));
  next.inefficiencyScore = Number(Math.max(0, (next.inefficiencyScore || 0) - 0.2).toFixed(2));

  if (
    issueType === next.issueType &&
    Math.max(next.confusionScore, next.distractionScore, next.inefficiencyScore) < 0.45
  ) {
    next.issueType = null;
    next.issueSeverity = null;
  }

  session.lastSignal = next;
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

  session.timeline = session.timeline.slice(0, 40);
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
      timeline: session.timeline
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
    show_fix: "Show Fix",
    give_hint: "Give Hint",
    refocus: "Refocus",
    summarize: "Summarize"
  };
  return labels[action] || "Refocus";
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

function numberOrZero(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return 0;
}

function clamp(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function capitalize(value) {
  if (!value) {
    return "";
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
