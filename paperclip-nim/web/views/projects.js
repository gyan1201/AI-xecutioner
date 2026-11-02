import { api, esc, icon, modal, toast } from "../lib.js";
import { emptyState, pageHeader } from "./shared.js";

export const title = "Projects";

export async function render(root, ctx) {
  const { projects } = await api(`/api/companies/${ctx.companyId}/projects`);
  const company = ctx.company;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Work",
      title: "Projects",
      subtitle: "A project is a container, not a plan. The plan lives on the board.",
      actions: `<button class="btn primary" data-action="new">${icon("plus", "nav-icon")} New project</button>`,
    })}

    ${
      projects.length
        ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
            ${projects
              .map((project) => {
                const open = project.open ?? 0;
                const done = (project.issues ?? 0) - open;
                const progress = project.issues ? done / project.issues : 0;
                return `<div class="card" data-project="${esc(project.id)}" style="cursor:pointer;display:flex;flex-direction:column;gap:10px">
                  <div class="row" style="gap:8px">
                    <i style="width:9px;height:9px;border-radius:3px;background:${esc(project.color)}"></i>
                    <h3 style="font-size:13.5px" class="grow truncate">${esc(project.name)}</h3>
                    <span class="pill">${open} open</span>
                  </div>
                  <div class="hint" style="min-height:34px">${esc(project.description || "No description.")}</div>
                  <div class="progress"><i style="width:${Math.round(progress * 100)}%;background:${esc(project.color)}"></i></div>
                  <div class="row-between" style="font-size:11px;color:var(--dim)">
                    <span>${done} done · ${project.issues} total</span>
                    <span>${Math.round(progress * 100)}%</span>
                  </div>
                </div>`;
              })
              .join("")}
          </div>`
        : emptyState({ title: "No projects", body: "Group related issues so the board stays readable at scale." })
    }

    <div class="section-title">Unprojected issues</div>
    <div class="card pad-0" style="overflow:hidden">
      <table class="table">
        <tbody>
          ${
            (company.issues ?? [])
              .filter((issue) => !issue.projectId && issue.status !== "done")
              .slice(0, 8)
              .map((issue) => `<tr data-issue="${esc(issue.id)}"><td class="key">${esc(issue.key)}</td><td class="title-cell">${esc(issue.title)}</td><td class="dim">${esc(issue.status)}</td></tr>`)
              .join("") || `<tr><td class="hint">Everything is filed.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  root.querySelector('[data-action="new"]').addEventListener("click", () => projectModal(ctx, null));
  root.querySelectorAll("[data-project]").forEach((card) =>
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-edit]")) return;
      const project = projects.find((entry) => entry.id === card.dataset.project);
      ctx.navigate(`/issues?project=${project.id}`);
    }),
  );
  root.querySelectorAll("[data-issue]").forEach((row) =>
    row.addEventListener("click", () => ctx.navigate(`/issues/${row.dataset.issue}`)),
  );
}

function projectModal(ctx, project) {
  modal({
    title: project ? "Edit project" : "New project",
    submitLabel: project ? "Save" : "Create project",
    body: `
      <div class="field"><label>Name</label><input class="input" name="name" required value="${esc(project?.name ?? "")}" placeholder="Activation" /></div>
      <div class="field"><label>Description</label><textarea class="textarea" name="description">${esc(project?.description ?? "")}</textarea></div>
      <div class="field"><label>Colour</label><input class="input" name="color" type="color" value="${esc(project?.color ?? "#76b900")}" style="height:36px;padding:3px" /></div>
    `,
    async onSubmit(data) {
      const path = project ? `/api/companies/${ctx.companyId}/projects/${project.id}` : `/api/companies/${ctx.companyId}/projects`;
      await api(path, { method: project ? "PATCH" : "POST", body: data });
      await ctx.refresh(true);
      toast(project ? "Project saved" : "Project created");
      render(document.getElementById("view"), ctx);
    },
  });
}
