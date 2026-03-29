const tabSessions = new Map();

const LIVE_RESULTS_URL = "https://nudge-frontend-ten.vercel.app/live-results";
const BRAND_NAME = "Tether";
const STORAGE_TETHER_ENABLED_KEY = "tether_enabled";
const STRICT_INACTIVITY_MS = 30 * 1000;
const SECONDARY_INACTIVITY_MS = 150 * 1000;
const INACTIVITY_NOTIFICATION_COOLDOWN_MS = 90 * 1000;

const SESSION_COOLDOWN_MS = {
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

let activeTabId = null;
let activeWindowId = null;
let previousActiveTabId = null;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_TETHER_ENABLED_KEY]) {
    return;
  }
  const enabled = changes[STORAGE_TETHER_ENABLED_KEY].newValue !== false;
  void broadcastPowerState(enabled);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_TETHER_ENABLED_KEY], (result) => {
    const nextEnabled = result[STORAGE_TETHER_ENABLED_KEY] !== false;
    chrome.storage.local.set({
      nudge_ready: true,
      nudge_version: "3.0.0",
      [STORAGE_TETHER_ENABLED_KEY]: nextEnabled
    });
  });
  void initializeActiveContext();
});

void initializeActiveContext();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    activeTabId = null;
  }
  if (tabId === previousActiveTabId) {
    previousActiveTabId = null;
  }
  tabSessions.delete(tabId);
  chrome.storage.local.remove([`nudge_tab_${tabId}`]).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo?.status === "complete") {
    await ensureContentScriptInjected(tabId);
    if (tabId === activeTabId) {
      await setTabActiveState(tabId, true);
    }
  }

  if (!tabSessions.has(tabId)) {
    return;
  }

  const session = tabSessions.get(tabId);
  session.url = tab?.url || session.url;
  session.title = tab?.title || session.title;
  const refreshedContext = classifyContext({
    typingSpeed: session.lastMetrics?.typingSpeed || 0,
    pauseDurationMs: session.lastMetrics?.pauseDurationMs || 0,
    idleDurationMs: session.lastMetrics?.idleDurationMs || 0,
    repeatedActions: session.lastMetrics?.repeatedActions || 0,
    repeatedEdits: 0,
    deletionRate: 0,
    scrollSpeed: session.lastMetrics?.scrollSpeed || 0,
    scrollBursts: 0,
    scrollDistance: 0,
    tabSwitchesDelta: session.lastMetrics?.tabSwitchesDelta || 0,
    timeOnTaskMs: session.aggregate?.timeOnTaskMs || 0,
    keystrokesDelta: 0,
    contextSample: "",
    pageTextSample: "",
    pageTitle: session.title || session.context?.pageTitle || "",
    url: session.url || "",
    hasVideo: false,
    hasEditable: false
  });
  session.context = refreshedContext;
  session.updatedAt = Date.now();
  void persistState(tabId, session);
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await setActiveTabContext(tabId, windowId);
  await ensureContentScriptInjected(tabId);
  await setTabActiveState(tabId, true);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (activeTabId !== null) {
      await setTabActiveState(activeTabId, false);
    }
    activeWindowId = null;
    activeTabId = null;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id) {
    await setActiveTabContext(tab.id, windowId);
    await ensureContentScriptInjected(tab.id);
  }
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

  if (message.type === "NUDGE_GET_GLOBAL_LIVE_STATE") {
    getTetherEnabled()
      .then((enabled) => {
        sendResponse({
          ok: true,
          tetherEnabled: enabled,
          state: buildGlobalLiveState(enabled)
        });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "NUDGE_ACTIVITY") {
    handleActivityMessage(message, sender)
      .then((payload) => sendResponse(payload))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "NUDGE_TAB_READY") {
    const tabId = sender?.tab?.id;
    const windowId = sender?.tab?.windowId;
    const isActive = typeof tabId === "number" && tabId === activeTabId && windowId === activeWindowId;
    if (typeof tabId === "number" && typeof windowId === "number" && tabId === activeTabId && windowId === activeWindowId) {
      void setTabActiveState(tabId, true);
    } else if (typeof tabId === "number") {
      void setTabActiveState(tabId, false);
    }
    sendResponse({ ok: true, active: isActive, activeTabId, activeWindowId });
    return true;
  }

  if (message.type === "NUDGE_PING") {
    sendResponse({ ok: true });
    return true;
  }
});

async function handleMetricsMessage(message, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false };
  }

  const tetherEnabled = await getTetherEnabled();
  if (!tetherEnabled) {
    const session = ensureSession(tabId, sender?.tab?.url || "", sender?.tab?.title || "");
    session.lastSignal = {
      issueType: null,
      issueDisplayType: null,
      issueSeverity: null,
      statusLabel: "Tether off",
      procrastinationScore: 0,
      distractionScore: 0,
      focusScore: 72,
      focusImprovementPct: 0
    };
    session.updatedAt = Date.now();
    await persistState(tabId, session);

    return {
      ok: true,
      tetherEnabled: false,
      signal: session.lastSignal,
      intervention: null,
      context: session.context,
      timeline: session.timeline.slice(0, 10),
      liveResultsUrl: LIVE_RESULTS_URL
    };
  }

  const session = ensureSession(tabId, sender?.tab?.url || "", sender?.tab?.title || "");
  const metrics = normalizeMetrics(message.metrics || {}, sender?.tab);
  const context = classifyContext(metrics, sender?.tab);

  session.context = context;
  session.updatedAt = Date.now();

  ingestMetrics(session, metrics);
  processIgnoredReminderFollowUp(session, metrics);

  const detection = detectIssue(session, metrics, context);
  const issue = detection.issue;
  const signal = buildSignal(issue, detection.diagnostics, session.lastSignal);

  let intervention = null;
  if (issue) {
    bumpIssueCounters(session, issue.type);
    addTimeline(session, "issue_detected", `${humanizeIssue(issue.type)} detected`, issue.reason);
    if (issue.interruptionDetected) {
      addTimeline(
        session,
        "interruption_detected",
        "Interruption detector triggered",
        "You stopped, resumed, and stopped again."
      );
      session.recentInterruptionPattern = false;
    }

    if (canEmitIntervention(session, issue)) {
      if (issue.strategy === "inactivity_strict") {
        maybeSendInactivityNotification(session, {
          message: "You stopped working. Get back in for 2 minutes.",
          label: "Reminder sent: Resume session",
          details: "Inactivity reminder notification triggered."
        });
      }

      intervention = buildIntervention(issue, context, detection.diagnostics);
      session.interventions.unshift(intervention);
      session.interventions = session.interventions.slice(0, 20);
      session.pendingIgnoredReminder = null;
      session.activity.issueActive = true;
      session.activity.lastIssueId = intervention.id;

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

  if (!issue) {
    session.activity.issueActive = false;
  }

  session.lastSignal = signal;
  await persistState(tabId, session);

  return {
    ok: true,
    tetherEnabled: true,
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

  const tetherEnabled = await getTetherEnabled();
  if (!tetherEnabled) {
    return { ok: true, tetherEnabled: false };
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
  target.applied = ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "resume_task"].includes(action);
  session.activity.issueActive = false;
  session.activity.lastIssueId = null;

  const snoozeKey = target.strategy === "inactivity_strict" ? "inactivity" : target.type;
  if (ACTION_SNOOZE_MS[action] && snoozeKey) {
    session.snoozedByType[snoozeKey] = Date.now() + ACTION_SNOOZE_MS[action];
  }

  const improvementPct = simulateImprovement(session, target.type, action);
  if (improvementPct > 0) {
    target.improvementNote = `Focus improved by ${improvementPct}%`;
  }

  addTimeline(session, "user_action", `User selected ${actionLabel(action)}`, `${humanizeIssue(target.type)} intervention`);

  if (action === "lock_in_2m") {
    addTimeline(session, "focus_timer_started", "User started 2-minute lock-in", "120-second focus sprint started");
    session.pendingIgnoredReminder = null;
    session.inactivityReminderStopped = false;
  }

  if (action === "refocus_timer") {
    addTimeline(session, "focus_timer_started", "User started focus timer", "60-second refocus sprint started");
  }

  if (action === "ignore" && target.strategy === "inactivity_strict") {
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

  if (action === "resume_task") {
    session.pendingIgnoredReminder = null;
    session.inactivityReminderStopped = false;
  }

  if (action === "resume_task") {
    addTimeline(session, "focus_restored", "Focus improved", `Focus improved by ${improvementPct}%`);
  }

  session.updatedAt = Date.now();
  await persistState(tabId, session);

  return {
    ok: true,
    tetherEnabled: true,
    signal: session.lastSignal,
    context: session.context,
    intervention: target,
    timeline: session.timeline.slice(0, 10),
    liveResultsUrl: LIVE_RESULTS_URL
  };
}

async function handleActivityMessage(message, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false };
  }

  const session = ensureSession(tabId, sender?.tab?.url || "", sender?.tab?.title || "");
  const now = numberOrZero(message.ts) || Date.now();
  const eventType = String(message.eventType || "interaction");
  const keyDelta = Math.max(0, numberOrZero(message.keystrokesDelta));

  session.activity.lastActivityAt = now;
  session.activity.hasInteracted = true;
  session.activity.lastEventType = eventType;

  if (eventType === "keydown") {
    session.activity.totalKeystrokes += keyDelta > 0 ? keyDelta : 1;
  }
  if (eventType === "tab_hidden") {
    session.activity.tabSwitches += 1;
    session.aggregate.totalTabSwitches += 1;
  }

  const tabIsActive = tabId === activeTabId && sender?.tab?.windowId === activeWindowId;
  if (tabIsActive && session.activity.issueActive) {
    session.activity.lastActivityAt = now;
    session.activity.issueActive = false;
    session.activity.lastIssueId = null;
    addTimeline(session, "activity_resumed", "Activity resumed", "Inactivity timer reset after interaction.");
    chrome.tabs.sendMessage(tabId, { type: "NUDGE_HIDE_ISSUE" }).catch(() => {});
  }

  session.lastMetrics = {
    ...(session.lastMetrics || {}),
    totalKeystrokes: session.activity.totalKeystrokes,
    tabSwitchesDelta: session.activity.tabSwitches,
    idleDurationMs: Math.max(0, Date.now() - session.activity.lastActivityAt),
    isPageActive: tabIsActive
  };

  session.updatedAt = Date.now();
  await persistState(tabId, session);

  return { ok: true };
}

async function getTetherEnabled() {
  try {
    const result = await chrome.storage.local.get([STORAGE_TETHER_ENABLED_KEY]);
    return result[STORAGE_TETHER_ENABLED_KEY] !== false;
  } catch {
    return true;
  }
}

async function broadcastPowerState(enabled) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, { type: "NUDGE_TETHER_POWER", enabled: Boolean(enabled) })
          .catch(() => {})
      )
  );
}

async function initializeActiveContext() {
  try {
    const currentWindow = await chrome.windows.getLastFocused();
    if (!currentWindow?.id) {
      return;
    }
    const [active] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
    if (!active?.id) {
      return;
    }
    await setActiveTabContext(active.id, currentWindow.id);
    await ensureContentScriptInjected(active.id);
    await setTabActiveState(active.id, true);
  } catch {
    // Best effort on startup.
  }
}

async function setActiveTabContext(nextTabId, nextWindowId) {
  if (typeof nextTabId !== "number" || typeof nextWindowId !== "number") {
    return;
  }

  if (activeTabId === nextTabId && activeWindowId === nextWindowId) {
    await setTabActiveState(nextTabId, true);
    return;
  }

  previousActiveTabId = activeTabId;
  if (previousActiveTabId !== null && previousActiveTabId !== nextTabId) {
    await setTabActiveState(previousActiveTabId, false);
  }

  activeTabId = nextTabId;
  activeWindowId = nextWindowId;
  await setTabActiveState(nextTabId, true);

  const activeSession = ensureSession(nextTabId, "", "");
  activeSession.activity.tabSwitches += 1;
  activeSession.lastMetrics = {
    ...(activeSession.lastMetrics || {}),
    tabSwitchesDelta: activeSession.activity.tabSwitches,
    isPageActive: true
  };
  activeSession.updatedAt = Date.now();
  await persistState(nextTabId, activeSession);
}

async function setTabActiveState(tabId, active) {
  if (typeof tabId !== "number") {
    return;
  }
  await chrome.tabs
    .sendMessage(tabId, { type: "NUDGE_SET_TAB_ACTIVE", active: Boolean(active), activeTabId, activeWindowId })
    .catch(() => {});
}

async function ensureContentScriptInjected(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  const url = String(tab?.url || "");
  if (!/^https?:\/\//i.test(url)) {
    return;
  }

  try {
    const [{ result: booted }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(globalThis.__TETHER_CONTENT_BOOTED__)
    });
    if (booted) {
      return;
    }
  } catch {
    // Ignore and fallback to direct ping/inject.
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "NUDGE_PING" });
    return;
  } catch {
    // Not injected yet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
  } catch {
    return;
  }
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
      inactivity: 0
    },
    interventions: [],
    timeline: [],
    lastInterventionByType: {},
    snoozedByType: {},
    lastSignal: {
      issueType: null,
      issueDisplayType: null,
      issueSeverity: null,
      statusLabel: "Live monitoring",
      procrastinationScore: 0,
      distractionScore: 0,
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
      totalKeystrokes: 0,
      isPageActive: false
    },
    activity: {
      hasInteracted: false,
      lastActivityAt: Date.now(),
      lastEventType: "none",
      totalKeystrokes: 0,
      tabSwitches: 0,
      issueActive: false,
      lastIssueId: null
    },
    interruptionStats: {
      lostFocusCount: 0,
      recoveredCount: 0,
      savedMinutes: 0,
      patternDetections: 0
    },
    recentInterruptionPattern: false,
    pendingIgnoredReminder: null,
    inactivityReminderStopped: false,
    lastInactivityNotificationAt: 0
  };

  addTimeline(session, "session_started", "Live monitoring started", domainFromUrl(url));

  tabSessions.set(tabId, session);
  return session;
}

function normalizeMetrics(metrics, tab) {
  const tabIsActive = Boolean(tab?.id === activeTabId && tab?.windowId === activeWindowId);
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
    pageHost: String(metrics.pageHost || domainFromUrl(metrics.url || tab?.url || "")),
    pageKey: String(metrics.pageKey || ""),
    isPageActive: Boolean(metrics.isPageActive) && tabIsActive,
    inactivityThresholdMs: numberOrZero(metrics.inactivityThresholdMs),
    hasVideo: Boolean(metrics.hasVideo),
    hasEditable: Boolean(metrics.hasEditable),
    interruptionStats: normalizeInterruptionStats(metrics.interruptionStats)
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
    totalKeystrokes: session.aggregate.totalKeystrokes,
    isPageActive: metrics.isPageActive
  };

  const previousPatternDetections = Number(session.interruptionStats?.patternDetections || 0);
  session.interruptionStats = metrics.interruptionStats;
  session.recentInterruptionPattern = Number(metrics.interruptionStats?.patternDetections || 0) > previousPatternDetections;
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
    focusScore: session.lastSignal?.focusScore || 72,
    pauseDurationMs: metrics.pauseDurationMs,
    idleDurationMs: metrics.idleDurationMs,
    repeatedActions: metrics.repeatedActions,
    tabSwitchesDelta: metrics.tabSwitchesDelta
  };

  if (!metrics.isPageActive) {
    return { issue: null, diagnostics: baseDiagnostics };
  }

  if (!session.activity?.hasInteracted) {
    return { issue: null, diagnostics: baseDiagnostics };
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

  const inactivityThresholdMs = getInactivityThresholdMs(session, metrics);
  const inactivityStrict =
    metrics.isPageActive &&
    Boolean(session.activity?.hasInteracted) &&
    metrics.pauseDurationMs >= inactivityThresholdMs &&
    metrics.idleDurationMs >= inactivityThresholdMs &&
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
        inactivityThresholdMs,
        interruptionDetected: Boolean(session.recentInterruptionPattern),
        reason: session.recentInterruptionPattern
          ? "You’ve been interrupted multiple times."
          : `You've been inactive for ${Math.round(inactivityThresholdMs / 1000)} seconds.`
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

  if (noFreshActivity && metrics.idleDurationMs < inactivityThresholdMs) {
    return { issue: null, diagnostics };
  }

  if (metrics.idleDurationMs > inactivityThresholdMs) {
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
    statusLabel:
      issue.type === "inactivity"
        ? "Inactivity detected"
        : issue.type === "distraction"
          ? "Distraction detected"
          : "Procrastination detected",
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

  const unresolvedIntervention = session.interventions.some(
    (entry) => !entry.userAction && now - entry.ts < 3 * 60 * 1000
  );
  if (unresolvedIntervention) {
    return false;
  }

  const lastTs = session.lastInterventionByType[issueKey] || 0;
  if (now - lastTs < (SESSION_COOLDOWN_MS[issueKey] || 90000)) {
    return false;
  }

  session.lastInterventionByType[issueKey] = now;
  return true;
}

function buildIntervention(issue, context, diagnostics) {
  if (issue.strategy === "inactivity_strict") {
    const inactivitySeconds = Math.round(numberOrZero(issue.inactivityThresholdMs) / 1000) || 30;
    const interruptionMessage = issue.interruptionDetected
      ? "You’ve been interrupted multiple times."
      : `You've been inactive for ${inactivitySeconds} seconds. You may be losing focus.`;
    const interruptionWhy = issue.interruptionDetected
      ? "Pattern detected: stop -> resume -> stop. Your momentum is getting fragmented."
      : `No typing, interaction, or activity was detected for ${inactivitySeconds} seconds.`;
    const interruptionNext = issue.interruptionDetected
      ? "Lock back in now and protect the next 2 minutes without switching."
      : "Lock back in for 2 minutes to regain momentum.";

    return {
      id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
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
      title: issue.interruptionDetected ? "Interruption Detector" : "Distraction / Inactivity",
      message: interruptionMessage,
      what: interruptionMessage,
      why: interruptionWhy,
      nextAction: interruptionNext,
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
      nextAction: "Pick one concrete outcome and stay on it for 30 seconds."
    },
    distraction: {
      title: "Distraction Detected",
      what: "No activity was detected for a while.",
      why: "Extended inactivity usually means attention drift.",
      nextAction: "Run a short focus sprint or take a quick intentional break."
    }
  };

  const pick = templates[issue.type] || templates.distraction;

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
      lock_in_2m: "Start a 2-minute focus sprint and avoid switching tasks.",
      refocus_timer: "Start a 60-second single-task sprint and block all distractions.",
      break_steps: "Break the task into 3 tiny steps and execute step one now.",
      try_new_approach: "Use a different strategy and test one fresh approach.",
      short_break: "Take a 90-second reset, then return with one clear objective.",
      resume_task: "Resume now and finish one concrete outcome before switching."
    },
    actions: ["refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task"],
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

function buildGlobalLiveState(tetherEnabled) {
  const sessions = [...tabSessions.values()];
  const externalSessions = sessions.filter((session) => !isControlSurfaceDomain(session?.context?.domain || session?.url));
  const candidates = externalSessions.filter(
    (session) =>
      Number(session?.aggregate?.totalKeystrokes || 0) > 0 ||
      Number(session?.aggregate?.timeOnTaskMs || 0) > 0 ||
      Boolean(session?.activity?.hasInteracted)
  );

  const recent = candidates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;

  const overall = externalSessions.reduce(
    (acc, session) => {
      acc.totalKeystrokes += Number(session?.aggregate?.totalKeystrokes || 0);
      acc.totalTabSwitches += Number(session?.aggregate?.totalTabSwitches || 0);
      acc.totalScrollDistance += Number(session?.aggregate?.totalScrollDistance || 0);
      acc.totalIdleMs += Number(session?.aggregate?.totalIdleMs || 0);
      acc.timeOnTaskMs += Number(session?.aggregate?.timeOnTaskMs || 0);
      acc.totalDetections += Number(session?.aggregate?.totalDetections || 0);
      acc.issueCounters.procrastination += Number(session?.issueCounters?.procrastination || 0);
      acc.issueCounters.distraction += Number(session?.issueCounters?.distraction || 0);
      acc.issueCounters.inactivity += Number(session?.issueCounters?.inactivity || 0);
      acc.interruptionStats.lostFocusCount += Number(session?.interruptionStats?.lostFocusCount || 0);
      acc.interruptionStats.recoveredCount += Number(session?.interruptionStats?.recoveredCount || 0);
      acc.interruptionStats.savedMinutes += Number(session?.interruptionStats?.savedMinutes || 0);
      acc.interruptionStats.patternDetections += Number(session?.interruptionStats?.patternDetections || 0);

      const contextKey = String(session?.context?.activityType || "none_detected");
      acc.contextCounts[contextKey] = (acc.contextCounts[contextKey] || 0) + 1;
      return acc;
    },
    {
      totalKeystrokes: 0,
      totalTabSwitches: 0,
      totalScrollDistance: 0,
      totalIdleMs: 0,
      timeOnTaskMs: 0,
      totalDetections: 0,
      issueCounters: {
        procrastination: 0,
        distraction: 0,
        inactivity: 0
      },
      interruptionStats: {
        lostFocusCount: 0,
        recoveredCount: 0,
        savedMinutes: 0,
        patternDetections: 0
      },
      contextCounts: {}
    }
  );

  const recentPayload = recent
    ? {
        tabId: recent.tabId,
        url: recent.url,
        title: recent.title,
        updatedAt: recent.updatedAt,
        context: recent.context,
        signal: recent.lastSignal,
        metrics: {
          typingSpeed: Number(recent?.lastMetrics?.typingSpeed || 0),
          idleDurationMs: Number(recent?.lastMetrics?.idleDurationMs || 0),
          pauseDurationMs: Number(recent?.lastMetrics?.pauseDurationMs || 0),
          repeatedActions: Number(recent?.lastMetrics?.repeatedActions || 0),
          scrollSpeed: Number(recent?.lastMetrics?.scrollSpeed || 0),
          tabSwitchesDelta: Number(recent?.lastMetrics?.tabSwitchesDelta || 0),
          timeOnTaskMs: Number(recent?.aggregate?.timeOnTaskMs || 0),
          totalKeystrokes: Number(recent?.aggregate?.totalKeystrokes || 0),
          totalScrollDistance: Number(recent?.aggregate?.totalScrollDistance || 0)
        },
        issueCounters: recent.issueCounters,
        interruptionStats: recent.interruptionStats
      }
    : null;

  return {
    updatedAt: Date.now(),
    tetherEnabled: tetherEnabled !== false,
    activeTabId,
    activeWindowId,
    recent: recentPayload,
    overall
  };
}

async function persistState(tabId, session) {
  const key = `nudge_tab_${tabId}`;
  const detailedSummary = `You lost focus ${session.interruptionStats?.lostFocusCount || 0} times, recovered ${session.interruptionStats?.recoveredCount || 0} times, and saved ~${session.interruptionStats?.savedMinutes || 0} minutes.`;
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
      activity: session.activity,
      interventions: session.interventions,
      timeline: session.timeline,
      pendingIgnoredReminder: session.pendingIgnoredReminder,
      inactivityReminderStopped: session.inactivityReminderStopped,
      lastInactivityNotificationAt: session.lastInactivityNotificationAt || 0,
      liveResultsUrl: LIVE_RESULTS_URL,
      interruptionStats: session.interruptionStats,
      detailedSummary,
      activeTabId,
      activeWindowId
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

function isControlSurfaceDomain(value) {
  const domain = String(value || "").toLowerCase();
  if (!domain) {
    return false;
  }
  return domain.includes("nudge-frontend-ten.vercel.app") || domain.includes("tether-frontend") || domain === "localhost";
}

function matchesAny(domain, patterns) {
  return patterns.some((entry) => domain.includes(entry));
}

function includesAny(text, tokens) {
  return tokens.some((token) => text.includes(token));
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

function normalizeAction(action) {
  const resolved = String(action || "");
  if (
    ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task", "ignore"].includes(
      resolved
    )
  ) {
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

function processIgnoredReminderFollowUp(session, metrics) {
  if (!metrics.isPageActive) {
    return;
  }

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

  maybeSendInactivityNotification(session, {
    message: "You stopped working. Get back in for 2 minutes.",
    label: "Second reminder sent: Resume session",
    details: "Inactivity was ignored for 3 minutes. This is the final reminder.",
    force: true
  });

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

function dispatchBrowserNotification(title, message) {
  if (!chrome.notifications?.create) {
    return;
  }

  chrome.notifications.create(
    `nudge-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/nudge-128.png"),
      title,
      message,
      priority: 2,
      requireInteraction: true
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function maybeSendInactivityNotification(session, { message, label, details, force = false }) {
  if (!session.lastMetrics?.isPageActive) {
    return false;
  }

  const now = Date.now();
  const lastSent = Number(session.lastInactivityNotificationAt || 0);
  if (!force && now - lastSent < INACTIVITY_NOTIFICATION_COOLDOWN_MS) {
    return false;
  }

  dispatchBrowserNotification(`${BRAND_NAME} Alert`, message);
  session.lastInactivityNotificationAt = now;
  addTimeline(session, "reminder_sent", label, details);
  return true;
}

function normalizeInterruptionStats(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    lostFocusCount: Math.max(0, numberOrZero(safe.lostFocusCount)),
    recoveredCount: Math.max(0, numberOrZero(safe.recoveredCount)),
    savedMinutes: Math.max(0, numberOrZero(safe.savedMinutes)),
    patternDetections: Math.max(0, numberOrZero(safe.patternDetections))
  };
}

function getInactivityThresholdMs(session, metrics) {
  const metricThreshold = numberOrZero(metrics?.inactivityThresholdMs);
  if (metricThreshold >= STRICT_INACTIVITY_MS) {
    return metricThreshold;
  }
  return (session?.issueCounters?.inactivity || 0) > 0 ? SECONDARY_INACTIVITY_MS : STRICT_INACTIVITY_MS;
}
