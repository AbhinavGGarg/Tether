const tabSessions = new Map();
const SESSION_COOLDOWN_MS = {
  confusion: 18000,
  knowledge_gap: 14000,
  inefficiency: 22000
};

const conceptGraph = {
  variables: { requires: [], refresher: "Variables store values that change as your code executes." },
  functions: { requires: ["variables"], refresher: "Functions package behavior so you can reuse and reason in chunks." },
  loops: { requires: ["variables"], refresher: "Loops repeat operations over collections or conditions." },
  conditionals: { requires: ["variables"], refresher: "Conditionals branch execution using true/false checks." },
  arrays: { requires: ["variables"], refresher: "Arrays hold ordered values and are often processed with loops." },
  recursion: {
    requires: ["functions", "conditionals"],
    refresher: "Recursion solves large problems by reducing them to smaller versions of the same problem."
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nudge_ready: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "NUDGE_METRICS") {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false });
      return;
    }

    const session = ensureSession(tabId, sender?.tab?.url || "");
    const metrics = message.metrics || {};

    ingestMetrics(session, metrics);
    const issue = detectIssue(session, metrics);
    const signal = {
      issueType: issue?.type || null,
      issueSeverity: issue?.severity || null,
      confusionScore: Number((issue?.diagnostics?.confusionScore || 0).toFixed(2))
    };

    let intervention = null;
    if (issue) {
      bumpIssueCounters(session, issue);
      if (canEmitIntervention(session, issue.type)) {
        intervention = buildIntervention(issue);
        session.interventions.unshift(intervention);
        session.interventions = session.interventions.slice(0, 8);
      }
    }

    session.lastSignal = signal;
    session.updatedAt = Date.now();

    persistState(tabId, session).catch(() => {});

    if (intervention) {
      chrome.tabs.sendMessage(tabId, {
        type: "NUDGE_INTERVENTION",
        intervention,
        signal
      });
    }

    sendResponse({ ok: true, signal, intervention });
    return true;
  }

  if (message.type === "NUDGE_APPLY_INTERVENTION") {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false });
      return;
    }

    const session = ensureSession(tabId, sender?.tab?.url || "");
    const interventionId = message.interventionId;
    const target = session.interventions.find((entry) => entry.id === interventionId);
    if (target) {
      target.applied = true;
      const concept = target.concept;
      session.masteryByConcept[concept] = Math.min(0.99, (session.masteryByConcept[concept] || 0.5) + 0.04);
    }

    session.updatedAt = Date.now();
    persistState(tabId, session).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "NUDGE_GET_TAB_STATE") {
    const tabId = message.tabId;
    const key = `nudge_tab_${tabId}`;
    chrome.storage.local.get([key], (result) => {
      sendResponse({ ok: true, state: result[key] || null });
    });
    return true;
  }
});

function ensureSession(tabId, url) {
  if (tabSessions.has(tabId)) {
    return tabSessions.get(tabId);
  }

  const session = {
    tabId,
    url,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    aggregate: {
      totalKeystrokes: 0,
      totalPauseMs: 0,
      repeatedEditBursts: 0,
      unproductiveTimeMs: 0,
      timeOnTaskMs: 0
    },
    issueCounters: {
      confusion: 0,
      knowledge_gap: 0,
      inefficiency: 0
    },
    conceptStats: {},
    masteryByConcept: {
      variables: 0.7,
      functions: 0.66,
      loops: 0.58,
      conditionals: 0.62,
      arrays: 0.68,
      recursion: 0.4
    },
    attempts: [],
    interventions: [],
    lastInterventionByType: {},
    lastSignal: {
      issueType: null,
      issueSeverity: null,
      confusionScore: 0
    },
    lastMetrics: {}
  };

  tabSessions.set(tabId, session);
  return session;
}

function ingestMetrics(session, metrics) {
  session.aggregate.totalKeystrokes += metrics.keystrokesDelta || 0;
  session.aggregate.totalPauseMs += metrics.pauseDurationMs || 0;
  session.aggregate.timeOnTaskMs = Math.max(session.aggregate.timeOnTaskMs, metrics.timeOnProblemMs || 0);

  if ((metrics.pauseDurationMs || 0) > 10000) {
    session.aggregate.unproductiveTimeMs += metrics.pauseDurationMs;
  }
  if ((metrics.repeatedEdits || 0) >= 6) {
    session.aggregate.repeatedEditBursts += 1;
    session.aggregate.unproductiveTimeMs += 3000;
  }

  session.lastMetrics = {
    typingSpeed: metrics.typingSpeed || 0,
    pauseDurationMs: metrics.pauseDurationMs || 0,
    repeatedEdits: metrics.repeatedEdits || 0,
    deletionRate: metrics.deletionRate || 0,
    complexityScore: metrics.complexityScore || 0,
    totalKeystrokes: session.aggregate.totalKeystrokes
  };
}

function detectIssue(session, metrics) {
  const concept = inferConcept(metrics.contextSample || "", session.url);
  const typingSpeed = metrics.typingSpeed || 0;
  const pauseDurationMs = metrics.pauseDurationMs || 0;
  const repeatedEdits = metrics.repeatedEdits || 0;
  const deletionRate = metrics.deletionRate || 0;
  const complexityScore = metrics.complexityScore || 0;
  const nestedLoopSignals = metrics.nestedLoopSignals || 0;

  const confusionSignals = [];
  if (pauseDurationMs > 11000) {
    confusionSignals.push("long_pause");
  }
  if (repeatedEdits >= 6 || deletionRate > 0.32) {
    confusionSignals.push("churn_editing");
  }
  if (typingSpeed < 1.1 && (metrics.timeOnProblemMs || 0) > 60000) {
    confusionSignals.push("slow_progress");
  }

  const confusionScore =
    (pauseDurationMs > 0 ? Math.min(1, pauseDurationMs / 18000) : 0) * 0.4 +
    Math.min(1, repeatedEdits / 10) * 0.3 +
    Math.min(1, Math.max(0, 1.3 - typingSpeed)) * 0.15 +
    Math.min(1, deletionRate * 2) * 0.15;

  const gaps = getPrerequisiteGaps(concept, session.masteryByConcept);

  if (gaps.length > 0 && (confusionSignals.length >= 2 || confusionScore > 0.62)) {
    return {
      type: "knowledge_gap",
      severity: confusionScore > 0.78 ? "high" : "medium",
      concept,
      reason: `This work likely depends on ${gaps[0].missingPrerequisite}, which seems underdeveloped.`,
      diagnostics: {
        confusionSignals,
        confusionScore,
        missingPrerequisite: gaps[0].missingPrerequisite
      }
    };
  }

  if (confusionSignals.length >= 2 || confusionScore > 0.64) {
    return {
      type: "confusion",
      severity: confusionScore > 0.82 ? "high" : "medium",
      concept,
      reason: "Behavior indicates a stuck moment or uncertainty spike.",
      diagnostics: {
        confusionSignals,
        confusionScore
      }
    };
  }

  if (complexityScore > 0.72 || nestedLoopSignals > 0) {
    return {
      type: "inefficiency",
      severity: complexityScore > 0.82 ? "medium" : "low",
      concept,
      reason: "Current solution path appears over-complex for likely task scope.",
      diagnostics: {
        confusionScore,
        complexityScore,
        nestedLoopSignals
      }
    };
  }

  return null;
}

function bumpIssueCounters(session, issue) {
  session.issueCounters[issue.type] = (session.issueCounters[issue.type] || 0) + 1;
  if (!session.conceptStats[issue.concept]) {
    session.conceptStats[issue.concept] = {
      incorrect: 0,
      correct: 0,
      confusionSignals: 0,
      inefficiencyFlags: 0
    };
  }

  if (issue.type === "inefficiency") {
    session.conceptStats[issue.concept].inefficiencyFlags += 1;
  } else {
    session.conceptStats[issue.concept].confusionSignals += 1;
    session.masteryByConcept[issue.concept] = Math.max(0.2, (session.masteryByConcept[issue.concept] || 0.5) - 0.03);
  }
}

function canEmitIntervention(session, issueType) {
  const now = Date.now();
  const lastTs = session.lastInterventionByType[issueType] || 0;
  if (now - lastTs < (SESSION_COOLDOWN_MS[issueType] || 16000)) {
    return false;
  }
  session.lastInterventionByType[issueType] = now;
  return true;
}

function buildIntervention(issue) {
  const preset = {
    confusion: {
      title: "Stuck Moment Detected",
      message: `You seem stuck on ${issue.concept}. Want a 60-second reset?`,
      nextAction: "Write your next 3 steps in pseudocode before typing more code."
    },
    knowledge_gap: {
      title: "Prerequisite Gap Identified",
      message: `This likely depends on ${issue.diagnostics?.missingPrerequisite}. Quick refresher?`,
      nextAction: `Do one tiny ${issue.diagnostics?.missingPrerequisite} example, then retry.`
    },
    inefficiency: {
      title: "Simpler Path Available",
      message: `Your current approach may be over-complex for ${issue.concept}.`,
      nextAction: "Try the smallest correct solution first, then optimize if needed."
    }
  }[issue.type];

  const targetConcept = issue.diagnostics?.missingPrerequisite || issue.concept;
  const node = conceptGraph[targetConcept] || conceptGraph[issue.concept];

  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    ts: Date.now(),
    applied: false,
    type: issue.type,
    severity: issue.severity,
    concept: issue.concept,
    reason: issue.reason,
    title: preset.title,
    message: preset.message,
    nextAction: preset.nextAction,
    miniLesson: `${targetConcept}: ${node?.refresher || "Focus on a small working example first."}`
  };
}

function inferConcept(contextSample, url) {
  const text = `${contextSample || ""} ${url || ""}`.toLowerCase();

  const rules = [
    { concept: "recursion", tests: ["recursion", "recursive", "factorial", "dfs"] },
    { concept: "loops", tests: ["for", "while", "iterate", "loop"] },
    { concept: "conditionals", tests: ["if", "else", "condition", "branch"] },
    { concept: "arrays", tests: ["array", "list", "index", "vector"] },
    { concept: "functions", tests: ["function", "method", "def ", "=>"] }
  ];

  for (const rule of rules) {
    if (rule.tests.some((token) => text.includes(token))) {
      return rule.concept;
    }
  }

  return "variables";
}

function getPrerequisiteGaps(targetConcept, masteryByConcept) {
  const visited = new Set();
  const gaps = [];

  function walk(concept) {
    if (!concept || visited.has(concept)) {
      return;
    }
    visited.add(concept);

    const node = conceptGraph[concept];
    if (!node) {
      return;
    }

    node.requires.forEach((prereq) => {
      const mastery = masteryByConcept[prereq] ?? 0.5;
      if (mastery < 0.62) {
        gaps.push({ concept, missingPrerequisite: prereq, mastery: Number(mastery.toFixed(2)) });
      }
      walk(prereq);
    });
  }

  walk(targetConcept);
  return gaps;
}

async function persistState(tabId, session) {
  const state = {
    tabId,
    url: session.url,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    aggregate: session.aggregate,
    issueCounters: session.issueCounters,
    lastSignal: session.lastSignal,
    lastMetrics: session.lastMetrics,
    interventions: session.interventions,
    masteryByConcept: session.masteryByConcept
  };

  const key = `nudge_tab_${tabId}`;
  await chrome.storage.local.set({
    [key]: state,
    nudge_last_tab: tabId,
    nudge_last_update: Date.now()
  });
}
