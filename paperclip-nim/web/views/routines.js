import { api, ago, esc, icon, modal, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Routines";

export async function render(root, ctx) {
  const { routines } = await api(`/api/companies/${ctx.companyId}/routines`);
  const company = ctx.company;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Work",
      title: "Routines",
      subtitle: "Scheduled prompts that keep the board honest — standups, triage, quality sweeps.",
      actions: `<button class="btn primary" data-action="new">${icon("plus", "nav-icon")} New routine</button>`,
    })}

    <div class="stack">
      ${
        routines.length
          ? routines
              .map(
                (routine) => `<div class="card">
                  <div class="row-between" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <div class="grow" style="min-width:240px">
                      <div class="row" style="gap:8px">
                        <h3 style="font-size:13.5px">${esc(routine.name)}</h3>
                        <span class="pill ${routine.enabled ? "accent" : ""}">${routine.enabled ? "enabled" : "paused"}</span>
                        <span class="pill">every ${formatCadence(routine.cadenceMinutes)}</span>
                      </div>
                      <div class="hint" style="margin-top:4px">${esc(routine.instruction)}</div>
                      <div class="hint" style="margin-top:6px">${esc(routine.agent ?? "unassigned")} · ${routine.runs ?? 0} runs · last ${routine.lastRunAt ? ago(routine.lastRunAt) : "never"} · next ${routine.nextRunAt ? ago(routine.nextRunAt).replace("ago", "") : "—"}</div>
                    </div>
                    <div class="row" style="gap:6px">
                      <button class="btn sm" data-run="${esc(routine.id)}">${icon("play", "nav-icon")} Run now</button>
                      <button class="btn sm ghost" data-toggle="${esc(routine.id)}">${routine.enabled ? "Pause" : "Enable"}</button>
                      <button class="btn sm ghost" data-edit="${esc(routine.id)}">Edit</button>
                    </div>
                  </div>
                  <div class="live-output" data-output="${esc(routine.id)}" hidden></div>
                </div>`,
              )
              .join("")
          : `<div class="card hint">No routines yet. Start with a morning standup.</div>`
      }
    </div>
  `;

  root.querySelector('[data-action="new"]').addEventListener("click", () => routineModal(ctx, null));
  root.querySelectorAll("[data-edit]").forEach((button) =>
    button.addEventListener("click", () => routineModal(ctx, routines.find((routine) => routine.id === button.dataset.edit))),
  );
  root.querySelectorAll("[data-toggle]").forEach((button) =>
    button.addEventListener("click", async () => {
      const routine = routines.find((entry) => entry.id === button.dataset.toggle);
      await api(`/api/companies/${ctx.companyId}/routines/${routine.id}`, { method: "PATCH", body: { enabled: !routine.enabled } });
      await ctx.refresh(true);
      render(root, ctx);
    }),
  );
  root.querySelectorAll("[data-run]").forEach((button) =>
    button.addEventListener("click", async () => {
      const routine = routines.find((entry) => entry.id === button.dataset.run);
      button.disabled = true;
      button.textContent = "Running…";
      try {
        const result = await api(`/api/companies/${ctx.companyId}/routines/${routine.id}/run`, { method: "POST" });
        const output = root.querySelector(`[data-output="${routine.id}"]`);
        output.hidden = false;
        output.textContent = result.text;
        await ctx.refresh(true);
        toast("Routine ran");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
        button.innerHTML = `${icon("play", "nav-icon")} Run now`;
      }
    }),
  );
}

function formatCadence(minutes) {
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function routineModal(ctx, routine) {
  modal({
    title: routine ? "Edit routine" : "New routine",
    submitLabel: routine ? "Save" : "Create routine",
    body: `
      <div class="field"><label>Name</label><input class="input" name="name" required value="${esc(routine?.name ?? "")}" placeholder="Morning standup" /></div>
      <div class="field"><label>Instruction</label><textarea class="textarea" name="instruction" placeholder="What should the agent do each time?">${esc(routine?.instruction ?? "")}</textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Agent</label><select class="select" name="agentId">
          ${ctx.company.agents.map((agent) => `<option value="${esc(agent.id)}" ${routine?.agentId === agent.id ? "selected" : ""}>${esc(agent.name)}</option>`).join("")}
        </select></div>
        <div class="field"><label>Cadence (minutes)</label><input class="input" type="number" name="cadenceMinutes" min="5" value="${routine?.cadenceMinutes ?? 1440}" /></div>
      </div>
    `,
    async onSubmit(data) {
      const path = routine ? `/api/companies/${ctx.companyId}/routines/${routine.id}` : `/api/companies/${ctx.companyId}/routines`;
      await api(path, { method: routine ? "PATCH" : "POST", body: data });
      await ctx.refresh(true);
      toast(routine ? "Routine saved" : "Routine created");
      render(document.getElementById("view"), ctx);
    },
  });
}
