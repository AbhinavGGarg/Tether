const NUDGE_TAG = "nudge-extension-root";
const NUDGE_DOCK_TAG = "nudge-extension-dock";
const BRAND_NAME = "Tether";
const BLOCKED_MONITOR_PAGES = [
  { host: "accounts.google.com", pathPrefix: "/v3/signin" },
  { host: "accounts.google.com", pathPrefix: "/ServiceLogin" },
  { host: "accounts.google.com", pathPrefix: "/signin" }
];

const STRICT_INACTIVITY_MS = 60 * 1000;
const SECONDARY_INACTIVITY_MS = 150 * 1000;

let sessionStartedAt = Date.now();
let lastInputAt = Date.now();
let lastInteractionAt = Date.now();
let lastActivityTime = Date.now();

let keyEvents = [];
let editEvents = [];
let scrollEvents = [];

let keystrokesDelta = 0;
let tabSwitchesDelta = 0;
let scrollDistanceDelta = 0;
let lastScrollY = window.scrollY || 0;
let previousText = "";

let issueActive = false;
let currentIssue = null;
let lastActionNote = "";

let lockInTimerId = null;
let lockInRemainingSec = 0;

let overlay;
let overlayCard;
let overlayBody;
let dock;
let dockButton;
let dockPanel;
let dockOpen = false;
let noteTimerId = null;
let currentPageKey = buildPageKey(window.location);
let interruptionEvents = [];
let interruptionStats = {
  lostFocusCount: 0,
  recoveredCount: 0,
  savedMinutes: 0,
  patternDetections: 0
};

boot();

function boot() {
  if (shouldSkipMonitoringPage(window.location)) {
    return;
  }

  createCenteredPopup();
  createDock();
  renderDock();

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("visibilitychange", onVisibilityChange, true);

  setInterval(checkInactivity, 1000);
  setInterval(publishMetrics, 2000);
  setInterval(ensureUiPresence, 2000);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    // Ignore remote intervention templates here; strict inactivity is local and deterministic.
    if (message.type === "NUDGE_INTERVENTION") {
      sendResponse({ ok: true, ignored: true });
    }
  });
}

function onMouseMove(event) {
  if (!event.isTrusted) {
    return;
  }
  registerActivity();
}

function onClick(event) {
  if (!event.isTrusted) {
    return;
  }
  registerActivity();
}

function onKeyDown(event) {
  if (!event.isTrusted) {
    return;
  }

  registerActivity();

  if (isSensitiveTarget(event.target)) {
    return;
  }

  const safeKey = typeof event.key === "string" ? event.key : "";
  if (!safeKey) {
    return;
  }

  const trackable = safeKey.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(safeKey);
  if (!trackable) {
    return;
  }

  const now = Date.now();
  keyEvents.push(now);
  lastInputAt = now;
  keystrokesDelta += 1;

  if (safeKey === "Backspace" || safeKey === "Delete") {
    editEvents.push({ ts: now, type: "delete" });
  }
}

function onInput(event) {
  if (!event.isTrusted) {
    return;
  }
  if (isSensitiveTarget(event.target) || !isTrackableInputTarget(event.target)) {
    return;
  }

  const now = Date.now();
  lastInputAt = now;
  registerActivity(false);

  const text = String(extractWorkingText() || "");
  if (text.length > previousText.length) {
    editEvents.push({ ts: now, type: "insert" });
  } else if (text.length < previousText.length) {
    editEvents.push({ ts: now, type: "delete" });
  }

  previousText = text;
}

function onScroll() {
  const now = Date.now();
  const currentY = window.scrollY || 0;
  const delta = Math.abs(currentY - lastScrollY);
  lastScrollY = currentY;

  scrollEvents.push({ ts: now, delta });
  scrollDistanceDelta += delta;
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    tabSwitchesDelta += 1;
  }
}

function registerActivity(clearIssue = true) {
  const now = Date.now();
  lastActivityTime = now;
  lastInteractionAt = now;
  void clearIssue;

  renderDock();
}

function checkInactivity() {
  const pageKey = buildPageKey(window.location);
  if (pageKey !== currentPageKey) {
    resetForPageChange(pageKey);
    return;
  }

  if (!isCurrentPageActive()) {
    // Pause inactivity tracking while this tab is not active/focused.
    const now = Date.now();
    lastActivityTime = now;
    lastInteractionAt = now;
    hidePopup();
    renderDock();
    return;
  }

  const idleMs = Date.now() - lastActivityTime;
  const inactivityThresholdMs = getInactivityThresholdMs();
  if (!issueActive && idleMs >= inactivityThresholdMs) {
    triggerInactivityIssue(idleMs);
    return;
  }

  if (issueActive) {
    renderPopup();
  }

  renderDock();
}

function triggerInactivityIssue(idleMs) {
  interruptionStats.lostFocusCount += 1;
  const interruptedAgain = registerInterruptionStop();
  const inactivitySeconds = Math.round(getInactivityThresholdMs() / 1000);

  issueActive = true;
  currentIssue = {
    id: `inactivity-${Date.now()}`,
    type: "inactivity",
    severity: "high",
    title: interruptedAgain ? "Interruption Detector" : "Distraction / Inactivity",
    message: interruptedAgain
      ? "You’ve been interrupted multiple times."
      : `You’ve been inactive for ${inactivitySeconds} seconds.`,
    nextAction: interruptedAgain
      ? "You stopped, resumed, and stopped again. Lock back in for 2 minutes to rebuild momentum."
      : "Get back in for 2 minutes to regain focus.",
    idleMs
  };
  lastActionNote = "";
  renderPopup();
  renderDock();

  chrome.runtime.sendMessage(
    {
      type: "NUDGE_METRICS",
      metrics: {
        typingSpeed: 0,
        pauseDurationMs: Date.now() - lastInputAt,
        idleDurationMs: idleMs,
        repeatedActions: 0,
        repeatedEdits: 0,
        deletionRate: 0,
        scrollSpeed: 0,
        scrollBursts: 0,
        scrollDistance: 0,
        tabSwitchesDelta: 0,
        timeOnTaskMs: Date.now() - sessionStartedAt,
        keystrokesDelta: 0,
        pageTitle: document.title,
        url: window.location.href,
        contextSample: `${document.title}\n${extractWorkingText().slice(0, 300)}`,
        pageTextSample: extractPageTextSample(),
        hasVideo: Boolean(document.querySelector("video")),
        hasEditable: hasEditableSurface(),
        inactivityThresholdMs: getInactivityThresholdMs(),
        interruptionStats
      }
    },
    () => {
      void chrome.runtime?.lastError;
    }
  );
}

function clearInactivityIssue() {
  issueActive = false;
  currentIssue = null;
  hidePopup();
  renderDock();
}

function handleIssueAction(action) {
  if (!issueActive || !currentIssue) {
    return;
  }

  if (action === "lock_in_2m") {
    startLockInTimer(120);
    registerInterruptionResume("2-minute lock-in started.");
    interruptionStats.savedMinutes += 2;
    lastActionNote = "Lock-in started for 2 minutes.";
  } else if (action === "resume_task") {
    registerInterruptionResume("Resumed current task.");
    interruptionStats.savedMinutes += 1;
    lastActionNote = "Resumed. Keep momentum.";
  } else if (action === "close_popup") {
    lastActionNote = "Closed by user. Monitoring continues.";
  } else {
    lastActionNote = "Ignored. Monitoring resumed.";
  }

  if (action === "lock_in_2m" || action === "resume_task" || action === "close_popup") {
    registerActivity(false);
  } else {
    lastInteractionAt = Date.now();
  }
  issueActive = false;
  currentIssue = null;
  hidePopup();
  renderDock();

  if (noteTimerId) {
    clearTimeout(noteTimerId);
  }
  noteTimerId = setTimeout(() => {
    lastActionNote = "";
    renderDock();
  }, 5000);
}

function startLockInTimer(seconds) {
  if (lockInTimerId) {
    clearInterval(lockInTimerId);
  }

  lockInRemainingSec = Math.max(0, Number(seconds) || 0);
  lockInTimerId = setInterval(() => {
    lockInRemainingSec -= 1;
    if (lockInRemainingSec <= 0) {
      clearInterval(lockInTimerId);
      lockInTimerId = null;
      lockInRemainingSec = 0;
      lastActionNote = "2-minute lock-in complete. Focus restored.";
    }
    renderDock();
  }, 1000);
}

function createDock() {
  const existing = document.getElementById(NUDGE_DOCK_TAG);
  if (existing) {
    existing.remove();
  }

  dock = document.createElement("div");
  dock.id = NUDGE_DOCK_TAG;
  dock.setAttribute(
    "style",
    [
      "position:fixed",
      "right:10px",
      "top:50%",
      "transform:translateY(-50%)",
      "z-index:2147483645",
      "display:grid",
      "justify-items:end",
      "gap:8px",
      "font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    ].join(";")
  );

  dockPanel = document.createElement("div");
  dockPanel.setAttribute(
    "style",
    [
      "display:none",
      "width:min(330px, calc(100vw - 24px))",
      "padding:10px 12px",
      "border-radius:12px",
      "background:rgba(2,6,23,0.96)",
      "border:1px solid rgba(14,165,233,0.38)",
      "box-shadow:0 14px 30px rgba(2,6,23,0.45)",
      "color:#e2e8f0",
      "font-size:12px",
      "line-height:1.45"
    ].join(";")
  );

  dockButton = document.createElement("button");
  dockButton.type = "button";
  dockButton.setAttribute(
    "style",
    [
      "border-radius:999px",
      "border:1px solid rgba(56,189,248,0.65)",
      "background:#0b1220",
      "color:#e0f2fe",
      "padding:9px 14px",
      "font-size:13px",
      "font-weight:700",
      "cursor:pointer",
      "box-shadow:0 12px 24px rgba(2,6,23,0.45)"
    ].join(";")
  );
  dockButton.textContent = `${BRAND_NAME} Live`;
  dockButton.addEventListener("click", () => {
    dockOpen = !dockOpen;
    renderDock();
  });

  dock.appendChild(dockPanel);
  dock.appendChild(dockButton);
  document.documentElement.appendChild(dock);
}

function renderDock() {
  if (!dock || !dockButton || !dockPanel) {
    return;
  }

  const idleSeconds = Math.floor((Date.now() - lastActivityTime) / 1000);
  const issueLabel = issueActive && currentIssue ? "Inactivity detected" : "No active issue";
  const lockLine = lockInRemainingSec > 0 ? `${lockInRemainingSec}s left in 2-minute lock-in.` : "";

  dockButton.style.borderColor = issueActive ? "rgba(248,113,113,0.65)" : "rgba(14,165,233,0.45)";
  dockButton.style.color = issueActive ? "#fecaca" : "#bae6fd";
  dockButton.textContent = issueActive ? `${BRAND_NAME} Live • Alert` : `${BRAND_NAME} Live`;

  dockPanel.style.display = dockOpen ? "block" : "none";
  const detailedSummary = `You lost focus ${interruptionStats.lostFocusCount} times, recovered ${interruptionStats.recoveredCount} times, and saved ~${interruptionStats.savedMinutes} minutes.`;
  dockPanel.innerHTML = `
    <div style="font-weight:700;font-size:13px;margin-bottom:6px">${BRAND_NAME} Status</div>
    <div><strong>Site:</strong> ${escapeHtml(window.location.hostname || "unknown")}</div>
    <div><strong>State:</strong> Live monitoring</div>
    <div><strong>Issue:</strong> ${escapeHtml(issueLabel)}</div>
    <div><strong>Idle:</strong> ${idleSeconds}s</div>
    ${lockLine ? `<div style="color:#86efac;margin-top:4px">${escapeHtml(lockLine)}</div>` : ""}
    ${lastActionNote ? `<div style="color:#86efac;margin-top:4px">${escapeHtml(lastActionNote)}</div>` : ""}
    <div style="margin-top:8px;color:#bfdbfe">${escapeHtml(detailedSummary)}</div>
    <div style="margin-top:8px;color:#94a3b8">
      ${BRAND_NAME} interventions appear automatically after ${Math.round(getInactivityThresholdMs() / 1000)}s inactivity on this current site.
    </div>
  `;
}

function createCenteredPopup() {
  const existing = document.getElementById(NUDGE_TAG);
  if (existing) {
    existing.remove();
  }

  overlay = document.createElement("div");
  overlay.id = NUDGE_TAG;
  overlay.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
      "z-index:2147483646",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "background:rgba(2,6,23,0.52)",
      "padding:20px"
    ].join(";")
  );

  overlayCard = document.createElement("section");
  overlayCard.setAttribute(
    "style",
    [
      "width:min(560px, calc(100vw - 40px))",
      "background:#0b1220",
      "border:1px solid rgba(248,113,113,0.45)",
      "border-radius:16px",
      "box-shadow:0 24px 52px rgba(2,6,23,0.5)",
      "font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      "color:#e2e8f0"
    ].join(";")
  );

  overlayBody = document.createElement("div");
  overlayBody.setAttribute("style", "padding:18px");

  overlayCard.appendChild(overlayBody);
  overlay.appendChild(overlayCard);
  document.documentElement.appendChild(overlay);
}

function renderPopup() {
  if (!overlay || !overlayBody || !currentIssue || !issueActive) {
    return;
  }

  const idleSeconds = Math.floor((Date.now() - lastActivityTime) / 1000);
  const lockLine = lockInRemainingSec > 0 ? `${lockInRemainingSec}s left in lock-in timer.` : "";

  overlayBody.innerHTML = `
    <div style="display:grid;gap:10px">
      <div style="font-size:22px;font-weight:800;color:#f87171">${escapeHtml(currentIssue.title)}</div>
      <div style="font-size:17px;font-weight:700">${escapeHtml(currentIssue.message)}</div>
      <div style="font-size:15px;color:#cbd5e1">${escapeHtml(currentIssue.nextAction)}</div>
      <div style="font-size:12px;color:#94a3b8">Idle: ${idleSeconds}s</div>
      ${lockLine ? `<div style="font-size:12px;color:#86efac">${escapeHtml(lockLine)}</div>` : ""}
      ${lastActionNote ? `<div style="font-size:12px;color:#86efac">${escapeHtml(lastActionNote)}</div>` : ""}

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        <button data-nudge-action="lock_in_2m" style="background:#22c55e;color:#052e16;border:none;border-radius:10px;padding:8px 12px;cursor:pointer;font-weight:800;font-size:13px">Lock In (2 min)</button>
        <button data-nudge-action="resume_task" style="background:#0ea5e9;color:#f8fafc;border:none;border-radius:10px;padding:8px 12px;cursor:pointer;font-size:13px">Resume</button>
        <button data-nudge-action="close_popup" style="background:rgba(148,163,184,0.18);color:#e2e8f0;border:1px solid rgba(148,163,184,0.4);border-radius:10px;padding:8px 12px;cursor:pointer;font-size:13px">Exit</button>
        <button data-nudge-action="ignore" style="background:rgba(148,163,184,0.25);color:#e2e8f0;border:1px solid rgba(148,163,184,0.4);border-radius:10px;padding:8px 12px;cursor:pointer;font-size:13px">Ignore</button>
      </div>
    </div>
  `;

  overlay.style.display = "flex";

  overlayBody.querySelectorAll("[data-nudge-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-nudge-action");
      if (action) {
        handleIssueAction(action);
      }
    });
  });
}

function hidePopup() {
  if (overlay) {
    overlay.style.display = "none";
  }
}

function publishMetrics() {
  const now = Date.now();
  const tenSec = now - 10000;
  const twentySec = now - 20000;

  keyEvents = keyEvents.filter((ts) => ts >= tenSec);
  editEvents = editEvents.filter((entry) => entry.ts >= twentySec);
  scrollEvents = scrollEvents.filter((entry) => entry.ts >= tenSec);

  const text = String(extractWorkingText() || "");
  const repeatedEdits = editEvents.filter((entry) => entry.type === "delete").length;
  const insertCount = editEvents.filter((entry) => entry.type === "insert").length;
  const deleteCount = repeatedEdits;
  const scrollDistanceRecent = scrollEvents.reduce((sum, entry) => sum + entry.delta, 0);
  const scrollBursts = scrollEvents.filter((entry) => entry.delta > 140).length;

  const metrics = {
    typingSpeed: Number((keyEvents.length / 10).toFixed(2)),
    pauseDurationMs: now - lastInputAt,
    idleDurationMs: now - lastActivityTime,
    repeatedEdits,
    repeatedActions: repeatedEdits + Math.floor(scrollBursts / 2),
    deletionRate: Number((deleteCount / Math.max(1, insertCount + deleteCount)).toFixed(2)),
    scrollSpeed: Number((scrollDistanceRecent / 10).toFixed(2)),
    scrollBursts,
    scrollDistance: Math.round(scrollDistanceDelta),
    tabSwitchesDelta,
    timeOnTaskMs: now - sessionStartedAt,
    keystrokesDelta,
    pageTitle: document.title,
    url: window.location.href,
    pageHost: window.location.hostname,
    pageKey: currentPageKey,
    isPageActive: document.visibilityState === "visible" && document.hasFocus(),
    inactivityThresholdMs: getInactivityThresholdMs(),
    contextSample: `${document.title}\n${text.slice(0, 500)}`,
    pageTextSample: extractPageTextSample(),
    hasVideo: Boolean(document.querySelector("video")),
    hasEditable: hasEditableSurface(),
    interruptionStats
  };

  keystrokesDelta = 0;
  tabSwitchesDelta = 0;
  scrollDistanceDelta = 0;

  chrome.runtime.sendMessage({ type: "NUDGE_METRICS", metrics }, () => {
    void chrome.runtime?.lastError;
  });
}

function ensureUiPresence() {
  if (shouldSkipMonitoringPage(window.location)) {
    return;
  }

  if (!document.getElementById(NUDGE_DOCK_TAG)) {
    createDock();
  }
  if (!document.getElementById(NUDGE_TAG)) {
    createCenteredPopup();
  }
  renderDock();
  if (issueActive) {
    renderPopup();
  }
}

function resetForPageChange(nextPageKey) {
  currentPageKey = nextPageKey;
  sessionStartedAt = Date.now();
  lastInputAt = Date.now();
  lastInteractionAt = Date.now();
  lastActivityTime = Date.now();
  keyEvents = [];
  editEvents = [];
  scrollEvents = [];
  keystrokesDelta = 0;
  tabSwitchesDelta = 0;
  scrollDistanceDelta = 0;
  lastScrollY = window.scrollY || 0;
  previousText = "";
  clearInactivityIssue();
  renderDock();
}

function getInactivityThresholdMs() {
  return interruptionStats.lostFocusCount >= 1 ? SECONDARY_INACTIVITY_MS : STRICT_INACTIVITY_MS;
}

function isCurrentPageActive() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function registerInterruptionStop() {
  interruptionEvents.push("stop");
  if (interruptionEvents.length > 6) {
    interruptionEvents = interruptionEvents.slice(-6);
  }

  const lastThree = interruptionEvents.slice(-3).join(">");
  const interruptedAgain = lastThree === "stop>resume>stop";
  if (interruptedAgain) {
    interruptionStats.patternDetections += 1;
  }
  return interruptedAgain;
}

function registerInterruptionResume(note = "") {
  interruptionEvents.push("resume");
  if (interruptionEvents.length > 6) {
    interruptionEvents = interruptionEvents.slice(-6);
  }
  interruptionStats.recoveredCount += 1;
  if (note) {
    lastActionNote = note;
  }
}

function buildPageKey(locationLike) {
  const host = String(locationLike?.hostname || "").toLowerCase();
  const path = String(locationLike?.pathname || "");
  return `${host}${path}`;
}

function extractWorkingText() {
  const active = document.activeElement;

  if (active && isTextLikeInput(active)) {
    return String(active.value || "").slice(0, 6000);
  }

  if (active && active.isContentEditable) {
    return String(active.textContent || "").slice(0, 6000);
  }

  const textareas = Array.from(document.querySelectorAll("textarea"))
    .filter((node) => !isSensitiveTarget(node))
    .sort((a, b) => (b.value?.length || 0) - (a.value?.length || 0));

  if (textareas[0]) {
    return String(textareas[0].value || "").slice(0, 6000);
  }

  return "";
}

function extractPageTextSample() {
  const candidate =
    document.querySelector("main") || document.querySelector("article") || document.querySelector("section") || document.body;
  const text = (candidate?.innerText || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 700);
}

function hasEditableSurface() {
  return Boolean(
    document.querySelector(
      "textarea, [contenteditable='true'], input[type='text'], input[type='search'], input:not([type])"
    )
  );
}

function isTextLikeInput(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  if (node.tagName === "TEXTAREA") {
    return true;
  }
  if (node.tagName === "INPUT") {
    const input = node;
    const type = (input.type || "text").toLowerCase();
    return ["text", "search", "url", "email", "number"].includes(type);
  }
  return false;
}

function isTrackableInputTarget(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  return isTextLikeInput(node) || node.isContentEditable;
}

function isSensitiveTarget(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  if (node.tagName === "INPUT") {
    const type = (node.type || "").toLowerCase();
    if (["password", "hidden", "tel"].includes(type)) {
      return true;
    }
  }

  return node.closest("[data-nudge-ignore='true']") !== null;
}

function shouldSkipMonitoringPage(locationLike) {
  const host = String(locationLike?.hostname || "").toLowerCase();
  const path = String(locationLike?.pathname || "");

  return BLOCKED_MONITOR_PAGES.some((rule) => host === rule.host && path.startsWith(rule.pathPrefix));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
