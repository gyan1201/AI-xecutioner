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
        <div class="card" id="connect-card">
          <div class="card-head">
            <span class="card-title">Connect NVIDIA</span>
            <span class="row-wrap">
              <span class="badge ${settings.hasApiKey ? (settings.simulation ? "badge-amber" : "badge-green") : "badge-dim"}">
                ${settings.hasApiKey ? (settings.simulation ? "key saved · simulation" : "live") : "no key"}
              </span>
              <span class="tiny mono faint">${esc(settings.keyHint ?? "not set")}</span>
            </span>
          </div>
          <p class="small muted">
            Paste <strong>anything</strong> that contains your key — the bare <code>nvapi-…</code> token,
            an <code>NVIDIA_API_KEY=…</code> line, or the whole python / curl / SDK snippet. The key,
            endpoints, model ids and request parameters are extracted, the key is verified against NVIDIA,
            and the app configures itself.
          </p>
          <div class="field">
            <label for="key-paste">Key, env line, or request snippet</label>
            <textarea id="key-paste" rows="6" spellcheck="false" autocomplete="off"
              placeholder='nvapi-…&#10;&#10;— or —&#10;&#10;export NVIDIA_API_KEY=nvapi-…&#10;&#10;— or the whole snippet —&#10;&#10;invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"&#10;headers = {"Authorization": "Bearer nvapi-…"}&#10;payload = {"model": "mistralai/mistral-large-4-1t-a52b", "reasoning_effort": "high"}'></textarea>
            <span class="tiny faint">Stored at <code>data/settings.json</code> with file mode 0600. It is never returned to the browser and never sent anywhere except NVIDIA.</span>
          </div>
          <div class="row-wrap" style="margin-top:var(--space-3)">
            <button class="btn btn-primary" id="connect">Connect &amp; auto-configure</button>
            <button class="btn" id="test">Test live</button>
            ${settings.hasApiKey && settings.simulation ? `<button class="btn btn-sm" id="go-live">Go live anyway</button>` : ""}
            ${settings.hasApiKey ? `<button class="btn btn-danger btn-sm" id="clear-key">Remove key</button>` : ""}
          </div>
          <div id="paste-preview" style="margin-top:var(--space-3)"></div>
          <div id="key-result" style="margin-top:var(--space-3)"></div>
          <div id="test-result" style="margin-top:var(--space-3)"></div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Inference mode</span></div>
          <label class="check" style="margin-bottom:10px">
            <input type="checkbox" id="simulation" ${settings.simulation ? "checked" : ""} />
            Force simulation (never call NVIDIA, even with a key)
          </label>
          <p class="small muted">
            With no key, simulation is automatic. <strong>Connect &amp; auto-configure</strong> verifies the key and
            switches to live inference on its own — unless this host cannot reach NVIDIA, in which case the key is
            saved and simulation stays on until you press <strong>Test live</strong>.
          </p>
          ${settings.keyMeta?.addedAt ? `<dl class="kv" style="margin-top:10px">
            <dt>Key source</dt><dd class="mono tiny">${esc(settings.keyMeta.source ?? "manual")}</dd>
            <dt>Added</dt><dd class="tiny">${esc(new Date(settings.keyMeta.addedAt).toLocaleString())}</dd>
            <dt>Verified</dt><dd class="tiny">${settings.keyMeta.verified ? "yes" : `no${settings.keyMeta.verifyReason ? ` (${esc(settings.keyMeta.verifyReason)})` : ""}`}</dd>
            ${settings.keyMeta.modelCount ? `<dt>Models</dt><dd class="mono tiny">${settings.keyMeta.modelCount}</dd>` : ""}
          </dl>` : ""}
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
          <div class="card-head"><span class="card-title">Auto-configured defaults</span></div>
          ${
            settings.defaultModel || (settings.pastedModels ?? []).length
              ? `<dl class="kv">
                  ${settings.defaultModel ? `<dt>Chat model</dt><dd class="mono tiny">${esc(settings.defaultModel)}</dd>` : ""}
                  ${(settings.pastedModels ?? []).length ? `<dt>Pasted models</dt><dd class="tiny mono">${(settings.pastedModels ?? []).map((id) => esc(id)).join("<br>")}</dd>` : ""}
                  ${Object.keys(settings.defaults?.params ?? {}).length ? `<dt>Params</dt><dd class="tiny mono">${esc(JSON.stringify(settings.defaults.params))}</dd>` : ""}
                </dl>
                <p class="tiny faint" style="margin-top:8px">Extracted from your paste. They seed Chat lab and appear in Models &amp; routing even when discovery is offline.</p>`
              : `<p class="small muted">Nothing pasted yet. A snippet becomes a default chat model, request parameters and a list of usable model ids.</p>`
          }
        </div>
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

  const resultHost = () => el.querySelector("#key-result");

  function paintParsed(parsed) {
    const host = el.querySelector("#paste-preview");
    if (!parsed) return;
    const chips = [
      parsed.keyHint ? `key ${parsed.keyHint}` : "",
      parsed.nimBaseUrl ? `endpoint ${parsed.nimBaseUrl}` : "",
      ...(parsed.models ?? []).map((id) => `model ${id}`),
      ...Object.entries(parsed.params ?? {}).map(([key, value]) => `${key} ${value}`),
      parsed.flags?.vision ? "vision" : "",
      parsed.flags?.stream ? "streaming" : "",
    ].filter(Boolean);
    host.innerHTML = `
      <div class="chips">${chips.map((chip) => `<span class="chip">${esc(chip)}</span>`).join("") || '<span class="tiny faint">nothing detected yet</span>'}</div>
      ${(parsed.warnings ?? []).map((warning) => `<div class="tiny faint" style="margin-top:6px">· ${esc(warning)}</div>`).join("")}`;
  }

  function paintVerification(verification) {
    if (!verification) return "";
    if (verification.ok) {
      return `<div class="banner green"><span>✓</span><div><strong>Key verified.</strong> ${verification.modelCount} models available in ${verification.latencyMs}ms.</div></div>`;
    }
    if (verification.reason === "unreachable") {
      return `<div class="banner"><span>◐</span><div><strong>Saved, but NVIDIA is unreachable from this host.</strong> ${esc(verification.detail ?? "")} Simulation stays on — press <strong>Test live</strong> once the network allows it.</div></div>`;
    }
    if (verification.reason === "skipped") {
      return `<div class="banner"><span>◐</span><div>Saved without verification.</div></div>`;
    }
    return `<div class="banner red"><span>✕</span><div><strong>NVIDIA rejected the key (${esc(verification.reason ?? verification.status)}).</strong> ${esc(verification.hint ?? "")}</div></div>`;
  }

  el.querySelector("#connect").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const text = el.querySelector("#key-paste").value.trim();
    if (!text) return toast("Paste a key or a snippet first.", "warn");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> reading & verifying`;
    resultHost().innerHTML = "";
    try {
      const result = await api.post("/api/settings/key", { text, mode: "auto" });
      paintParsed(result.parsed);
      resultHost().innerHTML = `
        ${paintVerification(result.verification)}
        <div class="stack small" style="margin-top:8px">
          ${(result.notes ?? []).map((note) => `<div class="faint">· ${esc(note)}</div>`).join("")}
        </div>`;
      toast(result.live ? "Key connected — live inference is on" : "Key saved — still in simulation");
      await ctx.refresh();
      el.querySelector("#key-paste").value = "";
      if (result.live) setTimeout(() => location.reload(), 900);
    } catch (error) {
      resultHost().innerHTML = `<div class="banner red"><span>✕</span><div><strong>${esc(error.message)}</strong>${error.hint ? ` ${esc(error.hint)}` : ""}</div></div>`;
      if (error.detail?.warnings) paintParsed({ warnings: error.detail.warnings });
    } finally {
      button.disabled = false;
      button.textContent = "Connect & auto-configure";
    }
  });

  el.querySelector("#test").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const host = el.querySelector("#test-result");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> testing`;
    host.innerHTML = "";
    try {
      const pasted = el.querySelector("#key-paste").value.trim();
      const result = pasted
        ? await api.post("/api/settings/key", { text: pasted, mode: "auto" })
        : await api.post("/api/settings/key/verify", {});
      paintParsed(result.parsed ?? null);
      host.innerHTML = `${paintVerification(result.verification)}${
        result.verification?.ok && ctx.state?.status?.config?.simulation
          ? `<div class="row-wrap" style="margin-top:8px"><button class="btn btn-primary btn-sm" id="enable-live">Switch to live now</button></div>`
          : ""
      }`;
      host.querySelector("#enable-live")?.addEventListener("click", async () => {
        await patch({ simulation: false }, "Live inference enabled");
        location.reload();
      });
      await ctx.refresh();
    } catch (error) {
      host.innerHTML = `<div class="banner red"><span>✕</span><div><strong>Connection failed.</strong> ${esc(error.message)}${error.hint ? ` — ${esc(error.hint)}` : ""}</div></div>`;
    } finally {
      button.disabled = false;
      button.textContent = "Test live";
    }
  });

  el.querySelector("#go-live")?.addEventListener("click", async () => {
    if (!confirm("Send every call to NVIDIA now? If this host cannot reach NVIDIA, runs will fail.")) return;
    const saved = await patch({ simulation: false }, "Live inference enabled");
    if (saved) location.reload();
  });

  el.querySelector("#clear-key")?.addEventListener("click", async () => {
    if (!confirm("Remove the stored NVIDIA API key? The app returns to simulation mode.")) return;
    await patch({ apiKey: "", simulation: true }, "Key removed");
    location.reload();
  });

  el.querySelector("#simulation").addEventListener("change", async (event) => {
    await patch({ simulation: event.target.checked }, event.target.checked ? "Simulation enabled" : "Simulation disabled");
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
