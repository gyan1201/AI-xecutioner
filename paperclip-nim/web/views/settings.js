import { api, copy, esc, icon, money, num, toast } from "../lib.js";
import { pageHeader } from "./shared.js";
import { setupPanel, wireSetup } from "./provider-setup.js";

export const title = "Settings";

export async function render(root, ctx) {
  const [settingsData, config, providerData] = await Promise.all([
    api("/api/settings"),
    Promise.resolve(ctx.state.bootstrap?.config),
    api("/api/providers"),
  ]);
  const company = ctx.company;
  const models = ctx.state.models ?? [];
  const routing = company.settings.defaultModels ?? {};
  const roles = [
    ["strategist", "Strategist", "planning"],
    ["operator", "Operator", "chat"],
    ["analyst", "Analyst", "chat"],
    ["critic", "Critic", "chat"],
    ["embedding", "Embeddings", "embedding"],
    ["rerank", "Rerank", "rerank"],
    ["image", "Image", "image"],
    ["safety", "Guardrails", "safety"],
  ];

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Company",
      title: "Settings",
      subtitle: "Credentials, routing, guardrails and the company's operating rules.",
      actions: "",
    })}

    <div class="split" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">
      <div class="stack">
        <div class="card">
          <div class="row-between" style="margin-bottom:10px">
            <div class="card-title" style="margin:0">NVIDIA NIM connection</div>
            <span class="pill ${config?.mode === "live" ? "green" : "amber"}"><span class="dot"></span>${esc(config?.mode ?? "simulation")}</span>
          </div>
          <div class="field" style="margin-bottom:10px">
            <label>Base URL</label>
            <input class="input" id="base-url" value="${esc(config?.baseUrl ?? "https://integrate.api.nvidia.com/v1")}" />
            <div class="hint">Point this at a self-hosted NIM gateway too — any OpenAI-compatible NIM endpoint works.</div>
          </div>
          <div class="kv"><span class="k">Key</span><span class="v mono">${config?.keyPresent ? esc(config.keyHint) : "none"}</span></div>
          <div class="kv"><span class="k">Key source</span><span class="v">${esc(config?.keySource ?? "none")}</span></div>
          <label class="row" style="gap:8px;margin-top:10px;font-size:12.5px;color:var(--text-2)">
            <input type="checkbox" id="simulation-override" ${config?.simulationOverride ? "checked" : ""} />
            Force simulation even when a key is present
          </label>
          <div class="row" style="gap:7px;margin-top:12px">
            <button class="btn primary sm" data-action="save-connection">Save connection</button>
            <button class="btn sm ghost" data-action="verify">${icon("shield", "nav-icon")} Verify key</button>
          </div>
          <div id="verify-result"></div>
        </div>

        <div class="card">
          <div class="row-between" style="margin-bottom:4px">
            <div class="card-title" style="margin:0">Quick Setup via Code Snippet</div>
            <span class="pill ${providerData.providers.length ? "green" : "amber"}"><span class="dot"></span>${providerData.providers.length ? `${providerData.providers.length} connected` : "not configured"}</span>
          </div>
          <p class="hint" style="margin-bottom:11px">Paste the Python or cURL snippet from NVIDIA NIM, OpenAI or Groq. The provider is detected, the key extracted, the model added and everything configured — no field-by-field setup.</p>
          <div id="provider-setup">
            ${setupPanel({ available: providerData.available, providers: providerData.providers })}
          </div>
        </div>

        <div class="card">
          <div class="card-title">API key database</div>
          <p class="hint" style="margin-bottom:9px">Keys are written to <span class="mono">data/keys.json</span> (mode 0600) and never sent to the browser. Precedence: saved setting → active vault key → <span class="mono">NVIDIA_API_KEY</span>.</p>
          <div class="stack" style="gap:6px">
            ${
              (config?.vault ?? [])
                .map(
                  (key) => `<div class="row-between" style="border:1px solid var(--border);border-radius:7px;padding:8px 10px">
                    <div style="min-width:0">
                      <div class="row" style="gap:6px"><span style="font-size:12.4px">${esc(key.label)}</span>${key.active ? `<span class="pill accent">active</span>` : ""}${key.verified ? `<span class="pill green">verified</span>` : `<span class="pill">unverified</span>`}</div>
                      <div class="hint mono" style="font-size:10.5px">${esc(key.hint)}${key.modelCount ? ` · ${key.modelCount} models` : ""}</div>
                    </div>
                    <div class="row" style="gap:5px">
                      ${key.active ? "" : `<button class="btn sm" data-activate="${esc(key.id)}">Use</button>`}
                      <button class="btn sm ghost" data-remove-key="${esc(key.id)}">Remove</button>
                    </div>
                  </div>`,
                )
                .join("") || `<div class="hint">No keys stored. Add one below or set NVIDIA_API_KEY.</div>`
            }
          </div>
          <div class="field" style="margin-top:11px">
            <label>Add a key</label>
            <textarea class="textarea" id="key-text" style="min-height:66px" placeholder="nvapi-… — paste a bare key, an env line, or a whole curl/SDK snippet"></textarea>
          </div>
          <div class="row" style="gap:7px;margin-top:8px">
            <input class="input" id="key-label" placeholder="Label (optional)" style="max-width:200px" />
            <button class="btn primary sm" data-action="add-key">Add & verify</button>
          </div>
          <div id="key-result"></div>
        </div>

        <div class="card">
          <div class="card-title">Operating rules</div>
          <div class="grid" style="grid-template-columns:1fr 1fr">
            <div class="field"><label>Company name</label><input class="input" id="company-name-input" value="${esc(company.name)}" /></div>
            <div class="field"><label>Approval policy</label><select class="select" id="approval-policy">
              ${["high", "all", "off"].map((value) => `<option value="${value}" ${company.settings.approvalPolicy === value ? "selected" : ""}>${value}</option>`).join("")}
            </select></div>
          </div>
          <div class="field" style="margin-top:9px"><label>Mission</label><textarea class="textarea" id="mission" style="min-height:70px">${esc(company.mission)}</textarea></div>
          <div class="grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:9px">
            <div class="field"><label>Monthly cap (cents)</label><input class="input" type="number" id="monthly-cap" value="${company.settings.monthlyBudgetCents}" min="0" step="100" /></div>
            <div class="field"><label>Cycle minutes</label><input class="input" type="number" id="cycle-minutes" value="${company.settings.cycleMinutes}" min="1" /></div>
            <div class="field"><label>Max cycles</label><input class="input" type="number" id="max-cycles" value="${company.settings.maxCycles}" min="1" /></div>
          </div>
          <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:9px">
            <div class="field"><label>Rework limit</label><input class="input" type="number" id="rework-limit" value="${company.settings.reworkLimit}" min="0" max="5" /></div>
            <div class="field"><label>Auto mode</label>
              <label class="row" style="gap:8px;padding-top:7px;font-size:12.5px;color:var(--text-2)">
                <input type="checkbox" id="auto-mode" ${company.settings.autoMode ? "checked" : ""} /> Run a cycle every ${company.settings.cycleMinutes} minutes
              </label>
            </div>
          </div>
          <div class="chips" style="margin-top:10px">
            <label class="chip ${company.settings.guardrails?.safetyCheck ? "on" : ""}" style="cursor:pointer"><input type="checkbox" id="guardrail-safety" ${company.settings.guardrails?.safetyCheck ? "checked" : ""} style="display:none" /> NeMo Guardrail on input + output</label>
            <span class="chip ${company.settings.guardrails?.redactSecrets ? "on" : ""}">Secret redaction</span>
          </div>
          <button class="btn primary sm" data-action="save-company" style="margin-top:12px">Save rules</button>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-title">Model routing</div>
          <p class="hint" style="margin-bottom:9px">Agents default to these when a role does not pin its own model.</p>
          <div class="stack" style="gap:7px">
            ${roles
              .map(
                ([key, label, capability]) => `<div class="row" style="gap:8px">
                  <span style="width:82px;font-size:11.5px;color:var(--dim)">${esc(label)}</span>
                  <select class="select grow" data-route="${esc(key)}">
                    ${models
                      .filter((model) => model.capabilities.includes(capability))
                      .slice(0, 80)
                      .map((model) => `<option value="${esc(model.id)}" ${routing[key] === model.id ? "selected" : ""}>${esc(model.name)}</option>`)
                      .join("") || `<option value="${esc(routing[key] ?? "")}">${esc(routing[key] ?? "—")}</option>`}
                  </select>
                </div>`,
              )
              .join("")}
          </div>
          <button class="btn sm" data-action="save-routing" style="margin-top:11px">Save routing</button>
        </div>

        <div class="card">
          <div class="card-title">Data</div>
          <div class="kv"><span class="k">Companies</span><span class="v">${ctx.state.bootstrap?.companies.length ?? 0}</span></div>
          <div class="kv"><span class="k">Models in catalog</span><span class="v">${num(ctx.state.models?.length ?? 0)}</span></div>
          <div class="kv"><span class="k">Skills</span><span class="v">${num(ctx.state.bootstrap?.skills?.count ?? 0)}</span></div>
          <div class="kv"><span class="k">Blueprints</span><span class="v">${ctx.state.bootstrap?.blueprints?.count ?? 0}</span></div>
          <div class="kv"><span class="k">Guardrails</span><span class="v">${company.settings.guardrails?.safetyCheck ? "on" : "off"}</span></div>
          <div class="row" style="gap:7px;margin-top:11px;flex-wrap:wrap">
            <button class="btn sm" data-action="export">${icon("external", "nav-icon")} Export company</button>
            <button class="btn sm ghost" data-action="reset">Reset demo data</button>
          </div>
          <div class="hint" style="margin-top:9px">State lives in <span class="mono">data/</span> as JSON + NDJSON. Export is a portable bundle you can re-import with <span class="mono">POST /api/companies/import</span>.</div>
        </div>

        <div class="card">
          <div class="card-title">About</div>
          <div class="prose" style="font-size:12.5px">
            <p><b>Paperclip × NVIDIA NIM</b> — a clone of Paperclip that runs every agent, skill, blueprint and endpoint on NVIDIA NIM.</p>
            <p class="hint">Zero runtime dependencies · Node ≥ 20 · data on disk · no telemetry.</p>
            <div class="row" style="gap:7px;margin-top:8px">
              <a class="btn sm ghost" href="https://build.nvidia.com/models" target="_blank" rel="noreferrer">Models ${icon("external", "nav-icon")}</a>
              <a class="btn sm ghost" href="https://build.nvidia.com/skills" target="_blank" rel="noreferrer">Skills ${icon("external", "nav-icon")}</a>
              <a class="btn sm ghost" href="https://build.nvidia.com/blueprints" target="_blank" rel="noreferrer">Blueprints ${icon("external", "nav-icon")}</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  /* ------------------------------------------------------------- handlers */

  root.querySelector('[data-action="save-connection"]').addEventListener("click", async () => {
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: {
          baseUrl: root.querySelector("#base-url").value,
          simulationOverride: root.querySelector("#simulation-override").checked,
        },
      });
      ctx.state.bootstrap = await api("/api/bootstrap");
      toast("Connection saved");
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  });

  root.querySelector('[data-action="verify"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const target = root.querySelector("#verify-result");
    target.innerHTML = `<div class="hint" style="margin-top:8px">Calling /v1/models…</div>`;
    try {
      const result = await api("/api/keys/verify", { method: "POST", body: {} });
      target.innerHTML = result.ok
        ? `<div class="card tight" style="margin-top:8px"><div class="row" style="gap:7px"><span class="pill green">verified</span><span class="hint">${result.count} models · ${result.latencyMs}ms</span></div></div>`
        : `<div class="card tight" style="margin-top:8px"><div class="row" style="gap:7px"><span class="pill red">failed</span><span class="hint">${esc(result.error)}</span></div></div>`;
    } catch (error) {
      target.innerHTML = `<div class="hint" style="color:var(--red);margin-top:8px">${esc(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector('[data-action="add-key"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const target = root.querySelector("#key-result");
    target.innerHTML = `<div class="hint" style="margin-top:8px">Parsing and verifying against NVIDIA…</div>`;
    try {
      const result = await api("/api/keys", {
        method: "POST",
        body: { text: root.querySelector("#key-text").value, label: root.querySelector("#key-label").value },
      });
      ctx.state.bootstrap = await api("/api/bootstrap");
      target.innerHTML = `<div class="card tight" style="margin-top:8px"><div class="row" style="gap:7px"><span class="pill ${result.verified ? "green" : "amber"}">${result.verified ? "verified" : "stored"}</span><span class="hint">${esc(result.detail)}</span></div></div>`;
      toast(result.verified ? "Key verified — live inference enabled" : "Key stored but not verified", result.verified ? "ok" : "warn");
      setTimeout(() => render(root, ctx), 900);
    } catch (error) {
      target.innerHTML = `<div class="hint" style="color:var(--red);margin-top:8px">${esc(error.message)}</div>`;
      button.disabled = false;
    }
  });

  root.querySelectorAll("[data-activate]").forEach((button) =>
    button.addEventListener("click", async () => {
      await api(`/api/keys/${button.dataset.activate}`, { method: "PATCH", body: { active: true } });
      ctx.state.bootstrap = await api("/api/bootstrap");
      toast("Key activated");
      render(root, ctx);
    }),
  );
  root.querySelectorAll("[data-remove-key]").forEach((button) =>
    button.addEventListener("click", async () => {
      await api(`/api/keys/${button.dataset.removeKey}`, { method: "DELETE" });
      ctx.state.bootstrap = await api("/api/bootstrap");
      toast("Key removed");
      render(root, ctx);
    }),
  );

  wireSetup(root.querySelector("#provider-setup"), {
    available: providerData.available,
    onChanged: async () => {
      await render(root, ctx);
      toast("Provider configured", "ok");
    },
  });

  root.querySelector('[data-action="save-company"]').addEventListener("click", async () => {
    try {
      await api(`/api/companies/${ctx.companyId}`, {
        method: "PATCH",
        body: {
          name: root.querySelector("#company-name-input").value,
          mission: root.querySelector("#mission").value,
          settings: {
            approvalPolicy: root.querySelector("#approval-policy").value,
            monthlyBudgetCents: Number(root.querySelector("#monthly-cap").value),
            cycleMinutes: Number(root.querySelector("#cycle-minutes").value),
            maxCycles: Number(root.querySelector("#max-cycles").value),
            reworkLimit: Number(root.querySelector("#rework-limit").value),
            autoMode: root.querySelector("#auto-mode").checked,
            guardrails: { ...company.settings.guardrails, safetyCheck: root.querySelector("#guardrail-safety").checked },
          },
        },
      });
      ctx.state.bootstrap = await api("/api/bootstrap");
      await ctx.refresh(true);
      toast("Operating rules saved");
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  });

  root.querySelector('[data-action="save-routing"]').addEventListener("click", async () => {
    const defaultModels = {};
    root.querySelectorAll("[data-route]").forEach((select) => {
      defaultModels[select.dataset.route] = select.value;
    });
    await api(`/api/companies/${ctx.companyId}`, { method: "PATCH", body: { settings: { defaultModels } } });
    await ctx.refresh(true);
    toast("Routing saved");
  });

  root.querySelector('[data-action="export"]').addEventListener("click", async () => {
    const bundle = await api(`/api/companies/${ctx.companyId}/export`);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${company.slug}-paperclip-nim.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast("Export downloaded");
  });

  root.querySelector('[data-action="reset"]').addEventListener("click", async () => {
    const lib = await import("../lib.js");
    const ok = await lib.confirmDialog({
      title: "Reset all companies?",
      message: "Every company, issue, run and ledger row is deleted from `data/companies` and the demo company is recreated. Keys and settings are kept.",
      confirmLabel: "Reset data",
      danger: true,
    });
    if (!ok) return;
    const result = await api("/api/data/reset", { method: "POST", body: { confirm: "RESET" } });
    ctx.state.bootstrap = await api("/api/bootstrap");
    ctx.state.companyId = result.companyId;
    ctx.state.company = null;
    ctx.toast("Demo data reset");
    location.hash = "/dashboard";
    location.reload();
  });
}
