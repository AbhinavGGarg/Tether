import { CONTEXT_PROFILES } from "./knowledgeGraph.js";

const STRICT_INACTIVITY_MS = 60 * 1000;

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
  const isNudgeSurface =
    domain.includes("nudge-frontend") || domain.includes("nudge") || domain.includes("vercel.app");

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
  } else if (!isNudgeSurface && includesAny(text, ["article", "research", "blog", "paper", "report"])) {
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
      type: "inactivity",
      strategy: "inactivity_strict",
      displayType: "Inactivity",
      severity: "high",
      score: Number(diagnostics.distractionScore.toFixed(2)),
      reason: "You've been inactive for 60 seconds.",
      diagnostics
    };
  }

  if (context.activityType === "none_detected") {
    return null;
  }

  const noFreshActivity =
    metrics.keystrokesDelta === 0 && metrics.scrollDistance === 0 && metrics.tabSwitchesDelta === 0;

  if (noFreshActivity && metrics.idleDurationMs < STRICT_INACTIVITY_MS) {
    return null;
  }

  if (metrics.idleDurationMs > STRICT_INACTIVITY_MS) {
    return {
      type: "distraction",
      displayType: "Distraction",
      score: diagnostics.distractionScore,
      severity: severityFromScore(diagnostics.distractionScore),
      reason: "No activity detected for an extended stretch.",
      diagnostics
    };
  }

  const meaningfulActivity =
    session.aggregate.totalKeystrokes >= 8 ||
    session.aggregate.totalScrollDistance >= 1000 ||
    metrics.timeOnTaskMs > 30000;

  if (!meaningfulActivity) {
    return null;
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
    return null;
  }

  return {
    type: top.type,
    displayType: top.type === "procrastination" ? "Procrastination" : "Distraction",
    severity: severityFromScore(top.score),
    score: Number(top.score.toFixed(2)),
    reason: top.reason,
    diagnostics
  };
}

function buildSignal(issue) {
  if (!issue) {
    return emptySignal();
  }

  return {
    issueType: issue.type,
    issueDisplayType: issue.displayType || humanizeIssue(issue.type),
    issueSeverity: issue.severity,
    statusLabel:
      issue.type === "inactivity"
        ? "Inactivity detected"
        : issue.type === "distraction"
          ? "Distraction detected"
          : "Procrastination detected",
    procrastinationScore: issue.diagnostics?.procrastinationScore || 0,
    distractionScore: issue.diagnostics?.distractionScore || 0,
    focusScore: issue.diagnostics?.focusScore || 72,
    focusImprovementPct: 0
  };
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

function humanizeIssue(issueType) {
  return String(issueType || "issue").replaceAll("_", " ");
}

export { buildSignal, classifyContext, detectIssue, emptyContext, emptySignal, normalizeMetrics };
