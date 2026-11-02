import { api, esc, icon, modal, money, num, toast } from "../lib.js";
import { emptyState, goalDirection, goalProgress, pageHeader } from "./shared.js";

export const title = "Goals";

export async function render(root, ctx) {
  const { goals } = await api(`/api/companies/${ctx.companyId}/goals`);
  const company = ctx.company;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Work",
      title: "Goals",
      subtitle: "Every issue should trace to a goal. Agents plan against these numbers.",
      actions: `<button class="btn primary" data-action="new">${icon("plus", "nav-icon")} New goal</button>`,
    })}

    ${
      goals.length
        ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">
            ${goals
              .map((goal) => {
                const progress = goalProgress(goal);
                return `<div class="card" style="display:flex;flex-direction:column;gap:10px">
                  <div class="row-between" style="align-items:flex-start">
                    <div class="grow">
                      <div class="row" style="gap:6px;margin-bottom:4px"><span class="pill ${goal.status === "active" ? "accent" : ""}">${esc(goal.status)}</span>${goal.unit ? `<span class="tag">${esc(goal.unit)}</span>` : ""}</div>
                      <h3 style="font-size:14px;line-height:1.4">${esc(goal.title)}</h3>
                    </div>
                    <button class="btn sm ghost" data-edit="${esc(goal.id)}">Edit</button>
                  </div>
                  <div class="hint" style="min-height:34px">${esc(goal.description || "No description.")}</div>
                  <div class="progress" style="height:6px"><i style="width:${Math.round(progress * 100)}%"></i></div>
                  <div class="row-between" style="font-size:12px">
                    <span style="color:var(--text-2)">${num(goal.current)} → ${num(goal.target)} ${esc(goal.unit)}</span>
                    <span class="pill ${progress >= 1 ? "green" : ""}">${Math.round(progress * 100)}%</span>
                  </div>
                  <div class="row" style="gap:6px;flex-wrap:wrap">
                    <span class="tag">${esc(goal.metric || "metric")}</span>
                    <span class="tag">baseline ${num(goal.baseline)}</span>
                    <span class="tag">${goalDirection(goal)}</span>
                    <span class="tag">${goal.issues} issues · ${goal.done} done</span>
                  </div>
                  <div class="hint">Owner ${esc(goal.owner ?? "unassigned")}${goal.dueAt ? ` · due ${new Date(goal.dueAt).toLocaleDateString()}` : ""}</div>
                </div>`;
              })
              .join("")}
          </div>`
        : emptyState({ title: "No goals yet", body: "A goal gives agents something to optimize. Add a metric and a baseline." })
    }
  `;

  root.querySelector('[data-action="new"]').addEventListener("click", () => goalModal(ctx, null));
  root.querySelectorAll("[data-edit]").forEach((button) =>
    button.addEventListener("click", () => goalModal(ctx, goals.find((goal) => goal.id === button.dataset.edit))),
  );
}

function goalModal(ctx, goal) {
  const company = ctx.company;
  modal({
    title: goal ? "Edit goal" : "New goal",
    submitLabel: goal ? "Save goal" : "Create goal",
    body: `
      <div class="field"><label>Title</label><input class="input" name="title" required value="${esc(goal?.title ?? "")}" placeholder="e.g. Reach $20k MRR in 90 days" /></div>
      <div class="field"><label>Description</label><textarea class="textarea" name="description">${esc(goal?.description ?? "")}</textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Metric</label><input class="input" name="metric" value="${esc(goal?.metric ?? "")}" placeholder="MRR" /></div>
        <div class="field"><label>Unit</label><input class="input" name="unit" value="${esc(goal?.unit ?? "")}" placeholder="USD" /></div>
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr 1fr">
        <div class="field"><label>Baseline</label><input class="input" type="number" step="any" name="baseline" value="${goal?.baseline ?? 0}" /></div>
        <div class="field"><label>Current</label><input class="input" type="number" step="any" name="current" value="${goal?.current ?? 0}" /></div>
        <div class="field"><label>Target</label><input class="input" type="number" step="any" name="target" value="${goal?.target ?? 100}" /></div>
      </div>
      <div class="field"><label>Owner</label><select class="select" name="ownerId">
        <option value="">Unassigned</option>
        ${company.agents.map((agent) => `<option value="${esc(agent.id)}" ${goal?.ownerId === agent.id ? "selected" : ""}>${esc(agent.name)}</option>`).join("")}
      </select></div>
    `,
    async onSubmit(data) {
      const path = goal ? `/api/companies/${ctx.companyId}/goals/${goal.id}` : `/api/companies/${ctx.companyId}/goals`;
      await api(path, { method: goal ? "PATCH" : "POST", body: data });
      await ctx.refresh(true);
      toast(goal ? "Goal updated" : "Goal created");
      render(document.getElementById("view"), ctx);
    },
  });
}
