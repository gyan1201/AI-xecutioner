import { api, debounce, esc, icon } from "../lib.js";
import { emptyState, issueCard, issueRow, pageHeader, statusCounts } from "./shared.js";

export const title = "Issues";

const BOARD_COLUMNS = [
  { status: "backlog", label: "Backlog", color: "#8b949e" },
  { status: "todo", label: "Todo", color: "#8b949e" },
  { status: "in_progress", label: "In progress", color: "#6995ff" },
  { status: "in_review", label: "In review", color: "#e3b341" },
  { status: "blocked", label: "Blocked", color: "#ff7b72" },
  { status: "done", label: "Done", color: "#3fb950" },
];

export async function render(root, ctx) {
  const company = ctx.company;
  const view = ctx.query.view === "board" ? "board" : "table";
  const filters = {
    status: ctx.query.status ?? "open",
    priority: ctx.query.priority ?? "all",
    assigneeId: ctx.query.assignee ?? "",
    label: ctx.query.label ?? "",
    q: ctx.query.q ?? "",
  };

  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.priority !== "all") query.set("priority", filters.priority);
  if (filters.assigneeId) query.set("assigneeId", filters.assigneeId);
  if (filters.q) query.set("query", filters.q);
  if (filters.label) query.set("label", filters.label);

  const data = await api(`/api/companies/${ctx.companyId}/issues?${query}`);
  const allIssues = company.issues ?? [];
  const counts = statusCounts(allIssues, ["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
  const labels = [...new Set(allIssues.flatMap((issue) => issue.labels ?? []))].slice(0, 14);

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Work",
      title: "Issues",
      subtitle: `${data.counts.open} open of ${data.counts.all} total · ${counts.in_progress} in progress · ${counts.blocked} blocked`,
      actions: `<button class="btn primary" data-action="new">${icon("plus", "nav-icon")} New issue</button>`,
    })}

    <div class="toolbar">
      <div class="segmented">
        <button data-view="table" class="${view === "table" ? "on" : ""}">List</button>
        <button data-view="board" class="${view === "board" ? "on" : ""}">Board</button>
      </div>
      <input class="input" id="issue-search" placeholder="Filter issues…" value="${esc(filters.q)}" />
      <select class="select" id="filter-status">
        ${[
          ["open", "Open"],
          ["all", "All statuses"],
          ["todo", "Todo"],
          ["in_progress", "In progress"],
          ["in_review", "In review"],
          ["blocked", "Blocked"],
          ["done", "Done"],
          ["backlog", "Backlog"],
        ]
          .map(([value, label]) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
      <select class="select" id="filter-priority">
        ${["all", "urgent", "high", "medium", "low"]
          .map((value) => `<option value="${value}" ${filters.priority === value ? "selected" : ""}>${value === "all" ? "All priorities" : value}</option>`)
          .join("")}
      </select>
      <select class="select" id="filter-assignee">
        <option value="">Everyone</option>
        ${(company.agents ?? [])
          .map((agent) => `<option value="${esc(agent.id)}" ${filters.assigneeId === agent.id ? "selected" : ""}>${esc(agent.name)}</option>`)
          .join("")}
      </select>
      <span class="grow"></span>
      <span class="hint">${data.total} total</span>
    </div>

    ${
      labels.length
        ? `<div class="chips" style="margin-bottom:12px">
            <button class="chip ${!filters.label ? "on" : ""}" data-label="">All labels</button>
            ${labels.map((label) => `<button class="chip ${filters.label === label ? "on" : ""}" data-label="${esc(label)}">${esc(label)}</button>`).join("")}
          </div>`
        : ""
    }

    ${
      data.issues.length === 0
        ? emptyState({
            title: "Nothing matches",
            body: "Adjust the filters, or give the board something new to chew on.",
            action: `<button class="btn primary" data-action="new" style="margin-top:12px">${icon("plus", "nav-icon")} New issue</button>`,
          })
        : view === "board"
          ? renderBoard(data.issues, company)
          : renderTable(data.issues)
    }
  `;

  const updateUrl = (patch) => {
    const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === "all" || (key === "status" && value === "open") || (key === "view" && value === "table")) next.delete(key);
      else next.set(key, value);
    }
    if (view === "board" && patch.view === undefined) next.set("view", "board");
    location.hash = `/issues${next.toString() ? `?${next}` : ""}`;
    render(root, ctx);
  };

  root.querySelectorAll("[data-view]").forEach((button) =>
    button.addEventListener("click", () => updateUrl({ view: button.dataset.view, status: filters.status })),
  );
  root.querySelector("#filter-status")?.addEventListener("change", (event) => updateUrl({ status: event.target.value }));
  root.querySelector("#filter-priority")?.addEventListener("change", (event) => updateUrl({ priority: event.target.value }));
  root.querySelector("#filter-assignee")?.addEventListener("change", (event) => updateUrl({ assignee: event.target.value }));
  root.querySelectorAll("[data-label]").forEach((chip) =>
    chip.addEventListener("click", () => updateUrl({ label: chip.dataset.label })),
  );
  root.querySelector("#issue-search")?.addEventListener(
    "input",
    debounce((event) => updateUrl({ q: event.target.value }), 320),
  );
  root.querySelectorAll('[data-action="new"]').forEach((button) => button.addEventListener("click", () => ctx.newIssue?.()));

  const open = (event) => {
    const id = event.target.closest("[data-issue]")?.dataset.issue;
    if (id) ctx.navigate(`/issues/${id}`);
  };
  root.addEventListener("click", open);
  return () => root.removeEventListener("click", open);
}

function renderTable(issues) {
  return `<div class="card pad-0" style="overflow:hidden">
    <table class="table">
      <thead><tr><th>Key</th><th>Issue</th><th>Status</th><th>Priority</th><th>Owner</th><th>Updated</th></tr></thead>
      <tbody>${issues.map(issueRow).join("")}</tbody>
    </table>
  </div>`;
}

function renderBoard(issues, company) {
  return `<div class="board" style="grid-template-columns:repeat(6, minmax(196px, 1fr))">
    ${BOARD_COLUMNS.map((column) => {
      const columnIssues = issues.filter((issue) => issue.status === column.status);
      return `<div class="column">
        <div class="column-head">
          <span class="column-title"><i style="width:6px;height:6px;border-radius:50%;background:${column.color}"></i>${esc(column.label)}</span>
          <span class="column-count">${columnIssues.length}</span>
        </div>
        <div class="column-body">
          ${columnIssues.map((issue) => issueCard({ ...issue, assignee: issue.assignee ?? company.agents.find((agent) => agent.id === issue.assigneeId) })).join("") ||
            `<div class="hint" style="padding:6px 2px">Empty</div>`}
        </div>
      </div>`;
    }).join("")}
  </div>`;
}
