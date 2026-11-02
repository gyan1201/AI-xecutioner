import { randomUUID } from "node:crypto";
import { AGENT_TOOLS, ROLE_DEFINITIONS } from "./catalog.mjs";
import { extractJson, parseToolArguments } from "./nim.mjs";
import { createToolRuntime } from "./tools.mjs";

/**
 * Goal-driven autopilot.
 *
 * Give it one company goal. It plans, staffs, executes, reviews and reports —
 * unattended — using NVIDIA NIM for every step. Humans stay in the loop through
 * guardrails, spend ceilings and approval gates rather than by babysitting.
 */

export const RUN_STATUSES = [
  "queued",
  "planning",
  "executing",
  "awaiting_approval",
  "paused",
  "reporting",
  "completed",
  "completed_with_issues",
  "blocked",
  "failed",
  "cancelled",
];

const DEFAULT_OPTIONS = {
  maxSteps: 6,
  maxTokens: 250_000,
  maxMinutes: 20,
  concurrency: 2,
  requireApproval: "high", // "never" | "high" | "all"
  useKnowledge: true,
  screenOutputs: true,
  approvalTimeoutMinutes: 30,
};

export class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    maxSteps: clamp(options.maxSteps, 1, 20, DEFAULT_OPTIONS.maxSteps),
    maxTokens: clamp(options.maxTokens, 5_000, 5_000_000, DEFAULT_OPTIONS.maxTokens),
    maxMinutes: clamp(options.maxMinutes, 1, 240, DEFAULT_OPTIONS.maxMinutes),
    concurrency: clamp(options.concurrency, 1, 6, DEFAULT_OPTIONS.concurrency),
    requireApproval: ["never", "high", "all"].includes(options.requireApproval)
      ? options.requireApproval
      : DEFAULT_OPTIONS.requireApproval,
    approvalTimeoutMinutes: clamp(options.approvalTimeoutMinutes, 1, 1440, DEFAULT_OPTIONS.approvalTimeoutMinutes),
    useKnowledge: options.useKnowledge !== false,
    screenOutputs: options.screenOutputs !== false,
  };
}

const SYSTEM_PROMPTS = {
  strategist: `You are the Strategist, chief of staff for a company run by AI agents.
You convert one company goal into an executable plan. Be concrete and economical.
Return ONLY valid JSON matching this shape:
{
  "objective": string,
  "summary": string,
  "kpis": [{"name": string, "target": string, "measure": string}],
  "assumptions": [string],
  "tasks": [{
    "title": string,
    "owner": "analyst" | "operator" | "critic",
    "dependsOn": number[],
    "doneWhen": string,
    "risk": "low" | "medium" | "high",
    "effort": "S" | "M" | "L"
  }],
  "successCriteria": string
}
Rules: 3 to 6 tasks. "dependsOn" uses 1-based task numbers. Every task needs a testable "doneWhen".
Mark externally visible work, spend, legal or irreversible actions as "high" risk.
No prose outside the JSON.`,
  analyst: `You are the Analyst, research lead. Produce evidence-led analysis a busy executive can act on.
Structure: question, what the company context says (cite [K1], [K2] refs when context is supplied), baseline table with explicit assumptions, recommendation.
Never invent numbers — label estimates as assumptions. Flag any claim that needs human verification.`,
  operator: `You are the Operator, delivery lead. Produce the actual deliverable, not a description of it.
Use tools when they help: search_knowledge for company facts, calculate for numbers, save_artifact to persist files,
generate_visual for images, safety_check before publishing, escalate_to_human when blocked on money, access or a decision.
Write finished, customer-ready markdown. Be specific: names, owners, dates, numbers, next actions.
Keep definitions of done in mind and prove you met them.`,
  critic: `You are the Critic, quality reviewer. Judge the deliverable strictly against its definition of done.
Return ONLY valid JSON:
{"verdict":"pass"|"revise","score":0-100,"strengths":[string],"gaps":[string],"requiredChanges":[string]}
Pass only if the deliverable is specific, complete, internally consistent, grounded in supplied context and free of placeholders.
"requiredChanges" must be actionable instructions, empty when verdict is "pass".`,
  scribe: `You are the Scribe, executive reporter. Write a short board-ready report in markdown:
# Executive report
**Goal:** ...
## Outcome
## What shipped (link each deliverable by filename)
## KPI scoreboard (table: KPI | target | status)
## Risks and open decisions (numbered)
## Recommended next actions
State clearly when a step failed or was blocked. Never claim work that did not happen.`,
};

function requireModel(role, roleName) {
  const model = role?.model;
  if (typeof model !== "string" || !model.trim()) {
    throw Object.assign(new Error(`No model is assigned to the ${roleName} role. Pick one in Models & routing.`), {
      name: "RoleModelMissing",
    });
  }
  return { ...role, model };
}

function systemFor(role, run, task) {
  const base = SYSTEM_PROMPTS[role] ?? SYSTEM_PROMPTS.operator;
  const lines = [
    base,
    "",
    `Company: ${run.company || "the company"}`,
    `Company goal: ${run.goal}`,
    run.options.companyContext ? `Operating context: ${run.options.companyContext}` : "",
    task ? `Current work item: ${task.title}\nDefinition of done: ${task.doneWhen}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function summarize(text, limit = 700) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function topologicalWaves(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  const waves = [];
  let guard = 0;
  while (remaining.size && guard < 50) {
    guard += 1;
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!ready.length) {
      // Dependency cycle — release everything left as one final wave.
      waves.push([...remaining.keys()]);
      break;
    }
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) {
      for (const id of ready) deps.delete(id);
    }
  }
  return waves;
}

function normalizePlan(raw, { goal, maxSteps }) {
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
  const entries = tasks.slice(0, maxSteps).map((task, index) => ({
    id: `t${index + 1}`,
    index: index + 1,
    title: String(task?.title ?? `Work item ${index + 1}`).slice(0, 300),
    owner: ["analyst", "operator", "critic", "strategist"].includes(task?.owner) ? task.owner : "operator",
    dependsOn: (Array.isArray(task?.dependsOn) ? task.dependsOn : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= tasks.length)
      .map((value) => `t${value}`)
      .filter((value) => value !== `t${index + 1}`),
    doneWhen: String(task?.doneWhen ?? "The deliverable is complete, specific and reviewable.").slice(0, 500),
    risk: ["low", "medium", "high"].includes(task?.risk) ? task.risk : "medium",
    effort: ["S", "M", "L"].includes(task?.effort) ? task.effort : "M",
    status: "pending",
    attempts: 0,
    artifacts: [],
    output: null,
    critique: null,
    error: null,
    blockedReason: null,
    startedAt: null,
    finishedAt: null,
  }));
  const fallback = {
    objective: goal,
    summary: "Plan could not be parsed; running a single delivery work item.",
    kpis: [],
    assumptions: [],
    successCriteria: "A reviewable deliverable exists.",
    tasks: entries,
  };
  return { ...fallback, ...raw, tasks: entries };
}

export function createAutopilot({ nim, store, retrieval, resolveActiveRoles, getConfig }) {
  /** @type {Map<string, {controller: AbortController, pauseRequested: boolean}>} */
  const active = new Map();
  /** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>} */
  const approvalWaiters = new Map();

  function emit(run, type, payload = {}) {
    store.appendEvent(run.id, { type, runId: run.id, ...payload });
  }

  function persist(run) {
    store.saveRun(run);
  }

  function recordUsage(run, { model, usage }) {
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    run.usage.calls += 1;
    run.usage.promptTokens += promptTokens;
    run.usage.completionTokens += completionTokens;
    run.usage.totalTokens += promptTokens + completionTokens;
    run.usage.byModel[model] = run.usage.byModel[model] ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
    run.usage.byModel[model].calls += 1;
    run.usage.byModel[model].promptTokens += promptTokens;
    run.usage.byModel[model].completionTokens += completionTokens;
    emit(run, "usage", { model, promptTokens, completionTokens });
    const pricing = getConfig().pricing;
    if (pricing?.inputPerMTok || pricing?.outputPerMTok) {
      run.usage.estimatedCostUsd =
        (run.usage.promptTokens / 1_000_000) * (pricing.inputPerMTok ?? 0) +
        (run.usage.completionTokens / 1_000_000) * (pricing.outputPerMTok ?? 0);
    }
    checkBudget(run);
  }

  function checkBudget(run) {
    if (run.usage.totalTokens > run.options.maxTokens) {
      throw new BudgetExceededError(
        `Token budget exhausted (${run.usage.totalTokens.toLocaleString()} of ${run.options.maxTokens.toLocaleString()} tokens).`,
      );
    }
    const elapsed = Date.now() - new Date(run.createdAt).getTime();
    if (elapsed > run.options.maxMinutes * 60_000) {
      throw new BudgetExceededError(`Time budget exhausted (${run.options.maxMinutes} minutes).`);
    }
  }

  function assertRunnable(run) {
    const live = active.get(run.id);
    if (live?.controller.signal.aborted) throw new Error("Run cancelled");
    if (live?.pauseRequested) {
      const error = new Error("Run paused");
      error.name = "PauseRequested";
      throw error;
    }
    checkBudget(run);
  }

  async function waitForApproval(run, request) {
    run.pendingApproval = request;
    run.status = "awaiting_approval";
    persist(run);
    emit(run, "run.awaiting_approval", { request });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        approvalWaiters.delete(run.id);
        run.pendingApproval = null;
        resolve({ approved: false, note: "Timed out waiting for a human decision." });
      }, run.options.approvalTimeoutMinutes * 60_000);
      timer.unref?.();
      approvalWaiters.set(run.id, { resolve, timer });
    });
  }

  function finishApproval(runId, decision) {
    const waiter = approvalWaiters.get(runId);
    const run = store.getRun(runId);
    if (waiter) {
      clearTimeout(waiter.timer);
      approvalWaiters.delete(runId);
      if (run) {
        run.pendingApproval = null;
        persist(run);
      }
      waiter.resolve(decision);
      return true;
    }
    // No in-memory waiter (e.g. server restarted). Record the decision on the run
    // so a resumed run can proceed.
    if (!run) return false;
    run.approvals.push({ ...decision, at: new Date().toISOString(), deferred: true });
    persist(run);
    return false;
  }

  async function plan(run) {
    const roles = {
      strategist: requireModel(run.roles.strategist, "strategist"),
      safety: run.roles.safety?.model ? run.roles.safety : null,
    };
    run.status = "planning";
    persist(run);
    emit(run, "phase", { phase: "planning", model: roles.strategist.model });

    // Screen the goal itself before any work starts. A restricted goal must not
    // reach the planner at all.
    if (run.options.screenOutputs && roles.safety?.model) {
      try {
        const check = await nim.safetyCheck({
          text: `Company goal: ${run.goal}\nOperating context: ${run.options.companyContext ?? "none"}`,
          model: roles.safety.model,
          signal: active.get(run.id)?.controller.signal,
        });
        emit(run, "guardrail", { scope: "goal", safe: check.safe, categories: check.categories, model: check.model });
        if (!check.safe) {
          run.status = "blocked";
          run.blockedReason = `The goal was flagged by guardrails (${check.categories.filter(Boolean).join(", ") || "restricted content"}) and was not executed.`;
          run.finishedAt = new Date().toISOString();
          persist(run);
          emit(run, "run.blocked", { reason: run.blockedReason, code: "guardrail" });
          throw Object.assign(new Error(run.blockedReason), { name: "GuardrailBlocked" });
        }
      } catch (error) {
        if (error?.name === "AbortError" || error?.name === "GuardrailBlocked") throw error;
        emit(run, "note", { message: `Goal screening skipped: ${error?.message ?? error}` });
      }
    }

    const messages = [
      { role: "system", content: systemFor("strategist", run) },
      {
        role: "user",
        content: [
          `Goal: ${run.goal}`,
          `Maximum work items: ${run.options.maxSteps}`,
          run.options.companyContext ? `Company context: ${run.options.companyContext}` : "",
          "Return the plan JSON now.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const response = await nim.chat({
      model: roles.strategist.model,
      messages,
      temperature: roles.strategist.temperature,
      maxTokens: roles.strategist.maxTokens,
      intent: "plan",
      signal: active.get(run.id)?.controller.signal,
    });
    recordUsage(run, { model: roles.strategist.model, usage: response.usage });

    const parsed = extractJson(response.content);
    const normalized = normalizePlan(parsed ?? {}, { goal: run.goal, maxSteps: run.options.maxSteps });
    if (!normalized.tasks.length) {
      normalized.tasks = normalizePlan(
        { tasks: [{ title: run.goal, owner: "operator", doneWhen: "A complete, reviewable deliverable exists." }] },
        { goal: run.goal, maxSteps: 1 },
      ).tasks;
    }
    run.plan = {
      objective: normalized.objective,
      summary: normalized.summary,
      kpis: normalized.kpis ?? [],
      assumptions: normalized.assumptions ?? [],
      successCriteria: normalized.successCriteria ?? "",
      parsed: Boolean(parsed),
      raw: parsed ? undefined : response.content.slice(0, 4000),
    };
    run.tasks = normalized.tasks;
    persist(run);
    emit(run, "plan.ready", {
      objective: run.plan.objective,
      kpis: run.plan.kpis,
      assumptions: run.plan.assumptions,
      tasks: run.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        owner: task.owner,
        risk: task.risk,
        dependsOn: task.dependsOn,
        doneWhen: task.doneWhen,
      })),
      parsed: run.plan.parsed,
    });
  }

  async function contextForTask(run, task) {
    const blocks = [];
    if (run.options.useKnowledge) {
      try {
        const search = await retrieval.search(`${task.title} ${task.doneWhen}`, { topK: 4 });
        if (search.passages.length) {
          blocks.push(
            [
              "Company knowledge (cite as [K1], [K2] …):",
              ...search.passages.map(
                (passage, index) => `[K${index + 1}] ${passage.title}: ${passage.text.slice(0, 900)}`,
              ),
            ].join("\n"),
          );
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        emit(run, "note", { message: `Knowledge retrieval unavailable: ${error?.message ?? error}` });
      }
    }
    const dependencyOutputs = task.dependsOn
      .map((id) => run.tasks.find((entry) => entry.id === id))
      .filter((entry) => entry?.output)
      .map((entry) => `### Upstream deliverable ${entry.id} — ${entry.title}\n${summarize(entry.output, 1500)}`);
    if (dependencyOutputs.length) blocks.push(`Upstream work already completed:\n${dependencyOutputs.join("\n\n")}`);
    return blocks.join("\n\n");
  }

  async function reviewTask(run, task, output) {
    const roles = run.roles;
    const critic = requireModel(roles.critic, "critic");
    const response = await nim.chat({
      model: critic.model,
      messages: [
        { role: "system", content: systemFor("critic", run, task) },
        {
          role: "user",
          content: `Definition of done:\n${task.doneWhen}\n\nDeliverable:\n${String(output).slice(0, 12_000)}\n\nReturn the review JSON.`,
        },
      ],
      temperature: critic.temperature,
      maxTokens: critic.maxTokens,
      intent: "critique",
      signal: active.get(run.id)?.controller.signal,
    });
    recordUsage(run, { model: critic.model, usage: response.usage });
    const review = extractJson(response.content) ?? {
      verdict: "pass",
      score: null,
      strengths: [],
      gaps: ["Critic response could not be parsed; accepted by default."],
      requiredChanges: [],
    };
    return {
      verdict: review.verdict === "revise" ? "revise" : "pass",
      score: Number(review.score) || null,
      strengths: (review.strengths ?? []).map(String).slice(0, 6),
      gaps: (review.gaps ?? []).map(String).slice(0, 8),
      requiredChanges: (review.requiredChanges ?? []).map(String).slice(0, 8),
    };
  }

  async function executeTask(run, task, { signal }) {
    const roles = run.roles;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.attempts += 1;
    persist(run);
    emit(run, "task.started", {
      taskId: task.id,
      title: task.title,
      owner: task.owner,
      risk: task.risk,
      model: (roles[task.owner] ?? roles.operator)?.model ?? null,
      attempts: task.attempts,
    });

    if (run.options.requireApproval === "all" || (run.options.requireApproval === "high" && task.risk === "high")) {
      const decision = await waitForApproval(run, {
        taskId: task.id,
        question: `Approve execution of "${task.title}" (${task.risk} risk)?`,
        whyBlocked: `This work item is marked ${task.risk} risk, so the operating policy needs a human decision before it runs.`,
        options: ["Approve", "Reject"],
        kind: "task",
      });
      run.approvals.push({ taskId: task.id, ...decision, at: new Date().toISOString() });
      run.status = "executing";
      persist(run);
      if (!decision.approved) {
        task.status = "blocked";
        task.blockedReason = decision.note || "Rejected by operator.";
        task.finishedAt = new Date().toISOString();
        persist(run);
        emit(run, "task.blocked", { taskId: task.id, reason: task.blockedReason });
        return;
      }
    }

    const role = requireModel(run.roles[task.owner] ?? run.roles.operator, task.owner);
    const context = await contextForTask(run, task);
    const toolRuntime = createToolRuntime({
      nim,
      store,
      retrieval,
      roles,
      runId: run.id,
      emit: (type, payload) => emit(run, type, { taskId: task.id, ...payload }),
      signal,
      requireApproval: (request) => waitForApproval(run, { ...request, taskId: task.id, kind: "escalation" }),
    });

    const messages = [
      { role: "system", content: systemFor(task.owner === "analyst" ? "analyst" : "operator", run, task) },
      {
        role: "user",
        content: [
          `Work item ${task.id}: ${task.title}`,
          `Definition of done: ${task.doneWhen}`,
          context ? `Context:\n${context}` : "No company context was retrieved. State assumptions explicitly.",
          "Produce the finished deliverable now. Save it with save_artifact before you finish.",
        ].join("\n\n"),
      },
    ];

    let finalContent = "";
    let revisions = 0;
    let critique = null;

    while (revisions <= 2) {
      assertRunnable(run);
      let round = 0;
      let content = "";
      while (round < 5) {
        assertRunnable(run);
        round += 1;
        const response = await nim.chat({
          model: role.model,
          messages,
          temperature: role.temperature,
          maxTokens: role.maxTokens,
          tools: AGENT_TOOLS,
          toolChoice: "auto",
          intent: task.owner === "analyst" ? "analyst" : "operator",
          signal,
        });
        recordUsage(run, { model: role.model, usage: response.usage });

        if (response.toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: response.content || null,
            tool_calls: response.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          });
          for (const call of response.toolCalls) {
            const result = await toolRuntime.run(call.name, parseToolArguments(call.arguments));
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result).slice(0, 6000),
            });
            if (call.name === "save_artifact" && result?.filename) {
              task.artifacts.push(result.filename);
            }
            if (call.name === "generate_visual" && result?.filename) {
              task.artifacts.push(result.filename);
            }
          }
          continue;
        }
        content = response.content || "";
        break;
      }

      if (!content) {
        content = "The agent produced no text output. See the run events for the tool activity.";
      }
      finalContent = content;

      if (run.options.screenOutputs && roles.safety?.model) {
        try {
          const check = await nim.safetyCheck({ text: content, model: roles.safety.model, signal });
          emit(run, "guardrail", { taskId: task.id, scope: "output", safe: check.safe, categories: check.categories });
          if (!check.safe) {
            task.status = "blocked";
            task.blockedReason = `Guardrail flagged the output (${check.categories.join(", ") || "restricted content"}).`;
            task.finishedAt = new Date().toISOString();
            persist(run);
            emit(run, "task.blocked", { taskId: task.id, reason: task.blockedReason });
            return;
          }
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          emit(run, "note", { message: `Guardrail check skipped: ${error?.message ?? error}` });
        }
      }

      critique = await reviewTask(run, task, content);
      emit(run, "task.critique", { taskId: task.id, ...critique });
      if (critique.verdict === "pass" || revisions === 2) break;

      revisions += 1;
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: [
          `The critic rejected the deliverable (score ${critique.score ?? "n/a"}).`,
          "Required changes:",
          ...critique.requiredChanges.map((change) => `- ${change}`),
          "Revise the deliverable to address every point, then save the updated artifact.",
        ].join("\n"),
      });
      emit(run, "task.revising", { taskId: task.id, attempt: revisions, requiredChanges: critique.requiredChanges });
    }

    const filename = `${task.id}.md`;
    const record = store.writeArtifact(run.id, filename, finalContent, { source: "task", taskId: task.id });
    if (!task.artifacts.includes(record.name)) task.artifacts.push(record.name);
    emit(run, "artifact", { taskId: task.id, name: record.name, bytes: record.bytes });

    task.output = finalContent;
    task.critique = critique;
    task.status = "done";
    task.finishedAt = new Date().toISOString();
    persist(run);
    emit(run, "task.completed", {
      taskId: task.id,
      title: task.title,
      summary: summarize(finalContent, 400),
      score: critique?.score ?? null,
      verdict: critique?.verdict ?? null,
      artifacts: task.artifacts,
      revisions,
    });
  }

  async function execute(run) {
    run.status = "executing";
    persist(run);
    emit(run, "phase", { phase: "executing" });
    const live = active.get(run.id);
    const signal = live?.controller.signal;

    while (true) {
      assertRunnable(run);
      const pending = run.tasks.filter((task) => task.status === "pending" || task.status === "failed");
      if (!pending.length) break;
      const done = new Set(run.tasks.filter((task) => task.status === "done" || task.status === "blocked").map((task) => task.id));
      const ready = pending.filter((task) => task.dependsOn.every((id) => done.has(id)));
      if (!ready.length) {
        // Unreachable dependencies (failed upstream). Run the rest sequentially.
        ready.push(pending[0]);
        emit(run, "note", { message: "Dependency could not be satisfied; continuing with the next work item." });
      }
      const slice = ready.slice(0, run.options.concurrency || 1);
      // Siblings in a wave must all settle before the engine reacts to a pause,
      // abort or budget breach; rejecting early would leave tasks mutating a run
      // that the driver has already stopped.
      const results = await Promise.all(
        slice.map(async (task) => {
          try {
            await executeTask(run, task, { signal });
            return { stop: null };
          } catch (error) {
            if (error?.name === "AbortError") return { stop: "abort" };
            if (error?.name === "PauseRequested") return { stop: "pause" };
            if (error instanceof BudgetExceededError) return { stop: "budget", error };
            task.status = "failed";
            task.error = error?.message ?? String(error);
            task.finishedAt = new Date().toISOString();
            persist(run);
            emit(run, "task.failed", { taskId: task.id, error: task.error });
            return { stop: null };
          }
        }),
      );
      const halt = results.find((result) => result.stop);
      if (halt?.stop === "budget") throw halt.error;
      if (halt?.stop === "abort") throw Object.assign(new Error("Run cancelled"), { name: "AbortError" });
      if (halt?.stop === "pause") throw Object.assign(new Error("Run paused"), { name: "PauseRequested" });
    }
    const unfinished = run.tasks.filter((task) => task.status === "pending");
    if (unfinished.length) {
      // Paused or cancelled mid-flight: leave them pending for a resume.
      throw Object.assign(new Error("Run paused before completing all work items"), { name: "PauseRequested" });
    }
  }

  function fallbackReport(run) {
    const done = run.tasks.filter((task) => task.status === "done");
    const blocked = run.tasks.filter((task) => task.status === "blocked" || task.status === "failed");
    return [
      "# Executive report",
      "",
      `**Goal:** ${run.goal}`,
      "",
      "## Outcome",
      `${done.length} of ${run.tasks.length} work items completed.${blocked.length ? ` ${blocked.length} need attention.` : ""}`,
      "",
      "## What shipped",
      ...(done.flatMap((task) => [`- **${task.title}** — ${task.artifacts.join(", ") || "no files"}`]) || ["- Nothing was completed."]),
      "",
      "## KPI scoreboard",
      ...(run.plan?.kpis?.length
        ? ["| KPI | Target | Status |", "| --- | --- | --- |", ...run.plan.kpis.map((kpi) => `| ${kpi.name} | ${kpi.target} | pending human review |`)]
        : ["No KPIs were defined."]),
      "",
      "## Risks and open decisions",
      ...(blocked.length
        ? blocked.map((task) => `- ${task.title}: ${task.blockedReason || task.error || "not completed"}`)
        : ["- None recorded."]),
      "",
      "## Recommended next actions",
      "1. Review the saved deliverables.",
      "2. Confirm assumptions marked in the plan.",
      "3. Re-run this goal with a larger step budget if more coverage is needed.",
    ].join("\n");
  }

  async function report(run) {
    run.status = "reporting";
    persist(run);
    emit(run, "phase", { phase: "reporting" });
    const scribe = requireModel(run.roles.scribe, "scribe");
    const digest = run.tasks
      .map(
        (task) =>
          `### ${task.id} — ${task.title} [${task.status}]${task.artifacts.length ? ` files: ${task.artifacts.join(", ")}` : ""}\n${summarize(task.output ?? task.blockedReason ?? task.error ?? "", 900)}`,
      )
      .join("\n\n");
    let markdown;
    try {
      const response = await nim.chat({
        model: scribe.model,
        messages: [
          { role: "system", content: systemFor("scribe", run) },
          {
            role: "user",
            content: [
              `Goal: ${run.goal}`,
              run.plan?.kpis?.length ? `KPIs: ${JSON.stringify(run.plan.kpis)}` : "",
              `Token usage: ${run.usage.totalTokens} across ${run.usage.calls} model calls.`,
              `Work items:\n${digest}`,
              "Write the executive report now.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        temperature: scribe.temperature,
        maxTokens: scribe.maxTokens,
        intent: "report",
        signal: active.get(run.id)?.controller.signal,
      });
      recordUsage(run, { model: scribe.model, usage: response.usage });
      markdown = response.content?.trim() || fallbackReport(run);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      emit(run, "note", { message: `Report generation failed, using deterministic summary: ${error?.message ?? error}` });
      markdown = fallbackReport(run);
    }
    const artifact = store.writeArtifact(run.id, "executive-report.md", markdown, { source: "report" });
    run.report = { markdown, artifact: artifact.name, generatedAt: new Date().toISOString() };
    emit(run, "report.ready", { artifact: artifact.name });
  }

  async function drive(run) {
    const live = active.get(run.id);
    if (live) live.driving = true;
    try {
      assertRunnable(run);
      if (!run.plan) await plan(run);
      await execute(run);
      await report(run);
      const issues = run.tasks.filter((task) => task.status !== "done");
      run.status = issues.length ? "completed_with_issues" : "completed";
      run.finishedAt = new Date().toISOString();
      persist(run);
      emit(run, "run.finished", {
        status: run.status,
        usage: run.usage,
        completed: run.tasks.filter((task) => task.status === "done").length,
        total: run.tasks.length,
      });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        run.status = "blocked";
        run.blockedReason = error.message;
        emit(run, "run.blocked", { reason: error.message, code: "budget" });
      } else if (error?.name === "AbortError") {
        run.status = "cancelled";
        emit(run, "run.cancelled", {});
      } else if (error?.name === "GuardrailBlocked") {
        run.status = "blocked";
      } else if (error?.name === "PauseRequested" || live?.pauseRequested) {
        run.status = "paused";
        emit(run, "run.paused", {});
      } else {
        run.status = "failed";
        run.error = error?.message ?? String(error);
        emit(run, "run.failed", { error: run.error });
      }
      run.finishedAt = new Date().toISOString();
      persist(run);
    } finally {
      const entry = active.get(run.id);
      if (entry) entry.driving = false;
      if (run.status !== "paused" && run.status !== "awaiting_approval") active.delete(run.id);
    }
  }

  return {
    async start({ goal, company, options }) {
      const trimmedGoal = String(goal ?? "").trim();
      if (trimmedGoal.length < 8) {
        const error = new Error("Describe the goal in at least a sentence so the team has something to execute.");
        error.status = 422;
        throw error;
      }
      const config = getConfig();
      const roles = resolveActiveRoles();
      const run = {
        id: randomUUID(),
        goal: trimmedGoal,
        company: String(company ?? "").trim() || null,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: null,
        simulated: config.simulation,
        roles: Object.fromEntries(
          Object.entries(roles).map(([role, entry]) => [
            role,
            {
              model: entry.model,
              temperature: entry.temperature,
              maxTokens: entry.maxTokens,
              label: entry.label,
              title: entry.title,
              capability: entry.capability,
              resolvedFrom: entry.resolvedFrom,
            },
          ]),
        ),
        routing: Object.fromEntries(
          Object.entries(roles).map(([role, entry]) => [
            role,
            { label: entry.label, title: entry.title, model: entry.model, capability: entry.capability, resolvedFrom: entry.resolvedFrom },
          ]),
        ),
        options: normalizeOptions(options),
        plan: null,
        tasks: [],
        approvals: [],
        pendingApproval: null,
        usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, byModel: {}, estimatedCostUsd: null },
        report: null,
        error: null,
        blockedReason: null,
      };
      store.saveRun(run);
      emit(run, "run.created", { goal: run.goal, company: run.company, simulated: run.simulated, options: run.options });
      active.set(run.id, { controller: new AbortController(), pauseRequested: false, driving: false });
      const snapshot = store.getRun(run.id);
      // Let the HTTP response land before the engine starts mutating the run.
      setTimeout(() => void drive(run), 0);
      return snapshot;
    },

    get(runId) {
      return store.getRun(runId);
    },

    list() {
      return store.listRuns();
    },

    pause(runId) {
      const run = store.getRun(runId);
      if (!run) return null;
      const live = active.get(runId);
      if (live) live.pauseRequested = true;
      run.pauseRequested = true;
      persist(run);
      emit(run, "run.pause_requested", {});
      if (!live) {
        run.status = "paused";
        persist(run);
      }
      return store.getRun(runId);
    },

    resume(runId) {
      const run = store.getRun(runId);
      if (!run) return null;
      if (["completed", "completed_with_issues", "cancelled"].includes(run.status)) return run;
      for (const task of run.tasks) {
        if (task.status === "running") task.status = "pending";
      }
      run.status = "executing";
      run.pauseRequested = false;
      persist(run);
      emit(run, "run.resumed", {});
      const entry = active.get(runId);
      if (entry) {
        // An entry can outlive its driver when the run was paused; leave the
        // same controller in place and start a fresh driver.
        entry.pauseRequested = false;
        if (!entry.driving) {
          entry.driving = true;
          setTimeout(() => void drive(run), 0);
        }
      } else {
        active.set(runId, { controller: new AbortController(), pauseRequested: false, driving: true });
        setTimeout(() => void drive(run), 0);
      }
      return store.getRun(runId);
    },

    cancel(runId) {
      const run = store.getRun(runId);
      if (!run) return null;
      const live = active.get(runId);
      live?.controller.abort();
      active.delete(runId);
      run.status = "cancelled";
      run.finishedAt = new Date().toISOString();
      persist(run);
      emit(run, "run.cancelled", {});
      const waiter = approvalWaiters.get(runId);
      if (waiter) {
        clearTimeout(waiter.timer);
        approvalWaiters.delete(runId);
        waiter.resolve({ approved: false, note: "Run cancelled." });
      }
      return store.getRun(runId);
    },

    approve(runId, { approved = true, note = "" } = {}) {
      const run = store.getRun(runId);
      if (!run) return null;
      const resolved = finishApproval(runId, { approved: Boolean(approved), note: String(note) });
      return { resolved, run: store.getRun(runId) };
    },

    isActive(runId) {
      return active.has(runId);
    },
  };
}
