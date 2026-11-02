/**
 * The agent engine.
 *
 * One `runIssue` is a Paperclip heartbeat: retrieve, work with tools, save an
 * artefact, guardrail the output, get reviewed, move the board, bill the ledger.
 * `planCycle` is the CEO's version: read the board, choose a focus, then run the
 * top few issues inside the budget.
 *
 * Everything is deterministic in simulation and identical in shape when a real
 * key is present — the only branch is inside the NIM client.
 */

import { estimateCost, findModel } from "../nim/catalog.mjs";
import { withUsageContext } from "../nim/usage.mjs";
import { newId, nowIso } from "../store.mjs";
import {
  OPEN_STATUSES,
  PRIORITIES,
  agentSpendStatus,
  createApproval,
  createComment,
  createIssue,
  createKnowledge,
  findAgent,
  findIssue,
  pushActivity,
  recomputeCompany,
  recordGoalMeasurement,
  recordLedger,
} from "./model.mjs";
import { renderContext, searchKnowledge } from "./retrieval.mjs";
import { createToolRegistry, toolsForAgent } from "./tools.mjs";
import { skillPrompt } from "../nim/skills.mjs";

const MAX_TOOL_HOPS = 3;

function clampText(text, limit = 8000) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
}

function parseJson(text) {
  const cleaned = String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function createEngine({ store, nim, bus }) {
  const tools = createToolRegistry({ store, nim, bus });

  const emit = (companyId, event) => bus?.publish({ companyId, at: nowIso(), ...event });
  const notify = (company, event) => {
    bus?.publish({ companyId: company.id, at: nowIso(), ...event });
    store.audit(company.id, { type: event.type, payload: event.payload ?? null });
  };

  function pickAgent(company, role, fallbackId = null) {
    const byId = fallbackId ? findAgent(company, fallbackId) : null;
    if (byId) return byId;
    const byRole = company.agents.find((agent) => agent.role === role && agent.status !== "paused");
    if (byRole) return byRole;
    return company.agents.find((agent) => agent.status !== "paused") ?? company.agents[0] ?? null;
  }

  function criticFor(company, excludeAgentId) {
    const critics = company.agents.filter((agent) => agent.role === "critic" && agent.id !== excludeAgentId && agent.status !== "paused");
    if (critics.length) return critics[0];
    const others = company.agents.filter((agent) => agent.id !== excludeAgentId && agent.role === "strategist");
    return others[0] ?? company.agents.find((agent) => agent.id !== excludeAgentId) ?? null;
  }

  /** The goal this issue is accountable to: its own goal first, then the active one. */
  function goalForIssue(company, issue) {
    return company.goals.find((goal) => goal.id === issue.goalId)
      ?? company.goals.find((goal) => goal.status === "active")
      ?? company.goals[0]
      ?? null;
  }

  /** The goal contract an agent or reviewer needs to see, in one block. */
  function goalBrief(goal) {
    if (!goal) return "";
    const unit = goal.unit ? ` ${goal.unit}` : "";
    const baseline = goal.baseline === null || goal.baseline === undefined ? "not measured yet" : `${goal.baseline}${unit}`;
    const current = goal.current === null || goal.current === undefined ? "" : ` · current ${goal.current}${unit}`;
    return `Goal: ${goal.title}\nMetric: ${goal.metric || "the goal metric"} · target ${goal.target}${unit} · baseline ${baseline}${current}`;
  }

  function budgetFor(company, agent) {
    const spend = agentSpendStatus(company, agent);
    const companyCapCents = company.settings.monthlyBudgetCents ?? 0;
    return {
      ...spend,
      companySpentCents: Math.round(company.ledger.reduce((sum, row) => sum + row.costCents, 0)),
      companyCapCents,
      companyUnlimited: !(companyCapCents > 0),
    };
  }

  function systemPrompt({ company, agent, issue, mode = "work" }) {
    const team = company.agents
      .filter((member) => member.id !== agent.id)
      .slice(0, 8)
      .map((member) => `${member.name} (${member.title})`)
      .join(", ");
    const base = `You are ${agent.name}, ${agent.title} at ${company.name} (role: ${agent.role}).
Company mission: ${company.mission}
Your remit: ${agent.description || agent.title}
Teammates: ${team || "solo"}.

Working agreements:
- Be concrete. Name the change, the metric it moves, and the evidence.
- Cite company knowledge as [1], [2] when you use it. Never invent a metric, customer quote or dashboard.
- If the evidence is missing, say what would settle it and how much it would cost.
${(agent.monthlyBudgetCents ?? 0) > 0 ? `- Stay inside your monthly budget of $${(agent.monthlyBudgetCents / 100).toFixed(2)}.` : "- No spend limit is set; keep each run focused anyway."}
${(agent.memory ?? []).length ? `\nWhat you learned from work you already shipped:\n${agent.memory.slice(0, 5).map((entry) => `- ${entry.issueKey ?? "work"}: ${entry.lesson}`).join("\n")}\n` : ""}${agent.instructions ? `\nRole instructions:\n${agent.instructions}` : ""}${skillPrompt(agent.skills)}
`;
    if (mode === "review") {
      const goal = goalForIssue(company, issue);
      return `Task type: review\n\n${base}\nYou are reviewing another agent's deliverable against the issue's acceptance criteria. Reply with JSON only:
{"verdict":"accepted"|"changes_requested","score":0-100,"summary":"...","findings":[{"severity":"blocker"|"major"|"minor"|"nit","finding":"...","fix":"..."}],"follow_ups":["..."]}
Be hard to impress; do not accept work that lacks evidence.${goal ? `\n\n${goalBrief(goal)}\nIf the deliverable reports a measured value for this metric, return it as "measurement": {"value": <number>, "unit": "${goal.unit ?? ""}", "source": "<where the number came from>"}. If it does not report one, return null. Do not estimate a number the deliverable does not contain.` : ""}`;
    }
    return `Task type: deliverable\n\n${base}\nDeliverable format (markdown, no code fence around the whole answer):
## <title>
### Objective
### What changed
### Evidence
### Numbers (a table with source)
### Risks / open questions
### Next step`;
  }

  function issuePrompt({ company, issue, agent, context }) {
    const acceptance = (issue.acceptance ?? []).length
      ? issue.acceptance.map((item) => `- [ ] ${item}`).join("\n")
      : "- [ ] The deliverable is reviewable and linked";
    const goal = goalForIssue(company, issue);
    const measureLine = goal
      ? `\n\n${goalBrief(goal)}\nIf this issue measures the metric, put the measured value in the Numbers section as "Measured ${goal.metric || "metric"}: <value> ${goal.unit ?? ""} (source: <where it came from>)".`
      : "";
    return `Issue: ${issue.key} — ${issue.title}
Company: ${company.name}
Agent: ${agent.name}
Priority: ${issue.priority}
Status: ${issue.status}
${issue.blockedReason ? `Blocked reason: ${issue.blockedReason}\n` : ""}Description:
${issue.description || "(no description)"}

Definition of done:
${acceptance}${measureLine}

${renderContext(context)}

Write the deliverable now. Use tools if they make the answer more verifiable.`;
  }

  async function runWithTools({ company, agent, issue, run, messages, toolsEnabled, onDelta, signal }) {
    const definitions = toolsEnabled.map((spec) => spec);
    let working = [...messages];
    const trace = [];
    for (let hop = 0; hop < MAX_TOOL_HOPS; hop += 1) {
      const response = await nim.chat({
        model: agent.model,
        messages: working,
        temperature: agent.temperature ?? 0.4,
        maxTokens: agent.maxTokens ?? 1800,
        tools: definitions.length ? definitions : undefined,
        onDelta,
        signal,
      });
      run.usage.prompt_tokens += response.usage.prompt_tokens ?? 0;
      run.usage.completion_tokens += response.usage.completion_tokens ?? 0;
      if (!response.toolCalls?.length) {
        return { text: response.text, reasoning: response.reasoning, trace, response };
      }
      working = [
        ...working,
        { role: "assistant", content: response.text ?? "", tool_calls: response.toolCalls },
      ];
      for (const call of response.toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const outcome = await tools.execute(call.function.name, args, {
          company,
          issue,
          agent,
          run,
          emit: (step) => {
            trace.push({ tool: call.function.name, args, summary: step.label });
          },
        });
        trace.push({ tool: call.function.name, args, summary: outcome.summary });
        working = [
          ...working,
          {
            role: "tool",
            tool_call_id: call.id,
            content: clampText(typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result), 6000),
          },
        ];
      }
    }
    // Budget of hops exhausted: ask for the written answer with what we have.
    const final = await nim.chat({
      model: agent.model,
      messages: [...working, { role: "user", content: "Tool budget exhausted. Write the deliverable now with what you have." }],
      temperature: agent.temperature ?? 0.4,
      maxTokens: agent.maxTokens ?? 1800,
      onDelta,
      signal,
    });
    run.usage.prompt_tokens += final.usage.prompt_tokens ?? 0;
    run.usage.completion_tokens += final.usage.completion_tokens ?? 0;
    return { text: final.text, reasoning: final.reasoning, trace, response: final };
  }

  /**
   * Execute one issue end to end. Returns a compact result:
   * { run, issue, verdict, blocked, reason }
   */
  async function runIssue({ companyId, issueId, actorId = "human", signal, onDelta, auto = false }) {
    return store.withCompany(companyId, async (company) => {
      const issue = findIssue(company, issueId);
      if (!issue) {
        const error = new Error(`Issue ${issueId} not found`);
        error.status = 404;
        throw error;
      }
      if (!OPEN_STATUSES.includes(issue.status)) {
        const error = new Error(`${issue.key} is already ${issue.status}. Reopen it before running.`);
        error.status = 409;
        throw error;
      }
      const pendingApproval = company.approvals.find((approval) => approval.issueId === issue.id && approval.status === "pending");
      if (pendingApproval) {
        const error = new Error(`${issue.key} is waiting on human approval: ${pendingApproval.action}`);
        error.status = 409;
        error.code = "awaiting_approval";
        throw error;
      }
      const agent = pickAgent(company, issue.assigneeId ? findAgent(company, issue.assigneeId)?.role ?? "operator" : "operator", issue.assigneeId);
      if (!agent) {
        const error = new Error("This company has no agents to run the issue.");
        error.status = 409;
        throw error;
      }
      if (agent.status === "paused") {
        const error = new Error(`${agent.name} is paused. Resume the agent before running.`);
        error.status = 409;
        throw error;
      }
      const budget = budgetFor(company, agent);
      if (!budget.unlimited && budget.overBudget) {
        issue.status = "blocked";
        issue.blockedReason = `${agent.name} is over the monthly cap ($${(budget.spentCents / 100).toFixed(2)} of $${(budget.capCents / 100).toFixed(2)}).`;
        issue.updatedAt = nowIso();
        pushActivity(company, {
          kind: "budget.exceeded",
          actorId: agent.id,
          subject: issue.key,
          detail: issue.blockedReason,
          issueId: issue.id,
        });
        recomputeCompany(company);
        return { blocked: true, reason: issue.blockedReason, issue, run: null };
      }
      if (!budget.companyUnlimited && budget.companySpentCents >= budget.companyCapCents) {
        issue.status = "blocked";
        issue.blockedReason = `Company budget exhausted ($${(budget.companySpentCents / 100).toFixed(2)} of $${(budget.companyCapCents / 100).toFixed(2)}).`;
        issue.updatedAt = nowIso();
        pushActivity(company, { kind: "budget.exceeded", actorId: agent.id, subject: issue.key, detail: issue.blockedReason, issueId: issue.id });
        recomputeCompany(company);
        return { blocked: true, reason: issue.blockedReason, issue, run: null };
      }

      const run = {
        id: newId("run"),
        issueId: issue.id,
        agentId: agent.id,
        kind: auto ? "auto" : "work",
        status: "running",
        model: agent.model,
        simulated: nim.status().mode === "simulation",
        startedAt: nowIso(),
        endedAt: null,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        costCents: 0,
        steps: [],
        output: "",
        review: null,
        error: null,
      };
      company.runs.unshift(run);
      issue.status = "in_progress";
      issue.updatedAt = nowIso();
      notify(company, { type: "run.started", payload: { runId: run.id, issueId: issue.id, agentId: agent.id, model: agent.model } });
      notify(company, { type: "issue.updated", payload: { issue } });

      const step = (label, detail, ms = 0) => {
        run.steps.push({ label, detail, ms, at: nowIso() });
        notify(company, { type: "run.step", payload: { runId: run.id, issueId: issue.id, label, detail, ms } });
      };

      try {
        const outcome = await withUsageContext(
          {
            companyId: company.id,
            runId: run.id,
            agentId: agent.id,
            sink: (usageEvent) => {
              const row = recordLedger(company, {
                runId: run.id,
                agentId: agent.id,
                model: usageEvent.model,
                usage: usageEvent.usage,
                cost: usageEvent.cost,
                endpoint: usageEvent.endpoint,
                simulated: usageEvent.simulated,
              });
              run.costCents += row.costCents;
              issue.spendCents = (issue.spendCents ?? 0) + row.costCents;
              notify(company, { type: "ledger.recorded", payload: { row, runId: run.id } });
            },
          },
          async () => {
            // 1 — guardrail the input
            if (company.settings.guardrails?.safetyCheck) {
              const guard = await nim.safety({ text: `${issue.title}\n${issue.description}`, signal });
              step("NeMo Guardrail (input)", `${guard.verdict} · score ${guard.score.toFixed(2)}`, guard.latencyMs);
              if (guard.unsafe) {
                issue.status = "blocked";
                issue.blockedReason = `Blocked by content safety: ${guard.rationale}`;
                issue.updatedAt = nowIso();
                company.comments.unshift(
                  createComment({
                    issueId: issue.id,
                    authorType: "system",
                    authorId: "guardrail",
                    kind: "guardrail",
                    body: `**Run stopped by the input guardrail.**\n\n${guard.rationale}\n\nCategories: ${(guard.categories ?? []).join(", ") || "harm"}`,
                  }),
                );
                return { blocked: true, reason: issue.blockedReason };
              }
            }

            // 2 — retrieval
            const retrieval = await searchKnowledge({ company, nim, query: `${issue.title} ${issue.description}`.slice(0, 500), signal });
            step(
              "Retrieved company knowledge",
              `${retrieval.passages.length} passages from ${retrieval.candidates} candidates · rerank ${retrieval.rerankModel ? findModel(retrieval.rerankModel)?.name ?? "NIM" : "off"}`,
            );
            step("Reranked candidates", retrieval.passages.map((passage) => passage.title).join(" · ") || "no match");

            // 3 — work with tools
            const messages = [
              { role: "system", content: systemPrompt({ company, agent, issue }) },
              { role: "user", content: issuePrompt({ company, issue, agent, context: retrieval.passages }) },
            ];
            const defs = toolsForAgent(agent, { allowEscalation: true });
            const work = await runWithTools({ company, agent, issue, run, messages, toolsEnabled: defs, onDelta, signal });
            const deliverable = String(work.text ?? "").trim();
            step("Drafted the deliverable", `${deliverable.length} chars · ${work.trace.length} tool calls`, 0);

            if (!deliverable) {
              run.status = "failed";
              run.error = "The model returned an empty deliverable.";
              issue.status = "todo";
              issue.updatedAt = nowIso();
              return { failed: true, reason: run.error };
            }

            // 4 — guardrail the output
            if (company.settings.guardrails?.safetyCheck) {
              const outputGuard = await nim.safety({ text: deliverable, signal });
              step("NeMo Guardrail (output)", `${outputGuard.verdict} · score ${outputGuard.score.toFixed(2)}`, outputGuard.latencyMs);
              if (outputGuard.unsafe) {
                issue.status = "blocked";
                issue.blockedReason = `Deliverable blocked by content safety: ${outputGuard.rationale}`;
                issue.updatedAt = nowIso();
                return { blocked: true, reason: issue.blockedReason };
              }
            }

            // 5 — persist the artifact + comment
            const artifact = {
              id: newId("art"),
              issueId: issue.id,
              runId: run.id,
              agentId: agent.id,
              title: `${issue.key}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}.md`,
              kind: "markdown",
              body: deliverable,
              createdAt: nowIso(),
            };
            company.artifacts.unshift(artifact);
            const deliverableComment = createComment({
              issueId: issue.id,
              authorType: "agent",
              authorId: agent.id,
              kind: "deliverable",
              body: deliverable,
              meta: {
                runId: run.id,
                model: agent.model,
                artifactId: artifact.id,
                citations: retrieval.passages.map((passage) => passage.title),
                tools: work.trace.map((entry) => entry.tool),
              },
            });
            company.comments.unshift(deliverableComment);
            notify(company, { type: "artifact.created", payload: { artifact } });
            notify(company, { type: "comment.created", payload: { comment: deliverableComment, issueId: issue.id } });

            // 6 — review gate
            const critic = criticFor(company, agent.id);
            let verdict = null;
            let measurement = null;
            let measuredGoal = null;
            if (critic && company.settings.approvalPolicy !== "off") {
              issue.status = "in_review";
              issue.updatedAt = nowIso();
              const reviewMessages = [
                {
                  role: "system",
                  content: systemPrompt({ company, agent: critic, issue, mode: "review" }),
                },
                {
                  role: "user",
                  content: `Issue: ${issue.key} — ${issue.title}\nReview attempt: ${(issue.reviewCount ?? 0) + 1}\n${goalBrief(goalForIssue(company, issue)) ? `${goalBrief(goalForIssue(company, issue))}\n` : ""}Definition of done:\n${(issue.acceptance ?? []).map((item) => `- [ ] ${item}`).join("\n") || "- [ ] Reviewable deliverable"}\n\nDeliverable by ${agent.name}:\n${clampText(deliverable, 6000)}`,
                },
              ];
              const review = await nim.chat({
                model: critic.model,
                messages: reviewMessages,
                temperature: 0.2,
                maxTokens: 700,
                responseFormat: { type: "json_object" },
                signal,
              });
              run.usage.prompt_tokens += review.usage.prompt_tokens ?? 0;
              run.usage.completion_tokens += review.usage.completion_tokens ?? 0;
              verdict = parseJson(review.text);
              if (!verdict) {
                verdict = { verdict: "accepted", score: 70, summary: "Reviewer returned unstructured output; accepted with a note.", findings: [], follow_ups: [] };
              }
              const accepted = verdict.verdict === "accepted";
              issue.reviewCount = (issue.reviewCount ?? 0) + 1;
              if (accepted) {
                issue.status = "done";
                issue.blockedReason = "";
              } else if (issue.reviewCount > (company.settings.reworkLimit ?? 1)) {
                issue.status = "blocked";
                issue.blockedReason = `Rework limit reached (${issue.reviewCount - 1} attempt(s)): ${verdict.summary ?? "review still failing"}`;
              } else {
                issue.status = "todo";
              }
              issue.updatedAt = nowIso();
              // Evidence only counts once the work is accepted. The reviewer
              // returns the number; the engine decides whether it belongs to
              // the goal (and whether it is the baseline or a new current).
              if (accepted) {
                measuredGoal = goalForIssue(company, issue);
                measurement = recordGoalMeasurement(company, measuredGoal, issue, verdict.measurement, run, agent);
                if (measurement) {
                  step("Goal measured", `${measuredGoal.metric}: ${measurement.value}${measurement.unit ? ` ${measurement.unit}` : ""} · ${measurement.source}`, 0);
                }
              }
              const measurementLine = measurement
                ? `\n\n**Measured ${measuredGoal.metric}:** ${measurement.value}${measurement.unit ? ` ${measurement.unit}` : ""} — ${measurement.source}`
                : "";
              const reviewComment = createComment({
                issueId: issue.id,
                authorType: "agent",
                authorId: critic.id,
                kind: "review",
                body: `**Verdict: ${accepted ? "accepted" : "changes requested"} (${verdict.score ?? "—"})**\n\n${verdict.summary ?? ""}\n\n${
                  (verdict.findings ?? [])
                    .map((finding) => `- **${finding.severity ?? "note"}** — ${finding.finding}${finding.fix ? `\n  _Fix:_ ${finding.fix}` : ""}`)
                    .join("\n") || "- No findings."
                }${(verdict.follow_ups ?? []).length ? `\n\n**Follow-ups**\n${verdict.follow_ups.map((item) => `- ${item}`).join("\n")}` : ""}${measurementLine}`,
                meta: { runId: run.id, model: critic.model, verdict: verdict.verdict, score: verdict.score, measurement },
              });
              company.comments.unshift(reviewComment);
              notify(company, { type: "comment.created", payload: { comment: reviewComment, issueId: issue.id } });
              run.review = {
                verdict: verdict.verdict,
                score: verdict.score,
                reviewerId: critic.id,
                summary: verdict.summary,
                measurement: measurement
                  ? { value: measurement.value, unit: measurement.unit, source: measurement.source, kind: measurement.kind }
                  : null,
              };
              step(
                "Quality gate",
                `${verdict.verdict} · score ${verdict.score ?? "—"} by ${critic.name} · attempt ${(issue.reviewCount ?? 0) + 1}`,
              );
            } else {
              issue.status = "done";
              issue.updatedAt = nowIso();
              step("Quality gate", "skipped (approval policy off)");
            }

            run.output = deliverable.slice(0, 2000);
            run.status = "succeeded";
            run.agentName = agent.name;
            if (issue.status === "done") remember(company, { agent, issue, verdict: run.review, deliverable });
            if (measurement && measuredGoal) {
              pushActivity(company, {
                kind: "goal.measured",
                actorId: agent.id,
                subject: `${measuredGoal.metric} measured`,
                detail: `${measurement.value}${measurement.unit ? ` ${measurement.unit}` : ""} · ${measurement.source}`,
                issueId: issue.id,
                meta: { goalId: measuredGoal.id, value: measurement.value, unit: measurement.unit, kind: measurement.kind },
              });
              notify(company, { type: "goal.measured", payload: { goalId: measuredGoal.id, measurement } });
            }
            notify(company, {
              type: "run.succeeded",
              payload: { runId: run.id, issueId: issue.id, agentId: agent.id, verdict: run.review?.verdict ?? null, costCents: run.costCents },
            });
            return { run, issue, verdict: run.review ?? null, blocked: false };
          },
        );

        if (!outcome?.blocked && !outcome?.failed) {
          pushActivity(company, {
            kind: "run.succeeded",
            actorId: agent.id,
            subject: issue.key,
            detail: `${issue.status === "done" ? "Completed" : "Submitted for review"} · $${(run.costCents / 100).toFixed(3)}`,
            issueId: issue.id,
            meta: { runId: run.id },
          });
        } else if (outcome?.blocked) {
          pushActivity(company, {
            kind: "issue.blocked",
            actorId: agent.id,
            subject: issue.key,
            detail: outcome.reason,
            issueId: issue.id,
          });
        }
        recomputeCompany(company);
        return { ...outcome, run, issue, agent };
      } catch (error) {
        if (error?.name === "AbortError") {
          run.status = "cancelled";
          run.error = "Cancelled by a human.";
          issue.status = "todo";
        } else {
          run.status = "failed";
          run.error = clampText(error?.message ?? "Run failed", 800);
          issue.status = "todo";
        }
        issue.updatedAt = nowIso();
        run.endedAt = nowIso();
        notify(company, { type: "run.failed", payload: { runId: run.id, issueId: issue.id, error: run.error, status: run.status } });
        recomputeCompany(company);
        return { run, issue, agent, failed: true, reason: run.error };
      } finally {
        run.endedAt = run.endedAt ?? nowIso();
        run.usage.costCents = run.costCents;
        recomputeCompany(company);
      }
    });
  }

  /** CEO planning call → focus, assignments, risks. Does not run work. */
  async function planOnly({ companyId, signal }) {
    return store.withCompany(companyId, async (company) => {
      const ceo = pickAgent(company, "strategist");
      if (!ceo) {
        const error = new Error("Add a strategist agent before planning a cycle.");
        error.status = 409;
        throw error;
      }
      const budget = budgetFor(company, ceo);
      if (!budget.unlimited && budget.overBudget) {
        const error = new Error(`${ceo.name} is over budget; the planning call would exceed the cap.`);
        error.status = 409;
        error.code = "over_budget";
        throw error;
      }
      const open = company.issues.filter((issue) => OPEN_STATUSES.includes(issue.status));
      const attempts = attemptCounts(company);
      const board = open
        .slice(0, 24)
        .map((issue, index) => {
          const owner = findAgent(company, issue.assigneeId);
          const tries = attempts.get(issue.id) ?? 0;
          return `${index + 1}. [${issue.status}/${issue.priority}] ${issue.title} — ${owner?.name ?? "unassigned"} (${tries} run${tries === 1 ? "" : "s"})`;
        })
        .join("\n");
      const cycleNumber = company.cycleHistory?.length ?? 0;
      const lastFocus = [...(company.cycleHistory ?? [])].reverse().find((entry) => entry?.focus)?.focus ?? "";
      const goals = company.goals.map((goal) => `- ${goal.title}: ${goal.current}/${goal.target} ${goal.unit}`).join("\n");
      const run = {
        id: newId("run"),
        issueId: null,
        agentId: ceo.id,
        kind: "plan",
        status: "running",
        model: ceo.model,
        simulated: nim.status().mode === "simulation",
        startedAt: nowIso(),
        endedAt: null,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        costCents: 0,
        steps: [],
        output: "",
        review: null,
        error: null,
      };
      company.runs.unshift(run);
      notify(company, { type: "cycle.planning", payload: { runId: run.id, agentId: ceo.id } });

      const result = await withUsageContext(
        {
          companyId: company.id,
          runId: run.id,
          agentId: ceo.id,
          sink: (usageEvent) => {
            const row = recordLedger(company, {
              runId: run.id,
              agentId: ceo.id,
              model: usageEvent.model,
              usage: usageEvent.usage,
              cost: usageEvent.cost,
              endpoint: usageEvent.endpoint,
              simulated: usageEvent.simulated,
            });
            run.costCents += row.costCents;
            notify(company, { type: "ledger.recorded", payload: { row, runId: run.id } });
          },
        },
        () =>
          nim.chat({
            model: ceo.model,
            messages: [
              {
                role: "system",
                content: `Task type: plan\n\n${systemPrompt({ company, agent: ceo, issue: null })}`,
              },
              {
                role: "user",
                content: `Cycle #${cycleNumber + 1}.${lastFocus ? ` Last cycle's focus was: ${lastFocus}` : ""}\nGoal:\n${goals || "- no goals defined"}\n\nOpen board (${open.length} issues, with how many times each has run):\n${board || "(empty)"}\n\nSpend so far: $${(budget.companySpentCents / 100).toFixed(2)} of $${(budget.companyCapCents / 100).toFixed(2)}.\nPick a focus this cycle that is different from last cycle's, and put work that has never run at the top of the assignments.\n\nReturn JSON only:\n{"focus":"one sentence","rationale":"two sentences","assignments":[{"title":"must match a board title","owner":"role name","why":"one sentence","priority":"urgent|high|medium|low"}],"risks":["..."],"citations":["..."]}`,
              },
            ],
            temperature: 0.3,
            maxTokens: 1200,
            responseFormat: { type: "json_object" },
            signal,
          }),
        );
      const plan = parseJson(result.text) ?? {
        focus: "Continue the highest-priority open work.",
        rationale: "The planning call returned unstructured output; falling back to board order.",
        assignments: [],
        risks: [],
        citations: [],
      };
      run.usage.prompt_tokens += result.usage.prompt_tokens ?? 0;
      run.usage.completion_tokens += result.usage.completion_tokens ?? 0;
      run.status = "succeeded";
      run.endedAt = nowIso();
      run.output = JSON.stringify(plan, null, 2).slice(0, 2000);
      run.agentName = ceo.name;

      // Apply assignments to the board.
      const roleToAgent = (role) =>
        company.agents.find((member) => member.role === String(role).toLowerCase()) ?? null;
      let applied = 0;
      for (const assignment of plan.assignments ?? []) {
        const target = company.issues.find(
          (issue) => OPEN_STATUSES.includes(issue.status) && issue.title.toLowerCase().includes(String(assignment.title ?? "").toLowerCase().slice(0, 24)),
        );
        if (!target) continue;
        const owner = roleToAgent(assignment.owner);
        if (owner) target.assigneeId = owner.id;
        if (assignment.priority && PRIORITIES.includes(assignment.priority)) target.priority = assignment.priority;
        target.updatedAt = nowIso();
        applied += 1;
      }
      notify(company, { type: "cycle.planned", payload: { plan, runId: run.id, applied } });
      pushActivity(company, {
        kind: "cycle.planned",
        actorId: ceo.id,
        subject: "Cycle plan",
        detail: plan.focus,
        meta: { runId: run.id, applied },
      });
      recomputeCompany(company);
      return { run, plan, applied, agent: ceo };
    });
  }

  /** Full cycle: due routines, plan, then run the highest-value issues inside budget. */
  async function planCycle({ companyId, maxIssues = 3, onDelta, signal, auto = false }) {
    // Whatever came due runs first — a routine that is never dispatched is a
    // decoration with a nextRunAt field.
    const dueCompany = store.getCompany(companyId);
    const due = (dueCompany?.routines ?? [])
      .filter((routine) => routine.enabled !== false)
      .filter((routine) => !routine.nextRunAt || new Date(routine.nextRunAt).getTime() <= Date.now())
      .slice(0, 2);
    for (const routine of due) {
      try {
        await runRoutine({ companyId, routineId: routine.id });
      } catch (error) {
        emit(companyId, { type: "auto.error", payload: { error: error.message, phase: "routine" } });
      }
    }

    const beforePlan = store.getCompany(companyId);
    if (beforePlan) replenishBoard(beforePlan, { max: 2 });

    const planned = await planOnly({ companyId, signal });
    const { plan } = planned;
    const company = store.getCompany(companyId);
    const focusTitles = new Set((plan.assignments ?? []).map((assignment) => String(assignment.title ?? "").toLowerCase()));
    // Fairness first: a board that always serves the same two issues starves the
    // rest forever (SD-106 never ran once). Fewest runs wins, then whoever has
    // been untouched longest, then priority and the CEO's focus.
    const attempts = attemptCounts(company);
    const lastTouch = new Map();
    for (const run of company.runs) {
      if (!run.issueId) continue;
      const started = new Date(run.startedAt ?? 0).getTime();
      lastTouch.set(run.issueId, Math.max(lastTouch.get(run.issueId) ?? 0, Number.isFinite(started) ? started : 0));
    }
    const candidates = company.issues
      .filter((issue) => OPEN_STATUSES.includes(issue.status) && issue.status !== "blocked")
      .filter((issue) => !company.approvals.some((approval) => approval.issueId === issue.id && approval.status === "pending"))
      .sort((a, b) => {
        const triesA = attempts.get(a.id) ?? 0;
        const triesB = attempts.get(b.id) ?? 0;
        if (triesA !== triesB) return triesA - triesB;
        const touchA = lastTouch.get(a.id) ?? 0;
        const touchB = lastTouch.get(b.id) ?? 0;
        if (touchA !== touchB) return touchA - touchB;
        const focusA = [...focusTitles].some((title) => title && a.title.toLowerCase().includes(title.slice(0, 20))) ? 0 : 1;
        const focusB = [...focusTitles].some((title) => title && b.title.toLowerCase().includes(title.slice(0, 20))) ? 0 : 1;
        if (focusA !== focusB) return focusA - focusB;
        return PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
      })
      .slice(0, maxIssues);

    const results = [];
    for (const issue of candidates) {
      if (signal?.aborted) break;
      try {
        const result = await runIssue({ companyId, issueId: issue.id, actorId: "cycle", signal, onDelta, auto });
        results.push({ issueId: issue.id, key: issue.key, status: result?.issue?.status, verdict: result?.verdict?.verdict ?? null, costCents: Math.round((result?.run?.costCents ?? 0) * 100) / 100, blocked: Boolean(result?.blocked) });
      } catch (error) {
        results.push({ issueId: issue.id, key: issue.key, error: error.message });
      }
    }

    // Scribe writes the standup.
    const c = store.getCompany(companyId);
    const scribe = c.agents.find((agent) => /scribe/i.test(agent.title) || /scribe/i.test(agent.name)) ?? pickAgent(c, "operator");
    let standup = "";
    if (scribe) {
      const run = {
        id: newId("run"),
        issueId: null,
        agentId: scribe.id,
        kind: "standup",
        status: "running",
        model: scribe.model,
        simulated: nim.status().mode === "simulation",
        startedAt: nowIso(),
        endedAt: null,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        costCents: 0,
        steps: [],
        output: "",
        review: null,
        error: null,
      };
      c.runs.unshift(run);
      const result = await withUsageContext(
        {
          companyId: c.id,
          runId: run.id,
          agentId: scribe.id,
          sink: (usageEvent) => {
            const row = recordLedger(c, {
              runId: run.id,
              agentId: scribe.id,
              model: usageEvent.model,
              usage: usageEvent.usage,
              cost: usageEvent.cost,
              endpoint: usageEvent.endpoint,
              simulated: usageEvent.simulated,
            });
            run.costCents += row.costCents;
          },
        },
        () =>
          nim.chat({
            model: scribe.model,
            messages: [
              {
                role: "system",
                content: `Task type: standup\n\nYou are ${scribe.name}, the ops scribe at ${c.name}. Write a short cycle standup: what shipped, what is blocked, what it cost, and the single next action.`,
              },
              {
                role: "user",
                content: `Focus: ${plan.focus}\nResults: ${JSON.stringify(results, null, 1)}\nOpen blocked: ${c.issues.filter((issue) => issue.status === "blocked").map((issue) => issue.key).join(", ") || "none"}`,
              },
            ],
            temperature: 0.4,
            maxTokens: 700,
          }),
      );
      standup = result.text;
      run.usage.prompt_tokens += result.usage.prompt_tokens ?? 0;
      run.usage.completion_tokens += result.usage.completion_tokens ?? 0;
      run.output = standup.slice(0, 1200);
      run.status = "succeeded";
      run.endedAt = nowIso();
      run.agentName = scribe.name;
      c.activity.unshift({
        id: newId("act"),
        at: nowIso(),
        kind: "standup",
        actorId: scribe.id,
        subject: "Cycle standup",
        detail: standup.slice(0, 180),
        issueId: null,
        meta: { runId: run.id },
      });
    }

    const finished = store.getCompany(companyId);
    const cycle = {
      id: newId("cycle"),
      startedAt: planned.run.startedAt,
      endedAt: nowIso(),
      focus: plan.focus,
      rationale: plan.rationale,
      ran: results.length,
      accepted: results.filter((row) => row.verdict === "accepted").length,
      changesRequested: results.filter((row) => row.verdict === "changes_requested").length,
      blocked: results.filter((row) => row.blocked).length,
      costCents: planned.run.costCents + results.reduce((sum, row) => sum + (row.costCents ?? 0), 0),
      standup,
      results,
      reason: signal?.aborted ? "cancelled" : "completed",
    };
    finished.cycleHistory.unshift(cycle);
    if (finished.cycleHistory.length > 60) finished.cycleHistory.length = 60;
    recomputeCompany(finished);
    store.saveCompany(finished);
    emit(companyId, { type: "cycle.finished", payload: { cycle } });
    return { plan, results, cycle, standup };
  }

  /** Interactive chat with an agent, with retrieval + tools + streaming. */
  async function chat({ companyId, agentId, message, onDelta, signal, issueId = null }) {
    return store.withCompany(companyId, async (company) => {
      const agent = findAgent(company, agentId);
      if (!agent) {
        const error = new Error(`Agent ${agentId} not found`);
        error.status = 404;
        throw error;
      }
      const issue = issueId ? findIssue(company, issueId) : null;
      const retrieval = await searchKnowledge({ company, nim, query: String(message).slice(0, 400), signal });
      const budget = budgetFor(company, agent);
      const threadKey = `${agent.id}${issue ? `:${issue.id}` : ""}`;
      company.threads ??= {};
      const thread = company.threads[threadKey] ?? [];
      const prior = thread.slice(-8).map((entry) => ({ role: entry.role, content: entry.content }));

      const run = {
        id: newId("run"),
        issueId: issue?.id ?? null,
        agentId: agent.id,
        kind: "chat",
        status: "running",
        model: agent.model,
        simulated: nim.status().mode === "simulation",
        startedAt: nowIso(),
        endedAt: null,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        costCents: 0,
        steps: [],
        output: "",
        review: null,
        error: null,
      };
      company.runs.unshift(run);

      const messages = [
        {
          role: "system",
          content: `Task type: chat\n\n${systemPrompt({ company, agent, issue })}\n${budget.unlimited ? "No budget limit." : `Budget remaining: $${(budget.remainingCents / 100).toFixed(2)} of $${(budget.capCents / 100).toFixed(2)}.`}\nAnswer in chat style: short paragraphs, cite sources as [1], do not repeat the question.`,
        },
        ...(issue ? [{ role: "system", content: `The user is looking at ${issue.key} — ${issue.title}.\n\n${renderContext(retrieval.passages)}` }] : []),
        ...prior,
        { role: "user", content: `${message}${issue ? "" : `\n\n${renderContext(retrieval.passages)}`}` },
      ];

      const result = await withUsageContext(
        {
          companyId: company.id,
          runId: run.id,
          agentId: agent.id,
          sink: (usageEvent) => {
            const row = recordLedger(company, {
              runId: run.id,
              agentId: agent.id,
              model: usageEvent.model,
              usage: usageEvent.usage,
              cost: usageEvent.cost,
              endpoint: usageEvent.endpoint,
              simulated: usageEvent.simulated,
            });
            run.costCents += row.costCents;
          },
        },
        async () => {
          const toolDefs = toolsForAgent(agent);
          const first = await nim.chat({
            model: agent.model,
            messages,
            temperature: agent.temperature ?? 0.4,
            maxTokens: 900,
            tools: toolDefs,
            onDelta,
            signal,
          });
          run.usage.prompt_tokens += first.usage.prompt_tokens ?? 0;
          run.usage.completion_tokens += first.usage.completion_tokens ?? 0;
          let text = first.text;
          let trace = [];
          if (first.toolCalls?.length) {
            const working = [...messages, { role: "assistant", content: first.text ?? "", tool_calls: first.toolCalls }];
            for (const call of first.toolCalls) {
              let args = {};
              try {
                args = JSON.parse(call.function.arguments || "{}");
              } catch {
                args = {};
              }
              const outcome = await tools.execute(call.function.name, args, { company, issue, agent, run });
              trace.push({ tool: call.function.name, summary: outcome.summary });
              working.push({ role: "tool", tool_call_id: call.id, content: clampText(JSON.stringify(outcome.result), 5000) });
            }
            const second = await nim.chat({
              model: agent.model,
              messages: working,
              temperature: agent.temperature ?? 0.4,
              maxTokens: 900,
              onDelta,
              signal,
            });
            run.usage.prompt_tokens += second.usage.prompt_tokens ?? 0;
            run.usage.completion_tokens += second.usage.completion_tokens ?? 0;
            text = text ? `${text}\n\n${second.text}` : second.text;
          }
          return { text, trace };
        },
      );

      thread.push({ role: "user", content: String(message), at: nowIso() });
      thread.push({
        role: "assistant",
        content: result.text,
        at: nowIso(),
        citations: retrieval.passages.map((passage) => passage.title),
        tools: result.trace,
        simulated: run.simulated,
        costCents: run.costCents,
      });
      company.threads[threadKey] = thread.slice(-40);
      run.output = result.text.slice(0, 1200);
      run.status = "succeeded";
      run.endedAt = nowIso();
      run.agentName = agent.name;
      pushActivity(company, {
        kind: "chat",
        actorId: agent.id,
        subject: issue ? issue.key : "Direct message",
        detail: String(message).slice(0, 120),
        issueId: issue?.id ?? null,
      });
      recomputeCompany(company);
      return { agent, run, text: result.text, citations: retrieval.passages, tools: result.trace };
    });
  }

  /* ----------------------------------------------------------- approvals */

  async function decideApproval({ companyId, approvalId, decision, by = "you", note = "" }) {
    return store.withCompany(companyId, async (company) => {
      const approval = company.approvals.find((entry) => entry.id === approvalId);
      if (!approval) {
        const error = new Error("Approval not found");
        error.status = 404;
        throw error;
      }
      if (approval.status !== "pending") {
        const error = new Error(`Approval already ${approval.status}`);
        error.status = 409;
        throw error;
      }
      approval.status = decision === "approve" ? "approved" : "denied";
      approval.decidedBy = by;
      approval.decidedAt = nowIso();
      approval.note = note;
      const issue = approval.issueId ? findIssue(company, approval.issueId) : null;
      if (issue) {
        if (approval.status === "approved") {
          issue.status = "todo";
          issue.blockedReason = "";
        } else {
          issue.status = "blocked";
          issue.blockedReason = `Denied by ${by}: ${note || approval.action}`;
        }
        issue.updatedAt = nowIso();
      }
      pushActivity(company, {
        kind: `approval.${approval.status}`,
        actorId: by,
        subject: issue?.key ?? approval.action,
        detail: note || approval.action,
        issueId: issue?.id ?? null,
      });
      notify(company, { type: "approval.decided", payload: { approval, issue } });
      recomputeCompany(company);
      return { approval, issue };
    });
  }

  /**
   * A company whose board is empty stops being a company. Once something has
   * shipped, the next cycle opens the follow-up the last review asked for —
   * grounded in the goal metric, never invented scope.
   */
  function replenishBoard(company, { max = 2 } = {}) {
    const open = company.issues.filter((issue) => OPEN_STATUSES.includes(issue.status));
    const room = Math.min(max, 2 - open.length);
    if (room <= 0) return [];
    const goal = company.goals.find((entry) => entry.status === "active") ?? company.goals[0];
    const shipped = company.issues.filter((issue) => issue.status === "done");
    if (!goal || !shipped.length) return [];
    // Follow-ups keep the company alive; an unbounded chain is a template
    // chasing its own tail. Four is enough rhythm for a week of cycles.
    if (company.issues.filter((issue) => (issue.labels ?? []).includes("follow-up")).length >= 4) return [];
    const metric = goal.metric || "the goal metric";
    const last = shipped[shipped.length - 1];
    const lastReview = [...company.runs].reverse().find((run) => run.issueId === last.id && run.review?.follow_ups?.length);
    const followUpText = lastReview?.review?.follow_ups?.[0];
    const owner = company.agents.find((agent) => agent.role === "operator") ?? company.agents[0];
    const templates = [
      {
        title: `Measure ${metric} after ${last.key} and record the number`,
        priority: "high",
        description: `Run the ${metric} check on what ${last.key} shipped, write the measured value next to the target (${goal.target}${goal.unit ? ` ${goal.unit}` : ""}) and say where the number came from.`,
        acceptance: [`A measured ${metric} value with its source and timestamp`, "Compared to the target, with the gap named", "Linked to the goal so progress moves only on evidence"],
      },
      {
        title: followUpText ? clip(followUpText, 76) : `Ship the follow-up ${last.key} asked for`,
        priority: "medium",
        description: `The review on ${last.key} left this next step: ${followUpText ?? "closing the gap it named"}. Close it, attach the artifact, and let the reviewer accept it against its criteria.`,
        acceptance: ["The follow-up named in the last review is closed", "Artifact linked in the issue", "Reviewer verdict recorded"],
      },
      {
        title: `Run the ${metric} check on a second real input`,
        priority: "low",
        description: `The first input proved the slice works once. Take a different real input through the same path and record latency, cost and the ${metric} result.`,
        acceptance: ["A second, different real input used", "Latency and cost recorded on the run", "Any difference from the first input explained"],
      },
    ];
    const existing = new Set(company.issues.map((issue) => issue.title.toLowerCase().slice(0, 40)));
    const created = [];
    for (const template of templates) {
      if (created.length >= room) break;
      if (existing.has(template.title.toLowerCase().slice(0, 40))) continue;
      const issue = createIssue(company, {
        ...template,
        status: "todo",
        assigneeId: owner?.id ?? null,
        projectId: last.projectId ?? company.projects[0]?.id ?? null,
        goalId: goal.id,
        labels: ["follow-up"],
        createdBy: "cycle",
      });
      company.issues.push(issue);
      created.push(issue);
    }
    if (created.length) {
      pushActivity(company, {
        kind: "board.replenished",
        actorId: owner?.id ?? "system",
        subject: `${created.length} new issue${created.length === 1 ? "" : "s"}`,
        detail: created.map((issue) => issue.title).join(" · "),
      });
      notify(company, { type: "board.replenished", payload: { issues: created.map((issue) => ({ id: issue.id, key: issue.key, title: issue.title })) } });
      recomputeCompany(company);
    }
    return created;
  }

  /**
   * Accepted work is the only thing worth remembering. It becomes one knowledge
   * document (so retrieval can cite it next cycle) and one line of the agent's
   * own memory (so the next run starts from what worked).
   */
  function remember(company, { agent, issue, verdict, deliverable }) {
    const at = nowIso();
    const lesson = clampText(String(verdict?.summary ?? "Shipped and accepted."), 240);
    const memory = (agent.memory ?? []).filter((entry) => entry.issueId !== issue.id);
    memory.unshift({ at, issueId: issue.id, issueKey: issue.key, title: issue.title, lesson });
    agent.memory = memory.slice(0, 12);
    if (!company.knowledge.some((doc) => doc.sourceIssueId === issue.id)) {
      company.knowledge.unshift(
        createKnowledge({
          title: `${issue.key} — ${issue.title}`,
          body: `${lesson}\n\n${clampText(deliverable, 2400)}`,
          tags: ["shipped", ...(issue.labels ?? []).slice(0, 2)],
          source: "agent",
          sourceIssueId: issue.id,
          agentId: agent.id,
        }),
      );
    }
    pushActivity(company, {
      kind: "knowledge.shipped",
      actorId: agent.id,
      subject: issue.key,
      detail: `Remembered: ${lesson}`,
      issueId: issue.id,
    });
  }

  /** How many work runs each issue has already had — the aging signal. */
  function attemptCounts(company) {
    const counts = new Map();
    for (const run of company.runs) {
      if (!run.issueId || run.kind === "plan" || run.kind === "standup") continue;
      counts.set(run.issueId, (counts.get(run.issueId) ?? 0) + 1);
    }
    return counts;
  }

  /* ------------------------------------------------------------ routines */

  async function runRoutine({ companyId, routineId }) {
    return store.withCompany(companyId, async (company) => {
      const routine = company.routines.find((entry) => entry.id === routineId);
      if (!routine) {
        const error = new Error("Routine not found");
        error.status = 404;
        throw error;
      }
      const agent = findAgent(company, routine.agentId) ?? pickAgent(company, "operator");
      const retrieval = await searchKnowledge({ company, nim, query: routine.instruction.slice(0, 300) });
      // A routine costs money like anything else: it gets a run row and a ledger
      // row, so "every call is billed" stays true for scheduled work too.
      const run = {
        id: newId("run"),
        issueId: null,
        agentId: agent?.id ?? null,
        kind: "routine",
        status: "running",
        model: agent?.model ?? null,
        simulated: nim.status().mode === "simulation",
        startedAt: nowIso(),
        endedAt: null,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        costCents: 0,
        steps: [],
        output: "",
        review: null,
        error: null,
        routineId: routine.id,
      };
      company.runs.unshift(run);
      const result = await withUsageContext(
        {
          companyId,
          runId: run.id,
          agentId: agent?.id ?? null,
          sink: (usageEvent) => {
            const row = recordLedger(company, {
              runId: run.id,
              agentId: agent?.id ?? null,
              model: usageEvent.model,
              usage: usageEvent.usage,
              cost: usageEvent.cost,
              endpoint: usageEvent.endpoint,
              simulated: usageEvent.simulated,
            });
            run.costCents += row.costCents;
            notify(company, { type: "ledger.recorded", payload: { row, runId: run.id } });
          },
        },
        () =>
          nim.chat({
            model: agent?.model,
            messages: [
              { role: "system", content: `Task type: triage\n\nYou are running a scheduled routine at ${company.name}. Be brief and concrete.` },
              { role: "user", content: `${routine.name}: ${routine.instruction}\n\n${renderContext(retrieval.passages)}` },
            ],
            temperature: 0.3,
            maxTokens: 700,
          }),
      );
      run.usage.prompt_tokens += result.usage?.prompt_tokens ?? 0;
      run.usage.completion_tokens += result.usage?.completion_tokens ?? 0;
      run.status = "succeeded";
      run.endedAt = nowIso();
      run.output = String(result.text ?? "").slice(0, 2000);
      run.agentName = agent?.name ?? "system";
      routine.runs = (routine.runs ?? 0) + 1;
      routine.lastRunAt = nowIso();
      routine.nextRunAt = new Date(Date.now() + routine.cadenceMinutes * 60_000).toISOString();
      company.activity.unshift({
        id: newId("act"),
        at: nowIso(),
        kind: "routine.run",
        actorId: agent?.id ?? "system",
        subject: routine.name,
        detail: String(result.text).slice(0, 200),
        issueId: null,
        meta: { routineId: routine.id },
      });
      recomputeCompany(company);
      emit(companyId, { type: "routine.ran", payload: { routine, runId: run.id, text: result.text } });
      return { routine, run, text: result.text };
    });
  }

  /* ------------------------------------------------------------ auto mode */

  const timers = new Map();

  function startAuto(companyId) {
    if (timers.has(companyId)) return { running: true };
    const company = store.getCompany(companyId);
    if (!company) return { running: false };
    const intervalMs = Math.max(60_000, (company.settings.cycleMinutes ?? 60) * 60_000);
    const tick = async () => {
      const current = store.getCompany(companyId);
      if (!current?.settings.autoMode) return;
      const cap = Number(current.settings.maxCycles ?? 0);
      if (cap > 0 && (current.cycleHistory?.length ?? 0) >= cap) {
        current.settings.autoMode = false;
        store.saveCompany(current);
        stopAuto(companyId);
        emit(companyId, { type: "auto.stopped", payload: { reason: "maxCycles reached" } });
        return;
      }
      // Routines are the company's heartbeat: dispatch whatever came due before
      // planning new work, otherwise nextRunAt is written and nothing ever fires.
      try {
        const due = (current.routines ?? [])
          .filter((routine) => !routine.nextRunAt || new Date(routine.nextRunAt).getTime() <= Date.now())
          .slice(0, 2);
        for (const routine of due) await runRoutine({ companyId, routineId: routine.id });
      } catch (error) {
        emit(companyId, { type: "auto.error", payload: { error: error.message, phase: "routine" } });
      }
      try {
        await planCycle({ companyId, maxIssues: 2, auto: true });
      } catch (error) {
        emit(companyId, { type: "auto.error", payload: { error: error.message } });
      }
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    timers.set(companyId, timer);
    return { running: true, intervalMs };
  }

  function stopAuto(companyId) {
    const timer = timers.get(companyId);
    if (timer) clearInterval(timer);
    timers.delete(companyId);
    return { running: false };
  }

  function stopAll() {
    for (const companyId of timers.keys()) stopAuto(companyId);
  }

  /**
   * A process that died mid-run leaves a run stuck in `running` forever. Anything
   * older than `olderThanMs` is marked failed (with a reason the UI can show) and
   * its issue goes back to `todo`, so the board never shows a zombie spinner.
   */
  function reapStaleRuns({ olderThanMs = 5 * 60_000 } = {}) {
    const cutoff = Date.now() - olderThanMs;
    const reaped = [];
    for (const summary of store.listCompanies()) {
      const company = store.getCompany(summary.id);
      if (!company) continue;
      let dirty = false;
      for (const run of company.runs) {
        if (run.status !== "running" || !run.startedAt) continue;
        if (new Date(run.startedAt).getTime() > cutoff) continue;
        run.status = "failed";
        run.endedAt = nowIso();
        run.error = "Interrupted before it finished — the process restarted. Re-run the issue.";
        dirty = true;
        reaped.push({ companyId: company.id, runId: run.id, issueId: run.issueId ?? null });
        pushActivity(company, {
          kind: "run.failed",
          actorId: run.agentId,
          subject: "Interrupted run",
          detail: run.error,
          meta: { runId: run.id, issueId: run.issueId ?? null },
        });
      }
      if (dirty) {
        for (const issue of company.issues) {
          const stillRunning = company.runs.some((run) => run.issueId === issue.id && run.status === "running");
          if (issue.status === "in_progress" && !stillRunning) {
            issue.status = "todo";
            issue.updatedAt = nowIso();
          }
        }
        recomputeCompany(company);
        store.saveCompany(company);
        emit(company.id, { type: "runs.reaped", payload: { count: reaped.length } });
      }
    }
    return reaped;
  }

  return {
    runIssue,
    planOnly,
    planCycle,
    chat,
    decideApproval,
    runRoutine,
    startAuto,
    stopAuto,
    stopAll,
    reapStaleRuns,
    tools,
    helpers: { pickAgent, criticFor, systemPrompt, parseJson, budgetFor },
  };
}
