const el = {
  tabUrl: document.getElementById("tab-url"),
  activity: document.getElementById("activity"),
  category: document.getElementById("category"),
  domain: document.getElementById("domain"),
  issue: document.getElementById("issue"),
  friction: document.getElementById("friction"),
  frictionBar: document.getElementById("friction-bar"),
  focus: document.getElementById("focus"),
  focusBar: document.getElementById("focus-bar"),
  typing: document.getElementById("typing"),
  idle: document.getElementById("idle"),
  switches: document.getElementById("switches"),
  latest: document.getElementById("latest"),
  timeline: document.getElementById("timeline"),
  resultsLink: document.getElementById("results-link")
};

let activeTabId = null;

init().catch(() => {
  el.tabUrl.textContent = "Unable to read active tab.";
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    el.tabUrl.textContent = "No active tab found.";
    return;
  }

  activeTabId = tab.id;
  el.tabUrl.textContent = shortenUrl(tab.url || "Unknown tab");

  await refresh();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !activeTabId) {
      return;
    }

    const key = `nudge_tab_${activeTabId}`;
    if (changes[key]) {
      render(changes[key].newValue || null);
    }
  });

  setInterval(refresh, 1200);
}

async function refresh() {
  if (!activeTabId) {
    return;
  }

  const key = `nudge_tab_${activeTabId}`;
  const result = await chrome.storage.local.get([key]);
  render(result[key] || null);
}

function render(state) {
  if (!state) {
    el.activity.textContent = "activity: none_detected";
    el.category.textContent = "category: unknown";
    el.domain.textContent = "domain: unknown";
    el.issue.textContent = "None";
    el.friction.textContent = "0%";
    el.frictionBar.style.width = "0%";
    el.focus.textContent = "72%";
    el.focusBar.style.width = "72%";
    el.typing.textContent = "0 keys/s";
    el.idle.textContent = "0s";
    el.switches.textContent = "0";
    el.latest.className = "empty";
    el.latest.textContent = "No intervention yet.";
    el.timeline.className = "empty";
    el.timeline.textContent = "No events yet.";
    return;
  }

  const context = state.context || {};
  const signal = state.lastSignal || {};
  const metrics = state.lastMetrics || {};

  const risk = Math.round(
    Math.max(
      signal.procrastinationScore || 0,
      signal.distractionScore || 0
    ) * 100
  );

  el.activity.textContent = `activity: ${context.activityType || "none_detected"}`;
  el.category.textContent = `category: ${context.category || "unknown"}`;
  el.domain.textContent = `domain: ${context.domain || "unknown"}`;
  const issueDisplay = signal.issueDisplayType || signal.issueType;
  el.issue.textContent = issueDisplay ? `${issueDisplay} (${signal.issueSeverity || "low"})` : "None";
  el.friction.textContent = `${risk}%`;
  el.frictionBar.style.width = `${Math.min(100, risk)}%`;

  const focusScore = Math.round(signal.focusScore ?? 72);
  el.focus.textContent = `${focusScore}%`;
  el.focusBar.style.width = `${Math.min(100, Math.max(0, focusScore))}%`;

  el.typing.textContent = `${Number(metrics.typingSpeed || 0).toFixed(2)} keys/s`;
  el.idle.textContent = `${Math.round((metrics.idleDurationMs || 0) / 1000)}s`;
  el.switches.textContent = String(metrics.tabSwitchesDelta || 0);

  if (state.liveResultsUrl && el.resultsLink) {
    el.resultsLink.href = state.liveResultsUrl;
  }

  const latest = (state.interventions || [])[0];
  if (latest) {
    const actionText = latest.userAction ? ` • ${latest.userAction.replaceAll("_", " ")}` : "";
    const summary = latest.what ? `${latest.what} ${latest.why || ""}`.trim() : latest.message;

    el.latest.className = "item";
    el.latest.innerHTML = `
      <div class="t">${escapeHtml(latest.type)}${escapeHtml(actionText)}</div>
      <div class="m">${escapeHtml(summary)}</div>
    `;
  } else {
    el.latest.className = "empty";
    el.latest.textContent = "No intervention yet.";
  }

  const timeline = state.timeline || [];
  if (!timeline.length) {
    el.timeline.className = "empty";
    el.timeline.textContent = "No events yet.";
    return;
  }

  el.timeline.className = "";
  el.timeline.innerHTML = timeline
    .slice(0, 6)
    .map(
      (item) => `
        <div class="item">
          <div class="t">${escapeHtml(formatEventType(item.eventType))}</div>
          <div class="m">${escapeHtml(item.label || "Event")}</div>
        </div>
      `
    )
    .join("");
}

function formatEventType(value) {
  return String(value || "event").replaceAll("_", " ");
}

function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.slice(0, 28)}${parsed.pathname.length > 28 ? "..." : ""}`;
  } catch {
    return url;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
