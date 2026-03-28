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

const INTERVENTION_LIBRARY = {
  coding: {
    confusion: {
      title: "Stuck While Coding",
      message: "You paused and retried repeatedly. A small reset can unblock you.",
      nextAction: "Write one tiny failing case, then fix only that path.",
      actionPayloads: {
        show_fix: "Use smallest-case debugging: input -> expected output -> first failing line.",
        give_hint: "Start with one edge case and prove it before scaling up.",
        refocus: "Run a 90-second single-tab sprint on one bug.",
        summarize: "Summarize bug, expected output, and next line to change."
      }
    },
    distraction: {
      title: "Focus Drift During Coding",
      message: "Frequent tab changes are breaking your coding momentum.",
      nextAction: "Set one micro-goal and finish it before switching context.",
      actionPayloads: {
        show_fix: "Keep one task tab and one reference tab only.",
        give_hint: "Pick one function and complete it end-to-end first.",
        refocus: "Start a 90-second focus sprint now.",
        summarize: "Write one coding objective for the next 90 seconds."
      }
    },
    inefficiency: {
      title: "Inefficient Edit Loop",
      message: "You are editing repeatedly with low forward progress.",
      nextAction: "Pause and choose one clear next action before coding more.",
      actionPayloads: {
        show_fix: "Plan first: input shape, logic path, edge case handling.",
        give_hint: "One complete pass beats multiple partial rewrites.",
        refocus: "Stop typing for 20 seconds and commit to one planned step.",
        summarize: "Summarize your immediate next action in one line."
      }
    }
  },
  writing: {
    confusion: {
      title: "Clarity Dip Detected",
      message: "Your writing flow looks stuck and uncertain.",
      nextAction: "Rewrite one sentence as subject + action + outcome.",
      actionPayloads: {
        show_fix: "Write a one-line thesis, then align every sentence to it.",
        give_hint: "Lead with one clear claim before supporting details.",
        refocus: "Draft two new sentences without editing.",
        summarize: "Summarize this paragraph’s job in one sentence."
      }
    },
    distraction: {
      title: "Writing Focus Drift",
      message: "Context switching is reducing your writing momentum.",
      nextAction: "Commit to 90 seconds of uninterrupted drafting.",
      actionPayloads: {
        show_fix: "Disable side tasks and keep cursor in one document.",
        give_hint: "Momentum first, polish second.",
        refocus: "Start a 90-second no-edit sprint.",
        summarize: "Summarize what this paragraph must accomplish."
      }
    },
    inefficiency: {
      title: "Over-Editing Pattern",
      message: "You may be polishing too early instead of finishing ideas.",
      nextAction: "Separate drafting and editing into short passes.",
      actionPayloads: {
        show_fix: "Use a 60s draft pass followed by a 30s edit pass.",
        give_hint: "Finish ideas fully, then improve wording.",
        refocus: "Switch to draft-only mode for one minute.",
        summarize: "Summarize the key point before editing style."
      }
    }
  },
  studying: {
    confusion: {
      title: "Comprehension Friction",
      message: "This section may not be sticking yet.",
      nextAction: "Summarize from memory in one sentence.",
      actionPayloads: {
        show_fix: "Read, close page, recall one key idea without looking.",
        give_hint: "If recall fails, reread heading and first sentence only.",
        refocus: "Take 20 seconds and capture one takeaway.",
        summarize: "Summarize what you learned in plain language."
      }
    },
    distraction: {
      title: "Study Attention Drift",
      message: "Your attention appears to be drifting from the task.",
      nextAction: "Define one question this page should answer.",
      actionPayloads: {
        show_fix: "Use question-led reading to stay task-focused.",
        give_hint: "Set objective before reading the next section.",
        refocus: "Run a 60-second focused recall sprint.",
        summarize: "Summarize your current study objective."
      }
    },
    inefficiency: {
      title: "Low-Return Study Loop",
      message: "You may be consuming without extracting useful insight.",
      nextAction: "Capture two practical takeaways now.",
      actionPayloads: {
        show_fix: "Convert passive reading into one Q&A from memory.",
        give_hint: "Extraction beats rereading for retention.",
        refocus: "Pause and write two bullet takeaways.",
        summarize: "Summarize one idea and one next action."
      }
    }
  },
  watching: {
    confusion: {
      title: "Passive Watching Detected",
      message: "You may be watching without enough retention.",
      nextAction: "Pause and write one sentence from the last 2 minutes.",
      actionPayloads: {
        show_fix: "Checkpoint each concept with a one-line note.",
        give_hint: "Pause briefly after each key point.",
        refocus: "Commit to 3 focused minutes or intentionally switch.",
        summarize: "Summarize the last segment in one sentence."
      }
    },
    distraction: {
      title: "Viewing Focus Drift",
      message: "Switching behavior is increasing during content consumption.",
      nextAction: "Decide intentionally: continue now or switch tasks.",
      actionPayloads: {
        show_fix: "Choose one path now: continue for 3 minutes or close it.",
        give_hint: "Intentional choices beat accidental scrolling.",
        refocus: "Set a 3-minute focus timer.",
        summarize: "Summarize why this content matters right now."
      }
    },
    inefficiency: {
      title: "Low-Return Consumption",
      message: "You may be consuming content without extracting value.",
      nextAction: "Capture two actionable takeaways before continuing.",
      actionPayloads: {
        show_fix: "Turn each segment into one concrete decision.",
        give_hint: "Ask what you will do differently after this.",
        refocus: "Pause and record one action item.",
        summarize: "Summarize one actionable takeaway."
      }
    }
  },
  reading: {
    confusion: {
      title: "Reading Friction Spotted",
      message: "You may be rereading without solid comprehension.",
      nextAction: "Paraphrase this section in one sentence.",
      actionPayloads: {
        show_fix: "Reread heading + first sentence, then paraphrase.",
        give_hint: "Find the main claim before details.",
        refocus: "Set one question this page should answer.",
        summarize: "Summarize the key idea in plain language."
      }
    },
    distraction: {
      title: "Browsing Drift Detected",
      message: "Scrolling and switching behavior have increased.",
      nextAction: "Define one objective for this page.",
      actionPayloads: {
        show_fix: "Question-led reading keeps browsing purposeful.",
        give_hint: "Keep one objective visible while reading.",
        refocus: "Do a 60-second objective-first pass.",
        summarize: "Summarize why this page matters to your goal."
      }
    },
    inefficiency: {
      title: "Low Progress Pattern",
      message: "You may be consuming information without extraction.",
      nextAction: "Write one insight and one next action.",
      actionPayloads: {
        show_fix: "Use one insight + one action per page.",
        give_hint: "Extraction beats passive consumption.",
        refocus: "Pause and capture one concrete insight.",
        summarize: "Summarize one insight and one action item."
      }
    }
  }
};

function getInterventionTemplate(activityType, issueType) {
  const byActivity = INTERVENTION_LIBRARY[activityType] || INTERVENTION_LIBRARY.reading;
  return byActivity[issueType] || INTERVENTION_LIBRARY.reading[issueType] || INTERVENTION_LIBRARY.reading.confusion;
}

export { CONTEXT_PROFILES, INTERVENTION_LIBRARY, getInterventionTemplate };
