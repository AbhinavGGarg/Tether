import { CONTEXT_PROFILES } from "./knowledgeGraph.js";

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
    contextSample: String(raw.contextSample || ""),
    pageTextSample: String(raw.pageTextSample || ""),
    pageTitle: String(raw.pageTitle || ""),
    url: String(raw.url || ""),
    hasVideo: Boolean(raw.hasVideo),
    hasEditable: Boolean(raw.hasEditable)
  };
}

function classifyContext(metrics) {
  const url = metrics.url || "";
  const domain = domainFromUrl(url);
  const text = `${metrics.pageTitle} ${metrics.contextSample} ${metrics.pageTextSample}`.toLowerCase();
  const isDecisionOsSurface =
    domain.includes("nudge-frontend") || domain.includes("decisionos") || domain.includes("vercel.app");

  const isCoding = matchesContext("coding", domain, text);
  const isWatching = metrics.hasVideo || matchesContext("watching", domain, text);
  const isWriting = (metrics.hasEditable && metrics.typingSpeed > 0.45) || matchesContext("writing", domain, text);
  const isStudying = matchesContext("studying", domain, text);

  let activityType = "none_detected";
  let category = "unknown";
  let confidence = 0;
  const evidence = [];

  if (isCoding) {
    activityType = "coding";
    category = "problem_solving";
    evidence.push("Code context signal");
    confidence = 0.8;
  } else if (isWriting) {
    activityType = "writing";
    category = "writing";
    evidence.push("Active writing signal");
    confidence = 0.72;
  } else if (isWatching) {
    activityType = "watching";
    category = "consuming_content";
    evidence.push("Video context signal");
    confidence = 0.66;
  } else if (isStudying) {
    activityType = "studying";
    category = "learning";
    evidence.push("Learning context signal");
    confidence = 0.7;
  } else if (!isDecisionOsSurface && includesAny(text, ["article", "research", "blog", "paper", "report"])) {
    activityType = "reading";
    category = "consuming_content";
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
  if (!session) {
    return null;
  }

  if (context.activityType === "none_detected") {
    return null;
  }

  const meaningfulActivity =
    session.aggregate.totalKeystrokes >= 8 ||
    session.aggregate.totalScrollDistance >= 1000 ||
    metrics.timeOnTaskMs > 45000;

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
      reason: `Repeated retries plus pauses suggest you are stuck while ${context.activityType}.`
    },
    {
      type: "distraction",
      score: distractionScore,
      threshold: 0.56,
      reason: `Idle time and context switches suggest attention drift during ${context.activityType}.`
    },
    {
      type: "inefficiency",
      score: inefficiencyScore,
      threshold: 0.58,
      reason: `Current behavior suggests low-return effort for this ${context.activityType} flow.`
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
    confusionScore: issue.diagnostics?.confusionScore || 0,
    distractionScore: issue.diagnostics?.distractionScore || 0,
    inefficiencyScore: issue.diagnostics?.inefficiencyScore || 0
  };
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

function severityFromScore(score) {
  if (score >= 0.82) {
    return "high";
  }
  if (score >= 0.68) {
    return "medium";
  }
  return "low";
}

function matchesContext(profileKey, domain, text) {
  const profile = CONTEXT_PROFILES[profileKey];
  if (!profile) {
    return false;
  }
  return profile.domains.some((entry) => domain.includes(entry)) || profile.keywords.some((token) => text.includes(token));
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
  return Number.isFinite(numeric) ? numeric : 0;
}

function includesAny(text, tokens) {
  return tokens.some((token) => text.includes(token));
}

export { buildSignal, classifyContext, detectIssue, emptyContext, emptySignal, normalizeMetrics };
