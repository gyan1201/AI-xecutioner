/* Small view-level components shared by more than one page. */

import { ago, avatar, esc, icon, md, money, num, pct, statusPill, priorityPill } from "../lib.js";

export const MAX_BUDGET_BAR = 100;

export function pageHeader({ title, subtitle = "", actions = "", eyebrow = "" }) {
  return `
    <div class="page-head">
      <div>
        ${eyebrow ? `<div class="section-title" style="margin:0 0 4px">${esc(eyebrow)}</div>` : ""}
        <h1 class="page-title">${title}</h1>
        ${subtitle ? `<div class="page-sub">${subtitle}</div>` : ""}
      </div>
      <div class="page-actions">${actions}</div>
    </div>`;
}

export function agentChip(agent, { showTitle = true } = {}) {
  if (!agent) return `<span class="muted">Unassigned</span>`;
  return `<span class="row" style="gap:6px">${avatar(agent, "sm")}<span>${esc(agent.name)}</span>${
    showTitle ? `<span class="dim" style="font-size:11px">${esc(agent.title)}</span>` : ""
  }</span>`;
}

export function spendBar(spend, { compact = false } = {}) {
  if (spend?.unlimited) {
    return `<div style="display:flex;flex-direction:column;gap:${compact ? "3px" : "5px"}">
      <div class="progress"><i style="width:100%;background:var(--accent);opacity:.35"></i></div>
      <div class="row" style="gap:6px;font-size:11px;color:var(--dim);justify-content:space-between">
        <span>${money(spend?.spentCents ?? 0, { precise: true })} spent</span>
        <span>no limit</span>
      </div>
    </div>`;
  }
  const ratio = Math.min(1, spend?.ratio ?? 0);
  const over = (spend?.ratio ?? 0) >= 1;
  const color = over ? "var(--red)" : ratio > 0.8 ? "var(--amber)" : "var(--accent)";
  return `<div style="display:flex;flex-direction:column;gap:${compact ? "3px" : "5px"}">
    <div class="progress"><i style="width:${Math.round(ratio * 100)}%;background:${color}"></i></div>
    <div class="row" style="gap:6px;font-size:11px;color:var(--dim);justify-content:space-between">
      <span>${money(spend?.spentCents ?? 0, { precise: true })} spent</span>
      <span>${money(spend?.capCents ?? 0)} cap</span>
    </div>
  </div>`;
}

export function issueRow(issue) {
  const project = issue.project ? `<span class="tag">${esc(issue.project)}</span>` : "";
  const labels = (issue.labels ?? []).slice(0, 2).map((label) => `<span class="tag">${esc(label)}</span>`).join("");
  return `<tr data-issue="${esc(issue.id)}">
    <td class="key nowrap">${esc(issue.key)}</td>
    <td class="title-cell">
      <div class="title truncate">${esc(issue.title)}</div>
      <div class="row" style="gap:5px;margin-top:3px">${project}${labels}</div>
    </td>
    <td>${statusPill(issue.status)}</td>
    <td>${priorityPill(issue.priority)}</td>
    <td>${issue.assignee ? agentChip(issue.assignee, { showTitle: false }) : `<span class="dim">—</span>`}</td>
    <td class="nowrap dim" style="font-size:11px">${ago(issue.updatedAt)}</td>
  </tr>`;
}

export function issueCard(issue) {
  return `<div class="issue-card" data-issue="${esc(issue.id)}">
    <div class="title">${esc(issue.title)}</div>
    <div class="meta">
      <span class="key">${esc(issue.key)}</span>
      ${issue.priority === "urgent" || issue.priority === "high" ? priorityPill(issue.priority) : ""}
      ${issue.comments ? `<span class="row" style="gap:3px">${icon("inbox", "nav-icon")}${issue.comments}</span>` : ""}
      <span class="grow"></span>
      ${issue.assignee ? avatar(issue.assignee, "sm") : ""}
    </div>
  </div>`;
}

export function commentCard(comment, company) {
  const author =
    comment.authorType === "human"
      ? { name: comment.authorId === "you" ? "You" : comment.authorId, accent: "var(--chart-8)" }
      : comment.authorId === "guardrail" || comment.authorId === "system"
        ? { name: "Guardrail", accent: "var(--chart-7)" }
        : company?.agents?.find((agent) => agent.id === comment.authorId) ?? { name: "Agent", accent: "var(--chart-3)" };
  const badge =
    comment.kind === "deliverable"
      ? `<span class="pill blue">deliverable</span>`
      : comment.kind === "review"
        ? `<span class="pill amber">review</span>`
        : comment.kind === "guardrail"
          ? `<span class="pill red">guardrail</span>`
          : "";
  const meta = comment.meta?.model
    ? `<span class="mono dim" style="font-size:10.5px">${esc(comment.meta.model)}</span>${
        comment.meta.costCents != null ? `<span class="dim" style="font-size:10.5px">${money(comment.meta.costCents, { precise: true })}</span>` : ""
      }`
    : "";
  return `<div class="comment ${comment.kind}">
    <div class="comment-head">
      ${avatar(author, "sm")}
      <span class="who">${esc(author.name)}</span>
      ${badge}
      <span class="grow"></span>
      ${meta}
      <span class="when">${ago(comment.createdAt)}</span>
    </div>
    <div class="comment-body prose">${md(comment.body)}</div>
  </div>`;
}

export function runTrace(run, { showHeader = true } = {}) {
  if (!run) return "";
  const steps = run.steps ?? [];
  return `
    ${showHeader ? `<div class="row-between" style="margin-bottom:6px">
      <div class="row" style="gap:7px">
        <span class="pill ${run.status === "succeeded" ? "green" : run.status === "running" ? "blue" : run.status === "failed" ? "red" : ""}">
          <span class="dot"></span>${esc(run.status)}</span>
        <span class="mono dim" style="font-size:10.5px">${esc(run.model ?? "")}</span>
        ${run.simulated ? '<span class="pill mono">sim</span>' : ""}
      </div>
      <div class="row" style="gap:10px;font-size:10.5px;color:var(--dim)">
        <span>${money(run.costCents ?? 0, { precise: true })}</span>
        <span>${num((run.usage?.prompt_tokens ?? 0) + (run.usage?.completion_tokens ?? 0))} tokens</span>
        <span>${run.endedAt ? ago(run.endedAt) : "running"}</span>
      </div>
    </div>` : ""}
    <div class="trace">
      ${steps
        .map(
          (step, index) => `<div class="trace-step">
            <span class="trace-index">${index + 1}</span>
            <div class="grow">
              <div class="trace-label">${esc(step.label)}</div>
              ${step.detail ? `<div class="trace-detail">${esc(step.detail)}</div>` : ""}
            </div>
            ${step.ms ? `<span class="trace-ms">${step.ms}ms</span>` : ""}
          </div>`,
        )
        .join("") || `<div class="hint">No steps recorded.</div>`}
    </div>`;
}

export function modelPill(modelId) {
  if (!modelId) return "";
  const short = modelId.split("/").pop();
  return `<span class="pill mono" title="${esc(modelId)}">${esc(short)}</span>`;
}

export function goalProgress(goal) {
  // A goal read from the user's sentence can have a target and no baseline yet.
  // Until something is measured, the honest progress is the share of linked
  // work that has been accepted — labelled as such in the UI.
  if (goal.baseline === null || goal.baseline === undefined || goal.current === null || goal.current === undefined) {
    const progress = goal.progress ?? {};
    return Math.max(0, Math.min(1, Number(progress.pct ?? 0) / 100));
  }
  const baseline = Number(goal.baseline) || 0;
  const target = Number(goal.target) || 0;
  const current = Number(goal.current) || 0;
  const descending = (goal.direction ?? (target < baseline ? "decrease" : "increase")) === "decrease";
  // Distance closed between where we started and where we want to be. Without
  // this, a "12 minutes → 4 minutes" goal reads as 300% on day one and 0%.
  const span = descending ? baseline - target : target - baseline;
  const moved = descending ? baseline - current : current - baseline;
  if (span === 0) return (descending ? current <= target : current >= target) ? 1 : 0;
  return Math.max(0, Math.min(1, moved / span));
}

export function goalDirection(goal) {
  if (goal.baseline === null || goal.baseline === undefined) {
    return goal.direction === "increase" ? "higher is better" : "lower is better";
  }
  const baseline = Number(goal.baseline) || 0;
  const target = Number(goal.target) || 0;
  return (goal.direction ?? (target < baseline ? "decrease" : "increase")) === "decrease" ? "lower is better" : "higher is better";
}

/** The pill next to the progress bar: a share of work, never a fake number. */
export function goalPill(goal) {
  if (goal.baseline === null || goal.baseline === undefined || goal.current === null || goal.current === undefined) {
    const progress = goal.progress ?? { accepted: 0, total: 0 };
    return `${progress.accepted ?? 0}/${progress.total ?? 0} accepted`;
  }
  return `${Math.round(goalProgress(goal) * 100)}%`;
}

/** "5 min" for a metric goal, "3 / 6 accepted" for a count goal. */
export function goalTarget(goal) {
  const unit = goal.unit ? ` ${goal.unit}` : "";
  if (goal.baseline === null || goal.baseline === undefined) {
    return `target ${num(goal.target)}${unit}`;
  }
  if (goal.current === null || goal.current === undefined) {
    return `baseline ${num(goal.baseline)}${unit} → target ${num(goal.target)}${unit}`;
  }
  return `${num(goal.current)} → ${num(goal.target)}${unit}`;
}

export function emptyState({ title, body, action = "" }) {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
}

export function statusCounts(issues, statuses) {
  return statuses.reduce((acc, status) => {
    acc[status] = issues.filter((issue) => issue.status === status).length;
    return acc;
  }, {});
}

export function ratio(n, d) {
  if (!d) return "0%";
  return pct(n / d, 0);
}
