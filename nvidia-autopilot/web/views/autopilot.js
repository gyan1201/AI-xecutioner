import { api, debounce, esc, fmt, md, reportError, riskBadge, statusBadge, toast, watchRun } from "../lib.js";

const TERMINAL = new Set(["completed", "completed_with_issues", "failed", "cancelled", "blocked"]);

export async function render(el, ctx, params) {
  const runId = params?.[0];
  if (runId) return renderDetail(el, ctx, runId);
  return renderList(el, ctx);
}

/* ---------------------------------- list ---------------------------------- */

async function renderList(el, ctx) {
  const { runs } = await api.get("/api/autopilot");
  const groups = [
    { key: "active", label: "Active", test: (run) => !TERMINAL.has(run.status) },
    { key: "done", label: "Finished", test: (run) => TERMINAL.has(run.status) },
  ];

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-4)">
      <div>
        <h1 style="font-size:26px">Autopilot runs</h1>
        <p class="muted small" style="margin-top:6px">Every goal becomes a plan, a set of reviewed deliverables and an executive report.</p>
      </div>
      <a class="btn btn-primary" href="#/">New run →</a>
    </div>
    ${
      runs.length
        ? groups
            .map((group) => {
              const subset = runs.filter(group.test);
              if (!subset.length) return "";
              return `
                <div class="card" style="margin-bottom:var(--space-4)">
                  <div class="card-head"><span class="card-title">${esc(group.label)} · ${subset.length}</span></div>
                  <div class="table-wrap"><table>
                    <thead><tr><th>Goal</th><th>Status</th><th>Tasks</th><th class="num">Tokens</th><th class="num">Created</th><th></th></tr></thead>
                    <tbody>
                      ${subset
                        .map(
                          (run) => `<tr>
                            <td><a href="#/autopilot/${esc(run.id)}">${esc(run.goal).slice(0, 110)}${run.goal.length > 110 ? "…" : ""}</a>
                              <div class="tiny faint">${esc(run.company ?? "no company")}${run.simulated ? " · simulated" : ""}</div></td>
                            <td>${statusBadge(run.status)}</td>
                            <td class="mono">${run.completedTasks}/${run.taskCount}</td>
                            <td class="num">${fmt.tokens(run.usage?.totalTokens)}</td>
                            <td class="num faint">${fmt.ago(run.createdAt)}</td>
                            <td><a class="btn btn-sm btn-ghost" href="#/autopilot/${esc(run.id)}">Open</a></td>
                          </tr>`,
                        )
                        .join("")}
                    </tbody>
                  </table></div>
                </div>`;
            })
            .join("")
        : `<div class="empty"><h3>No runs yet</h3><p>Start on <a href="#/">mission control</a>: give one goal and the team takes it from there.</p></div>`
    }
  `;
}

/* --------------------------------- detail --------------------------------- */

async function renderDetail(el, ctx, runId) {
  let detail;
  try {
    detail = await api.get(`/api/autopilot/${runId}`);
  } catch (error) {
    reportError(error);
    el.innerHTML = `<div class="empty"><h3>Run not found</h3><p>${esc(error.message)}</p><a class="btn" href="#/autopilot">Back to runs</a></div>`;
    return;
  }

  let run = detail.run;
  let artifacts = detail.artifacts ?? [];
  const timeline = [...(detail.events ?? [])];
  let stopStream = null;
  let follow = true;
  let closed = false;

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-3)">
      <a class="small" href="#/autopilot">← All runs</a>
      <div class="row">
        <button class="btn btn-sm" id="refresh">Refresh</button>
        <button class="btn btn-sm btn-ghost" id="copy-link">Copy link</button>
      </div>
    </div>
    <div id="run-root"></div>
  `;
  const root = el.querySelector("#run-root");

  function paint() {
    const config = ctx.state.status?.config;
    const done = run.tasks.filter((task) => task.status === "done").length;
    const pct = run.tasks.length ? Math.round((done / run.tasks.length) * 100) : 0;
    const active = !TERMINAL.has(run.status);
    root.innerHTML = `
      <section class="card" style="border-color:var(--line-strong)">
        <div class="spread row-wrap" style="align-items:flex-start">
          <div style="min-width:260px;flex:1">
            <div class="row-wrap" style="margin-bottom:8px">
              ${statusBadge(run.status)}
              ${run.simulated ? '<span class="badge badge-amber">simulated</span>' : '<span class="badge badge-green">live NIM</span>'}
              <span class="pill">${esc(run.company ?? "no company")}</span>
              ${run.options?.requireApproval !== "never" ? `<span class="pill" title="Approval policy">approval: ${esc(run.options?.requireApproval)}</span>` : ""}
            </div>
            <h1 style="font-size:24px;max-width:46ch">${esc(run.goal)}</h1>
            <div class="row-wrap tiny faint" style="margin-top:10px">
              <span class="mono">${esc(run.id)}</span>
              <span>· created ${fmt.date(run.createdAt)}</span>
              <span>· ${fmt.duration(run.createdAt, run.finishedAt)}</span>
              <span>· ${run.usage?.calls ?? 0} model calls</span>
              <span>· ${fmt.tokens(run.usage?.totalTokens)} tokens</span>
              ${run.usage?.estimatedCostUsd != null ? `<span>· ${fmt.money(run.usage.estimatedCostUsd)} est.</span>` : ""}
            </div>
          </div>
          <div class="row-wrap">
            ${active && run.status !== "awaiting_approval" ? `<button class="btn btn-sm" id="pause">${run.status === "paused" ? "Resume" : "Pause"}</button>` : ""}
            ${active ? `<button class="btn btn-sm btn-danger" id="cancel">Cancel</button>` : ""}
            ${TERMINAL.has(run.status) ? `<button class="btn btn-sm btn-danger" id="delete">Delete</button>` : ""}
          </div>
        </div>
        <div style="margin-top:var(--space-4)">
          <div class="spread tiny faint" style="margin-bottom:6px"><span>${done} of ${run.tasks.length} work items complete</span><span class="mono">${pct}%</span></div>
          <div class="progress"><span style="width:${pct}%"></span></div>
        </div>
      </section>

      ${renderApprovalBanner(run)}
      ${run.blockedReason ? `<div class="banner" style="margin-top:var(--space-3)"><span>⏸</span><div><strong>Stopped:</strong> ${esc(run.blockedReason)}</div></div>` : ""}
      ${run.error ? `<div class="banner red" style="margin-top:var(--space-3)"><span>✕</span><div><strong>Error:</strong> ${esc(run.error)}</div></div>` : ""}
      ${config?.simulation ? `<div class="banner" style="margin-top:var(--space-3)"><span>◐</span><div><strong>Simulation mode.</strong> Responses are deterministic stand-ins from the local simulator. Add an NVIDIA API key in <a href="#/settings">settings</a> to run this goal on real NIM models.</div></div>` : ""}

      <div class="split" style="margin-top:var(--space-4)">
        <div class="stack">
          ${renderPlan(run)}
          <div class="card">
            <div class="card-head"><span class="card-title">Work items</span><span class="badge badge-dim">${run.tasks.length}</span></div>
            <div class="stack">${run.tasks.map((task) => renderTask(task)).join("") || '<div class="empty">The plan has not been produced yet.</div>'}</div>
          </div>
          ${renderReport(run, artifacts)}
        </div>
        <div class="side-stack">
          <div class="card">
            <div class="card-head">
              <span class="card-title">Live timeline</span>
              <label class="check tiny"><input type="checkbox" id="follow" ${follow ? "checked" : ""}/> follow</label>
            </div>
            <div class="timeline" id="timeline">${renderTimeline(timeline.slice(-160))}</div>
          </div>
          ${renderArtifacts(artifacts, run)}
          ${renderRouting(run)}
        </div>
      </div>
    `;
    bind();
  }

  function renderApprovalBanner(current) {
    if (current.status !== "awaiting_approval" || !current.pendingApproval) return "";
    const request = current.pendingApproval;
    return `
      <div class="banner" style="margin-top:var(--space-3);border-color:rgba(251,191,36,.5)">
        <span>⚑</span>
        <div style="flex:1">
          <strong>Human decision required.</strong>
          <div style="margin:4px 0 6px">${esc(request.question)}</div>
          ${request.whyBlocked ? `<div class="small" style="opacity:.85">${esc(request.whyBlocked)}</div>` : ""}
          ${request.options?.length ? `<div class="chips" style="margin-top:8px">${request.options.map((option) => `<span class="chip">${esc(option)}</span>`).join("")}</div>` : ""}
          <div class="row-wrap" style="margin-top:10px">
            <input id="approval-note" placeholder="Decision note (optional)" style="max-width:280px" />
            <button class="btn btn-primary btn-sm" id="approve">Approve</button>
            <button class="btn btn-danger btn-sm" id="reject">Reject</button>
          </div>
        </div>
      </div>`;
  }

  function renderPlan(current) {
    if (!current.plan) return "";
    const plan = current.plan;
    return `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Plan</span>
          <span class="badge badge-dim">${plan.parsed ? "model-generated" : "fallback"}</span>
        </div>
        <p><strong>${esc(plan.objective)}</strong></p>
        <p class="small muted">${esc(plan.summary ?? "")}</p>
        ${
          plan.kpis?.length
            ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>KPI</th><th>Target</th><th>Measure</th></tr></thead><tbody>
                ${plan.kpis.map((kpi) => `<tr><td>${esc(kpi.name)}</td><td class="mono">${esc(kpi.target)}</td><td class="small faint">${esc(kpi.measure ?? "—")}</td></tr>`).join("")}
              </tbody></table></div>`
            : ""
        }
        ${
          plan.assumptions?.length
            ? `<div style="margin-top:12px"><div class="tiny uppercase faint">Assumptions</div><ul class="small muted" style="margin:6px 0 0;padding-left:18px">${plan.assumptions.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>`
            : ""
        }
        ${plan.successCriteria ? `<div class="small" style="margin-top:12px"><span class="faint">Success: </span>${esc(plan.successCriteria)}</div>` : ""}
      </div>`;
  }

  function renderTask(task) {
    const output = task.output ?? task.blockedReason ?? task.error ?? "";
    return `
      <article class="task ${esc(task.status)}">
        <div class="task-head">
          <span class="task-id">${esc(task.id)}</span>
          <div style="flex:1;min-width:0">
            <div class="task-title">${esc(task.title)}</div>
            <div class="task-meta">
              <span class="pill">${esc(task.owner)}</span>
              ${riskBadge(task.risk)}
              <span class="badge badge-dim">${esc(task.effort ?? "M")} effort</span>
              ${statusBadge(task.status)}
              ${task.critique?.score != null ? `<span class="badge ${task.critique.verdict === "pass" ? "badge-green" : "badge-amber"}">review ${task.critique.score}/100</span>` : ""}
              ${task.dependsOn?.length ? `<span class="tiny faint">after ${esc(task.dependsOn.join(", "))}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="small faint">Done when: ${esc(task.doneWhen)}</div>
        ${output ? `<div class="task-output md">${md(output.slice(0, 2200))}</div>` : ""}
        ${
          task.critique?.requiredChanges?.length
            ? `<div class="small"><span class="faint">Reviewer asked for:</span> ${esc(task.critique.requiredChanges.join(" · "))}</div>`
            : ""
        }
        ${
          task.artifacts?.length
            ? `<div class="chips">${task.artifacts.map((name) => `<a class="chip" href="/api/autopilot/${esc(run.id)}/artifacts/${encodeURIComponent(name)}" target="_blank">${esc(name)}</a>`).join("")}</div>`
            : ""
        }
      </article>`;
  }

  function renderReport(current, files) {
    if (!current.report?.markdown) return "";
    return `
      <div class="card">
        <div class="card-head">
          <span class="card-title">Executive report</span>
          <div class="row">
            <button class="btn btn-sm btn-ghost" id="copy-report">Copy</button>
            <a class="btn btn-sm btn-ghost" href="/api/autopilot/${esc(run.id)}/artifacts/${encodeURIComponent(current.report.artifact)}" target="_blank">Raw</a>
          </div>
        </div>
        <div class="md" id="report-md">${md(current.report.markdown)}</div>
      </div>`;
  }

  function renderArtifacts(files, current) {
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Artifacts</span><span class="badge badge-dim">${files.length}</span></div>
        ${
          files.length
            ? `<div class="artifacts">${files
                .map(
                  (file) => `<a class="artifact" href="/api/autopilot/${esc(current.id)}/artifacts/${encodeURIComponent(file.name)}" target="_blank">
                    <span class="name">${esc(file.name)}</span>
                    <span class="meta">${fmt.bytes(file.bytes)}</span>
                  </a>`,
                )
                .join("")}</div>`
            : `<p class="small faint">Deliverables appear here as agents save them.</p>`
        }
      </div>`;
  }

  function renderRouting(current) {
    const entries = Object.entries(current.routing ?? {});
    if (!entries.length) return "";
    return `
      <div class="card">
        <div class="card-head"><span class="card-title">Model routing</span></div>
        <dl class="kv">
          ${entries
            .map(
              ([role, entry]) =>
                `<dt>${esc(entry.label ?? role)}</dt><dd class="mono tiny">${esc(String(entry.model).split("/").pop())}${entry.resolvedFrom === "operator" ? ' <span class="badge badge-violet">pinned</span>' : ""}</dd>`,
            )
            .join("")}
        </dl>
      </div>`;
  }

  function renderTimeline(events) {
    if (!events.length) return `<div class="small faint">Waiting for the first event…</div>`;
    return events
      .slice()
      .reverse()
      .map((event) => {
        const view = eventView(event);
        if (!view) return "";
        return `<div class="tl-row ${view.tone}">
          <span class="tl-time">${fmt.time(event.at)}</span>
          <span class="tl-marker"><span class="tl-dot"></span></span>
          <span class="tl-body">${view.text}${view.detail ? `<span class="detail">${esc(view.detail)}</span>` : ""}</span>
        </div>`;
      })
      .join("");
  }

  function bind() {
    const pause = root.querySelector("#pause");
    pause?.addEventListener("click", async () => {
      try {
        const action = run.status === "paused" ? "resume" : "pause";
        await api.post(`/api/autopilot/${run.id}/${action}`, {});
        toast(action === "pause" ? "Pause requested" : "Resumed");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    root.querySelector("#cancel")?.addEventListener("click", async () => {
      if (!confirm("Cancel this run? In-flight model calls are aborted.")) return;
      try {
        await api.post(`/api/autopilot/${run.id}/cancel`, {});
        toast("Run cancelled");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    root.querySelector("#delete")?.addEventListener("click", async () => {
      if (!confirm("Delete this run and its artifacts?")) return;
      try {
        await api.del(`/api/autopilot/${run.id}`);
        ctx.navigate("/autopilot");
      } catch (error) {
        reportError(error);
      }
    });

    const decide = async (approved) => {
      const note = root.querySelector("#approval-note")?.value?.trim() ?? "";
      try {
        await api.post(`/api/autopilot/${run.id}/approve`, { approved, note });
        toast(approved ? "Approved" : "Rejected");
        await load();
      } catch (error) {
        reportError(error);
      }
    };
    root.querySelector("#approve")?.addEventListener("click", () => decide(true));
    root.querySelector("#reject")?.addEventListener("click", () => decide(false));

    root.querySelector("#copy-report")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(run.report?.markdown ?? "");
        toast("Report copied");
      } catch {
        toast("Clipboard unavailable", "warn");
      }
    });

    root.querySelector("#follow")?.addEventListener("change", (event) => {
      follow = event.target.checked;
      if (follow) scrollTimeline();
    });
    scrollTimeline();
  }

  function scrollTimeline() {
    if (!follow) return;
    const node = el.querySelector("#timeline");
    if (node) node.scrollTop = 0;
  }

  const reload = debounce(async () => {
    await load();
  }, 350);

  async function load() {
    if (closed) return;
    try {
      const next = await api.get(`/api/autopilot/${runId}`);
      run = next.run;
      artifacts = next.artifacts ?? [];
      timeline.length = 0;
      timeline.push(...(next.events ?? []));
      paint();
    } catch (error) {
      if (error.status === 404) {
        toast("This run was deleted", "warn");
        stopStream?.();
        ctx.navigate("/autopilot");
      }
    }
  }

  paint();

  el.querySelector("#refresh").addEventListener("click", () => load());
  el.querySelector("#copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied");
    } catch {
      toast("Clipboard unavailable", "warn");
    }
  });

  stopStream = watchRun(runId, {
    onEvent(event) {
      if (closed) return;
      const known = timeline.some((entry) => entry.seq === event.seq);
      if (!known) timeline.push(event);
      const timelineNode = el.querySelector("#timeline");
      if (timelineNode && event.seq) {
        const view = eventView(event);
        if (view) {
          const row = document.createElement("div");
          row.className = `tl-row ${view.tone}`;
          row.innerHTML = `<span class="tl-time">${fmt.time(event.at)}</span><span class="tl-marker"><span class="tl-dot"></span></span><span class="tl-body">${view.text}${view.detail ? `<span class="detail">${esc(view.detail)}</span>` : ""}</span>`;
          timelineNode.prepend(row);
        }
        scrollTimeline();
      }
      if (/^(task\.|plan\.|run\.|report\.|approval\.)/.test(event.type)) reload();
    },
    onState(next) {
      if (closed || !next) return;
      run = next;
      paint();
    },
  });

  return () => {
    closed = true;
    stopStream?.();
  };
}

/* ------------------------------- event views ------------------------------- */

function eventView(event) {
  const data = event;
  switch (event.type) {
    case "run.created":
      return { tone: "info", text: "<strong>Run created</strong>", detail: `${data.simulated ? "simulation" : "live NIM"} · max ${data.options?.maxSteps ?? "?"} work items` };
    case "phase":
      return { tone: "info", text: `<strong>Phase:</strong> ${esc(data.phase)}${data.model ? ` <span class="mono tiny">${esc(data.model)}</span>` : ""}` };
    case "plan.ready":
      return {
        tone: "ok",
        text: `<strong>Plan ready</strong> · ${data.tasks?.length ?? 0} work items, ${data.kpis?.length ?? 0} KPIs`,
        detail: data.objective ? String(data.objective).slice(0, 160) : "",
      };
    case "task.started":
      return { tone: "info", text: `<strong>${esc(data.taskId)} started</strong> — ${esc(data.title)}`, detail: `${data.owner} · ${data.risk} risk · ${String(data.model ?? "").split("/").pop()}${data.attempts > 1 ? ` · attempt ${data.attempts}` : ""}` };
    case "tool.started":
      return { tone: "info", text: `<strong>Tool:</strong> ${esc(data.tool)}`, detail: JSON.stringify(data.args ?? {}).slice(0, 160) };
    case "tool.completed":
      return { tone: "ok", text: `<strong>${esc(data.tool)}</strong> returned`, detail: `${data.ms ?? 0}ms · ${JSON.stringify(data.result ?? {}).slice(0, 140)}` };
    case "tool.failed":
      return { tone: "warn", text: `<strong>${esc(data.tool)}</strong> failed`, detail: data.error ?? "" };
    case "task.critique":
      return { tone: data.verdict === "pass" ? "ok" : "warn", text: `<strong>Review ${esc(data.taskId)}:</strong> ${esc(data.verdict)}${data.score ? ` · ${data.score}/100` : ""}`, detail: (data.gaps ?? []).join(" · ").slice(0, 200) };
    case "task.revising":
      return { tone: "warn", text: `<strong>${esc(data.taskId)} sent back</strong> for revision ${data.attempt}`, detail: (data.requiredChanges ?? []).join(" · ").slice(0, 200) };
    case "task.completed":
      return { tone: "ok", text: `<strong>${esc(data.taskId)} complete</strong> — ${esc(data.title)}`, detail: `${data.artifacts?.join(", ") ?? ""}${data.score ? ` · score ${data.score}` : ""}` };
    case "task.blocked":
      return { tone: "warn", text: `<strong>${esc(data.taskId)} blocked</strong>`, detail: data.reason ?? "" };
    case "task.failed":
      return { tone: "bad", text: `<strong>${esc(data.taskId)} failed</strong>`, detail: data.error ?? "" };
    case "artifact":
      return { tone: "ok", text: `<strong>Saved</strong> ${esc(data.name)}`, detail: data.bytes ? `${data.bytes} bytes` : "" };
    case "usage":
      return { tone: "info", text: `Usage · ${esc(String(data.model).split("/").pop())}`, detail: `+${data.promptTokens} in / +${data.completionTokens} out` };
    case "guardrail":
      return { tone: data.safe === false ? "bad" : "ok", text: `<strong>Guardrail (${esc(data.scope ?? "output")}):</strong> ${data.safe === false ? "unsafe" : "safe"}`, detail: (data.categories ?? []).filter(Boolean).join(", ") };
    case "approval.requested":
      return { tone: "warn", text: "<strong>Approval requested</strong>", detail: String(data.question ?? "").slice(0, 180) };
    case "approval.resolved":
      return { tone: data.approved ? "ok" : "warn", text: `<strong>Approval ${data.approved ? "granted" : "declined"}</strong>`, detail: data.note ?? "" };
    case "report.ready":
      return { tone: "ok", text: "<strong>Executive report ready</strong>", detail: data.artifact ?? "" };
    case "run.finished":
      return { tone: "ok", text: `<strong>Run ${esc(data.status.replace(/_/g, " "))}</strong>`, detail: `${data.completed}/${data.total} work items · ${fmt.tokens(data.usage?.totalTokens)} tokens` };
    case "run.blocked":
      return { tone: "warn", text: "<strong>Run blocked</strong>", detail: data.reason ?? "" };
    case "run.paused":
      return { tone: "warn", text: "<strong>Run paused</strong>", detail: "Resume from the run header." };
    case "run.pause_requested":
      return { tone: "warn", text: "Pause requested", detail: "Finishing the current model call." };
    case "run.resumed":
      return { tone: "info", text: "Run resumed" };
    case "run.cancelled":
      return { tone: "bad", text: "<strong>Run cancelled</strong>" };
    case "run.failed":
      return { tone: "bad", text: "<strong>Run failed</strong>", detail: data.error ?? "" };
    case "run.awaiting_approval":
      return { tone: "warn", text: "<strong>Waiting for a human decision</strong>", detail: String(data.request?.question ?? "") };
    case "note":
      return { tone: "info", text: esc(data.message ?? "") };
    default:
      return null;
  }
}
