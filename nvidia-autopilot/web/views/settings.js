import { api, esc, reportError, toast } from "../lib.js";

export async function render(el, ctx) {
  const settings = await api.get("/api/settings");

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-4)">
      <div>
        <h1 style="font-size:26px">Settings</h1>
        <p class="muted small" style="margin-top:6px">One NVIDIA API key unlocks every NIM endpoint in this app. Keys are stored on this machine only.</p>
      </div>
      <span class="badge ${settings.simulation ? "badge-amber" : "badge-green"}">${settings.simulation ? "simulation" : "live"}</span>
    </div>

    ${settings.hasApiKey ? "" : `<div class="banner" style="margin-bottom:var(--space-4)"><span>◐</span><div><strong>No API key yet.</strong> Everything runs in simulation so you can explore freely. Get a key from <a href="https://build.nvidia.com" target="_blank" rel="noreferrer">build.nvidia.com</a>, then paste it below for real inference.</div></div>`}

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><span class="card-title">NVIDIA API key</span><span class="tiny mono faint">${esc(settings.keyHint ?? "not set")}</span></div>
          <div class="field">
            <label for="apiKey">Key</label>
            <input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="nvapi-…" value="" />
            <span class="tiny faint">Stored at <code>data/settings.json</code> with file mode 0600. It is never returned to the browser.</span>
          </div>
          <div class="row-wrap" style="margin-top:var(--space-3)">
            <button class="btn btn-primary" id="save-key">Save key</button>
            <button class="btn" id="test">Test connection</button>
            ${settings.hasApiKey ? `<button class="btn btn-danger btn-sm" id="clear-key">Remove key</button>` : ""}
          </div>
          <div id="test-result" style="margin-top:var(--space-3)"></div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Inference mode</span></div>
          <label class="check" style="margin-bottom:10px">
            <input type="checkbox" id="simulation" ${settings.simulation ? "checked" : ""} />
            Force simulation (never call NVIDIA, even with a key)
          </label>
          <p class="small muted">
            With no key, simulation is automatic. When a key exists, unchecking this makes every call hit the live NIM API.
          </p>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Endpoints</span></div>
          <div class="field" style="margin-bottom:var(--space-3)">
            <label for="nimBaseUrl">Chat / embeddings / rerank base URL</label>
            <input id="nimBaseUrl" value="${esc(settings.nimBaseUrl)}" />
            <span class="tiny faint">Point this at a self-hosted NIM container to keep data on your own GPUs, e.g. <code>http://localhost:8000/v1</code>.</span>
          </div>
          <div class="field">
            <label for="genaiBaseUrl">Visual generative AI base URL</label>
            <input id="genaiBaseUrl" value="${esc(settings.genaiBaseUrl)}" />
            <span class="tiny faint">Image endpoints append <code>/{publisher}/{model}</code>.</span>
          </div>
          <div class="row" style="margin-top:var(--space-3)">
            <button class="btn" id="save-endpoints">Save endpoints</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Cost tracking</span></div>
          <p class="small muted" style="margin-bottom:var(--space-3)">
            NVIDIA prices vary per model. Set the rate you pay and every run reports an estimated cost next to token usage. Leave empty to hide cost.
          </p>
          <div class="field-row">
            <div class="field">
              <label for="priceIn">Input $ / 1M tokens</label>
              <input id="priceIn" type="number" step="0.01" min="0" value="${settings.pricing?.inputPerMTok ?? ""}" placeholder="0.71" />
            </div>
            <div class="field">
              <label for="priceOut">Output $ / 1M tokens</label>
              <input id="priceOut" type="number" step="0.01" min="0" value="${settings.pricing?.outputPerMTok ?? ""}" placeholder="0.71" />
            </div>
          </div>
          <button class="btn" id="save-pricing" style="margin-top:var(--space-3)">Save rates</button>
        </div>
      </div>

      <div class="side-stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Environment variables</span></div>
          <pre style="margin:0"><code>NVIDIA_API_KEY=nvapi-…
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_GENAI_BASE_URL=https://ai.api.nvidia.com/v1/genai
NIM_SIMULATION=0
PORT=8787
NVIDIA_AUTOPILOT_DATA_DIR=./data</code></pre>
          <p class="tiny faint" style="margin-top:8px">Runtime settings saved here take precedence over the environment.</p>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Data on this machine</span></div>
          <dl class="kv">
            <dt>Runs</dt><dd class="mono tiny">data/runs/&lt;id&gt;/</dd>
            <dt>Events</dt><dd class="mono tiny">events.ndjson</dd>
            <dt>Artifacts</dt><dd class="mono tiny">artifacts/</dd>
            <dt>Knowledge</dt><dd class="mono tiny">data/knowledge/index.json</dd>
            <dt>Settings</dt><dd class="mono tiny">data/settings.json</dd>
          </dl>
          <p class="small muted" style="margin-top:10px">
            There is no cloud sync. Back up <code>data/</code> to keep run history and the knowledge index.
          </p>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Security posture</span></div>
          <ul class="small muted" style="margin:0;padding-left:18px;line-height:1.8">
            <li>No authentication: run it on a trusted network or behind your own proxy.</li>
            <li>Keys never leave the server; the browser only sees a masked hint.</li>
            <li>Artifacts are path-sanitised before serving.</li>
            <li>Every model call, tool call and guardrail verdict is appended to an audit log.</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  const patch = async (body, message) => {
    try {
      await api.put("/api/settings", body);
      if (message) toast(message);
      await ctx.refresh();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  el.querySelector("#save-key").addEventListener("click", async () => {
    const value = el.querySelector("#apiKey").value.trim();
    if (!value) return toast("Paste a key first.", "warn");
    const saved = await patch({ apiKey: value, simulation: false }, "Key saved — switching to live inference");
    if (saved) el.querySelector("#apiKey").value = "";
  });

  el.querySelector("#clear-key")?.addEventListener("click", async () => {
    if (!confirm("Remove the stored NVIDIA API key? The app returns to simulation mode.")) return;
    await patch({ apiKey: "", simulation: true }, "Key removed");
    location.reload();
  });

  el.querySelector("#simulation").addEventListener("change", async (event) => {
    await patch({ simulation: event.target.checked }, event.target.checked ? "Simulation enabled" : "Simulation disabled");
  });

  el.querySelector("#test").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const host = el.querySelector("#test-result");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> testing`;
    host.innerHTML = "";
    try {
      const result = await api.post("/api/settings/test", {});
      host.innerHTML = result.simulated
        ? `<div class="banner"><span>◐</span><div>Simulation mode — ${result.modelCount} stand-in models, no NVIDIA call was made.</div></div>`
        : `<div class="banner green"><span>✓</span><div>Connected in ${result.latencyMs}ms · ${result.modelCount} models available on your account.</div></div>`;
      await ctx.refresh();
    } catch (error) {
      host.innerHTML = `<div class="banner red"><span>✕</span><div><strong>Connection failed.</strong> ${esc(error.message)}${error.hint ? ` — ${esc(error.hint)}` : ""}</div></div>`;
    } finally {
      button.disabled = false;
      button.textContent = "Test connection";
    }
  });

  el.querySelector("#save-endpoints").addEventListener("click", () =>
    patch(
      {
        nimBaseUrl: el.querySelector("#nimBaseUrl").value.trim(),
        genaiBaseUrl: el.querySelector("#genaiBaseUrl").value.trim(),
      },
      "Endpoints saved",
    ),
  );

  el.querySelector("#save-pricing").addEventListener("click", () =>
    patch(
      {
        pricing: {
          inputPerMTok: Number(el.querySelector("#priceIn").value) || null,
          outputPerMTok: Number(el.querySelector("#priceOut").value) || null,
        },
      },
      "Cost rates saved",
    ),
  );
}
