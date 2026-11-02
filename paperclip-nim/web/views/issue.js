import { api, ago, avatar, copy, dateTime, esc, icon, md, money, num, openDrawer, priorityPill, statusPill, stream, toast } from "../lib.js";
import { commentCard, runTrace } from "./shared.js";

export const title = "Issue";

export async function render(root, ctx) {
  const issueId = ctx.params[0];
  let detail;
  try {
    detail = await api(`/api/companies/${ctx.companyId}/issues/${issueId}`);
  } catch (error) {
    root.innerHTML = `<div class="empty"><h3>Issue not found</h3><p>${esc(error.message)}</p><a class="btn" href="#/issues">Back to issues</a></div>`;
    return;
  }
  const { issue, comments, runs, artifacts, approvals } = detail;
  const company = ctx.company;
  const tab = ctx.query.tab ?? "discussion";
  const pendingApproval = approvals.find((approval) => approval.status === "pending");
  const liveRun = runs.find((run) => run.status === "running");

  root.innerHTML = `
    <div class="row" style="margin-bottom:10px;gap:10px">
      <a class="btn ghost sm" href="#/issues">${icon("issues", "nav-icon")} All issues</a>
      ${issue.goal ? `<span class="pill purple" title="${esc(issue.goal.title)}">${icon("goals", "nav-icon")} ${esc(truncate(issue.goal.title, 34))}</span>` : ""}
      ${issue.project ? `<span class="pill">${esc(issue.project.name)}</span>` : ""}
      ${issue.source?.startsWith("blueprint:") ? `<span class="pill accent">${esc(issue.source)}</span>` : ""}
    </div>

    <div class="issue-layout">
      <div>
        <div class="issue-head">
          <div class="row" style="gap:8px;font-size:11.5px;color:var(--dim)">
            <span class="mono">${esc(issue.key)}</span><span>·</span><span>created ${ago(issue.createdAt)}</span>
          </div>
          <h1>${esc(issue.title)}</h1>
          <div class="issue-meta">
            ${statusPill(issue.status)}
            ${priorityPill(issue.priority)}
            ${(issue.labels ?? []).map((label) => `<span class="tag">${esc(label)}</span>`).join("")}
            ${issue.reviewCount ? `<span class="pill">${issue.reviewCount} review${issue.reviewCount === 1 ? "" : "s"}</span>` : ""}
            ${pendingApproval ? `<span class="pill red">approval pending</span>` : ""}
          </div>
        </div>

        ${issue.blockedReason ? `<div class="card" style="margin-top:14px;border-color:rgba(255,123,114,.32);background:rgba(255,123,114,.04)">
          <div class="row" style="gap:8px;color:#ff9d95;font-size:12.5px">${icon("shield", "nav-icon")}<b>Blocked</b><span style="color:var(--text-2)">${esc(issue.blockedReason)}</span></div>
        </div>` : ""}

        <div class="card" style="margin-top:14px">
          <div class="row-between" style="margin-bottom:10px">
            <div class="card-title" style="margin:0">Brief</div>
            <button class="btn sm ghost" data-action="edit-brief">${icon("settings", "nav-icon")} Edit</button>
          </div>
          <div class="prose">${issue.description ? md(issue.description) : `<span class="dim">No description yet.</span>`}</div>
          ${
            (issue.acceptance ?? []).length
              ? `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
                  <div class="card-title">Definition of done</div>
                  <div class="stack" style="gap:5px">
                    ${issue.acceptance
                      .map(
                        (item) => `<div class="row" style="gap:7px;font-size:12.4px;color:var(--text-2)">
                          <span style="color:${issue.status === "done" ? "var(--accent)" : "var(--dim)"}">${icon("check", "nav-icon")}</span>${esc(item)}
                        </div>`,
                      )
                      .join("")}
                  </div>
                </div>`
              : ""
          }
        </div>

        <div class="row-between" style="margin-top:18px;margin-bottom:10px">
          <div class="tabs" style="margin:0;border:0;gap:4px">
            ${[
              ["discussion", `Discussion (${comments.length})`],
              ["runs", `Runs (${runs.length})`],
              ["artifacts", `Artifacts (${artifacts.length})`],
            ]
              .map(([key, label]) => `<button class="tab ${tab === key ? "on" : ""}" data-tab="${key}">${esc(label)}</button>`)
              .join("")}
          </div>
          <button class="btn primary" data-action="run" ${issue.status === "done" || issue.status === "cancelled" ? "disabled" : ""}>
            ${icon("play", "nav-icon")} ${issue.status === "in_progress" ? "Re-run" : "Run issue"}
          </button>
        </div>

        <div class="live-output" id="live-output" hidden></div>
        <div id="live-steps" class="card" style="margin-top:10px" hidden></div>

        ${
          tab === "discussion"
            ? `<div class="thread" id="thread">${comments.map((comment) => commentCard(comment, company)).join("") || `<div class="hint">No comments yet — run the issue or start the thread.</div>`}</div>
              <div class="card" style="margin-top:12px">
                <div class="field"><textarea class="textarea" id="comment-box" placeholder="Reply, add context, or push back…" style="min-height:76px"></textarea></div>
                <div class="row-between" style="margin-top:9px">
                  <span class="hint">Comments are visible to every agent in the next run's context.</span>
                  <button class="btn" data-action="comment">Comment</button>
                </div>
              </div>`
            : tab === "runs"
              ? `<div class="stack">${
                  runs
                    .map(
                      (run) => `<div class="card">
                        <div class="row-between" style="margin-bottom:10px">
                          <div class="row" style="gap:7px">
                            <span class="pill ${run.status === "succeeded" ? "green" : run.status === "running" ? "blue" : "red"}"><span class="dot"></span>${esc(run.status)}</span>
                            <span class="pill mono">${esc(run.kind)}</span>
                            ${run.simulated ? `<span class="pill mono">simulated</span>` : ""}
                          </div>
                          <span class="hint">${dateTime(run.startedAt)}</span>
                        </div>
                        ${run.output ? `<div class="prose" style="max-height:220px;overflow:hidden;position:relative">${md(run.output)}</div>` : ""}
                        ${run.error ? `<div class="hint" style="color:var(--red)">${esc(run.error)}</div>` : ""}
                        <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">${runTrace(run, { showHeader: false })}</div>
                        <div class="row" style="gap:14px;margin-top:10px;font-size:10.5px;color:var(--dim)">
                          <span>${money(run.costCents ?? 0, { precise: true })}</span>
                          <span>${num(run.usage?.prompt_tokens ?? 0)} in / ${num(run.usage?.completion_tokens ?? 0)} out</span>
                          ${run.review ? `<span>verdict: ${esc(run.review.verdict)} (${run.review.score})</span>` : ""}
                        </div>
                      </div>`,
                    )
                    .join("") || `<div class="hint">No runs yet.</div>`
                }</div>`
              : `<div class="tile-grid">${
                  artifacts
                    .map(
                      (artifact) => `<div class="tile" data-artifact="${esc(artifact.id)}">
                        <div class="row" style="gap:7px">${icon(artifact.kind === "image" ? "image" : "knowledge", "nav-icon")}<h3>${esc(artifact.title)}</h3></div>
                        <p>${artifact.kind === "image" ? "Generated image artifact" : esc((artifact.body ?? "").slice(0, 150))}${(artifact.body ?? "").length > 150 ? "…" : ""}</p>
                        <div class="tile-foot"><span class="tag">${esc(artifact.kind)}</span><span class="tag">${ago(artifact.createdAt)}</span></div>
                      </div>`,
                    )
                    .join("") || `<div class="hint">No artifacts yet. Runs save deliverables here.</div>`
                }</div>`
        }
      </div>

      <aside class="side-panel">
        <div class="card">
          <div class="card-title">Properties</div>
          <div class="field" style="margin-bottom:9px">
            <label>Status</label>
            <select class="select" id="status-select">
              ${["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"]
                .map((status) => `<option value="${status}" ${issue.status === status ? "selected" : ""}>${status.replace("_", " ")}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field" style="margin-bottom:9px">
            <label>Priority</label>
            <select class="select" id="priority-select">
              ${["urgent", "high", "medium", "low"]
                .map((priority) => `<option value="${priority}" ${issue.priority === priority ? "selected" : ""}>${priority}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field" style="margin-bottom:9px">
            <label>Assignee</label>
            <select class="select" id="assignee-select">
              <option value="">Unassigned</option>
              ${company.agents
                .map((agent) => `<option value="${esc(agent.id)}" ${issue.assigneeId === agent.id ? "selected" : ""}>${esc(agent.name)} · ${esc(agent.title)}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label>Project</label>
            <select class="select" id="project-select">
              <option value="">No project</option>
              ${company.projects
                .map((project) => `<option value="${esc(project.id)}" ${issue.projectId === project.id ? "selected" : ""}>${esc(project.name)}</option>`)
                .join("")}
            </select>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Run</div>
          <div class="kv"><span class="k">Owner</span><span class="v">${issue.assignee ? `${avatar(issue.assignee, "sm")} ${esc(issue.assignee.name)}` : "—"}</span></div>
          <div class="kv"><span class="k">Model</span><span class="v mono" style="font-size:10.5px">${esc(issue.assignee?.model?.split("/").pop() ?? "—")}</span></div>
          <div class="kv"><span class="k">Spend on issue</span><span class="v">${money(issue.spendCents ?? 0, { precise: true })}</span></div>
          <div class="kv"><span class="k">Runs</span><span class="v">${runs.length}</span></div>
          <div class="kv"><span class="k">Reviews</span><span class="v">${issue.reviewCount ?? 0}</span></div>
          <div class="kv"><span class="k">Last update</span><span class="v">${ago(issue.updatedAt)}</span></div>
        </div>

        ${
          pendingApproval
            ? `<div class="card" style="border-color:rgba(255,123,114,.32)">
                <div class="card-title" style="color:#ff9d95">Approval needed</div>
                <div style="font-size:12.5px;color:var(--text-2);margin-bottom:6px">${esc(pendingApproval.action)}</div>
                <div class="hint" style="margin-bottom:10px">${esc(pendingApproval.reason)}</div>
                <div class="row" style="gap:6px">
                  <button class="btn primary sm grow" data-action="approve" data-approval="${esc(pendingApproval.id)}">Approve</button>
                  <button class="btn danger sm grow" data-action="deny" data-approval="${esc(pendingApproval.id)}">Deny</button>
                </div>
              </div>`
            : ""
        }

        <div class="card">
          <div class="card-title">Actions</div>
          <div class="stack" style="gap:6px">
            <button class="btn sm block" data-action="chat">${icon("agents", "nav-icon")} Ask the assignee</button>
            <button class="btn sm block" data-action="copy">${icon("knowledge", "nav-icon")} Copy link</button>
            <button class="btn sm block danger" data-action="delete">${icon("x", "nav-icon")} Delete issue</button>
          </div>
        </div>
      </aside>
    </div>
  `;

  /* ------------------------------------------------------------ interactions */

  const patch = async (body) => {
    try {
      await api(`/api/companies/${ctx.companyId}/issues/${issue.id}`, { method: "PATCH", body });
      await ctx.refresh(true);
      toast("Issue updated");
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  };

  root.querySelector("#status-select")?.addEventListener("change", (event) => patch({ status: event.target.value }));
  root.querySelector("#priority-select")?.addEventListener("change", (event) => patch({ priority: event.target.value }));
  root.querySelector("#assignee-select")?.addEventListener("change", (event) => patch({ assigneeId: event.target.value }));
  root.querySelector("#project-select")?.addEventListener("change", (event) => patch({ projectId: event.target.value }));

  root.querySelectorAll("[data-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
      next.set("tab", button.dataset.tab);
      location.hash = `/issues/${issue.id}?${next}`;
    }),
  );

  root.querySelector('[data-action="comment"]')?.addEventListener("click", async () => {
    const box = root.querySelector("#comment-box");
    const body = box?.value.trim();
    if (!body) return;
    box.disabled = true;
    try {
      await api(`/api/companies/${ctx.companyId}/issues/${issue.id}/comments`, { method: "POST", body: { body } });
      await ctx.refresh(true);
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
      box.disabled = false;
    }
  });

  const decide = async (approvalId, decision) => {
    try {
      await api(`/api/companies/${ctx.companyId}/approvals/${approvalId}/decide`, { method: "POST", body: { decision, by: "you" } });
      await ctx.refresh(true);
      toast(decision === "approve" ? "Approved — issue released" : "Denied");
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  };
  root.querySelector('[data-action="approve"]')?.addEventListener("click", (event) => decide(event.currentTarget.dataset.approval, "approve"));
  root.querySelector('[data-action="deny"]')?.addEventListener("click", (event) => decide(event.currentTarget.dataset.approval, "deny"));

  root.querySelector('[data-action="copy"]')?.addEventListener("click", () => copy(`${location.origin}/#/issues/${issue.id}`));

  root.querySelector('[data-action="chat"]')?.addEventListener("click", () => {
    if (!issue.assigneeId) {
      toast("Assign an agent first", "warn");
      return;
    }
    ctx.navigate(`/agents/${issue.assigneeId}?issue=${issue.id}&tab=chat`);
  });

  root.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
    const ok = await import("../lib.js").then((lib) =>
      lib.confirmDialog({ title: `Delete ${issue.key}?`, message: "The issue, its comments and artifacts are removed. This cannot be undone.", confirmLabel: "Delete issue", danger: true }),
    );
    if (!ok) return;
    await api(`/api/companies/${ctx.companyId}/issues/${issue.id}`, { method: "DELETE" });
    await ctx.refresh(true);
    ctx.navigate("/issues");
  });

  root.querySelector('[data-action="edit-brief"]')?.addEventListener("click", () => {
    const lib = window.__lib;
    import("../lib.js").then(({ modal }) => {
      modal({
        title: `Edit ${issue.key}`,
        wide: true,
        body: `
          <div class="field"><label>Title</label><input class="input" name="title" value="${esc(issue.title)}" /></div>
          <div class="field"><label>Brief</label><textarea class="textarea" name="description" style="min-height:180px">${esc(issue.description)}</textarea></div>
          <div class="field"><label>Definition of done (one per line)</label><textarea class="textarea" name="acceptance">${esc((issue.acceptance ?? []).join("\n"))}</textarea></div>`,
        submitLabel: "Save",
        async onSubmit(data) {
          await api(`/api/companies/${ctx.companyId}/issues/${issue.id}`, {
            method: "PATCH",
            body: {
              title: data.title,
              description: data.description,
              acceptance: String(data.acceptance ?? "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            },
          });
          await ctx.refresh(true);
          render(root, ctx);
        },
      });
    });
  });

  /* ------------------------------------------------------------------- run */

  const liveOutput = root.querySelector("#live-output");
  const liveSteps = root.querySelector("#live-steps");
  let runText = "";
  let steps = [];

  const paint = () => {
    if (!liveOutput) return;
    liveOutput.hidden = false;
    liveOutput.innerHTML = md(runText) || '<span class="blink">▍</span>';
    liveOutput.scrollTop = liveOutput.scrollHeight;
    if (liveSteps) {
      liveSteps.hidden = steps.length === 0;
      liveSteps.innerHTML = `<div class="card-title">Live trace</div><div class="trace">${steps
        .map(
          (step, index) => `<div class="trace-step"><span class="trace-index">${index + 1}</span><div class="grow"><div class="trace-label">${esc(step.label)}</div>${step.detail ? `<div class="trace-detail">${esc(step.detail)}</div>` : ""}</div></div>`,
        )
        .join("")}</div>`;
    }
  };

  const unsubscribe = ctx.subscribe((event) => {
    if (event.type === "run.step" && event.payload?.issueId === issue.id) {
      steps = [...steps, event.payload];
      paint();
    }
  });

  root.querySelector('[data-action="run"]')?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    button.innerHTML = `<span class="blink">▍</span> Running…`;
    runText = "";
    steps = [];
    paint();
    try {
      const result = await stream(`/api/companies/${ctx.companyId}/issues/${issue.id}/run?stream=1`, {}, {
        onDelta: (chunk) => {
          runText += chunk;
          paint();
        },
        onEvent: (type, payload) => {
          if (type === "done" && payload?.blocked) runText += `\n\n_Blocked: ${payload.reason ?? "needs a human"}_`;
        },
      });
      await ctx.refresh(true);
      if (result?.blocked) {
        toast(result.reason ?? "Run blocked", "warn");
      } else if (result?.verdict?.verdict) {
        toast(`Run finished · ${result.verdict.verdict}${result.verdict.score ? ` (${result.verdict.score})` : ""}`);
      } else {
        toast("Run finished");
      }
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.innerHTML = `${icon("play", "nav-icon")} Run issue`;
    }
  });

  root.querySelectorAll("[data-artifact]").forEach((tile) =>
    tile.addEventListener("click", () => {
      const artifact = artifacts.find((entry) => entry.id === tile.dataset.artifact);
      if (!artifact) return;
      openDrawer({
        title: artifact.title,
        subtitle: `${artifact.kind} · ${ago(artifact.createdAt)}`,
        body:
          artifact.kind === "image"
            ? `<img class="result-img" src="${esc(artifact.dataUri)}" alt="${esc(artifact.title)}" />`
            : `<div class="prose">${md(artifact.body)}</div>`,
      });
    }),
  );

  return () => {
    unsubscribe?.();
  };
}

function truncate(text, length) {
  const value = String(text ?? "");
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
