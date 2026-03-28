const el = {
  tabUrl: document.getElementById("tab-url"),
  issue: document.getElementById("issue"),
  typing: document.getElementById("typing"),
  pause: document.getElementById("pause"),
  keys: document.getElementById("keys"),
  confusion: document.getElementById("confusion"),
  latest: document.getElementById("latest"),
  timeline: document.getElementById("timeline")
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
    el.issue.textContent = "None";
    el.typing.textContent = "0 keys/s";
    el.pause.textContent = "0s";
    el.keys.textContent = "0";
    el.confusion.textContent = "0%";
    el.latest.textContent = "No intervention yet.";
    el.timeline.textContent = "No interventions yet.";
    el.latest.className = "empty";
    el.timeline.className = "empty";
    return;
  }

  const signal = state.lastSignal || {};
  const metrics = state.lastMetrics || {};

  el.issue.textContent = signal.issueType ? `${signal.issueType} (${signal.issueSeverity || "low"})` : "None";
  el.typing.textContent = `${Number(metrics.typingSpeed || 0).toFixed(2)} keys/s`;
  el.pause.textContent = `${Math.round((metrics.pauseDurationMs || 0) / 1000)}s`;
  el.keys.textContent = String(metrics.totalKeystrokes || 0);
  el.confusion.textContent = `${Math.round((signal.confusionScore || 0) * 100)}%`;

  const latest = (state.interventions || [])[0];
  if (latest) {
    el.latest.className = "item";
    el.latest.innerHTML = `
      <div class="t">${escapeHtml(latest.type)}</div>
      <div class="m">${escapeHtml(latest.message)}</div>
    `;
  } else {
    el.latest.className = "empty";
    el.latest.textContent = "No intervention yet.";
  }

  const timeline = state.interventions || [];
  if (!timeline.length) {
    el.timeline.className = "empty";
    el.timeline.textContent = "No interventions yet.";
    return;
  }

  el.timeline.className = "";
  el.timeline.innerHTML = timeline
    .slice(0, 5)
    .map(
      (item) => `
        <div class="item">
          <div class="t">${escapeHtml(item.type)} ${item.applied ? "• applied" : ""}</div>
          <div class="m">${escapeHtml(item.message)}</div>
        </div>
      `
    )
    .join("");
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
