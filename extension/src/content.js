const NUDGE_TAG = "nudge-extension-root";

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
let currentSignal = {
  issueType: null,
  issueSeverity: null,
  confusionScore: 0,
  distractionScore: 0,
  inefficiencyScore: 0
};
let currentContext = {
  domain: window.location.hostname || "unknown",
  category: "unknown",
  activityType: "none_detected",
  confidence: 0
};
let recentTimeline = [];
let actionDetail = "";

let isCollapsed = false;
let isClosed = false;

let overlay;
let overlayBody;
let overlayTitle;
let collapseBtn;
let reopenChip;

boot();

function boot() {
  createOverlay();

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("visibilitychange", onVisibilityChange, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "NUDGE_INTERVENTION") {
      lastIntervention = message.intervention || lastIntervention;
      currentSignal = message.signal || currentSignal;
      currentContext = message.context || currentContext;
      recentTimeline = message.timeline || recentTimeline;
      actionDetail = "";
      renderOverlay();
      sendResponse({ ok: true });
    }
  });

  setInterval(publishMetrics, 2000);
}

function onKeyDown(event) {
  if (isSensitiveTarget(event.target)) {
    return;
  }

  const trackable = event.key.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(event.key);
  if (!trackable) {
    return;
  }

  const now = Date.now();
  keyEvents.push(now);
  lastInputAt = now;
  lastInteractionAt = now;
  keystrokesDelta += 1;
  totalKeystrokes += 1;

  if (event.key === "Backspace" || event.key === "Delete") {
    editEvents.push({ ts: now, type: "delete" });
  }
}

function onInput(event) {
  if (isSensitiveTarget(event.target)) {
    return;
  }

  const now = Date.now();
  lastInputAt = now;
  lastInteractionAt = now;

  const text = extractWorkingText();
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
  lastInteractionAt = now;
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

  const text = extractWorkingText();
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
    if (!response || !response.ok) {
      return;
    }

    if (response.signal) {
      currentSignal = response.signal;
    }
    if (response.context) {
      currentContext = response.context;
    }
    if (response.timeline) {
      recentTimeline = response.timeline;
    }
    if (response.intervention) {
      lastIntervention = response.intervention;
      actionDetail = "";
    } else if (response.context?.activityType === "none_detected") {
      lastIntervention = null;
      actionDetail = "";
    }

    renderOverlay();
  });
}

function handleInterventionAction(action) {
  if (!lastIntervention) {
    return;
  }

  const actionPayloads = lastIntervention.actionPayloads || {};
  const immediateDetail = actionPayloads[action] || lastIntervention.nextAction || "";
  actionDetail = immediateDetail;
  renderOverlay();

  chrome.runtime.sendMessage(
    {
      type: "NUDGE_ACTION",
      interventionId: lastIntervention.id,
      action
    },
    (response) => {
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
      if (response.timeline) {
        recentTimeline = response.timeline;
      }
      if (response.intervention) {
        lastIntervention = response.intervention;
      }

      if (action === "refocus") {
        lastIntervention = null;
        actionDetail = "";
      }

      renderOverlay();
    }
  );
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
      "width:360px",
      "max-width:calc(100vw - 28px)",
      "z-index:2147483646",
      "border-radius:14px",
      "background:rgba(2, 6, 23, 0.95)",
      "border:1px solid rgba(148,163,184,0.35)",
      "box-shadow:0 18px 42px rgba(2,6,23,0.35)",
      "font-family:Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      "color:#e2e8f0"
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
  overlayTitle.textContent = "DecisionOS Live";
  overlayTitle.style.fontSize = "13px";

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
      "border-radius:8px",
      "padding:4px 8px",
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
      "border-radius:8px",
      "padding:4px 8px",
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

  overlay.style.width = isCollapsed ? "250px" : "360px";
  overlay.style.maxWidth = "calc(100vw - 28px)";

  if (overlayTitle) {
    overlayTitle.textContent = isCollapsed ? "DecisionOS (Collapsed)" : "DecisionOS Live";
  }
  if (collapseBtn) {
    collapseBtn.textContent = isCollapsed ? "Expand" : "Collapse";
  }

  const issueLabel = currentSignal.issueType
    ? `${currentSignal.issueType} (${currentSignal.issueSeverity || "low"})`
    : "No active issue";

  const contextLine = `${currentContext.activityType || "none_detected"} • ${currentContext.category || "unknown"}`;

  if (isCollapsed) {
    overlayBody.innerHTML = `
      <div style="display:grid;gap:4px">
        <div><strong>Context:</strong> ${escapeHtml(contextLine)}</div>
        <div><strong>Issue:</strong> ${escapeHtml(issueLabel)}</div>
        <div><strong>Friction:</strong> ${Math.round((currentSignal.confusionScore || 0) * 100)}%</div>
      </div>
    `;
    return;
  }

  const interventionHtml = lastIntervention
    ? `
      <div style="margin-top:10px;padding:9px;border-radius:10px;background:rgba(14,165,233,0.12);border:1px solid rgba(14,165,233,0.35)">
        <div style="font-weight:700;color:#67e8f9">${escapeHtml(lastIntervention.title)}</div>
        <div style="margin-top:4px">${escapeHtml(lastIntervention.message)}</div>
        <div style="margin-top:6px;color:#cbd5e1"><strong>Try:</strong> ${escapeHtml(lastIntervention.nextAction)}</div>
        <div style="margin-top:6px;padding:7px;border-radius:8px;background:rgba(15,23,42,0.35);display:${
          actionDetail ? "block" : "none"
        }">${escapeHtml(actionDetail || "")}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <button id="nudge-show-fix" style="background:#0ea5e9;color:#f8fafc;border:none;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px">Show Fix</button>
          <button id="nudge-give-hint" style="background:rgba(56,189,248,0.18);color:#e0f2fe;border:1px solid rgba(56,189,248,0.5);border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px">Give Hint</button>
          <button id="nudge-refocus" style="background:#22c55e;color:#052e16;border:none;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px;font-weight:700">Refocus</button>
          <button id="nudge-summarize" style="background:rgba(148,163,184,0.2);color:#e2e8f0;border:1px solid rgba(148,163,184,0.35);border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px">Summarize</button>
        </div>
      </div>
    `
    : `<div style="margin-top:10px;color:#94a3b8">Monitoring context and behavior for real-time interventions.</div>`;

  const timelineHtml = recentTimeline.length
    ? recentTimeline
        .slice(0, 4)
        .map(
          (item) => `
            <div style="margin-top:6px;padding-left:7px;border-left:2px solid rgba(249,115,22,0.45)">
              <div style="font-size:11px;color:#fb923c;text-transform:uppercase">${escapeHtml(
                formatEventType(item.eventType)
              )}</div>
              <div>${escapeHtml(item.label || "Event")}</div>
            </div>
          `
        )
        .join("")
    : `<div style="margin-top:6px;color:#94a3b8">No timeline events yet.</div>`;

  overlayBody.innerHTML = `
    <div style="display:grid;gap:4px">
      <div><strong>Status:</strong> Live monitoring</div>
      <div><strong>Context:</strong> ${escapeHtml(contextLine)}</div>
      <div><strong>Site:</strong> ${escapeHtml(currentContext.domain || window.location.hostname || "unknown")}</div>
      <div><strong>Issue:</strong> ${escapeHtml(issueLabel)}</div>
      <div><strong>Keystrokes:</strong> ${totalKeystrokes}</div>
    </div>

    ${interventionHtml}

    <div style="margin-top:10px;border-top:1px solid rgba(148,163,184,0.2);padding-top:8px">
      <div style="font-weight:700;color:#cbd5e1">Timeline</div>
      ${timelineHtml}
    </div>
  `;

  const showFixBtn = overlayBody.querySelector("#nudge-show-fix");
  const giveHintBtn = overlayBody.querySelector("#nudge-give-hint");
  const refocusBtn = overlayBody.querySelector("#nudge-refocus");
  const summarizeBtn = overlayBody.querySelector("#nudge-summarize");

  if (showFixBtn && lastIntervention) {
    showFixBtn.addEventListener("click", () => handleInterventionAction("show_fix"));
  }
  if (giveHintBtn && lastIntervention) {
    giveHintBtn.addEventListener("click", () => handleInterventionAction("give_hint"));
  }
  if (refocusBtn && lastIntervention) {
    refocusBtn.addEventListener("click", () => handleInterventionAction("refocus"));
  }
  if (summarizeBtn && lastIntervention) {
    summarizeBtn.addEventListener("click", () => handleInterventionAction("summarize"));
  }
}

function createReopenChip() {
  const existingChip = document.getElementById("nudge-reopen-chip");
  if (existingChip) {
    existingChip.remove();
  }

  reopenChip = document.createElement("button");
  reopenChip.id = "nudge-reopen-chip";
  reopenChip.textContent = "D";
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
    return (active.value || "").slice(0, 6000);
  }

  if (active && active.isContentEditable) {
    return (active.textContent || "").slice(0, 6000);
  }

  const textareas = Array.from(document.querySelectorAll("textarea"))
    .filter((node) => !isSensitiveTarget(node))
    .sort((a, b) => (b.value?.length || 0) - (a.value?.length || 0));

  if (textareas[0]) {
    return (textareas[0].value || "").slice(0, 6000);
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
