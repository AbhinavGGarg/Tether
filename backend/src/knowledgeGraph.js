const CONTEXT_PROFILES = {
  coding: {
    category: "problem_solving",
    activityType: "coding",
    domains: ["github.com", "replit.com", "stackblitz.com", "codesandbox.io", "leetcode.com"],
    keywords: ["function", "class", "compile", "debug", "terminal", "repository", "pull request"]
  },
  writing: {
    category: "writing",
    activityType: "writing",
    domains: ["docs.google.com", "notion.so", "medium.com", "substack.com"],
    keywords: ["draft", "paragraph", "outline", "introduction", "thesis", "edit", "revision"]
  },
  studying: {
    category: "learning",
    activityType: "studying",
    domains: ["coursera.org", "edx.org", "khanacademy.org", "udemy.com", "wikipedia.org"],
    keywords: ["lesson", "chapter", "quiz", "exercise", "tutorial", "lecture", "practice"]
  },
  watching: {
    category: "consuming_content",
    activityType: "watching",
    domains: ["youtube.com", "vimeo.com", "netflix.com", "udemy.com"],
    keywords: ["video", "watch", "playlist", "episode", "stream", "playback"]
  },
  reading: {
    category: "consuming_content",
    activityType: "reading",
    domains: [],
    keywords: ["article", "blog", "thread", "post", "analysis", "reference"]
  }
};

const SHARED_ACTION_PAYLOADS = {
  lock_in_2m: "Start a 2-minute focus sprint and avoid context switching.",
  refocus_timer: "Run a 60-second single-task refocus sprint.",
  break_steps: "Break this into 3 tiny steps and do step one now.",
  try_new_approach: "Switch strategy and test one new approach.",
  short_break: "Take a short reset, then return with one clear objective.",
  resume_task: "Resume now and complete one concrete next step.",
  ignore: "Ignore for now. Monitoring will continue."
};

const INTERVENTION_LIBRARY = {
  coding: {
    procrastination: {
      title: "Procrastination Pattern Detected",
      message: "You are switching context often and delaying progress.",
      nextAction: "Choose one coding objective and stay on it for 2 minutes.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    distraction: {
      title: "Distraction Detected",
      message: "Your activity dropped and attention appears to be drifting.",
      nextAction: "Lock in and complete one task before switching tabs.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    inactivity: {
      title: "Distraction / Inactivity",
      message: "You have been inactive for 60 seconds.",
      nextAction: "Get back in for 2 minutes to regain momentum.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    }
  },
  writing: {
    procrastination: {
      title: "Procrastination Pattern Detected",
      message: "Context switching is disrupting your writing flow.",
      nextAction: "Commit to one paragraph for the next 2 minutes.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    distraction: {
      title: "Distraction Detected",
      message: "Your writing activity slowed and attention appears to drift.",
      nextAction: "Refocus and finish one sentence block now.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    inactivity: {
      title: "Distraction / Inactivity",
      message: "You have been inactive for 60 seconds.",
      nextAction: "Get back in for 2 minutes to regain momentum.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    }
  },
  studying: {
    procrastination: {
      title: "Procrastination Pattern Detected",
      message: "Your study session shows repeated context switching.",
      nextAction: "Pick one section and stay on it for 2 minutes.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    distraction: {
      title: "Distraction Detected",
      message: "Attention drift is reducing your study momentum.",
      nextAction: "Refocus and capture one key takeaway now.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    inactivity: {
      title: "Distraction / Inactivity",
      message: "You have been inactive for 60 seconds.",
      nextAction: "Get back in for 2 minutes to regain momentum.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    }
  },
  watching: {
    procrastination: {
      title: "Procrastination Pattern Detected",
      message: "You are watching without consistent task engagement.",
      nextAction: "Decide the next concrete action and execute it now.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    distraction: {
      title: "Distraction Detected",
      message: "Attention drift is increasing during content viewing.",
      nextAction: "Refocus and extract one clear takeaway now.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    inactivity: {
      title: "Distraction / Inactivity",
      message: "You have been inactive for 60 seconds.",
      nextAction: "Get back in for 2 minutes to regain momentum.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    }
  },
  reading: {
    procrastination: {
      title: "Procrastination Pattern Detected",
      message: "You are switching context and slowing page progress.",
      nextAction: "Stay on one objective for the next 2 minutes.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    distraction: {
      title: "Distraction Detected",
      message: "Reading momentum dropped and focus appears to drift.",
      nextAction: "Refocus and capture one insight from this page.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    },
    inactivity: {
      title: "Distraction / Inactivity",
      message: "You have been inactive for 60 seconds.",
      nextAction: "Get back in for 2 minutes to regain momentum.",
      actionPayloads: SHARED_ACTION_PAYLOADS
    }
  }
};

function getInterventionTemplate(activityType, issueType) {
  const byActivity = INTERVENTION_LIBRARY[activityType] || INTERVENTION_LIBRARY.reading;
  return byActivity[issueType] || INTERVENTION_LIBRARY.reading[issueType] || INTERVENTION_LIBRARY.reading.distraction;
}

export { CONTEXT_PROFILES, INTERVENTION_LIBRARY, getInterventionTemplate };
