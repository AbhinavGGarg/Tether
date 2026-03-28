const NUDGE_TAG = "nudge-extension-root";
const LIVE_RESULTS_FALLBACK = "https://nudge-frontend-ten.vercel.app";
const BLOCKED_MONITOR_PAGES = [
  { host: "accounts.google.com", pathPrefix: "/v3/signin" },
  { host: "accounts.google.com", pathPrefix: "/ServiceLogin" },
  { host: "accounts.google.com", pathPrefix: "/signin" }
];

let sessionStartedAt = Date.now();
let lastInputAt = Date.now();
let lastInteractionAt = Date.now();

let keyEvents = [];
let editEvents = [];
let scrollEvents = [];

let keystrokesDelta = 0;
let totalKeystrokes = 0;
let tabSwitchesDelta = 0;
let scrollDistanceDelta = 0;
let lastScrollY = window.scrollY || 0;
let previousText = "";

let lastIntervention = null;
let actionDetail = "";
let impactMessage = "";
let resultsUrl = LIVE_RESULTS_FALLBACK;
let recentTimeline = [];

let currentSignal = {
  issueType: null,
  issueDisplayType: null,
  issueSeverity: null,
  statusLabel: "Live monitoring",
  procrastinationScore: 0,
  distractionScore: 0,
  lowFocusScore: 0,
  inefficiencyScore: 0,
  focusScore: 72,
  focusImprovementPct: 0
};

let currentContext = {
  domain: window.location.hostname || "unknown",
  category: "unknown",
  activityType: "none_detected",
  confidence: 0
};

const focusTimer = {
  running: false,
  startedAt: 0,
  durationMs: 60000,
  remainingMs: 60000,
  label: "Refocus Timer Running",
  intervalId: null
};

let isCollapsed = false;
let isClosed = false;
let overlay;
let overlayBody;
let overlayTitle;
let collapseBtn;
let reopenChip;

boot();

function boot() {
  if (shouldSkipMonitoringPage(window.location)) {
    return;
  }

  createOverlay();

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("wheel", onWheel, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("visibilitychange", onVisibilityChange, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "NUDGE_INTERVENTION") {
      if (focusTimer?.running) {
        sendResponse({ ok: true, ignored: true });
        return;
      }

      lastIntervention = sanitizeIntervention(message.intervention || null);
      currentSignal = message.signal || currentSignal;
      currentContext = message.context || currentContext;
      recentTimeline = normalizeTimeline(message.timeline, recentTimeline);
      actionDetail = "";
      renderOverlay();
      sendResponse({ ok: true });
    }
  });

  setInterval(publishMetrics, 2000);
}

function onKeyDown(event) {
  if (!event.isTrusted) {
    return;
  }
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
  lastInteractionAt = now;
  keystrokesDelta += 1;
  totalKeystrokes += 1;

  if (safeKey === "Backspace" || safeKey === "Delete") {
    editEvents.push({ ts: now, type: "delete" });
  }
}

function onInput(event) {
  if (!event.isTrusted) {
    return;
  }
  if (isSensitiveTarget(event.target)) {
    return;
  }
  if (!isTrackableInputTarget(event.target)) {
    return;
  }

  const now = Date.now();
  lastInputAt = now;
  lastInteractionAt = now;

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

function onWheel(event) {
  if (!event.isTrusted) {
    return;
  }
  lastInteractionAt = Date.now();
}

function onTouchMove(event) {
  if (!event.isTrusted) {
    return;
  }
  lastInteractionAt = Date.now();
}

function onPointerDown() {
  lastInteractionAt = Date.now();
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    tabSwitchesDelta += 1;
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
  const pageTextSample = extractPageTextSample();

  const pauseDurationMs = now - lastInputAt;
  const idleDurationMs = now - lastInteractionAt;
  const repeatedEdits = editEvents.filter((entry) => entry.type === "delete").length;
  const insertCount = editEvents.filter((entry) => entry.type === "insert").length;
  const deleteCount = repeatedEdits;
  const scrollDistanceRecent = scrollEvents.reduce((sum, entry) => sum + entry.delta, 0);
  const scrollBursts = scrollEvents.filter((entry) => entry.delta > 140).length;

  const metrics = {
    typingSpeed: Number((keyEvents.length / 10).toFixed(2)),
    pauseDurationMs,
    idleDurationMs,
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
    contextSample: `${document.title}\n${text.slice(0, 500)}`,
    pageTextSample,
    hasVideo: Boolean(document.querySelector("video")),
    hasEditable: hasEditableSurface()
  };

  keystrokesDelta = 0;
  tabSwitchesDelta = 0;
  scrollDistanceDelta = 0;

  chrome.runtime.sendMessage({ type: "NUDGE_METRICS", metrics }, (response) => {
    if (chrome.runtime?.lastError) {
      return;
    }
    if (!response || !response.ok) {
      return;
    }

    if (response.signal) {
      currentSignal = response.signal;
    }
    if (response.context) {
      currentContext = response.context;
    }
    if (response.timeline !== undefined) {
      recentTimeline = normalizeTimeline(response.timeline, recentTimeline);
    }
    if (typeof response.liveResultsUrl === "string" && response.liveResultsUrl.trim()) {
      resultsUrl = response.liveResultsUrl;
    }

    if (response.context?.activityType === "none_detected") {
      lastIntervention = null;
      actionDetail = "";
      impactMessage = "";
    } else if (!focusTimer.running && response.intervention) {
      lastIntervention = sanitizeIntervention(response.intervention);
      actionDetail = "";
      impactMessage = "";
    }

    renderOverlay();
  });
}

function handleInterventionAction(action) {
  if (!lastIntervention) {
    return;
  }

  const actionPayloads = lastIntervention.actionPayloads || {};
  actionDetail = actionPayloads[action] || lastIntervention.nextAction || "";

  if (action === "refocus_timer") {
    startFocusTimer(60000, "Refocus Timer Running");
  }

  if (action === "lock_in_2m") {
    startFocusTimer(120000, "Lock In Timer Running");
  }

  chrome.runtime.sendMessage(
    {
      type: "NUDGE_ACTION",
      interventionId: lastIntervention.id,
      action
    },
    (response) => {
      if (chrome.runtime?.lastError) {
        renderOverlay();
        return;
      }
      if (!response || !response.ok) {
        renderOverlay();
        return;
      }

      if (response.signal) {
        currentSignal = response.signal;
      }
      if (response.context) {
        currentContext = response.context;
      }
      if (response.timeline !== undefined) {
        recentTimeline = normalizeTimeline(response.timeline, recentTimeline);
      }
      if (response.intervention) {
        lastIntervention = sanitizeIntervention(response.intervention);
      }
      if (typeof response.liveResultsUrl === "string" && response.liveResultsUrl.trim()) {
        resultsUrl = response.liveResultsUrl;
      }

      if (currentSignal.focusImprovementPct > 0) {
        impactMessage = `Focus improved by ${currentSignal.focusImprovementPct}%`;
      }

      if (action === "short_break") {
        lastIntervention = null;
      }

      if (action === "resume_task") {
        lastIntervention = null;
      }

      renderOverlay();
    }
  );
}

function startFocusTimer(durationMs, label) {
  if (focusTimer.running) {
    return;
  }

  focusTimer.running = true;
  focusTimer.startedAt = Date.now();
  focusTimer.durationMs = durationMs;
  focusTimer.remainingMs = durationMs;
  focusTimer.label = label || "Refocus Timer Running";

  if (focusTimer.intervalId) {
    clearInterval(focusTimer.intervalId);
  }

  focusTimer.intervalId = setInterval(() => {
    const elapsed = Date.now() - focusTimer.startedAt;
    focusTimer.remainingMs = Math.max(0, focusTimer.durationMs - elapsed);

    if (focusTimer.remainingMs <= 0) {
      clearInterval(focusTimer.intervalId);
      focusTimer.intervalId = null;
      focusTimer.running = false;
      impactMessage = "Focus restored. Focus improved by 40%";
      currentSignal.focusScore = Math.min(100, (currentSignal.focusScore || 60) + 40);
      currentSignal.issueType = null;
      currentSignal.issueDisplayType = null;
      currentSignal.issueSeverity = null;
      currentSignal.statusLabel = "Live monitoring";

      recentTimeline.unshift({
        id: `local-${Date.now()}`,
        eventType: "focus_restored",
        label: "Focus improved",
        ts: Date.now()
      });
      recentTimeline = recentTimeline.slice(0, 10);
    }

    renderOverlay();
  }, 500);
}

function createOverlay() {
  const existingOverlay = document.getElementById(NUDGE_TAG);
  if (existingOverlay) {
    existingOverlay.remove();
  }

  overlay = document.createElement("aside");
  overlay.id = NUDGE_TAG;
  overlay.setAttribute(
    "style",
    [
      "position:fixed",
      "right:14px",
      "bottom:14px",
      "width:390px",
      "max-width:calc(100vw - 28px)",
      "z-index:2147483646",
      "border-radius:16px",
      "background:rgba(2, 6, 23, 0.96)",
      "border:1px solid rgba(148,163,184,0.35)",
      "box-shadow:0 20px 45px rgba(2,6,23,0.38)",
      "font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      "color:#e2e8f0",
      "transition:all 180ms ease"
    ].join(";")
  );

  const head = document.createElement("div");
  head.setAttribute(
    "style",
    [
      "display:flex",
      "justify-content:space-between",
      "align-items:center",
      "padding:10px 12px",
      "border-bottom:1px solid rgba(148,163,184,0.25)"
    ].join(";")
  );

  overlayTitle = document.createElement("strong");
  overlayTitle.textContent = "Nudge Live";
  overlayTitle.style.fontSize = "14px";

  const controls = document.createElement("div");
  controls.setAttribute("style", "display:flex;align-items:center;gap:8px");

  collapseBtn = document.createElement("button");
  collapseBtn.textContent = "Collapse";
  collapseBtn.setAttribute(
    "style",
    [
      "background:#22d3ee",
      "color:#082f49",
      "border:1px solid #67e8f9",
      "border-radius:10px",
      "padding:4px 10px",
      "cursor:pointer",
      "font-size:12px",
      "font-weight:700",
      "line-height:1"
    ].join(";")
  );
  collapseBtn.addEventListener("click", () => {
    isCollapsed = !isCollapsed;
    renderOverlay();
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.setAttribute(
    "style",
    [
      "background:rgba(239,68,68,0.15)",
      "color:#fecaca",
      "border:1px solid rgba(248,113,113,0.45)",
      "border-radius:10px",
      "padding:4px 10px",
      "cursor:pointer",
      "font-size:12px",
      "line-height:1"
    ].join(";")
  );
  closeBtn.addEventListener("click", () => {
    isClosed = true;
    if (overlay) {
      overlay.style.display = "none";
    }
    showReopenChip();
  });

  controls.appendChild(collapseBtn);
  controls.appendChild(closeBtn);
  head.appendChild(overlayTitle);
  head.appendChild(controls);

  overlayBody = document.createElement("div");
  overlayBody.style.padding = "10px 12px";
  overlayBody.style.fontSize = "12px";
  overlayBody.style.lineHeight = "1.45";

  overlay.appendChild(head);
  overlay.appendChild(overlayBody);
  document.documentElement.appendChild(overlay);

  createReopenChip();
  renderOverlay();
}

function renderOverlay() {
  if (isClosed || !overlay || !overlayBody) {
    return;
  }

  overlay.style.width = isCollapsed ? "260px" : "390px";
  overlay.style.maxWidth = "calc(100vw - 28px)";

  if (overlayTitle) {
    overlayTitle.textContent = isCollapsed ? "Nudge (Collapsed)" : "Nudge Live";
  }
  if (collapseBtn) {
    collapseBtn.textContent = isCollapsed ? "Expand" : "Collapse";
  }

  const issueType = currentSignal.issueType;
  const issueDisplayType = currentSignal.issueDisplayType || (issueType ? issueType.replaceAll("_", " ") : "No active issue");
  const issueLabel = issueType ? `${issueDisplayType} (${currentSignal.issueSeverity || "low"})` : "No active issue";
  const statusLabel = currentSignal.statusLabel || "Live monitoring";
  const contextLine = `${currentContext.activityType || "none_detected"} • ${currentContext.category || "unknown"}`;

  const highestRisk = Math.max(
    currentSignal.procrastinationScore || 0,
    currentSignal.distractionScore || 0,
    currentSignal.lowFocusScore || 0,
    currentSignal.inefficiencyScore || 0
  );

  const tone = issueTone(issueType);
  const issueColor = tone === "red" ? "#f87171" : tone === "yellow" ? "#facc15" : "#4ade80";

  if (isCollapsed) {
    overlayBody.innerHTML = `
      <div style="display:grid;gap:4px">
        <div><strong>Context:</strong> ${escapeHtml(contextLine)}</div>
        <div><strong>Issue:</strong> ${escapeHtml(issueLabel)}</div>
        <div><strong>Focus:</strong> ${Math.round(currentSignal.focusScore || 0)}%</div>
      </div>
    `;
    return;
  }

  const timerProgress = Math.round(
    ((focusTimer.durationMs - focusTimer.remainingMs) / Math.max(1, focusTimer.durationMs)) * 100
  );

  const timerHtml = focusTimer.running
    ? `
      <div style="margin-top:10px;padding:9px;border-radius:10px;border:1px solid rgba(14,165,233,0.5);background:rgba(14,165,233,0.12)">
        <div style="font-weight:700;color:#67e8f9">${escapeHtml(focusTimer.label)}</div>
        <div style="margin-top:4px">${Math.ceil(focusTimer.remainingMs / 1000)}s remaining</div>
        <div style="margin-top:6px;height:7px;border-radius:999px;background:rgba(148,163,184,0.2);overflow:hidden">
          <span style="display:block;height:100%;width:${timerProgress}%;background:linear-gradient(90deg,#22d3ee,#4ade80);transition:width 240ms ease"></span>
        </div>
      </div>
    `
    : "";

  const actionButtons = buildActionButtons(lastIntervention, focusTimer.running);
  const actionButtonsHtml = actionButtons
    .map((item) => {
      return `<button data-nudge-action="${escapeHtml(item.id)}" style="${item.style}" ${
        item.disabled ? "disabled" : ""
      }>${escapeHtml(item.label)}</button>`;
    })
    .join("");

  const interventionHtml = lastIntervention
    ? `
      <div style="margin-top:10px;padding:10px;border-radius:10px;border:1px solid ${issueColor};background:rgba(15,23,42,0.45);animation:nudgePulse 1.8s ease-in-out infinite">
        <div style="font-weight:800;color:${issueColor};font-size:13px">${escapeHtml(lastIntervention.title)}</div>
        <div style="margin-top:5px"><strong>What:</strong> ${escapeHtml(lastIntervention.what || lastIntervention.message)}</div>
        <div style="margin-top:4px"><strong>Why:</strong> ${escapeHtml(lastIntervention.why || lastIntervention.reason || "Behavior drift detected.")}</div>
        <div style="margin-top:4px"><strong>Next:</strong> ${escapeHtml(lastIntervention.nextAction)}</div>
        <div style="margin-top:8px;padding:7px;border-radius:8px;background:rgba(15,23,42,0.4);display:${actionDetail ? "block" : "none"}">${escapeHtml(actionDetail || "")}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${actionButtonsHtml}
        </div>
      </div>
    `
    : `<div style="margin-top:10px;color:#94a3b8">Monitoring behavior. Interventions appear when risk patterns are detected.</div>`;

  const timeline = normalizeTimeline(recentTimeline, []);
  const timelineHtml = timeline.length
    ? timeline
        .slice(0, 5)
        .map(
          (item) => `
            <div style="margin-top:6px;padding-left:7px;border-left:2px solid rgba(249,115,22,0.45)">
              <div style="font-size:11px;color:#fb923c;text-transform:uppercase">${escapeHtml(formatEventType(item.eventType))}</div>
              <div>${escapeHtml(item.label || "Event")}</div>
            </div>
          `
        )
        .join("")
    : `<div style="margin-top:6px;color:#94a3b8">No timeline events yet.</div>`;

  overlayBody.innerHTML = `
    <style>@keyframes nudgePulse { 0% { box-shadow: 0 0 0 rgba(248,113,113,0); } 50% { box-shadow: 0 0 0 4px rgba(248,113,113,0.08); } 100% { box-shadow: 0 0 0 rgba(248,113,113,0); }}</style>
    <div style="display:grid;gap:4px">
      <div><strong>Status:</strong> ${escapeHtml(statusLabel)}</div>
      <div><strong>Context:</strong> ${escapeHtml(contextLine)}</div>
      <div><strong>Site:</strong> ${escapeHtml(currentContext.domain || window.location.hostname || "unknown")}</div>
      <div><strong>Issue:</strong> <span style="color:${issueColor}">${escapeHtml(issueLabel)}</span></div>
      <div><strong>Focus score:</strong> ${Math.round(currentSignal.focusScore || 0)}%</div>
      <div><strong>Keystrokes:</strong> ${totalKeystrokes}</div>
      <div style="margin-top:3px;height:7px;border-radius:999px;background:rgba(148,163,184,0.2);overflow:hidden">
        <span style="display:block;height:100%;width:${Math.round(highestRisk * 100)}%;background:linear-gradient(90deg,#f87171,#facc15);transition:width 220ms ease"></span>
      </div>
    </div>

    ${timerHtml}

    ${interventionHtml}

    <div style="margin-top:8px;color:#86efac;min-height:16px;font-weight:700">${escapeHtml(impactMessage)}</div>

    <div style="margin-top:10px;border-top:1px solid rgba(148,163,184,0.2);padding-top:8px">
      <div style="font-weight:700;color:#cbd5e1">Timeline</div>
      ${timelineHtml}
    </div>

    <div style="margin-top:10px;display:flex;justify-content:flex-end">
      <a href="${escapeHtml(resultsUrl || LIVE_RESULTS_FALLBACK)}" target="_blank" rel="noopener noreferrer" style="color:#67e8f9;text-decoration:none;font-weight:700;border:1px solid rgba(103,232,249,0.45);padding:6px 10px;border-radius:8px">View your real live results</a>
    </div>
  `;

  overlayBody.querySelectorAll("[data-nudge-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-nudge-action");
      if (action) {
        handleInterventionAction(action);
      }
    });
  });
}

function issueTone(issueType) {
  if (["procrastination", "distraction"].includes(issueType)) {
    return "red";
  }
  if (["low_focus", "inefficiency"].includes(issueType)) {
    return "yellow";
  }
  return "green";
}

function createReopenChip() {
  const existingChip = document.getElementById("nudge-reopen-chip");
  if (existingChip) {
    existingChip.remove();
  }

  reopenChip = document.createElement("button");
  reopenChip.id = "nudge-reopen-chip";
  reopenChip.textContent = "N";
  reopenChip.setAttribute(
    "style",
    [
      "position:fixed",
      "right:14px",
      "bottom:14px",
      "z-index:2147483647",
      "width:34px",
      "height:34px",
      "border-radius:999px",
      "border:1px solid rgba(14,165,233,0.55)",
      "background:rgba(2,6,23,0.95)",
      "color:#67e8f9",
      "font-weight:700",
      "cursor:pointer",
      "display:none"
    ].join(";")
  );
  reopenChip.addEventListener("click", () => {
    isClosed = false;
    if (overlay) {
      overlay.style.display = "block";
    }
    hideReopenChip();
    renderOverlay();
  });

  document.documentElement.appendChild(reopenChip);
}

function showReopenChip() {
  if (reopenChip) {
    reopenChip.style.display = "block";
  }
}

function hideReopenChip() {
  if (reopenChip) {
    reopenChip.style.display = "none";
  }
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

function formatEventType(value) {
  return String(value || "event").replaceAll("_", " ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shouldSkipMonitoringPage(locationLike) {
  const host = String(locationLike?.hostname || "").toLowerCase();
  const path = String(locationLike?.pathname || "");

  return BLOCKED_MONITOR_PAGES.some((rule) => host === rule.host && path.startsWith(rule.pathPrefix));
}

function sanitizeIntervention(rawIntervention) {
  if (!rawIntervention || typeof rawIntervention !== "object") {
    return null;
  }

  const normalizedActions = normalizeInterventionActions(rawIntervention.actions);
  const textBlob = [
    rawIntervention.title,
    rawIntervention.message,
    rawIntervention.what,
    rawIntervention.why,
    rawIntervention.nextAction
  ]
    .map((value) => String(value || ""))
    .join(" ")
    .toLowerCase();

  const isLegacy =
    textBlob.includes("stuck moment detected") ||
    textBlob.includes("stuck on variables") ||
    textBlob.includes("pseudocode") ||
    textBlob.includes("60-second reset") ||
    normalizedActions.some((action) => ["show_suggestion", "try_action", "mark_applied"].includes(action));

  const actionPayloads = rawIntervention.actionPayloads && typeof rawIntervention.actionPayloads === "object"
    ? rawIntervention.actionPayloads
    : {};

  if (isLegacy) {
    return {
      ...rawIntervention,
      title: "Distraction / Inactivity",
      message: "You’ve been inactive for over a minute. You may be losing focus.",
      what: "You’ve been inactive for over a minute. You may be losing focus.",
      why: "Legacy intervention templates were replaced with behavior-based guidance.",
      nextAction: "Lock back in for 2 minutes to regain momentum.",
      actions: ["lock_in_2m", "resume_task", "ignore"],
      actionPayloads: {
        lock_in_2m: "Start a 2-minute focus sprint and avoid switching tasks.",
        resume_task: "Resume now and complete one concrete step.",
        ignore: "No action taken. You can continue monitoring."
      }
    };
  }

  return {
    ...rawIntervention,
    actions: normalizedActions,
    actionPayloads
  };
}

function normalizeInterventionActions(actions) {
  const source = Array.isArray(actions) && actions.length
    ? actions
    : ["refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task"];

  const mapping = {
    show_suggestion: "break_steps",
    try_action: "resume_task",
    mark_applied: "resume_task",
    show_fix: "break_steps",
    give_hint: "try_new_approach",
    refocus: "refocus_timer",
    summarize: "resume_task"
  };

  const normalized = source
    .map((action) => mapping[action] || action)
    .filter((action) =>
      ["lock_in_2m", "refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task", "ignore"].includes(
        action
      )
    );

  return normalized.length ? Array.from(new Set(normalized)) : ["resume_task"];
}

function normalizeTimeline(value, fallback) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(fallback)) {
    return fallback;
  }
  return [];
}

function buildActionButtons(intervention, timerRunning) {
  if (!intervention) {
    return [];
  }

  const actions = Array.isArray(intervention.actions) && intervention.actions.length
    ? intervention.actions
    : ["refocus_timer", "break_steps", "try_new_approach", "short_break", "resume_task"];

  return actions.map((action) => {
    const style = buttonStyle(action);
    const isTimerAction = action === "refocus_timer" || action === "lock_in_2m";
    return {
      id: action,
      label: buttonLabel(action),
      style,
      disabled: Boolean(timerRunning && isTimerAction)
    };
  });
}

function buttonLabel(action) {
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

function buttonStyle(action) {
  const styles = {
    lock_in_2m:
      "background:#22c55e;color:#052e16;border:none;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px;font-weight:800",
    refocus_timer:
      "background:#22c55e;color:#052e16;border:none;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px;font-weight:800",
    break_steps:
      "background:#0ea5e9;color:#f8fafc;border:none;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px",
    try_new_approach:
      "background:rgba(250,204,21,0.18);color:#fde68a;border:1px solid rgba(250,204,21,0.45);border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px",
    short_break:
      "background:rgba(248,113,113,0.15);color:#fecaca;border:1px solid rgba(248,113,113,0.4);border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px",
    resume_task:
      "background:rgba(74,222,128,0.18);color:#86efac;border:1px solid rgba(74,222,128,0.45);border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px",
    ignore:
      "background:rgba(148,163,184,0.2);color:#cbd5e1;border:1px solid rgba(148,163,184,0.4);border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px"
  };

  return styles[action] || styles.resume_task;
}
