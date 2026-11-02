import { api, ago, autoGrow, avatar, esc, icon, md, money, num, statusPill, stream, toast } from "../lib.js";
import { issueRow, modelPill, pageHeader, runTrace, spendBar } from "./shared.js";

export const title = "Agent";

export async function render(root, ctx) {
  const agentId = ctx.params[0];
  let detail;
  try {
    detail = await api(`/api/companies/${ctx.companyId}/agents/${agentId}`);
  } catch (error) {
    root.innerHTML = `<div class="empty"><h3>Agent not found</h3><p>${esc(error.message)}</p><a class="btn" href="#/agents">Back to roster</a></div>`;
    return;
  }
  const { agent, spend, issues, runs, byDay, skills, model } = detail;
  const company = ctx.company;
  const tab = ctx.query.tab ?? "overview";
  const issueContext = ctx.query.issue ? (company.issues ?? []).find((issue) => issue.id === ctx.query.issue) : null;
  const threadKey = `${agent.id}${issueContext ? `:${issueContext.id}` : ""}`;
  const thread = (company.threads ?? {})[threadKey] ?? [];

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <a class="btn ghost sm" href="#/agents">${icon("agents", "nav-icon")} Roster</a>
      ${issueContext ? `<span class="pill blue">context: ${esc(issueContext.key)} · ${esc(issueContext.title.slice(0, 40))}</span>` : ""}
    </div>

    <div class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="row-between" style="align-items:flex-start;flex-wrap:wrap;gap:14px">
        <div class="row" style="gap:13px">
          ${avatar(agent, "lg")}
          <div>
            <div class="row" style="gap:8px"><h1 class="page-title" style="margin:0">${esc(agent.name)}</h1><span class="status-dot ${agent.status}" title="${esc(agent.status)}"></span></div>
            <div class="hint">${esc(agent.title)} · ${esc(agent.role)} · hired ${ago(agent.createdAt)}</div>
            <div class="row" style="gap:6px;margin-top:6px">${modelPill(agent.model)}<span class="pill">${esc(agent.capabilities.join(" · "))}</span></div>
          </div>
        </div>
        <div class="row" style="gap:7px">
          <button class="btn ghost" data-action="toggle">${agent.status === "paused" ? "Resume" : "Pause"}</button>
          <button class="btn" data-action="chat">${icon("agents", "nav-icon")} Message</button>
          <button class="btn primary" data-action="edit">${icon("settings", "nav-icon")} Configure</button>
        </div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:14px">
        <div><div class="kpi"><b>${money(spend.spentCents, { precise: true })}</b><span>Spent · cap ${money(spend.capCents)}</span></div>${spendBar(spend, { compact: true })}</div>
        <div><div class="kpi"><b>${issues.filter((issue) => issue.status !== "done").length}</b><span>Open issues</span></div></div>
        <div><div class="kpi"><b>${runs.length}</b><span>Recent runs</span></div></div>
        <div><div class="kpi"><b>${skills.length}</b><span>NVIDIA skills</span></div></div>
      </div>
    </div>

    <div class="tabs" style="margin-top:18px">
      ${[
        ["overview", "Overview"],
        ["runs", `Runs (${runs.length})`],
        ["chat", "Chat"],
        ["skills", `Skills (${skills.length})`],
        ["instructions", "Instructions"],
      ]
        .map(([key, label]) => `<button class="tab ${tab === key ? "on" : ""}" data-tab="${key}">${esc(label)}</button>`)
        .join("")}
    </div>

    ${
      tab === "overview"
        ? `<div class="split" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)">
            <div class="stack">
              <div class="card">
                <div class="card-title">Assigned issues</div>
                <table class="table">
                  <tbody>${issues.slice(0, 8).map(issueRow).join("") || `<tr><td class="hint">No issues assigned.</td></tr>`}</tbody>
                </table>
              </div>
              <div class="card">
                <div class="card-title">State</div>
                <div class="kv"><span class="k">Status</span><span class="v">${esc(agent.status)}</span></div>
                <div class="kv"><span class="k">Model</span><span class="v mono" style="font-size:11px">${esc(agent.model)}</span></div>
                <div class="kv"><span class="k">Fallback</span><span class="v mono" style="font-size:11px">${esc(agent.fallbackModel)}</span></div>
                <div class="kv"><span class="k">Temperature</span><span class="v">${agent.temperature}</span></div>
                <div class="kv"><span class="k">Max tokens</span><span class="v">${num(agent.maxTokens)}</span></div>
                <div class="kv"><span class="k">Reports to</span><span class="v">${esc(company.agents.find((entry) => entry.id === agent.reportsTo)?.name ?? "—")}</span></div>
                <div class="kv"><span class="k">Family</span><span class="v">${esc(model?.family ?? "—")}</span></div>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <div class="card-title">Spend · last 14 days</div>
                ${miniBars(byDay)}
                <div class="hint" style="margin-top:6px">${money(byDay.reduce((sum, day) => sum + day.cents, 0))} across ${byDay.length} active days</div>
              </div>
              <div class="card">
                <div class="card-title">Remit</div>
                <div class="prose" style="font-size:12.5px">${md(agent.description || "No remit written.")}</div>
              </div>
            </div>
          </div>`
        : ""
    }

    ${
      tab === "runs"
        ? `<div class="stack">${runs
            .map(
              (run) => `<div class="card">
                <div class="row-between" style="margin-bottom:8px">
                  <div class="row" style="gap:7px">
                    <span class="pill ${run.status === "succeeded" ? "green" : run.status === "running" ? "blue" : "red"}"><span class="dot"></span>${esc(run.status)}</span>
                    <span class="pill mono">${esc(run.kind)}</span>
                    ${run.issueId ? `<a class="pill" href="#/issues/${esc(run.issueId)}">${esc(company.issues.find((issue) => issue.id === run.issueId)?.key ?? "issue")}</a>` : ""}
                  </div>
                  <span class="hint">${ago(run.startedAt)} · ${money(run.costCents ?? 0, { precise: true })} · ${num((run.usage?.prompt_tokens ?? 0) + (run.usage?.completion_tokens ?? 0))} tokens</span>
                </div>
                ${run.output ? `<div class="prose" style="max-height:180px;overflow:hidden">${md(run.output)}</div>` : ""}
                <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Trace · ${run.steps?.length ?? 0} steps</summary><div style="margin-top:8px">${runTrace(run, { showHeader: false })}</div></details>
              </div>`,
            )
            .join("") || `<div class="hint">No runs yet. Assign an issue and run it.</div>`}</div>`
        : ""
    }

    ${
      tab === "chat"
        ? `<div class="chat">
            <div class="chat-log" id="chat-log">
              ${
                thread.length
                  ? thread
                      .map(
                        (message) => `<div class="msg ${message.role === "user" ? "user" : "assistant"}">
                          ${message.role === "user" ? avatar({ name: "You", accent: "var(--chart-8)" }, "sm") : avatar(agent, "sm")}
                          <div class="msg-body">
                            <div class="prose">${md(message.content)}</div>
                            ${message.role === "assistant" ? `<div class="msg-meta">
                              <span>${esc((message.citations ?? []).join(" · ") || "no citations")}</span>
                              ${message.tools?.length ? `<span>tools: ${esc(message.tools.map((tool) => tool.tool).join(", "))}</span>` : ""}
                              ${message.costCents != null ? `<span>${money(message.costCents, { precise: true })}</span>` : ""}
                            </div>` : ""}
                          </div>
                        </div>`,
                      )
                      .join("")
                  : `<div class="msg assistant">${avatar(agent, "sm")}<div class="msg-body"><div class="prose">
                      <p><b>${esc(agent.name)}</b> — ${esc(agent.title)}. Model <code>${esc(agent.model)}</code>.</p>
                      <p>Ask about the board, a specific issue, or what this agent would do next. Answers are grounded in company knowledge with the embedding + rerank NIMs.</p>
                    </div></div></div>`
              }
            </div>
            <div class="chat-input">
              <textarea class="textarea" id="chat-text" placeholder="Message ${esc(agent.name)}…  (⌘↵ to send)"></textarea>
              <div class="chat-hint">
                <span>${issueContext ? `Context: ${esc(issueContext.key)}` : "No issue context"} · ${esc(agent.model.split("/").pop())}</span>
                <div class="row" style="gap:6px">
                  <button class="btn sm ghost" data-action="clear-chat">New thread</button>
                  <button class="btn sm primary" data-action="send">Send</button>
                </div>
              </div>
            </div>
          </div>`
        : ""
    }

    ${
      tab === "skills"
        ? `<div class="split">
            <div class="card">
              <div class="row-between" style="margin-bottom:10px"><div class="card-title" style="margin:0">Assigned skills</div><span class="pill">${skills.length}/12</span></div>
              <div class="stack" id="skill-list">
                ${
                  skills.length
                    ? skills
                        .map(
                          (skill) => `<div class="row" style="gap:9px;align-items:flex-start;border:1px solid var(--border);border-radius:8px;padding:9px 10px">
                            <div class="grow">
                              <div style="font-size:12.6px;font-weight:500">${esc(skill.title)}</div>
                              <div class="hint" style="margin-top:2px">${esc(skill.description.slice(0, 170))}${skill.description.length > 170 ? "…" : ""}</div>
                              <div class="row" style="gap:4px;margin-top:6px"><span class="tag on">${esc(skill.category)}</span>${skill.tags.slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</div>
                            </div>
                            <button class="btn sm ghost" data-remove-skill="${esc(skill.id)}">Remove</button>
                          </div>`,
                        )
                        .join("")
                    : `<div class="hint">No skills yet. Assigned skills are appended to this agent's system prompt and named in the run trace.</div>`
                }
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <div class="card-title">Suggest for this remit</div>
                <div class="stack" id="suggestions"><div class="hint">Finding skills that match this agent's remit…</div></div>
              </div>
              <div class="card">
                <div class="card-title">Browse the catalog</div>
                <p class="hint">All ${num(ctx.state.bootstrap?.skills?.count ?? 0)} NVIDIA skills are available. Search by capability, library or domain.</p>
                <a class="btn sm block" href="#/skills">Open skills catalog →</a>
              </div>
            </div>
          </div>`
        : ""
    }

    ${
      tab === "instructions"
        ? `<div class="split">
            <div class="card">
              <div class="card-title">Instructions</div>
              <textarea class="textarea" id="instructions" style="min-height:260px;font-size:12.5px">${esc(agent.instructions)}</textarea>
              <div class="row-between" style="margin-top:10px">
                <span class="hint">Sent as the role block on every call.</span>
                <button class="btn primary sm" data-action="save-instructions">Save</button>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <div class="card-title">Runtime</div>
                <div class="field" style="margin-bottom:9px"><label>Model</label><select class="select" id="model-select">${(ctx.state.models ?? [])
                  .filter((entry) => entry.capabilities.includes("chat"))
                  .map((entry) => `<option value="${esc(entry.id)}" ${entry.id === agent.model ? "selected" : ""}>${esc(entry.name)} · ${esc(entry.family)}</option>`)
                  .join("")}</select></div>
                <div class="field" style="margin-bottom:9px"><label>Temperature</label><input class="input" id="temperature" type="number" min="0" max="2" step="0.05" value="${agent.temperature}" /></div>
                <div class="field" style="margin-bottom:9px"><label>Max tokens</label><input class="input" id="max-tokens" type="number" min="128" max="32000" step="64" value="${agent.maxTokens}" /></div>
                <div class="field"><label>Monthly budget (cents)</label><input class="input" id="agent-budget" type="number" min="0" step="50" value="${agent.monthlyBudgetCents}" /></div>
                <button class="btn sm block primary" data-action="save-runtime" style="margin-top:10px">Save runtime</button>
              </div>
            </div>
          </div>`
        : ""
    }
  `;

  /* --------------------------------------------------------------- actions */

  root.querySelectorAll("[data-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
      next.set("tab", button.dataset.tab);
      location.hash = `/agents/${agent.id}?${next}`;
    }),
  );

  root.querySelector('[data-action="toggle"]')?.addEventListener("click", async () => {
    try {
      await api(`/api/companies/${ctx.companyId}/agents/${agent.id}`, {
        method: "PATCH",
        body: { status: agent.status === "paused" ? "active" : "paused" },
      });
      await ctx.refresh(true);
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  });

  root.querySelector('[data-action="chat"]')?.addEventListener("click", () => {
    const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
    next.set("tab", "chat");
    location.hash = `/agents/${agent.id}?${next}`;
  });

  root.querySelector('[data-action="edit"]')?.addEventListener("click", () => {
    const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
    next.set("tab", "instructions");
    location.hash = `/agents/${agent.id}?${next}`;
  });

  root.querySelector('[data-action="save-instructions"]')?.addEventListener("click", async () => {
    const instructions = root.querySelector("#instructions").value;
    await api(`/api/companies/${ctx.companyId}/agents/${agent.id}`, { method: "PATCH", body: { instructions } });
    await ctx.refresh(true);
    toast("Instructions saved");
  });

  root.querySelector('[data-action="save-runtime"]')?.addEventListener("click", async () => {
    try {
      await api(`/api/companies/${ctx.companyId}/agents/${agent.id}`, {
        method: "PATCH",
        body: {
          model: root.querySelector("#model-select").value,
          temperature: Number(root.querySelector("#temperature").value),
          maxTokens: Number(root.querySelector("#max-tokens").value),
          monthlyBudgetCents: Number(root.querySelector("#agent-budget").value),
        },
      });
      await ctx.refresh(true);
      toast("Runtime saved");
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  });

  /* ------------------------------------------------------------------ chat */

  if (tab === "chat") {
    const log = root.querySelector("#chat-log");
    const input = root.querySelector("#chat-text");
    const send = async () => {
      const message = input.value.trim();
      if (!message) return;
      input.value = "";
      autoGrow(input);
      const node = document.createElement("div");
      node.className = "msg user";
      node.innerHTML = `${avatar({ name: "You", accent: "var(--chart-8)" }, "sm")}<div class="msg-body"><div class="prose">${md(message)}</div></div>`;
      log.append(node);
      const reply = document.createElement("div");
      reply.className = "msg assistant";
      reply.innerHTML = `${avatar(agent, "sm")}<div class="msg-body"><div class="prose" id="streaming"></div><div class="msg-meta"><span class="blink">thinking…</span></div></div>`;
      log.append(reply);
      log.scrollTop = log.scrollHeight;
      const target = reply.querySelector("#streaming");
      let text = "";
      try {
        const result = await stream(`/api/companies/${ctx.companyId}/agents/${agent.id}/chat`, { message, issueId: issueContext?.id ?? null }, {
          onDelta: (chunk) => {
            text += chunk;
            target.innerHTML = md(text);
            log.scrollTop = log.scrollHeight;
          },
        });
        target.innerHTML = md(result?.text ?? text);
        reply.querySelector(".msg-meta").innerHTML = `<span>${esc((result?.citations ?? []).map((citation) => citation.title).join(" · ") || "no citations")}</span>${
          result?.tools?.length ? `<span>tools: ${esc(result.tools.map((tool) => tool.tool).join(", "))}</span>` : ""
        }<span>${money(result?.run?.costCents ?? 0, { precise: true })}</span>`;
        await ctx.refresh(true);
      } catch (error) {
        target.innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>`;
      }
    };
    root.querySelector('[data-action="send"]')?.addEventListener("click", send);
    root.querySelector('[data-action="clear-chat"]')?.addEventListener("click", () => {
      const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
      next.delete("issue");
      location.hash = `/agents/${agent.id}?${next}`;
      render(root, ctx);
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
        event.preventDefault();
        send();
      }
    });
    input?.addEventListener("input", () => autoGrow(input));
    input?.focus();
  }

  /* ---------------------------------------------------------------- skills */

  if (tab === "skills") {
    root.querySelectorAll("[data-remove-skill]").forEach((button) =>
      button.addEventListener("click", async () => {
        const remaining = agent.skills.filter((id) => id !== button.dataset.removeSkill);
        await api(`/api/companies/${ctx.companyId}/agents/${agent.id}/skills`, { method: "PUT", body: { skills: remaining } });
        await ctx.refresh(true);
        toast("Skill removed");
        render(root, ctx);
      }),
    );
    try {
      const suggestions = await api(`/api/skills/suggest?q=${encodeURIComponent(`${agent.description} ${agent.title} ${agent.instructions}`)}&limit=6`);
      const host = root.querySelector("#suggestions");
      if (host) {
        host.innerHTML =
          suggestions.skills
            .filter((skill) => !agent.skills.includes(skill.id))
            .map(
              (skill) => `<div class="row" style="gap:8px;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:8px">
                <div class="grow">
                  <div style="font-size:12.3px;font-weight:500">${esc(skill.title)}</div>
                  <div class="hint">${esc(skill.description.slice(0, 130))}</div>
                </div>
                <button class="btn sm" data-add-skill="${esc(skill.id)}">Add</button>
              </div>`,
            )
            .join("") || `<div class="hint">No obvious matches — browse the catalog.</div>`;
        host.querySelectorAll("[data-add-skill]").forEach((button) =>
          button.addEventListener("click", async () => {
            await api(`/api/companies/${ctx.companyId}/agents/${agent.id}/skills`, {
              method: "PUT",
              body: { skills: [...agent.skills, button.dataset.addSkill].slice(0, 12) },
            });
            await ctx.refresh(true);
            toast("Skill assigned");
            render(root, ctx);
          }),
        );
      }
    } catch (error) {
      console.warn(error);
    }
  }
}

function miniBars(byDay) {
  if (!byDay?.length) return `<div class="hint">No spend yet.</div>`;
  const max = Math.max(1, ...byDay.map((day) => day.cents));
  return `<div class="chart" style="height:64px">${byDay
    .map((day) => `<div class="bar green" style="height:${Math.max(3, Math.round((day.cents / max) * 100))}%" title="${day.day}: ${money(day.cents, { precise: true })}"></div>`)
    .join("")}</div>`;
}
