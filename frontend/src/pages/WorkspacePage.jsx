import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { endSession, markInterventionApplied, recordMetrics, startSession } from "../lib/api";

const GRADE_OPTIONS = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"];
const GRADE_SLOT_COUNT = 6;
const ASSESSMENT_SLOT_COUNT = 3;
const RISK_LEVEL_ORDER = { Low: 1, Moderate: 2, High: 3 };
const GITHUB_ZIP_URL = "https://github.com/AbhinavGGarg/Tether/archive/refs/heads/main.zip";
const EXTENSION_POWER_BRIDGE_EVENT = "TETHER_EXTENSION_POWER";
const REMINDER_DELAYS_MS = [0, 3 * 60 * 1000, 8 * 60 * 1000];
const NOTIFICATION_MODE_CONFIG = {
  Normal: { inactivityMs: 90000, lostFocusMs: 120000 },
  Focus: { inactivityMs: 65000, lostFocusMs: 90000 },
  Chill: { inactivityMs: 120000, lostFocusMs: 150000 }
};

function WorkspacePage() {
  const navigate = useNavigate();

  const [learnerName, setLearnerName] = useState("");
  const [learnerDraft, setLearnerDraft] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [connected, setConnected] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [startError, setStartError] = useState("");

  const [activeTab, setActiveTab] = useState("live");
  const [gradesInput, setGradesInput] = useState({
    currentGrade: "B+",
    upcomingAssessments: buildEmptyAssessments(),
    gradePortalLink: "",
    courseGrades: buildEmptyCourseGrades()
  });
  const [portalStatus, setPortalStatus] = useState("");
  const [riskAdjustment, setRiskAdjustment] = useState(0);
  const [riskTrend, setRiskTrend] = useState("stable");
  const [riskEvents, setRiskEvents] = useState([]);
  const [recoveryPlan, setRecoveryPlan] = useState([]);
  const [priorityTopics, setPriorityTopics] = useState([]);
  const [focusModeRunning, setFocusModeRunning] = useState(false);
  const [focusModeSeconds, setFocusModeSeconds] = useState(60);
  const [focusModeDuration, setFocusModeDuration] = useState(60);
  const [tetherEnabled, setTetherEnabled] = useState(true);
  const [browserNotifications, setBrowserNotifications] = useState({
    enabled: true,
    mode: "Normal"
  });
  const [browserNotificationStatus, setBrowserNotificationStatus] = useState("Browser notifications are on.");
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"
  );
  const [notificationLogs, setNotificationLogs] = useState([]);
  const [notificationEvents, setNotificationEvents] = useState([]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const saved = window.localStorage.getItem("tether_enabled");
      if (saved === "true") {
        setTetherEnabled(true);
      } else if (saved === "false") {
        setTetherEnabled(false);
      }
    } catch {
      // Ignore storage access failures.
    }
  }, []);

  useEffect(() => {
    if (!sessionId || typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem("tether_last_session_id", sessionId);
    } catch {
      // Ignore storage access failures.
    }
  }, [sessionId]);

  const [context, setContext] = useState({
    domain: window.location.hostname,
    category: "unknown",
    activityType: "none_detected",
    confidence: 0
  });

  const [signal, setSignal] = useState({
    issueType: null,
    issueDisplayType: null,
    issueSeverity: null,
    statusLabel: "Live monitoring",
    procrastinationScore: 0,
    distractionScore: 0,
    focusScore: 72,
    focusImprovementPct: 0
  });

  const [telemetry, setTelemetry] = useState({
    typingSpeed: 0,
    idleDurationMs: 0,
    pauseDurationMs: 0,
    repeatedActions: 0,
    deletionRate: 0,
    scrollSpeed: 0,
    tabSwitchesDelta: 0,
    timeOnTaskMs: 0,
    totalKeystrokes: 0
  });

  const [activeIntervention, setActiveIntervention] = useState(null);
  const [interventionHistory, setInterventionHistory] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [impactNote, setImpactNote] = useState("No intervention impact yet.");
  const [liveInterventionDetail, setLiveInterventionDetail] = useState("");

  const sessionStartRef = useRef(Date.now());
  const lastInputRef = useRef(Date.now());
  const lastInteractionRef = useRef(Date.now());
  const previousRiskScoreRef = useRef(null);
  const previousRiskLevelRef = useRef(null);
  const reminderSequenceRef = useRef({ active: null });
  const notificationRequestedRef = useRef(false);

  const keyEventsRef = useRef([]);
  const editEventsRef = useRef([]);
  const scrollEventsRef = useRef([]);

  const keystrokesDeltaRef = useRef(0);
  const totalKeystrokesRef = useRef(0);
  const tabSwitchesDeltaRef = useRef(0);
  const scrollDistanceDeltaRef = useRef(0);
  const lastScrollYRef = useRef(window.scrollY || 0);

  const riskState = useMemo(
    () =>
      computeGradesRiskState({
        currentGrade: gradesInput.currentGrade,
        courseGrades: gradesInput.courseGrades,
        upcomingAssessments: gradesInput.upcomingAssessments,
        signal,
        telemetry,
        context,
        riskAdjustment
      }),
    [
      gradesInput.currentGrade,
      gradesInput.courseGrades,
      gradesInput.upcomingAssessments,
      signal,
      telemetry,
      context,
      riskAdjustment
    ]
  );

  const combinedTimeline = useMemo(() => {
    return [...timeline, ...riskEvents, ...notificationEvents]
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
      .slice(0, 12);
  }, [timeline, riskEvents, notificationEvents]);

  const enrichedActiveIntervention = useMemo(
    () => attachRiskToIntervention(activeIntervention, riskState, browserNotifications, gradesInput.upcomingAssessments),
    [activeIntervention, riskState, browserNotifications, gradesInput.upcomingAssessments]
  );

  const addRiskTimelineEvent = useCallback((eventType, label, details) => {
    setRiskEvents((prev) =>
      [
        {
          id: `risk-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          ts: Date.now(),
          eventType,
          label,
          details
        },
        ...prev
      ].slice(0, 30)
    );
  }, []);

  const addBrowserNotificationEvent = useCallback((eventType, label, details) => {
    const entry = {
      id: `nudge-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      ts: Date.now(),
      eventType,
      label,
      details
    };

    setNotificationLogs((prev) => [entry, ...prev].slice(0, 40));
    setNotificationEvents((prev) => [entry, ...prev].slice(0, 40));
  }, []);

  async function handleCreateSession() {
    const cleanName = learnerDraft.trim();
    if (!cleanName) {
      setStartError("Enter a learner name to begin.");
      return;
    }

    setStartingSession(true);
    setStartError("");

    try {
      const sessionResponse = await startSession(cleanName);
      setSessionId(sessionResponse.sessionId);
      setLearnerName(cleanName);
      setConnected(true);

      sessionStartRef.current = Date.now();
      lastInputRef.current = Date.now();
      lastInteractionRef.current = Date.now();
      previousRiskScoreRef.current = null;
      previousRiskLevelRef.current = null;

      keyEventsRef.current = [];
      editEventsRef.current = [];
      scrollEventsRef.current = [];
      keystrokesDeltaRef.current = 0;
      totalKeystrokesRef.current = 0;
      tabSwitchesDeltaRef.current = 0;
      scrollDistanceDeltaRef.current = 0;
      lastScrollYRef.current = window.scrollY || 0;

      setSignal({
        issueType: null,
        issueDisplayType: null,
        issueSeverity: null,
        statusLabel: "Live monitoring",
        procrastinationScore: 0,
        distractionScore: 0,
        focusScore: 72,
        focusImprovementPct: 0
      });
      setImpactNote("No intervention impact yet.");
      setActiveIntervention(null);
      setLiveInterventionDetail("");
      setInterventionHistory([]);
      setTimeline([]);
      setRiskEvents([]);
      setRiskAdjustment(0);
      setRiskTrend("stable");
      setRecoveryPlan([]);
      setPriorityTopics([]);
      setFocusModeRunning(false);
      setFocusModeSeconds(60);
      setFocusModeDuration(60);
      setGradesInput({
        currentGrade: "B+",
        upcomingAssessments: buildEmptyAssessments(),
        gradePortalLink: "",
        courseGrades: buildEmptyCourseGrades()
      });
      setPortalStatus("");
      setBrowserNotificationStatus(
        browserNotifications.enabled ? `Browser notifications running in ${browserNotifications.mode} mode.` : "Browser notifications are off."
      );
      setNotificationLogs([]);
      setNotificationEvents([]);
      reminderSequenceRef.current = { active: null };
      setActiveTab("live");
    } catch {
      setStartError("Could not start session. Try again.");
    } finally {
      setStartingSession(false);
    }
  }

  function handleTetherPowerToggle(nextEnabled) {
    setTetherEnabled(nextEnabled);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("tether_enabled", nextEnabled ? "true" : "false");
      } catch {
        // Ignore storage access failures.
      }

      window.postMessage(
        {
          type: EXTENSION_POWER_BRIDGE_EVENT,
          enabled: nextEnabled,
          source: "tether-web-app",
          ts: Date.now()
        },
        "*"
      );
    }
  }

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    if (!tetherEnabled) {
      reminderSequenceRef.current.active = null;
      setActiveIntervention(null);
      setLiveInterventionDetail("");
      setFocusModeRunning(false);
      setFocusModeSeconds(0);
      setFocusModeDuration(0);
      setSignal((prev) => ({
        ...prev,
        issueType: null,
        issueDisplayType: null,
        issueSeverity: null,
        statusLabel: "Monitoring off"
      }));
      setTelemetry({
        typingSpeed: 0,
        idleDurationMs: 0,
        pauseDurationMs: 0,
        repeatedActions: 0,
        deletionRate: 0,
        scrollSpeed: 0,
        tabSwitchesDelta: 0,
        timeOnTaskMs: 0,
        totalKeystrokes: totalKeystrokesRef.current
      });
      setImpactNote("Tether is off. No monitoring is running.");
      setBrowserNotificationStatus("Tether is off. Monitoring and reminders paused.");
      addBrowserNotificationEvent("tether_disabled", "Tether turned off", "All monitoring loops paused.");
      return;
    }

    setSignal((prev) => ({
      ...prev,
      statusLabel: "Live monitoring"
    }));
    setImpactNote("No intervention impact yet.");
    setBrowserNotificationStatus(
      browserNotifications.enabled ? `Browser notifications running in ${browserNotifications.mode} mode.` : "Browser notifications are off."
    );
    addBrowserNotificationEvent("tether_enabled", "Tether turned on", "Monitoring loops resumed.");
  }, [addBrowserNotificationEvent, browserNotifications.enabled, browserNotifications.mode, sessionId, tetherEnabled]);

  useEffect(() => {
    if (!sessionId || !tetherEnabled) {
      return;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      const tenSecondsAgo = now - 10000;
      const twentySecondsAgo = now - 20000;

      keyEventsRef.current = keyEventsRef.current.filter((ts) => ts >= tenSecondsAgo);
      editEventsRef.current = editEventsRef.current.filter((event) => event.ts >= twentySecondsAgo);
      scrollEventsRef.current = scrollEventsRef.current.filter((event) => event.ts >= tenSecondsAgo);

      const repeatedEdits = editEventsRef.current.filter((event) => event.type === "delete").length;
      const insertCount = editEventsRef.current.filter((event) => event.type === "insert").length;
      const deleteCount = repeatedEdits;
      const scrollDistanceRecent = scrollEventsRef.current.reduce((sum, event) => sum + event.delta, 0);
      const scrollBursts = scrollEventsRef.current.filter((event) => event.delta > 140).length;

      const metrics = {
        typingSpeed: Number((keyEventsRef.current.length / 10).toFixed(2)),
        pauseDurationMs: now - lastInputRef.current,
        idleDurationMs: now - lastInteractionRef.current,
        repeatedEdits,
        repeatedActions: repeatedEdits + Math.floor(scrollBursts / 2),
        deletionRate: Number((deleteCount / Math.max(1, insertCount + deleteCount)).toFixed(2)),
        scrollSpeed: Number((scrollDistanceRecent / 10).toFixed(2)),
        scrollBursts,
        scrollDistance: Math.round(scrollDistanceDeltaRef.current),
        tabSwitchesDelta: tabSwitchesDeltaRef.current,
        timeOnTaskMs: now - sessionStartRef.current,
        keystrokesDelta: keystrokesDeltaRef.current,
        pageTitle: document.title,
        url: window.location.href,
        contextSample: `${document.title}\n${extractWorkingText().slice(0, 280)}`,
        pageTextSample: extractPageTextSample(),
        hasVideo: Boolean(document.querySelector("video")),
        hasEditable: Boolean(hasEditableSurface())
      };

      const realtime = recordMetrics(sessionId, metrics);

      if (realtime?.signal) {
        setSignal(realtime.signal);
      }
      if (realtime?.context) {
        setContext(realtime.context);
        if (realtime.context.activityType === "none_detected") {
          setActiveIntervention(null);
        }
      }
      if (realtime?.timeline) {
        setTimeline(realtime.timeline);
      }

      if (realtime?.intervention) {
        setActiveIntervention(realtime.intervention);
        setLiveInterventionDetail("");
        setInterventionHistory((prev) => {
          if (prev.some((item) => item.id === realtime.intervention.id)) {
            return prev;
          }
          return [realtime.intervention, ...prev].slice(0, 8);
        });
      }

      setTelemetry({
        typingSpeed: metrics.typingSpeed,
        idleDurationMs: metrics.idleDurationMs,
        pauseDurationMs: metrics.pauseDurationMs,
        repeatedActions: metrics.repeatedActions,
        deletionRate: metrics.deletionRate,
        scrollSpeed: metrics.scrollSpeed,
        tabSwitchesDelta: metrics.tabSwitchesDelta,
        timeOnTaskMs: metrics.timeOnTaskMs,
        totalKeystrokes: totalKeystrokesRef.current
      });

      keystrokesDeltaRef.current = 0;
      tabSwitchesDeltaRef.current = 0;
      scrollDistanceDeltaRef.current = 0;
    }, 2000);

    return () => clearInterval(timer);
  }, [sessionId, tetherEnabled]);

  useEffect(() => {
    if (!sessionId || !tetherEnabled) {
      return;
    }

    function onKeyDown(event) {
      const trackable = event.key.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(event.key);
      if (!trackable) {
        return;
      }

      const now = Date.now();
      keyEventsRef.current.push(now);
      lastInputRef.current = now;
      lastInteractionRef.current = now;
      keystrokesDeltaRef.current += 1;
      totalKeystrokesRef.current += 1;

      if (event.key === "Backspace" || event.key === "Delete") {
        editEventsRef.current.push({ ts: now, type: "delete" });
      } else {
        editEventsRef.current.push({ ts: now, type: "insert" });
      }
    }

    function onScroll() {
      const now = Date.now();
      const currentY = window.scrollY || 0;
      const delta = Math.abs(currentY - lastScrollYRef.current);
      lastScrollYRef.current = currentY;
      scrollEventsRef.current.push({ ts: now, delta });
      scrollDistanceDeltaRef.current += delta;
      lastInteractionRef.current = now;
    }

    function onPointerDown() {
      lastInteractionRef.current = Date.now();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        tabSwitchesDeltaRef.current += 1;
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("visibilitychange", onVisibilityChange, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange, true);
    };
  }, [sessionId, tetherEnabled]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const previousScore = previousRiskScoreRef.current;
    if (previousScore !== null) {
      if (riskState.score < previousScore - 0.04) {
        setRiskTrend("improving");
      } else if (riskState.score > previousScore + 0.04) {
        setRiskTrend("declining");
      } else {
        setRiskTrend("stable");
      }
    }
    previousRiskScoreRef.current = riskState.score;
  }, [riskState.score, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const previousLevel = previousRiskLevelRef.current;
    if (previousLevel && previousLevel !== riskState.level) {
      const prevValue = RISK_LEVEL_ORDER[previousLevel] || 0;
      const nextValue = RISK_LEVEL_ORDER[riskState.level] || 0;
      if (nextValue > prevValue) {
        addRiskTimelineEvent(
          "risk_level_increased",
          `Risk level increased to ${riskState.level}`,
          "Behavior + grade trend suggests higher academic risk."
        );
      } else if (nextValue < prevValue) {
        addRiskTimelineEvent(
          "risk_level_decreased",
          `Risk level improved to ${riskState.level}`,
          "Recent actions are reducing academic risk."
        );
      }
    }
    previousRiskLevelRef.current = riskState.level;
  }, [addRiskTimelineEvent, riskState.level, sessionId]);

  useEffect(() => {
    if (!focusModeRunning || !tetherEnabled) {
      return;
    }

    const timer = window.setInterval(() => {
      setFocusModeSeconds((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          setFocusModeRunning(false);
          setRiskAdjustment((current) => Math.min(0.45, current + 0.12));
          addRiskTimelineEvent("focus_improved", "Focus improved", "Completed focus mode sprint.");
          setImpactNote("Focus mode completed. Focus improved by 40%.");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [addRiskTimelineEvent, focusModeRunning, tetherEnabled]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setBrowserNotificationPermission("unsupported");
      return;
    }

    if (!tetherEnabled) {
      return;
    }

    setBrowserNotificationPermission(Notification.permission);
    if (!browserNotifications.enabled) {
      return;
    }

    if (!notificationRequestedRef.current && Notification.permission === "default") {
      notificationRequestedRef.current = true;
      Notification.requestPermission().then((permission) => {
        setBrowserNotificationPermission(permission);
        addBrowserNotificationEvent(
          "notification_permission",
          `Notification permission: ${permission}`,
          "Permission requested for browser notifications."
        );
      });
    }
  }, [addBrowserNotificationEvent, browserNotifications.enabled, tetherEnabled]);

  useEffect(() => {
    if (!sessionId || !tetherEnabled) {
      return;
    }

    const reminderTimer = window.setInterval(() => {
      const now = Date.now();
      const activeReminder = reminderSequenceRef.current.active;

      if (!browserNotifications.enabled || !connected) {
        if (activeReminder) {
          reminderSequenceRef.current.active = null;
          setBrowserNotificationStatus("Browser notifications are off.");
        }
        return;
      }

      const modeConfig = NOTIFICATION_MODE_CONFIG[browserNotifications.mode] || NOTIFICATION_MODE_CONFIG.Normal;
      const inactiveMs = now - lastInteractionRef.current;
      const lowProductivityMs = now - lastInputRef.current;
      const hasSessionProgress = telemetry.timeOnTaskMs > 12000;
      const forgotSessionDetected = hasSessionProgress && inactiveMs >= modeConfig.inactivityMs;
      const lostFocusDetected =
        hasSessionProgress &&
        inactiveMs < modeConfig.inactivityMs &&
        lowProductivityMs > modeConfig.lostFocusMs &&
        (signal.procrastinationScore > 0.44 || signal.distractionScore > 0.44);

      const userReturned = inactiveMs < 6000 && lowProductivityMs < 10000;
      const productivityRecovered =
        telemetry.typingSpeed > 0.28 && signal.procrastinationScore < 0.4 && signal.distractionScore < 0.4;

      if (!reminderSequenceRef.current.active) {
        if (forgotSessionDetected || lostFocusDetected) {
          const type = forgotSessionDetected ? "forgot_session" : "lost_focus";
          reminderSequenceRef.current.active = {
            type,
            startedAt: now,
            sentCount: 0
          };

          setBrowserNotificationStatus(
            type === "forgot_session"
              ? "Detected possible forgotten session. Browser reminder sequence started."
              : "Detected low productivity. Browser reminder sequence started."
          );

          addBrowserNotificationEvent(
            "focus_drift_detected",
            type === "forgot_session" ? "Forgot session detected" : "Lost focus detected",
            "Preparing reminder sequence."
          );
        }
        return;
      }

      const active = reminderSequenceRef.current.active;

      if (userReturned || (active.type === "lost_focus" && productivityRecovered)) {
        addBrowserNotificationEvent("user_returned", "User returned", "Reminder sequence stopped.");
        reminderSequenceRef.current.active = null;
        setBrowserNotificationStatus("User returned. Browser reminders paused.");
        return;
      }

      if (active.sentCount >= REMINDER_DELAYS_MS.length) {
        setBrowserNotificationStatus("Reminder limit reached (3). Waiting for user return.");
        return;
      }

      const dueDelay = REMINDER_DELAYS_MS[active.sentCount];
      if (now - active.startedAt < dueDelay) {
        return;
      }

      if (active.sentCount > 0) {
        addBrowserNotificationEvent("user_ignored", "User ignored", "No return after previous reminder.");
      }

      const message =
        active.type === "forgot_session"
          ? "Reminder sent: Resume session"
          : "Reminder sent: Regain focus and continue the current task";
      addBrowserNotificationEvent("reminder_sent", message, `Mode: ${browserNotifications.mode}`);

      if (browserNotificationPermission === "granted" && typeof Notification !== "undefined") {
        const notification = new Notification("Tether Reminder", {
          body:
            active.type === "forgot_session"
              ? "You paused your session. Resume now?"
              : "You are active but drifting. Want to refocus now?",
          tag: `nudge-${active.type}`
        });

        notification.onclick = () => {
          window.focus();
          addBrowserNotificationEvent("user_returned", "User returned", "Clicked browser notification.");
          reminderSequenceRef.current.active = null;
          setBrowserNotificationStatus("Notification opened. User returned.");
          notification.close();
        };
      } else {
        addBrowserNotificationEvent(
          "notification_skipped",
          "Browser notification skipped",
          "Permission not granted. Enable notifications for real alerts."
        );
      }

      reminderSequenceRef.current.active = {
        ...active,
        sentCount: active.sentCount + 1
      };

      const remaining = REMINDER_DELAYS_MS.length - (active.sentCount + 1);
      setBrowserNotificationStatus(
        remaining > 0 ? `Reminder sent. ${remaining} reminder(s) remaining in sequence.` : "All reminders sent."
      );
    }, 1000);

    return () => window.clearInterval(reminderTimer);
  }, [
    addBrowserNotificationEvent,
    connected,
    sessionId,
    signal.procrastinationScore,
    signal.distractionScore,
    browserNotificationPermission,
    browserNotifications.enabled,
    browserNotifications.mode,
    telemetry.timeOnTaskMs,
    telemetry.typingSpeed,
    tetherEnabled
  ]);

  function handleInterventionAction(intervention, action) {
    if (!intervention || !sessionId) {
      return "";
    }

    if (!tetherEnabled) {
      return "Tether is off. Turn it back on to run interventions.";
    }

    const update = markInterventionApplied(sessionId, intervention.id, action);

    if (update?.signal) {
      setSignal(update.signal);
    }
    if (update?.timeline) {
      setTimeline(update.timeline);
    }

    setInterventionHistory((prev) =>
      prev.map((item) =>
        item.id === intervention.id
          ? {
              ...item,
              userAction: action,
              improvementNote: update?.intervention?.improvementNote || item.improvementNote
            }
          : item
      )
    );

    const beforeMinutes = estimateWastedMinutes(signal, telemetry);
    const improvementMap = {
      lock_in_2m: 0.4,
      refocus_timer: 0.4,
      break_steps: 0.25,
      try_new_approach: 0.22,
      short_break: 0.18,
      resume_task: 0.2,
      ignore: 0
    };

    const reductionWeight = improvementMap[action] || 0.2;
    const afterMinutes = Math.max(1, Math.round(beforeMinutes * (1 - reductionWeight)));
    const reduction = Math.max(0, Math.round(((beforeMinutes - afterMinutes) / Math.max(1, beforeMinutes)) * 100));

    setImpactNote(
      `Estimated time waste: ~${beforeMinutes}m -> ~${afterMinutes}m (${reduction}% reduction). Current risk: ${riskState.level}.`
    );

    if (action === "refocus_timer") {
      addRiskTimelineEvent("focus_mode_started", "Focus mode started", "Triggered through intervention action.");
      setFocusModeRunning(true);
      setFocusModeSeconds(60);
      setFocusModeDuration(60);
    }

    if (action === "lock_in_2m") {
      addRiskTimelineEvent("focus_mode_started", "2-minute lock-in started", "Triggered through intervention action.");
      setFocusModeRunning(true);
      setFocusModeSeconds(120);
      setFocusModeDuration(120);
    }

    if (action === "short_break" || action === "resume_task") {
      setActiveIntervention(null);
    }

    return resolveActionText(intervention, action, update?.intervention);
  }

  function handleAnalyzePortalLink() {
    const fallbackGrade = deriveFallbackGrade(gradesInput.courseGrades, gradesInput.currentGrade);
    const parsed = parseGradeFromPortalLink(gradesInput.gradePortalLink, fallbackGrade);
    if (!gradesInput.gradePortalLink.trim()) {
      setPortalStatus("Add a grade portal link to simulate parsing.");
      return;
    }

    if (parsed.grade) {
      setGradesInput((prev) => {
        const parsedGrades = Array.isArray(parsed.grades) && parsed.grades.length > 0 ? parsed.grades : [parsed.grade];
        const hasEmptySlots = prev.courseGrades.some((entry) => !entry.grade);
        let appliedCount = 0;
        let nextParsedIndex = 0;

        const nextCourseGrades = prev.courseGrades.map((entry) => {
          if (entry.grade) {
            return entry;
          }
          const picked = parsedGrades[Math.min(nextParsedIndex, parsedGrades.length - 1)] || parsed.grade;
          if (!picked) {
            return entry;
          }
          appliedCount += 1;
          nextParsedIndex += 1;
          return { ...entry, grade: picked };
        });

        return {
          ...prev,
          currentGrade: parsed.grade,
          courseGrades: nextCourseGrades
        };
      });

      const parsedCount = Array.isArray(parsed.grades) ? parsed.grades.length : 1;
      const emptySlots = gradesInput.courseGrades.filter((entry) => !entry.grade).length;
      if (emptySlots === 0) {
        setPortalStatus(`Parsed grade signal: ${parsed.grade}. No empty course slots left, so your entered grades were kept.`);
      } else {
        setPortalStatus(
          `Parsed ${parsedCount} grade signal${parsedCount > 1 ? "s" : ""}: ${
            parsedCount > 1 ? parsed.grades.join(", ") : parsed.grade
          }. Applied to ${Math.min(emptySlots, Math.max(1, parsedCount))} empty course slot${Math.min(
            emptySlots,
            Math.max(1, parsedCount)
          ) > 1
            ? "s"
            : ""}.`
        );
      }
      addRiskTimelineEvent("grade_parsed", `Portal grade parsed (${parsed.grade})`, parsed.source);
    } else {
      setPortalStatus(parsed.message);
    }
  }

  function handleRiskAction(action) {
    if (!sessionId) {
      return;
    }

    if (!tetherEnabled) {
      setImpactNote("Tether is off. Turn it on to run focus and recovery actions.");
      return;
    }

    if (action === "start_focus_mode") {
      if (!focusModeRunning) {
        setFocusModeRunning(true);
        setFocusModeSeconds(60);
        setFocusModeDuration(60);
        setRiskAdjustment((current) => Math.min(0.45, current + 0.08));
        addRiskTimelineEvent("focus_mode_started", "Focus mode started", "Started a 60-second sprint.");
      }
      return;
    }

    if (action === "create_recovery_plan") {
      const plan = buildRecoveryPlan(
        riskState,
        context,
        formatAssessmentTargets(gradesInput.upcomingAssessments)
      );
      setRecoveryPlan(plan);
      setRiskAdjustment((current) => Math.min(0.45, current + 0.09));
      addRiskTimelineEvent("recovery_plan_started", "Recovery plan started", "Generated a 3-step recovery plan.");
      return;
    }

    if (action === "show_priority_topics") {
      const topics = buildPriorityTopics(context, signal);
      setPriorityTopics(topics);
      setRiskAdjustment((current) => Math.min(0.45, current + 0.05));
      addRiskTimelineEvent("priority_topics_opened", "Priority topics generated", "Surfaced highest-impact topics.");
    }
  }

  function handleBrowserNotificationsToggle(enabled) {
    if (!tetherEnabled) {
      setBrowserNotificationStatus("Turn Tether on first, then enable browser notifications.");
      return;
    }

    setBrowserNotifications((prev) => ({ ...prev, enabled }));

    if (!enabled) {
      reminderSequenceRef.current.active = null;
      setBrowserNotificationStatus("Browser notifications are off.");
      addBrowserNotificationEvent(
        "browser_notifications_disabled",
        "Browser notifications disabled",
        "Reminder engine stopped."
      );
      return;
    }

    setBrowserNotificationStatus(`Browser notifications running in ${browserNotifications.mode} mode.`);
    addBrowserNotificationEvent(
      "browser_notifications_enabled",
      "Browser notifications enabled",
      `Mode: ${browserNotifications.mode}`
    );
  }

  function updateCourseGrade(index, key, value) {
    setGradesInput((prev) => ({
      ...prev,
      courseGrades: prev.courseGrades.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [key]: value } : entry
      )
    }));
  }

  function updateUpcomingAssessment(index, key, value) {
    setGradesInput((prev) => ({
      ...prev,
      upcomingAssessments: prev.upcomingAssessments.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [key]: value } : entry
      )
    }));
  }

  function handleBrowserNotificationMode(mode) {
    setBrowserNotifications((prev) => ({ ...prev, mode }));
    addBrowserNotificationEvent(
      "notification_mode_changed",
      `Notification mode set to ${mode}`,
      "Updated browser reminder behavior."
    );
    setBrowserNotificationStatus(`Browser notifications running in ${mode} mode.`);
  }

  async function goToDashboard() {
    if (!sessionId) {
      return;
    }

    reminderSequenceRef.current.active = null;
    if (browserNotifications.enabled) {
      addBrowserNotificationEvent("session_completed", "Session completed", "Stopped all browser reminder sequences.");
    }

    await endSession(sessionId);
    navigate(`/dashboard/${sessionId}`);
  }

  function openLiveResults() {
    if (!sessionId) {
      return;
    }
    window.open(`/dashboard/${sessionId}`, "_blank", "noopener,noreferrer");
  }

  const issueLabel = signal.issueType
    ? `${(signal.issueDisplayType || signal.issueType).replaceAll("_", " ")} (${signal.issueSeverity || "low"})`
    : tetherEnabled
      ? "No active issue"
      : "Monitoring off";

  const behaviorRiskPct = Math.round(
    Math.max(
      signal.procrastinationScore || 0,
      signal.distractionScore || 0
    ) * 100
  );

  const focusModeProgress = Math.max(
    0,
    Math.min(100, Math.round(((focusModeDuration - focusModeSeconds) / Math.max(1, focusModeDuration)) * 100))
  );
  const displayIntervention = enrichedActiveIntervention || interventionHistory[0] || null;

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <h1>Tether</h1>
          <p>Catch drift early. Recover focus instantly.</p>
        </div>
        <div className="status-cluster">
          <span className={`status-pill ${connected && tetherEnabled ? "online" : "offline"}`}>
            {connected ? (tetherEnabled ? "Live Monitoring" : "Tether Off") : "Session not started"}
          </span>
          {learnerName ? <span className="status-pill online">Operator: {learnerName}</span> : null}
          {sessionId ? (
            <label className="master-power-toggle">
              <span>Tether Power</span>
              <input
                type="checkbox"
                checked={tetherEnabled}
                onChange={(event) => handleTetherPowerToggle(event.target.checked)}
              />
            </label>
          ) : null}
          {sessionId ? (
            <button className="btn btn-ghost" onClick={openLiveResults}>
              View your real live results
            </button>
          ) : null}
          {sessionId ? (
            <button className="btn btn-primary" onClick={goToDashboard}>
              End Session + Dashboard
            </button>
          ) : null}
        </div>
      </header>

      {!sessionId ? (
        <>
          <section className="panel landing-hero">
            <div className="landing-hero-copy">
              <h2>Real-time intervention for procrastination, distraction, and inactivity</h2>
              <p>
                Tether observes live behavior patterns and intervenes when momentum drops. It helps students and builders
                recover focus in the moment instead of after performance already declines.
              </p>
              <div className="landing-kpis">
                <span>Live context detection</span>
                <span>Behavior risk scoring</span>
                <span>Immediate recovery actions</span>
                <span>Post-session impact analytics</span>
              </div>
            </div>
            <div className="landing-hero-cta">
              <h3>Create Operator Session</h3>
              <p>Start a session to run live detection, interventions, and impact tracking.</p>
              <div className="action-row">
                <input
                  value={learnerDraft}
                  onChange={(event) => setLearnerDraft(event.target.value)}
                  placeholder="Operator name"
                  className="session-input"
                />
                <button className="btn btn-primary" onClick={handleCreateSession} disabled={startingSession}>
                  {startingSession ? "Starting..." : "Start Session"}
                </button>
              </div>
              {startError ? <p className="start-error">{startError}</p> : null}
            </div>
          </section>

          <section className="landing-grid">
            <article className="panel">
              <h3>What Tether Solves</h3>
              <p>
                Procrastination and attention drift are still major unsolved problems in learning. Most tools only react
                after results drop. Tether acts during the session.
              </p>
              <ul className="landing-list">
                <li>Detects inactivity, distraction, and procrastination in real time.</li>
                <li>Adapts to page context across coding, reading, writing, and browsing.</li>
                <li>Pushes targeted actions like lock-in timers and recovery prompts.</li>
              </ul>
            </article>

            <article className="panel">
              <h3>How It Works</h3>
              <div className="landing-steps">
                <div>
                  <strong>1. Observe</strong>
                  <p>Capture typing speed, idle time, repeated actions, tab switching, and scroll behavior.</p>
                </div>
                <div>
                  <strong>2. Detect</strong>
                  <p>Classify risk patterns and trigger strict inactivity detection at 60 seconds.</p>
                </div>
                <div>
                  <strong>3. Intervene</strong>
                  <p>Deliver live actions and log measurable improvement in timeline and dashboard.</p>
                </div>
              </div>
            </article>

            <article className="panel landing-install">
              <h3>Install & Try Tether</h3>
              <p>
                Tether now appears only when a real behavior issue is detected. If you are active, it stays quiet.
              </p>
              <ol className="landing-install-list">
                <li>Download the extension zip from GitHub.</li>
                <li>Open Chrome and go to `chrome://extensions`.</li>
                <li>Turn on Developer mode, then click Load unpacked.</li>
                <li>Select the `extension` folder from the downloaded repo.</li>
                <li>Open any site, then stay inactive for 60 seconds to trigger Tether.</li>
              </ol>
              <div className="action-row landing-install-actions">
                <a className="btn btn-primary" href={GITHUB_ZIP_URL} target="_blank" rel="noreferrer">
                  Download Extension ZIP
                </a>
              </div>
              <p className="monitor-note">
                If Developer mode is blocked on your school-managed Chrome profile, use a personal Chrome profile to load
                the extension.
              </p>
            </article>
          </section>
        </>
      ) : null}

      {sessionId ? (
        <>
          <section className="module-tabs">
            <button
              className={`module-tab ${activeTab === "live" ? "active" : ""}`}
              onClick={() => setActiveTab("live")}
              type="button"
            >
              Live Interventions
            </button>
            <button
              className={`module-tab ${activeTab === "grades" ? "active" : ""}`}
              onClick={() => setActiveTab("grades")}
              type="button"
            >
              Grades & Risk
            </button>
          </section>

          {activeTab === "live" ? (
            <section className="workspace-grid">
              <article className="panel panel-main">
                <h3>Live Context Engine</h3>

                <div className="metric-grid">
                  <Metric label="Activity" value={context.activityType} />
                  <Metric label="Category" value={context.category} />
                  <Metric label="Domain" value={context.domain} />
                  <Metric label="Confidence" value={`${Math.round((context.confidence || 0) * 100)}%`} />
                  <Metric label="Focus score" value={`${Math.round(signal.focusScore || 0)}%`} />
                  <Metric label="Typing speed" value={`${telemetry.typingSpeed} keys/s`} />
                  <Metric label="Idle" value={`${Math.round(telemetry.idleDurationMs / 1000)}s`} />
                  <Metric label="Pause" value={`${Math.round(telemetry.pauseDurationMs / 1000)}s`} />
                  <Metric label="Repeated actions" value={telemetry.repeatedActions} />
                  <Metric label="Scroll speed" value={`${Math.round(telemetry.scrollSpeed)} px/s`} />
                  <Metric label="Tab switches" value={telemetry.tabSwitchesDelta} />
                  <Metric label="Time on task" value={`${Math.round(telemetry.timeOnTaskMs / 1000)}s`} />
                </div>

                <div className="signal-box">
                  <h4>Current Issue</h4>
                  <p>{issueLabel}</p>
                  <div className="progress-track">
                    <span style={{ width: `${Math.min(100, behaviorRiskPct)}%` }} />
                  </div>
                </div>

                <div className="impact-box">
                  <h4>Impact System</h4>
                  <p>{impactNote}</p>
                </div>

                {displayIntervention ? (
                  <div className="timeline-box">
                    <h4>Active Intervention</h4>
                    <p>
                      <strong>What:</strong> {displayIntervention.what || displayIntervention.message}
                    </p>
                    <p>
                      <strong>Why:</strong> {displayIntervention.why || displayIntervention.reason}
                    </p>
                    <p>
                      <strong>Next:</strong> {displayIntervention.nextAction}
                    </p>
                    <div className="risk-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() =>
                          setLiveInterventionDetail(
                            handleInterventionAction(displayIntervention, "lock_in_2m") ||
                              "2-minute lock-in started."
                          )
                        }
                        type="button"
                      >
                        Lock In (2 min focus)
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() =>
                          setLiveInterventionDetail(
                            handleInterventionAction(displayIntervention, "break_steps") || "Break steps generated."
                          )
                        }
                        type="button"
                      >
                        Break into Steps
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() =>
                          setLiveInterventionDetail(
                            handleInterventionAction(displayIntervention, "try_new_approach") ||
                              "Try a new approach now."
                          )
                        }
                        type="button"
                      >
                        Try New Approach
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() =>
                          setLiveInterventionDetail(
                            handleInterventionAction(displayIntervention, "resume_task") || "Task resumed."
                          )
                        }
                        type="button"
                      >
                        Resume Task
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() =>
                          setLiveInterventionDetail(
                            handleInterventionAction(displayIntervention, "ignore") || "Ignored for now."
                          )
                        }
                        type="button"
                      >
                        Ignore
                      </button>
                    </div>
                    {liveInterventionDetail ? <p className="monitor-note">{liveInterventionDetail}</p> : null}
                  </div>
                ) : null}
              </article>

              <aside className="panel panel-side">
                <h3>Decision Timeline</h3>
                <div className="timeline-box">
                  {combinedTimeline.length === 0 ? <p>No events yet.</p> : null}
                  {combinedTimeline.map((item) => (
                    <div key={item.id} className="timeline-item">
                      <span>{formatEventType(item.eventType)}</span>
                      <p>{item.label}</p>
                    </div>
                  ))}
                </div>

                <div className="timeline-box">
                  <h4>Browser Notifications</h4>
                  <label className="notification-toggle">
                    <span>Enable browser reminders</span>
                    <input
                      type="checkbox"
                      checked={browserNotifications.enabled}
                      onChange={(event) => handleBrowserNotificationsToggle(event.target.checked)}
                      disabled={!tetherEnabled}
                    />
                  </label>
                  <label className="risk-field">
                    Notification mode
                    <select
                      value={browserNotifications.mode}
                      onChange={(event) => handleBrowserNotificationMode(event.target.value)}
                      disabled={!browserNotifications.enabled || !tetherEnabled}
                    >
                      <option value="Normal">Normal</option>
                      <option value="Focus">Focus</option>
                      <option value="Chill">Chill</option>
                    </select>
                  </label>
                  {!tetherEnabled ? <p className="monitor-note">Tether is off. Nothing is running.</p> : null}
                  <p className="monitor-note">
                    Browser permission: <strong>{browserNotificationPermission}</strong>
                  </p>
                  <p className="monitor-note">{browserNotificationStatus}</p>
                </div>

                <div className="timeline-box">
                  <h4>Notification Log</h4>
                  {notificationLogs.length === 0 ? <p>No reminders yet.</p> : null}
                  {notificationLogs.slice(0, 6).map((item) => (
                    <div key={item.id} className="timeline-item">
                      <span>{new Date(item.ts).toLocaleTimeString()}</span>
                      <p>{item.label}</p>
                    </div>
                  ))}
                </div>

                <div className="timeline-box">
                  <h4>Intervention History</h4>
                  {interventionHistory.length === 0 ? <p>No interventions yet.</p> : null}
                  {interventionHistory.map((item) => (
                    <div key={item.id} className="timeline-item">
                      <span>{item.type.replaceAll("_", " ")}</span>
                      <p>{item.what || item.message}</p>
                      {item.userAction ? <p>Action: {item.userAction.replaceAll("_", " ")}</p> : null}
                      {item.improvementNote ? <p>{item.improvementNote}</p> : null}
                    </div>
                  ))}
                </div>
              </aside>
            </section>
          ) : null}

          {activeTab === "grades" ? (
            <section className="workspace-grid">
              <article className="panel panel-main">
                <h3>Grades & Risk Intelligence</h3>

                <div className="risk-input-grid">
                  <div className="risk-field risk-field-full">
                    Upcoming assessments (up to 3)
                    <div className="assessment-grid">
                      {gradesInput.upcomingAssessments.map((entry, index) => (
                        <div key={entry.id} className="assessment-card">
                          <label className="risk-field">
                            Assessment {index + 1}
                            <input
                              type="text"
                              value={entry.name}
                              onChange={(event) => updateUpcomingAssessment(index, "name", event.target.value)}
                              placeholder={`e.g. Midterm ${index + 1}`}
                            />
                          </label>
                          <label className="risk-field">
                            Date (recommended)
                            <input
                              type="date"
                              value={entry.date}
                              onChange={(event) => updateUpcomingAssessment(index, "date", event.target.value)}
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>

                  <label className="risk-field risk-field-full">
                    Grade portal link (optional)
                    <input
                      type="text"
                      value={gradesInput.gradePortalLink}
                      onChange={(event) =>
                        setGradesInput((prev) => ({ ...prev, gradePortalLink: event.target.value }))
                      }
                      placeholder="Paste grade portal link to simulate parsing"
                    />
                  </label>
                </div>

                <div className="timeline-box">
                  <h4>Course Grade Inputs (6 slots)</h4>
                  <div className="grade-slots-grid">
                    {gradesInput.courseGrades.map((entry, index) => (
                      <div className="grade-slot-card" key={entry.id}>
                        <label className="risk-field">
                          Course {index + 1}
                          <input
                            type="text"
                            value={entry.course}
                            onChange={(event) => updateCourseGrade(index, "course", event.target.value)}
                            placeholder={`e.g. Course ${index + 1}`}
                          />
                        </label>
                        <label className="risk-field">
                          Grade
                          <select
                            value={entry.grade}
                            onChange={(event) => updateCourseGrade(index, "grade", event.target.value)}
                          >
                            <option value="">Select</option>
                            {GRADE_OPTIONS.map((grade) => (
                              <option key={`${entry.id}-${grade}`} value={grade}>
                                {grade}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="action-row">
                  <button className="btn btn-ghost" onClick={handleAnalyzePortalLink} type="button">
                    Parse Grade Link
                  </button>
                </div>
                {portalStatus ? <p className="monitor-note">{portalStatus}</p> : null}

                <div className="risk-dashboard">
                  <div className="risk-row">
                    <span className={`risk-pill ${riskClassName(riskState.level)}`}>{riskState.level} Risk</span>
                    <span className="risk-score">Risk score: {Math.round(riskState.score * 100)}%</span>
                    <span className="risk-score">Grade coverage: {riskState.gradeCoveragePct}%</span>
                    <span className="risk-score">Upcoming assessments: {riskState.upcomingCount}</span>
                    <span className={`risk-trend ${riskTrend}`}>Trend: {riskTrend}</span>
                  </div>
                  <p className="risk-outcome">{riskState.predictedOutcome}</p>
                </div>
              </article>

              <aside className="panel panel-side">
                <h3>AI Insight Panel</h3>
                <div className="timeline-box">
                  <p>
                    <strong>What:</strong> {riskState.explanation}
                  </p>
                  {riskState.drivers?.length ? (
                    <p>
                      <strong>Key drivers:</strong> {riskState.drivers.join(" • ")}
                    </p>
                  ) : null}
                  <p>
                    <strong>If this continues:</strong> {riskState.consequence}
                  </p>
                  <p>
                    <strong>Recommended next:</strong> {riskState.recommendation}
                  </p>
                </div>

                <div className="risk-actions">
                  <button className="btn btn-primary" onClick={() => handleRiskAction("start_focus_mode")} type="button">
                    Start Focus Mode
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleRiskAction("create_recovery_plan")}
                    type="button"
                  >
                    Create Recovery Plan
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleRiskAction("show_priority_topics")}
                    type="button"
                  >
                    Show Priority Topics
                  </button>
                </div>

                {focusModeRunning ? (
                  <div className="timeline-box">
                    <h4>Focus Mode Running</h4>
                    <p>{focusModeSeconds}s remaining in sprint.</p>
                    <div className="progress-track">
                      <span style={{ width: `${focusModeProgress}%` }} />
                    </div>
                  </div>
                ) : null}

                {recoveryPlan.length > 0 ? (
                  <div className="timeline-box">
                    <h4>Recovery Plan</h4>
                    {recoveryPlan.map((step, index) => (
                      <p key={step}>
                        {index + 1}. {step}
                      </p>
                    ))}
                  </div>
                ) : null}

                {priorityTopics.length > 0 ? (
                  <div className="timeline-box">
                    <h4>Priority Topics</h4>
                    {priorityTopics.map((topic) => (
                      <p key={topic}>• {topic}</p>
                    ))}
                  </div>
                ) : null}
              </aside>
            </section>
          ) : null}
        </>
      ) : null}

    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function resolveActionText(intervention, action, updatedIntervention) {
  const payloads = intervention.actionPayloads || {};

  if (updatedIntervention?.improvementNote) {
    return `${payloads[action] || intervention.nextAction} ${updatedIntervention.improvementNote}`;
  }

  return payloads[action] || intervention.nextAction;
}

function estimateWastedMinutes(signal, telemetry) {
  const friction = Math.max(
    signal.procrastinationScore || 0,
    signal.distractionScore || 0
  );

  const base = Math.max(2, Math.round((telemetry.timeOnTaskMs || 0) / 60000));
  return Math.max(1, Math.round(base * (0.6 + friction)));
}

function computeGradesRiskState({
  currentGrade,
  courseGrades,
  upcomingAssessments,
  signal,
  telemetry,
  context,
  riskAdjustment
}) {
  const filledCourseGrades = (courseGrades || []).map((entry) => entry.grade).filter((value) => GRADE_OPTIONS.includes(value));
  const gradedCount = filledCourseGrades.length;
  const coverageRatio = clamp01(gradedCount / Math.max(1, GRADE_SLOT_COUNT));
  const fallbackGrade = GRADE_OPTIONS.includes(currentGrade) ? currentGrade : "B+";
  const gradeSamples = filledCourseGrades.length > 0 ? filledCourseGrades : Array.from({ length: GRADE_SLOT_COUNT }, () => fallbackGrade);
  const gradeRisk =
    gradeSamples.length > 0
      ? gradeSamples.reduce((sum, grade) => sum + gradeToRisk(grade), 0) / gradeSamples.length
      : gradeToRisk(fallbackGrade);
  const coveragePenalty = (1 - coverageRatio) * 0.16;
  const profileRisk = clamp01(gradeRisk + coveragePenalty);
  const averageGrade = percentToLetterGrade(
    gradeSamples.reduce((sum, grade) => sum + gradeToPercentMidpoint(grade), 0) / Math.max(1, gradeSamples.length)
  );
  const gradeLabel =
    gradedCount > 0
      ? `${gradedCount}/${GRADE_SLOT_COUNT} courses graded (avg ${averageGrade})`
      : `baseline ${fallbackGrade} across all courses`;
  const behaviorRisk = Math.max(
    signal.procrastinationScore || 0,
    signal.distractionScore || 0
  );
  const behaviorRiskPct = Math.round(behaviorRisk * 100);
  const wastedMinutes = estimateWastedMinutes(signal, telemetry);
  const wastedRisk = clamp01(wastedMinutes / 18);
  const idleSeconds = Math.round((telemetry.idleDurationMs || 0) / 1000);
  const repeatedActionCount = Number(telemetry.repeatedActions || 0);
  const focusScoreRounded = Math.round(Number(signal.focusScore || 0));

  const activitySignal = clamp01(
    (Math.min(1.2, telemetry.typingSpeed || 0) / 1.2) * 0.55 +
      (1 - clamp01((telemetry.idleDurationMs || 0) / 45000)) * 0.45
  );
  const activityPenalty = clamp01(1 - activitySignal);
  const assessmentTarget = formatAssessmentTargets(upcomingAssessments);
  const upcomingCount = countUpcomingAssessments(upcomingAssessments);
  const nearestAssessment = getNearestUpcomingAssessment(upcomingAssessments);
  const nearestAssessmentLine = getNearestAssessmentLine(nearestAssessment);
  const schedulePressure = upcomingCount >= 2 ? 0.06 : upcomingCount === 1 ? 0.03 : 0;

  const rawScore =
    profileRisk * 0.34 + behaviorRisk * 0.32 + wastedRisk * 0.18 + activityPenalty * 0.1 + schedulePressure - riskAdjustment;
  const score = clamp01(rawScore);

  let level = "Low";
  if (score >= 0.65) {
    level = "High";
  } else if (score >= 0.38) {
    level = "Moderate";
  }

  let predictedOutcome = `Current projection: with ${gradeLabel}, your performance can stay stable if you keep activity consistent and avoid long idle windows.`;
  if (level === "Moderate") {
    predictedOutcome = `Current projection: based on ${gradeLabel} plus behavior drift (${behaviorRiskPct}% risk), continued interruptions may lower quiz/test performance across upcoming checks.`;
  }
  if (level === "High") {
    predictedOutcome = `Current projection: your pace suggests incomplete coverage before ${assessmentTarget}. Without a recovery sprint, retention and completion quality are likely to drop.`;
  }

  const explanation = `Risk model sees ${gradeLabel}, ${behaviorRiskPct}% behavior drift, focus score ${focusScoreRounded}%, idle window ${idleSeconds}s, and ${repeatedActionCount} repeated actions. Combined signal indicates ${level.toLowerCase()} academic risk.`;
  const consequence =
    level === "Low"
      ? `You are on track, but repeated inactivity spikes can still reduce retention before ${assessmentTarget}.${nearestAssessmentLine ? ` ${nearestAssessmentLine}` : ""}`
      : level === "Moderate"
        ? `Retention may drop and prep quality can become uneven. At this pace, some topics may remain only partially reviewed before ${assessmentTarget}.${nearestAssessmentLine ? ` ${nearestAssessmentLine}` : ""}`
        : `High risk trend: key topics are likely to remain under-practiced before ${assessmentTarget}, which can directly affect assessment outcomes.${nearestAssessmentLine ? ` ${nearestAssessmentLine}` : ""}`;
  const recommendation =
    level === "Low"
      ? "Run 2 short focus blocks (10m each), log one takeaway per block, and avoid non-task tab switches."
      : level === "Moderate"
        ? `Start a 2-minute lock-in now, then complete one targeted review block for ${assessmentTarget}.${nearestAssessmentLine ? " You are close to assessment time, so consistency matters right now." : ""}`
        : `Start recovery now: 2-minute lock-in, then 20-minute focused review on highest-weight topics before ${assessmentTarget}.${nearestAssessmentLine ? " Protect this next window and avoid distractions." : ""}`;

  const drivers = [
    `Behavior drift: ${behaviorRiskPct}%`,
    `Focus score: ${focusScoreRounded}%`,
    `Idle duration: ${idleSeconds}s`,
    `Repeated actions: ${repeatedActionCount}`,
    `Grade coverage: ${Math.round(coverageRatio * 100)}%`
  ];

  return {
    score,
    level,
    gradeLabel,
    gradedCount,
    gradeCoveragePct: Math.round(coverageRatio * 100),
    upcomingCount,
    predictedOutcome,
    explanation,
    consequence,
    recommendation,
    drivers
  };
}

function attachRiskToIntervention(intervention, riskState, browserNotifications = null, upcomingAssessments = []) {
  if (!intervention) {
    return null;
  }

  const whatBase = intervention.what || intervention.message || "";
  const whyBase = intervention.why || intervention.reason || "";
  const riskLine = `You are currently at ${riskState.level.toLowerCase()} risk based on your grade and session behavior.`;
  const urgencyLine = buildAssessmentUrgencyLine(upcomingAssessments, intervention.type);
  const nudgeLine =
    browserNotifications?.enabled
      ? `Browser reminders are active (${browserNotifications.mode}) and will notify you if momentum drops.`
      : "";
  const nextActionLine = urgencyLine || intervention.nextAction;

  return {
    ...intervention,
    what: whatBase.includes("currently at") ? whatBase : `${whatBase} ${riskLine} ${urgencyLine}`.trim(),
    message: `${whatBase} ${riskLine} ${urgencyLine} ${nudgeLine}`.trim(),
    nextAction: nextActionLine,
    why: whyBase.includes("grade") ? whyBase : `${whyBase} Current grade signal: ${riskState.gradeLabel}.`.trim()
  };
}

function buildRecoveryPlan(riskState, context, upcomingAssessmentSummary) {
  const target = upcomingAssessmentSummary || "next assessment";
  return [
    "Focus for 10 minutes on one objective with no tab switching.",
    `Review high-impact material in ${context.activityType === "none_detected" ? "your current course" : context.activityType}.`,
    `Attempt 1 practice problem and check progress before ${target}.`,
    `Apply the recommendation: ${riskState.recommendation}`
  ];
}

function deriveFallbackGrade(courseGrades, baselineGrade) {
  const firstCourseGrade = (courseGrades || []).map((entry) => entry.grade).find((grade) => GRADE_OPTIONS.includes(grade));
  if (firstCourseGrade) {
    return firstCourseGrade;
  }
  if (GRADE_OPTIONS.includes(baselineGrade)) {
    return baselineGrade;
  }
  return "B+";
}

function formatAssessmentTargets(assessments) {
  const items = (assessments || [])
    .map((entry) => {
      const cleanName = String(entry?.name || "").trim();
      const cleanDate = String(entry?.date || "").trim();
      if (!cleanName && !cleanDate) {
        return "";
      }
      if (!cleanDate) {
        return cleanName;
      }
      const formattedDate = formatDateForDisplay(cleanDate);
      if (!cleanName) {
        return formattedDate;
      }
      return `${cleanName} (${formattedDate})`;
    })
    .filter(Boolean);

  if (items.length === 0) {
    return "your next assessment";
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items[0]}, ${items[1]}, and ${items[2]}`;
}

function countUpcomingAssessments(assessments) {
  return (assessments || []).filter((entry) => {
    const name = String(entry?.name || "").trim();
    const date = String(entry?.date || "").trim();
    return Boolean(name || date);
  }).length;
}

function buildAssessmentUrgencyLine(assessments, issueType) {
  if (!["distraction", "inactivity", "procrastination"].includes(issueType)) {
    return "";
  }

  const nearest = getNearestUpcomingAssessment(assessments);
  if (!nearest) {
    return "";
  }

  const target = nearest.name || "your assessment";
  if (nearest.daysUntil === 0) {
    return `Friendly reminder: ${target} is today. Let’s lock in for 2 minutes right now.`;
  }
  if (nearest.daysUntil === 1) {
    return `Friendly reminder: ${target} is tomorrow. Try a quick lock-in now to stay ahead.`;
  }
  if (nearest.daysUntil <= 3) {
    return `You have ${target} in ${nearest.daysUntil} days. Staying focused now will make prep easier.`;
  }
  return "";
}

function getNearestAssessmentLine(nearestAssessment) {
  if (!nearestAssessment) {
    return "";
  }
  const target = nearestAssessment.name || "Your upcoming assessment";
  if (nearestAssessment.daysUntil === 0) {
    return `${target} is today. Keep this study block protected.`;
  }
  if (nearestAssessment.daysUntil === 1) {
    return `${target} is tomorrow. This is the right time to lock in and review.`;
  }
  if (nearestAssessment.daysUntil <= 3) {
    return `${target} is in ${nearestAssessment.daysUntil} days, so consistency right now has high impact.`;
  }
  return "";
}

function getNearestUpcomingAssessment(assessments) {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const candidates = (assessments || [])
    .map((entry) => {
      const dateValue = String(entry?.date || "").trim();
      if (!dateValue) {
        return null;
      }
      const parsed = new Date(`${dateValue}T00:00:00`);
      if (Number.isNaN(parsed.getTime())) {
        return null;
      }
      const targetStart = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const daysUntil = Math.round((targetStart.getTime() - todayStart.getTime()) / 86400000);
      if (daysUntil < 0) {
        return null;
      }
      return {
        name: String(entry?.name || "").trim(),
        daysUntil,
        ts: targetStart.getTime()
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  return candidates[0] || null;
}

function formatDateForDisplay(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function buildPriorityTopics(context, signal) {
  const baseTopics = {
    coding: ["Core algorithms", "Debugging workflow", "Test case design"],
    writing: ["Thesis clarity", "Structure flow", "Evidence support"],
    studying: ["Active recall", "Concept mapping", "Practice questions"],
    watching: ["Key takeaways", "Action notes", "Checkpoint summaries"],
    reading: ["Main argument extraction", "Retention notes", "Decision checkpoints"],
    none_detected: ["Current assignment goals", "Upcoming test scope", "High-weight topics"]
  };

  const activity = context.activityType || "none_detected";
  const topics = baseTopics[activity] || baseTopics.none_detected;
  const issueHint = signal.issueType ? `Intervention target: ${signal.issueType.replaceAll("_", " ")}` : "No active issue";
  return [...topics, issueHint].slice(0, 4);
}

function gradeToRisk(grade) {
  const map = {
    A: 0.12,
    "A-": 0.18,
    "B+": 0.26,
    B: 0.34,
    "B-": 0.42,
    "C+": 0.52,
    C: 0.61,
    "C-": 0.68,
    D: 0.79,
    F: 0.92
  };
  return map[grade] ?? 0.4;
}

function riskClassName(level) {
  if (level === "Low") {
    return "low";
  }
  if (level === "Moderate") {
    return "moderate";
  }
  return "high";
}

function parseGradeFromPortalLink(link, fallbackGrade = "B+") {
  const clean = String(link || "").trim();
  if (!clean) {
    return {
      grade: null,
      grades: [],
      source: "No link provided.",
      message: "Add a grade portal link to simulate parsing."
    };
  }

  const tokenKeys = [
    "grade",
    "current_grade",
    "currentGrade",
    "letterGrade",
    "letter",
    "score",
    "percent",
    "pct",
    "g"
  ];

  try {
    const parsed = new URL(clean);
    const gradeSignals = [];

    for (const [key, value] of parsed.searchParams.entries()) {
      const normalizedValue = normalizeGradeToken(value);
      if (normalizedValue && /grade|score|percent|pct|letter|g/i.test(key)) {
        gradeSignals.push(normalizedValue);
      }
    }

    if (gradeSignals.length > 0) {
      return {
        grade: gradeSignals[0],
        grades: gradeSignals.slice(0, GRADE_SLOT_COUNT),
        source: "Grade tokens found in URL query params.",
        message: `Parsed grade signals: ${gradeSignals.slice(0, GRADE_SLOT_COUNT).join(", ")}`
      };
    }

    for (const key of tokenKeys) {
      const rawToken = parsed.searchParams.get(key);
      const normalized = normalizeGradeToken(rawToken);
      if (normalized) {
        return {
          grade: normalized,
          grades: [normalized],
          source: `Grade token found in query param "${key}".`,
          message: `Parsed grade signal: ${normalized}`
        };
      }
    }

    const pathMatch = safeDecode(`${parsed.pathname} ${parsed.hash}`).match(
      /(grade|score|letter)[^a-zA-Z0-9]{0,8}([A-F][+-]?|[0-9]{1,3}(?:\.[0-9]+)?%?)/i
    );
    if (pathMatch?.[2]) {
      const normalized = normalizeGradeToken(pathMatch[2]);
      if (normalized) {
        return {
          grade: normalized,
          grades: [normalized],
          source: "Grade token found in URL path/hash.",
          message: `Parsed grade signal: ${normalized}`
        };
      }
    }
  } catch {
    // Ignore parse failure and continue with regex extraction.
  }

  const tokenMatch = safeDecode(clean).match(/\b(A\+|A-|A|B\+|B-|B|C\+|C-|C|D|F|[0-9]{1,3}(?:\.[0-9]+)?%?)\b/i);
  if (tokenMatch?.[1]) {
    const normalized = normalizeGradeToken(tokenMatch[1]);
    if (normalized) {
      return {
        grade: normalized,
        grades: [normalized],
        source: "Grade token found in raw link text.",
        message: `Parsed grade signal: ${normalized}`
      };
    }
  }

  if (/grade|report|portal|progress|classroom|canvas|blackboard|schoology/i.test(clean)) {
    return {
      grade: fallbackGrade,
      grades: [fallbackGrade],
      source: "Portal URL detected without explicit grade token.",
      message: `Portal detected, but no explicit grade token found. Keeping your entered grades and using baseline ${fallbackGrade} only for empty slots.`
    };
  }

  return {
    grade: null,
    grades: [],
    source: "No grade token found in link.",
    message: "Could not parse a grade from this link. Add grade in URL (e.g. ?grade=B+) or keep manual grade."
  };
}

function buildEmptyCourseGrades() {
  return Array.from({ length: GRADE_SLOT_COUNT }, (_value, index) => ({
    id: `course-${index + 1}`,
    course: "",
    grade: ""
  }));
}

function buildEmptyAssessments() {
  return Array.from({ length: ASSESSMENT_SLOT_COUNT }, (_value, index) => ({
    id: `assessment-${index + 1}`,
    name: "",
    date: ""
  }));
}

function normalizeGradeToken(token) {
  const raw = String(token || "").trim();
  if (!raw) {
    return null;
  }

  const compact = raw.toUpperCase().replace(/\s+/g, "");
  const textExpanded = compact.replaceAll("PLUS", "+").replaceAll("MINUS", "-");

  if (GRADE_OPTIONS.includes(textExpanded)) {
    return textExpanded;
  }

  if (/^[0-9]{1,3}(\.[0-9]+)?%?$/.test(textExpanded)) {
    const numeric = Number(textExpanded.replace("%", ""));
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return percentToLetterGrade(numeric);
  }

  return null;
}

function percentToLetterGrade(percent) {
  if (percent >= 93) {
    return "A";
  }
  if (percent >= 90) {
    return "A-";
  }
  if (percent >= 87) {
    return "B+";
  }
  if (percent >= 83) {
    return "B";
  }
  if (percent >= 80) {
    return "B-";
  }
  if (percent >= 77) {
    return "C+";
  }
  if (percent >= 73) {
    return "C";
  }
  if (percent >= 70) {
    return "C-";
  }
  if (percent >= 60) {
    return "D";
  }
  return "F";
}

function gradeToPercentMidpoint(grade) {
  const map = {
    A: 96,
    "A-": 91,
    "B+": 88,
    B: 85,
    "B-": 81,
    "C+": 78,
    C: 74,
    "C-": 71,
    D: 66,
    F: 50
  };
  return map[grade] ?? 81;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractPageTextSample() {
  const candidate =
    document.querySelector("main") || document.querySelector("article") || document.querySelector("section") || document.body;
  const text = (candidate?.innerText || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 700);
}

function extractWorkingText() {
  const active = document.activeElement;

  if (active instanceof HTMLTextAreaElement) {
    return active.value || "";
  }

  if (active instanceof HTMLInputElement) {
    const type = (active.type || "text").toLowerCase();
    if (["text", "search", "url", "email", "number"].includes(type)) {
      return active.value || "";
    }
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    return active.textContent || "";
  }

  return "";
}

function hasEditableSurface() {
  return Boolean(
    document.querySelector(
      "textarea, [contenteditable='true'], input[type='text'], input[type='search'], input:not([type])"
    )
  );
}

function formatEventType(eventType) {
  return String(eventType || "event").replaceAll("_", " ");
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export default WorkspacePage;
