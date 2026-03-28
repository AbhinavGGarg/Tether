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
      show_fix: actionPayloads.show_fix || fallback.actionPayloads.show_fix,
      give_hint: actionPayloads.give_hint || fallback.actionPayloads.give_hint,
      refocus: actionPayloads.refocus || fallback.actionPayloads.refocus,
      summarize: actionPayloads.summarize || fallback.actionPayloads.summarize
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
- actionPayloads: { show_fix, give_hint, refocus, summarize }

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
