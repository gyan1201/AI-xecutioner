/**
 * Agent tool runtime.
 *
 * Tools are executed by the server, never by the model. Every call is recorded
 * as a run event so an operator can audit exactly what an agent did.
 */

/** Tiny recursive-descent arithmetic parser — no eval, no imports. */
export function calculate(expression) {
  const source = String(expression ?? "").replace(/\s+/g, "");
  if (!/^[-+*/%().^0-9eE]+$/.test(source) || !source) {
    throw new Error("Only numbers and + - * / % ^ ( ) are allowed.");
  }
  let index = 0;

  const peek = () => source[index];
  const eat = (char) => {
    if (source[index] !== char) throw new Error(`Expected '${char}' at position ${index}.`);
    index += 1;
  };

  function parseExpression() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const operator = source[index++];
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  function parseTerm() {
    let value = parseUnary();
    while (["*", "/", "%"].includes(peek())) {
      const operator = source[index++];
      const right = parseUnary();
      if (operator === "*") value *= right;
      else if (operator === "/") {
        if (right === 0) throw new Error("Division by zero.");
        value /= right;
      } else value %= right;
    }
    return value;
  }

  function parseUnary() {
    if (peek() === "+") {
      index += 1;
      return parseUnary();
    }
    if (peek() === "-") {
      index += 1;
      return -parseUnary();
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek() === "^") {
      index += 1;
      return base ** parseUnary();
    }
    return base;
  }

  function parsePrimary() {
    if (peek() === "(") {
      eat("(");
      const value = parseExpression();
      eat(")");
      return value;
    }
    const start = index;
    while (/[0-9.eE]/.test(peek() ?? "") || ((peek() === "+" || peek() === "-") && /[eE]/.test(source[index - 1] ?? ""))) {
      index += 1;
    }
    const raw = source.slice(start, index);
    if (!raw) throw new Error(`Unexpected '${peek() ?? "end of input"}'.`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`'${raw}' is not a number.`);
    return value;
  }

  const result = parseExpression();
  if (index !== source.length) throw new Error(`Unexpected '${source[index]}'.`);
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number.");
  return result;
}

function safeName(value, fallback) {
  return (
    String(value ?? fallback)
      .replace(/[^\w.\- ]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 100) || fallback
  );
}

/**
 * @param {{
 *   nim: ReturnType<import('./nim.mjs').createNim>,
 *   store: ReturnType<import('./store.mjs').createStore>,
 *   retrieval: ReturnType<import('./retrieval.mjs').createRetrieval>,
 *   roles: Record<string, {model: string}>,
 *   runId: string,
 *   emit: (type: string, payload?: object) => void,
 *   signal?: AbortSignal,
 *   requireApproval: (question: object) => Promise<{ approved: boolean, note?: string }>,
 * }} context
 */
export function createToolRuntime(context) {
  const { nim, store, retrieval, roles, runId, emit, signal } = context;
  // Runs persist artifacts under data/runs/<id>; company cycles persist under
  // data/companies/<id>. Callers can inject the sink so agents use the same
  // tools in both engines.
  const writeArtifact =
    typeof context.writeArtifact === "function"
      ? context.writeArtifact
      : (name, content, meta) => store.writeArtifact(runId, name, content, meta);
  const approvals = [];

  async function run(name, args = {}) {
    emit("tool.started", { tool: name, args: redact(args) });
    const startedAt = Date.now();
    try {
      const result = await handlers[name]?.(args);
      if (result === undefined) throw new Error(`Unknown tool: ${name}`);
      emit("tool.completed", { tool: name, ms: Date.now() - startedAt, result: redact(result) });
      return result;
    } catch (error) {
      const message = error?.message ?? String(error);
      emit("tool.failed", { tool: name, ms: Date.now() - startedAt, error: message });
      return { error: message };
    }
  }

  const handlers = {
    async search_knowledge(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return { error: "query is required", passages: [] };
      const topK = Math.min(Math.max(Number(args.top_k ?? 4) || 4, 1), 10);
      const result = await retrieval.search(query, { topK, signal, useRerank: true });
      if (!result.passages.length) return { query, passages: [], note: "Knowledge base is empty. State assumptions explicitly." };
      return {
        query,
        reranked: Boolean(result.reranked),
        passages: result.passages.map((passage, index) => ({
          ref: `K${index + 1}`,
          title: passage.title,
          text: passage.text.slice(0, 1200),
          score: passage.rerankScore ?? passage.score,
        })),
      };
    },

    async calculate(args) {
      const expression = String(args.expression ?? "").trim();
      return { expression, value: calculate(expression) };
    },

    async save_artifact(args) {
      if (!runId) return { error: "No active run to save into." };
      const name = safeName(args.filename, "artifact.md");
      const record = writeArtifact(name, args.content ?? "", { source: "agent" });
      emit("artifact", { name: record.name, bytes: record.bytes });
      return { saved: true, filename: record.name, bytes: record.bytes };
    },

    async safety_check(args) {
      const text = String(args.text ?? "").slice(0, 12_000);
      const result = await nim.safetyCheck({ text, model: roles.safety?.model, signal });
      emit("guardrail", { safe: result.safe, categories: result.categories, scope: "tool" });
      return { safe: result.safe, categories: result.categories, reason: result.reason };
    },

    async generate_visual(args) {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { error: "prompt is required" };
      const [width, height] = String(args.aspect_ratio ?? "1024x1024")
        .split("x")
        .map((value) => Number(value) || 1024);
      const result = await nim.image({
        model: roles.artist?.model,
        prompt,
        width,
        height,
        signal,
      });
      const artifact = result.artifacts?.[0];
      if (artifact) {
        const extension = artifact.mimeType?.includes("svg") ? "svg" : "jpg";
        const filename = safeName(`${prompt.slice(0, 40)}.${extension}`, "visual.jpg");
        const buffer = Buffer.from(artifact.base64, "base64");
        const record = writeArtifact(filename, buffer, { source: "image", model: roles.artist?.model });
        emit("artifact", { name: record.name, bytes: record.bytes, kind: "image" });
        return { saved: true, filename: record.name, model: result.model, simulated: result.simulated };
      }
      return { error: "No image artifact returned." };
    },

    async escalate_to_human(args) {
      const question = String(args.question ?? "").trim();
      if (!question) return { error: "question is required" };
      const request = {
        question,
        whyBlocked: String(args.why_blocked ?? "").trim(),
        options: Array.isArray(args.options) ? args.options.map(String).slice(0, 5) : [],
        raisedAt: new Date().toISOString(),
      };
      approvals.push(request);
      emit("approval.requested", request);
      const decision = await context.requireApproval(request);
      emit("approval.resolved", { ...request, approved: decision.approved, note: decision.note });
      return {
        approved: decision.approved,
        note: decision.note ?? "",
        instruction: decision.approved
          ? "The human approved. Continue and finish the work item."
          : "The human rejected or deferred. Stop the work item and document the blocker.",
      };
    },
  };

  return { run, approvals };
}

function redact(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, depth + 1)]));
  }
  return value;
}
