const NUDGE_TAG = "nudge-extension-root";

let sessionStartedAt = Date.now();
let lastInputAt = Date.now();
let keyEvents = [];
let editEvents = [];
let keystrokesDelta = 0;
let totalKeystrokes = 0;
let previousText = "";
let lastIntervention = null;
let currentSignal = { issueType: null, issueSeverity: null, confusionScore: 0 };
let isCollapsed = false;
let isClosed = false;

let overlay;
let overlayBody;
let overlayTitle;
let collapseBtn;

boot();

function boot() {
  createOverlay();

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "NUDGE_INTERVENTION") {
      lastIntervention = message.intervention;
      currentSignal = message.signal || currentSignal;
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

  const text = extractWorkingText();
  if (text.length > previousText.length) {
    editEvents.push({ ts: now, type: "insert" });
  } else if (text.length < previousText.length) {
    editEvents.push({ ts: now, type: "delete" });
  }

  previousText = text;
}

function publishMetrics() {
  const now = Date.now();
  const tenSec = now - 10000;
  const twentySec = now - 20000;

  keyEvents = keyEvents.filter((ts) => ts >= tenSec);
  editEvents = editEvents.filter((entry) => entry.ts >= twentySec);

  const text = extractWorkingText();
  const pauseDurationMs = now - lastInputAt;
  const repeatedEdits = editEvents.filter((entry) => entry.type === "delete").length;
  const insertCount = editEvents.filter((entry) => entry.type === "insert").length;
  const deleteCount = repeatedEdits;

  const metrics = {
    typingSpeed: Number((keyEvents.length / 10).toFixed(2)),
    pauseDurationMs,
    repeatedEdits,
    deletionRate: Number((deleteCount / Math.max(1, insertCount + deleteCount)).toFixed(2)),
    complexityScore: estimateComplexity(text),
    nestedLoopSignals: /(for|while)[\s\S]{0,120}(for|while)/i.test(text) ? 1 : 0,
    timeOnProblemMs: now - sessionStartedAt,
    keystrokesDelta,
    contextSample: `${document.title}\n${text.slice(0, 500)}`
  };

  keystrokesDelta = 0;

  chrome.runtime.sendMessage({ type: "NUDGE_METRICS", metrics }, (response) => {
    if (!response || !response.ok) {
      return;
    }

    if (response.signal) {
      currentSignal = response.signal;
    }

    if (response.intervention) {
      lastIntervention = response.intervention;
    }

    renderOverlay();
  });
}

function createOverlay() {
  if (document.getElementById(NUDGE_TAG)) {
    return;
  }

  overlay = document.createElement("aside");
  overlay.id = NUDGE_TAG;
  overlay.setAttribute(
    "style",
    [
      "position:fixed",
      "right:14px",
      "bottom:14px",
      "width:320px",
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

  const title = document.createElement("strong");
  title.textContent = "Nudge Live";
  title.style.fontSize = "13px";
  overlayTitle = title;

  const controls = document.createElement("div");
  controls.setAttribute(
    "style",
    [
      "display:flex",
      "align-items:center",
      "gap:8px"
    ].join(";")
  );

  collapseBtn = document.createElement("button");
  collapseBtn.textContent = "-";
  collapseBtn.setAttribute(
    "style",
    [
      "background:transparent",
      "color:#94a3b8",
      "border:none",
      "cursor:pointer",
      "font-size:14px",
      "line-height:1"
    ].join(";")
  );
  collapseBtn.addEventListener("click", () => {
    isCollapsed = !isCollapsed;
    renderOverlay();
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "x";
  closeBtn.setAttribute(
    "style",
    [
      "background:transparent",
      "color:#94a3b8",
      "border:none",
      "cursor:pointer",
      "font-size:16px",
      "line-height:1"
    ].join(";")
  );
  closeBtn.addEventListener("click", () => {
    isClosed = true;
    if (overlay) {
      overlay.remove();
    }
    overlay = null;
    overlayBody = null;
  });

  head.appendChild(title);
  controls.appendChild(collapseBtn);
  controls.appendChild(closeBtn);
  head.appendChild(controls);

  overlayBody = document.createElement("div");
  overlayBody.style.padding = "10px 12px";
  overlayBody.style.fontSize = "12px";
  overlayBody.style.lineHeight = "1.45";

  overlay.appendChild(head);
  overlay.appendChild(overlayBody);
  document.documentElement.appendChild(overlay);
  renderOverlay();
}

function renderOverlay() {
  if (isClosed || !overlay || !overlayBody) {
    return;
  }

  const issueLabel = currentSignal.issueType
    ? `${currentSignal.issueType} (${currentSignal.issueSeverity || "low"})`
    : "No active issue";

  overlay.style.width = isCollapsed ? "240px" : "320px";
  overlay.style.maxWidth = "calc(100vw - 28px)";
  if (overlayTitle) {
    overlayTitle.textContent = isCollapsed ? "Nudge Live (Collapsed)" : "Nudge Live";
  }
  if (collapseBtn) {
    collapseBtn.textContent = isCollapsed ? "+" : "-";
  }

  if (isCollapsed) {
    overlayBody.innerHTML = `
      <div style="display:grid;gap:4px">
        <div><strong>Issue:</strong> ${escapeHtml(issueLabel)}</div>
        <div><strong>Score:</strong> ${Math.round((currentSignal.confusionScore || 0) * 100)}%</div>
        <div style="color:#94a3b8">Click + to expand</div>
      </div>
    `;
    return;
  }

  const interventionHtml = lastIntervention
    ? `
      <div style="margin-top:10px;padding:9px;border-radius:10px;background:rgba(14,165,233,0.12);border:1px solid rgba(14,165,233,0.35)">
        <div style="font-weight:700;color:#67e8f9">${escapeHtml(lastIntervention.title)}</div>
        <div style="margin-top:4px">${escapeHtml(lastIntervention.message)}</div>
        <div style="margin-top:6px;color:#cbd5e1"><strong>Next:</strong> ${escapeHtml(lastIntervention.nextAction)}</div>
        <button id="nudge-apply-btn" style="margin-top:8px;background:#0ea5e9;color:#f8fafc;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px">Mark Applied</button>
      </div>
    `
    : `<div style="margin-top:10px;color:#94a3b8">Monitoring behavior. Interventions appear here live.</div>`;

  overlayBody.innerHTML = `
    <div style="display:grid;gap:4px">
      <div><strong>Status:</strong> Live monitoring</div>
      <div><strong>Issue:</strong> ${escapeHtml(issueLabel)}</div>
      <div><strong>Confusion score:</strong> ${Math.round((currentSignal.confusionScore || 0) * 100)}%</div>
      <div><strong>Keystrokes:</strong> ${totalKeystrokes}</div>
    </div>
    ${interventionHtml}
  `;

  const applyBtn = overlayBody.querySelector("#nudge-apply-btn");
  if (applyBtn && lastIntervention) {
    applyBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage(
        {
          type: "NUDGE_APPLY_INTERVENTION",
          interventionId: lastIntervention.id
        },
        () => {
          if (!lastIntervention) {
            return;
          }
          lastIntervention.applied = true;
          applyBtn.textContent = "Applied";
          applyBtn.setAttribute("disabled", "true");
          applyBtn.style.opacity = "0.7";
        }
      );
    });
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

  const codeNode = document.querySelector("pre code, .monaco-editor, .cm-content, [data-language]");
  if (codeNode) {
    return (codeNode.textContent || "").slice(0, 6000);
  }

  return "";
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

function estimateComplexity(code) {
  const lines = code.split("\n").filter((line) => line.trim()).length;
  const loops = (code.match(/\bfor\b|\bwhile\b/g) || []).length;
  const conditionals = (code.match(/\bif\b|\bswitch\b/g) || []).length;
  const functions = (code.match(/function\s+|=>/g) || []).length;
  const recursionHints = (code.match(/\w+\s*\(/g) || []).length > 18 ? 1 : 0;

  const raw = lines * 0.03 + loops * 0.16 + conditionals * 0.1 + functions * 0.08 + recursionHints * 0.1;
  return Number(Math.min(1, raw).toFixed(2));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
