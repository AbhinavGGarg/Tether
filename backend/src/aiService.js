import OpenAI from "openai";
import { getInterventionTemplate } from "./knowledgeGraph.js";

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function buildFallback({ issue, context }) {
  const template = getInterventionTemplate(context.activityType, issue.type);

  return {
    title: template.title,
    message: template.message,
    nextAction: template.nextAction,
    actionPayloads: template.actionPayloads,
    impactBefore: "~5 min likely wasted",
    impactAfter: "~2 min after intervention"
  };
}

function extractJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sanitizePayload(parsed, fallback) {
  if (!parsed || typeof parsed !== "object") {
    return fallback;
  }

  const actionPayloads = parsed.actionPayloads || {};

  return {
    title: parsed.title || fallback.title,
    message: parsed.message || fallback.message,
    nextAction: parsed.nextAction || fallback.nextAction,
    actionPayloads: {
      lock_in_2m: actionPayloads.lock_in_2m || fallback.actionPayloads.lock_in_2m,
      refocus_timer: actionPayloads.refocus_timer || fallback.actionPayloads.refocus_timer,
      break_steps: actionPayloads.break_steps || fallback.actionPayloads.break_steps,
      try_new_approach: actionPayloads.try_new_approach || fallback.actionPayloads.try_new_approach,
      short_break: actionPayloads.short_break || fallback.actionPayloads.short_break,
      resume_task: actionPayloads.resume_task || fallback.actionPayloads.resume_task,
      ignore: actionPayloads.ignore || fallback.actionPayloads.ignore
    },
    impactBefore: parsed.impactBefore || fallback.impactBefore,
    impactAfter: parsed.impactAfter || fallback.impactAfter
  };
}

async function generateIntervention({ issue, context, metrics, sessionSnapshot }) {
  const fallback = buildFallback({ issue, context });

  if (!client) {
    return fallback;
  }

  const prompt = `You are Nudge, a context-aware real-time intervention system.
Return JSON only with keys:
- title
- message
- nextAction
- impactBefore
- impactAfter
- actionPayloads: { lock_in_2m, refocus_timer, break_steps, try_new_approach, short_break, resume_task, ignore }

Constraints:
- Keep title under 6 words.
- Keep message under 18 words.
- Keep each action payload under 18 words.
- Must include what is happening, why it is happening, and what to do next.

Context:
- activityType: ${context.activityType}
- category: ${context.category}
- domain: ${context.domain}
- issueType: ${issue.type}
- severity: ${issue.severity}
- reason: ${issue.reason}
- diagnostics: ${JSON.stringify(issue.diagnostics)}
- metrics: ${JSON.stringify(metrics)}
- aggregate: ${JSON.stringify(sessionSnapshot.aggregate)}
`;

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.25,
      messages: [{ role: "user", content: prompt }]
    });

    const content = response.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    return sanitizePayload(parsed, fallback);
  } catch {
    return fallback;
  }
}

export { generateIntervention };
