import { api, ago, avatar, esc, icon } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Activity";

export async function render(root, ctx) {
  const company = ctx.company;
  const filter = ctx.query.kind ?? "all";
  const events = (company.activity ?? []).filter((event) => filter === "all" || event.kind.startsWith(filter));
  const kinds = [...new Set((company.activity ?? []).map((event) => event.kind.split(".")[0]))];

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Company",
      title: "Activity",
      subtitle: "The audit trail: every run, review, approval and budget event, newest first.",
      actions: `<button class="btn ghost" data-action="audit">${icon("terminal", "nav-icon")} Raw audit log</button>`,
    })}

    <div class="chips" style="margin-bottom:14px">
      <button class="chip ${filter === "all" ? "on" : ""}" data-kind="all">All</button>
      ${kinds.map((kind) => `<button class="chip ${filter === kind ? "on" : ""}" data-kind="${esc(kind)}">${esc(kind)}</button>`).join("")}
    </div>

    <div class="card">
      <div class="stack" style="gap:0">
        ${events
          .slice(0, 120)
          .map((event) => {
            const actor = company.agents.find((agent) => agent.id === event.actorId);
            return `<div class="row" style="gap:10px;padding:9px 0;border-bottom:1px solid rgba(28,28,34,.8);align-items:flex-start">
              ${avatar(actor ?? { name: event.actorId ?? "system" }, "sm")}
              <div class="grow" style="min-width:0">
                <div style="font-size:12.6px;color:var(--text-2)">${esc(event.detail || event.subject || event.kind)}</div>
                <div class="row" style="gap:6px;margin-top:2px">
                  <span class="tag">${esc(event.kind)}</span>
                  ${event.subject ? `<span class="hint">${esc(event.subject)}</span>` : ""}
                  ${event.issueId ? `<a class="hint" href="#/issues/${esc(event.issueId)}">open issue</a>` : ""}
                </div>
              </div>
              <span class="hint nowrap">${ago(event.at)}</span>
            </div>`;
          })
          .join("") || `<div class="hint">No activity for this filter.</div>`}
      </div>
    </div>
  `;

  root.querySelectorAll("[data-kind]").forEach((chip) =>
    chip.addEventListener("click", () => {
      location.hash = chip.dataset.kind === "all" ? "/activity" : `/activity?kind=${chip.dataset.kind}`;
    }),
  );
  root.querySelector('[data-action="audit"]').addEventListener("click", async () => {
    const lib = await import("../lib.js");
    lib.openDrawer({
      title: "Audit log",
      subtitle: `data/companies/${ctx.companyId}/events.ndjson`,
      body: `<div class="hint" style="margin-bottom:10px">Append-only NDJSON on disk. Live SSE events mirror the same mutations.</div><div class="out">${esc(
        events
          .slice(0, 60)
          .map((event) => `${event.at} ${event.kind} ${event.actorId ?? ""} ${event.subject ?? ""}`)
          .join("\n"),
      )}</div>`,
    });
  });
}
