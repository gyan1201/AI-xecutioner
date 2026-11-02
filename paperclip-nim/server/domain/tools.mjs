/**
 * The agent toolbelt.
 *
 * Every tool is a NIM capability or a domain action, exposed to models in the
 * OpenAI function-calling shape. Tools are the reason an agent can do more than
 * write prose: it can retrieve, compute, draw, check itself, escalate to a human
 * and move the board.
 */

import { OPEN_STATUSES, PRIORITIES, createApproval, findIssue, pushActivity } from "./model.mjs";
import { newId, nowIso } from "../store.mjs";
import { renderContext, searchKnowledge } from "./retrieval.mjs";

export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "knowledge_search",
      description:
        "Search the company knowledge base (embeddings + rerank). Use before making any factual claim about the company, customers or metrics.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to look for." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluate arithmetic exactly. Supports + - * / % ^ and parentheses.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "e.g. (12400 / 20000) * 100" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_artifact",
      description: "Save a deliverable (markdown, csv, sql, text) to the issue so a human can open it.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          kind: { type: "string", enum: ["markdown", "csv", "sql", "text", "json"] },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generate an image with a NVIDIA visual generative AI NIM (returns an artifact).",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          negative_prompt: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_safety",
      description: "Run a NeMo Guardrail check on text before publishing it outside the company.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate",
      description: "Ask a human for approval. Use for public actions, spend above your cap, or anything irreversible.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          action: { type: "string" },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_issue",
      description: "Move this issue's status or priority on the board.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: OPEN_STATUSES },
          priority: { type: "string", enum: PRIORITIES },
          note: { type: "string" },
        },
      },
    },
  },
];

/* ------------------------------------------------------------ calculator */

function evaluate(expression) {
  const source = String(expression ?? "").replace(/\s+/g, "");
  if (!/^[-+*/%^().0-9eE]+$/.test(source)) throw new Error("Only arithmetic is allowed.");
  let index = 0;

  function parseExpression() {
    let value = parseTerm();
    while (source[index] === "+" || source[index] === "-") {
      const operator = source[index++];
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }
  function parseTerm() {
    let value = parseFactor();
    while (source[index] === "*" || source[index] === "/" || source[index] === "%") {
      const operator = source[index++];
      const right = parseFactor();
      if (operator === "*") value *= right;
      else if (operator === "/") value /= right;
      else value %= right;
    }
    return value;
  }
  function parseFactor() {
    if (source[index] === "+") {
      index += 1;
      return parseFactor();
    }
    if (source[index] === "-") {
      index += 1;
      return -parseFactor();
    }
    let base = parsePrimary();
    if (source[index] === "^") {
      index += 1;
      base **= parseFactor();
    }
    return base;
  }
  function parsePrimary() {
    if (source[index] === "(") {
      index += 1;
      const value = parseExpression();
      if (source[index] !== ")") throw new Error("Unbalanced parentheses.");
      index += 1;
      return value;
    }
    const start = index;
    while (/[0-9.eE+-]/.test(source[index] ?? "")) {
      // allow exponent signs only inside a number
      if ((source[index] === "+" || source[index] === "-") && !/[eE]/.test(source[index - 1] ?? "")) break;
      index += 1;
    }
    const text = source.slice(start, index);
    if (!text) throw new Error("Unexpected token.");
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`"${text}" is not a number.`);
    return value;
  }

  const result = parseExpression();
  if (index !== source.length) throw new Error("Unexpected trailing input.");
  if (!Number.isFinite(result)) throw new Error("Result is not finite.");
  return result;
}

/* --------------------------------------------------------------- registry */

export function createToolRegistry({ store, nim, bus }) {
  function emit(company, event) {
    bus?.publish({ companyId: company.id, ...event });
  }

  async function execute(name, args = {}, ctx = {}) {
    const { company, issue, agent, run, emit: localEmit } = ctx;
    const emitStep = (payload) => {
      run?.steps?.push({ label: payload.label, detail: payload.detail, ms: payload.ms ?? 0, at: nowIso() });
      emit(company, { type: "run.step", payload: { runId: run?.id, issueId: issue?.id, ...payload } });
      localEmit?.(payload);
    };

    switch (name) {
      case "knowledge_search": {
        const result = await searchKnowledge({ company, nim, query: String(args.query ?? "").slice(0, 400) });
        emitStep({
          label: `Searched knowledge: ${String(args.query ?? "").slice(0, 60)}`,
          detail: `${result.passages.length} passages from ${result.candidates} candidates`,
        });
        return {
          summary: `${result.passages.length} passages`,
          result: {
            passages: result.passages.map((passage, index) => ({
              source: `[${index + 1}] ${passage.title}`,
              text: passage.text.slice(0, 500),
              score: Number(passage.score.toFixed(3)),
            })),
            context: renderContext(result.passages),
          },
          meta: { passages: result.passages },
        };
      }
      case "calculator": {
        const value = evaluate(args.expression);
        emitStep({ label: `Calculated ${args.expression}`, detail: `= ${value}` });
        return { summary: `${args.expression} = ${value}`, result: { value } };
      }
      case "create_artifact": {
        const artifact = {
          id: newId("art"),
          issueId: issue?.id ?? null,
          runId: run?.id ?? null,
          agentId: agent?.id ?? null,
          title: String(args.title ?? "artifact.md").slice(0, 120),
          kind: ["markdown", "csv", "sql", "text", "json"].includes(args.kind) ? args.kind : "markdown",
          body: String(args.body ?? ""),
          createdAt: nowIso(),
        };
        company.artifacts.unshift(artifact);
        emitStep({ label: `Saved artifact ${artifact.title}`, detail: `${artifact.body.length} chars` });
        emit(company, { type: "artifact.created", payload: { artifact } });
        return { summary: `Saved ${artifact.title}`, result: { id: artifact.id, title: artifact.title } };
      }
      case "generate_image": {
        const image = await nim.generateImage({
          prompt: String(args.prompt ?? "").slice(0, 800),
          negativePrompt: args.negative_prompt,
          width: Number(args.width) || 1024,
          height: Number(args.height) || 1024,
        });
        const artifactRow = image.artifacts[0] ?? null;
        const artifact = artifactRow
          ? {
              id: newId("art"),
              issueId: issue?.id ?? null,
              runId: run?.id ?? null,
              agentId: agent?.id ?? null,
              title: String(args.prompt ?? "image").slice(0, 80),
              kind: "image",
              mimeType: artifactRow.mimeType,
              dataUri: `data:${artifactRow.mimeType};base64,${artifactRow.base64}`,
              body: "",
              createdAt: nowIso(),
              simulated: image.simulated,
            }
          : null;
        if (artifact) company.artifacts.unshift(artifact);
        emitStep({ label: "Generated an image", detail: artifact ? artifact.mimeType : "no artifact", ms: image.latencyMs });
        return {
          summary: artifact ? `Image artifact ${artifact.id}` : "Image NIM returned no artifact",
          result: { artifactId: artifact?.id ?? null, simulated: image.simulated },
        };
      }
      case "check_safety": {
        const verdict = await nim.safety({ text: String(args.text ?? "") });
        emitStep({ label: "NeMo Guardrail check", detail: `${verdict.verdict} (${verdict.score})`, ms: verdict.latencyMs });
        return {
          summary: `${verdict.verdict} (${verdict.score})`,
          result: { verdict: verdict.verdict, categories: verdict.categories, score: verdict.score, rationale: verdict.rationale },
        };
      }
      case "escalate": {
        if (!company || !issue) return { summary: "No issue in context to escalate.", result: { ok: false } };
        const approval = createApproval({
          issueId: issue.id,
          runId: run?.id ?? null,
          requestedBy: agent?.id ?? "agent",
          reason: String(args.reason ?? "Agent requested approval."),
          risk: ["low", "medium", "high"].includes(args.risk) ? args.risk : "medium",
          action: String(args.action ?? "Continue"),
        });
        company.approvals.unshift(approval);
        issue.status = "blocked";
        issue.blockedReason = `Awaiting approval: ${approval.action}`;
        issue.updatedAt = nowIso();
        pushActivity(company, {
          kind: "approval.requested",
          actorId: agent?.id ?? "system",
          subject: issue.key,
          detail: approval.action,
          issueId: issue.id,
        });
        emitStep({ label: "Escalated to a human", detail: approval.action });
        emit(company, { type: "approval.requested", payload: { approval, issueId: issue.id } });
        return { summary: `Escalated: ${approval.action}`, result: { approvalId: approval.id, status: "pending" } };
      }
      case "update_issue": {
        if (!company || !issue) return { summary: "No issue in context.", result: { ok: false } };
        const changes = {};
        if (args.status && OPEN_STATUSES.includes(args.status)) {
          issue.status = args.status;
          changes.status = args.status;
        }
        if (args.priority && PRIORITIES.includes(args.priority)) {
          issue.priority = args.priority;
          changes.priority = args.priority;
        }
        issue.updatedAt = nowIso();
        emitStep({ label: "Updated the board", detail: Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ") || "no change" });
        emit(company, { type: "issue.updated", payload: { issue } });
        return { summary: `Updated ${issue.key}: ${JSON.stringify(changes)}`, result: changes };
      }
      default:
        return { summary: `Unknown tool ${name}`, result: { error: "unknown_tool" } };
    }
  }

  return { definitions: TOOL_SPECS, execute, names: TOOL_SPECS.map((spec) => spec.function.name) };
}

export function toolsForAgent(agent, { allowEscalation = true } = {}) {
  const wanted = new Set(["knowledge_search", "calculator", "create_artifact", "check_safety", "update_issue"]);
  if ((agent?.capabilities ?? []).includes("image")) wanted.add("generate_image");
  if ((agent?.capabilities ?? []).includes("tools") || agent?.role === "operator" || allowEscalation) wanted.add("escalate");
  return TOOL_SPECS.filter((spec) => wanted.has(spec.function.name));
}
