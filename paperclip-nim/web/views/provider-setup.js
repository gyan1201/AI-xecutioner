import { api, copy, debounce, esc, icon, toast } from "../lib.js";

/**
 * Quick Setup via Code Snippet.
 *
 * Paste the Python or cURL snippet a provider hands you — NVIDIA NIM, OpenAI,
 * Groq, or any OpenAI-compatible endpoint — and this detects the provider,
 * pulls out the key, adds the model and configures the connection. Detection
 * runs server-side (`POST /api/providers/detect`) and is debounced while typing;
 * nothing is written until "Auto-Configure".
 */

export function connectCard({ providers = [], nvidia = { configured: false, models: 0, live: false } } = {}) {
  const nvidiaConnection = providers.find((provider) => provider.providerId === "nvidia" && provider.keyPresent);
  const others = providers.filter((provider) => provider.providerId !== "nvidia");
  const unlocked = Boolean(nvidiaConnection);

  return `
    <div class="card connect-card" style="margin-bottom:14px">
      <div class="row-between" style="gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div style="min-width:0">
          <div class="card-title" style="margin:0">
            ${unlocked ? `<span class="pill green"><span class="dot"></span>connected</span>` : `<span class="pill amber"><span class="dot"></span>key needed</span>`}
            ${unlocked ? "All models unlocked" : "Unlock every model with one key"}
          </div>
          <p class="hint" style="margin:7px 0 0;max-width:62ch">
            ${
              unlocked
                ? nvidia.live
                  ? `NVIDIA NIM is connected (${esc(nvidiaConnection.keyHint)}) — all ${nvidia.models} catalog models run live. One key covers every endpoint family: chat, tools, vision, embeddings, rerank, image, safety, parse, translate and BioNeMo.`
                  : `NVIDIA NIM is connected (${esc(nvidiaConnection.keyHint)}) and all ${nvidia.models} catalog models are unlocked, but this instance is still in <b>simulation</b>: the key has not been verified from here. Verify it in Settings, or untick “Force simulation” to call the real API anyway.`
                : `An NVIDIA key from <a href="https://build.nvidia.com/models" target="_blank" rel="noreferrer">build.nvidia.com/models</a> unlocks all ${nvidia.models} catalog models at once. Paste the key, or paste a whole Python/cURL snippet from NVIDIA NIM, OpenAI or Groq and let Paperclip work out the rest.`
            }
          </p>
          ${
            others.length
              ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px">
                  ${others
                    .map(
                      (provider) => `<span class="tag on" title="${esc(provider.baseUrl)}">${esc(provider.name)} · ${provider.models.length ? `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}` : "connected"}</span>`,
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
        <div class="row" style="gap:7px">
          <button class="btn ${unlocked ? "sm ghost" : "primary sm"}" data-action="open-setup">${icon("terminal", "nav-icon")} ${unlocked ? "Add another provider" : "Add a key"}</button>
          <a class="btn sm ghost" href="https://build.nvidia.com/models" target="_blank" rel="noreferrer">${icon("external", "nav-icon")} build.nvidia.com</a>
        </div>
      </div>
    </div>`;
}

/** The full Quick Setup panel (Settings uses it inline, Models uses it in a modal). */
export function setupPanel({ available = [], providers = [], detection = null } = {}) {
  const sample = available.find((provider) => provider.id === "nvidia") ?? available[0];
  return `
    <div class="stack" style="gap:10px">
      <div class="row" style="gap:6px;flex-wrap:wrap">
        ${available
          .filter((provider) => provider.snippet)
          .slice(0, 4)
          .map((provider) => `<button class="chip" data-sample="${esc(provider.id)}" title="Load a ${esc(provider.name)} example">${esc(provider.short)} sample</button>`)
          .join("")}
        <span class="grow"></span>
        <span class="hint">Python or cURL · auto-detected</span>
      </div>

      <div class="field">
        <label for="snippet-text">Paste a snippet or a key</label>
        <textarea class="textarea mono" id="snippet-text" style="min-height:132px;font-size:11.5px;line-height:1.55"
          placeholder="from openai import OpenAI&#10;&#10;client = OpenAI(&#10;  base_url=&quot;https://integrate.api.nvidia.com/v1&quot;,&#10;  api_key=&quot;nvapi-...&quot;&#10;)">${esc(sample?.snippet ?? "")}</textarea>
        <div class="hint">Nothing is sent anywhere until you press Auto-Configure. The key is stored locally in <span class="mono">data/keys.json</span> (0600) and never sent back to the browser.</div>
      </div>

      <div id="snippet-detection" aria-live="polite"></div>

      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="field">
          <label for="snippet-provider">Provider</label>
          <select class="select" id="snippet-provider">
            <option value="">Auto-detect</option>
            ${available.map((provider) => `<option value="${esc(provider.id)}">${esc(provider.name)} — ${esc(provider.host)}</option>`).join("")}
            <option value="custom">Custom OpenAI-compatible…</option>
          </select>
        </div>
        <div class="field">
          <label for="snippet-model">Model (optional)</label>
          <input class="input mono" id="snippet-model" placeholder="detected from the snippet" />
        </div>
      </div>

      <div class="field">
        <label for="snippet-key">Key (only if the snippet has none)</label>
        <input class="input mono" id="snippet-key" type="password" autocomplete="off" spellcheck="false" placeholder="nvapi-… · gsk_… · sk-…" />
      </div>

      <div class="row" style="gap:7px;flex-wrap:wrap">
        <button class="btn primary sm" data-action="auto-configure">${icon("terminal", "nav-icon")} Auto-Configure</button>
        <button class="btn sm ghost" data-action="clear-snippet">Clear</button>
        <span class="grow"></span>
        <span class="hint" id="snippet-status"></span>
      </div>

      <div id="snippet-result"></div>

      ${
        providers.length
          ? `<div class="connect-list">
              <div class="hint" style="margin-bottom:5px">Connected providers</div>
              ${providers
                .map(
                  (provider) => `<div class="row-between" style="border:1px solid var(--border);border-radius:7px;padding:8px 10px">
                    <div style="min-width:0">
                      <div class="row" style="gap:6px"><span style="font-size:12.4px">${esc(provider.name)}</span>
                        ${provider.keyPresent ? `<span class="pill green">key ${esc(provider.keyHint)}</span>` : `<span class="pill">no key</span>`}
                        ${provider.coversAllNvidia ? `<span class="pill accent">all ${esc(String(provider.modelCount ?? "catalog"))} models</span>` : ""}
                      </div>
                      <div class="hint mono" style="font-size:10.5px">${esc(provider.baseUrl)}${provider.models.length ? ` · ${esc(provider.models.slice(0, 3).join(", "))}${provider.models.length > 3 ? "…" : ""}` : ""}</div>
                    </div>
                    <button class="btn sm ghost" data-remove-provider="${esc(provider.id)}">Remove</button>
                  </div>`,
                )
                .join("")}
            </div>`
          : ""
      }
    </div>`;
}

export function detectionHtml(detection, { available = [] } = {}) {
  if (!detection) return `<div class="hint">Paste a snippet — the provider, key and model are detected as you type.</div>`;
  const confidenceClass = detection.confidence === "high" ? "green" : detection.confidence === "medium" ? "amber" : "red";
  const rows = [
    ["Provider", detection.provider?.name ?? detection.detectedName ?? "unknown"],
    ["Base URL", detection.baseUrl || "—"],
    ["Model", detection.model || "—"],
    ["Key", detection.keyMasked || (detection.warnings.some((warn) => /environment variable/.test(warn)) ? "in an env var" : "not found")],
  ];
  return `
    <div class="card tight" style="border-color:${detection.ok ? "rgba(118,185,0,.35)" : "rgba(227,179,65,.35)"}">
      <div class="row" style="gap:7px;margin-bottom:6px">
        <span class="pill ${confidenceClass}">${esc(detection.confidence)} confidence</span>
        ${detection.signals.map((signal) => `<span class="tag">${esc(signal)}</span>`).join("")}
      </div>
      ${rows
        .map(
          ([label, value]) =>
            `<div class="kv"><span class="k">${esc(label)}</span><span class="v mono" style="font-size:11px;word-break:break-all">${esc(String(value))}</span></div>`,
        )
        .join("")}
      ${
        detection.warnings.length
          ? `<div class="hint" style="margin-top:7px;color:#e3b341;font-size:11.5px">${detection.warnings.map((warning) => esc(warning)).join("<br />")}</div>`
          : ""
      }
      ${
        detection.providerId && !available.some((provider) => provider.id === detection.providerId) && detection.providerId !== "custom"
          ? ""
          : ""
      }
    </div>`;
}

/**
 * Wire a rendered Quick Setup panel. Returns the current detection getter so
 * callers (the modal) can trigger a re-detect after opening.
 */
export function wireSetup(root, { available = [], onChanged = () => {} } = {}) {
  const textarea = root.querySelector("#snippet-text");
  const providerSelect = root.querySelector("#snippet-provider");
  const modelInput = root.querySelector("#snippet-model");
  const keyInput = root.querySelector("#snippet-key");
  const detectionBox = root.querySelector("#snippet-detection");
  const resultBox = root.querySelector("#snippet-result");
  const status = root.querySelector("#snippet-status");
  const button = root.querySelector('[data-action="auto-configure"]');
  let detection = null;

  const renderDetection = (next) => {
    detection = next;
    if (detectionBox) detectionBox.innerHTML = detectionHtml(next, { available });
    if (next?.model && modelInput && !modelInput.value) modelInput.placeholder = next.model;
    if (next?.providerId && providerSelect && !providerSelect.dataset.touched) providerSelect.value = next.providerId === "custom" ? "custom" : next.providerId;
  };

  const detect = debounce(async () => {
    const text = textarea?.value ?? "";
    if (!text.trim()) {
      renderDetection(null);
      return;
    }
    try {
      const payload = await api("/api/providers/detect", { method: "POST", body: { text } });
      renderDetection(payload.detection);
    } catch (error) {
      if (detectionBox) detectionBox.innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
    }
  }, 260);

  textarea?.addEventListener("input", detect);
  providerSelect?.addEventListener("change", () => {
    providerSelect.dataset.touched = "1";
  });

  root.querySelectorAll("[data-sample]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const provider = available.find((entry) => entry.id === chip.dataset.sample);
      if (!provider?.snippet || !textarea) return;
      textarea.value = provider.snippet;
      delete providerSelect?.dataset.touched;
      if (providerSelect) providerSelect.value = provider.id;
      detect();
      textarea.focus();
    }),
  );

  root.querySelector('[data-action="clear-snippet"]')?.addEventListener("click", () => {
    if (textarea) textarea.value = "";
    if (keyInput) keyInput.value = "";
    if (modelInput) modelInput.value = "";
    delete providerSelect?.dataset.touched;
    if (providerSelect) providerSelect.value = "";
    renderDetection(null);
    if (resultBox) resultBox.innerHTML = "";
    if (status) status.textContent = "";
  });

  root.querySelectorAll("[data-remove-provider]").forEach((remove) =>
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api(`/api/providers/${encodeURIComponent(remove.dataset.removeProvider)}`, { method: "DELETE" });
        toast("Provider removed", "ok");
        await onChanged();
      } catch (error) {
        toast(error.message, "error");
        remove.disabled = false;
      }
    }),
  );

  button?.addEventListener("click", async () => {
    const text = textarea?.value ?? "";
    const providerId = providerSelect?.value || undefined;
    const key = keyInput?.value?.trim() || undefined;
    const model = modelInput?.value?.trim() || undefined;
    if (!text.trim() && !key) {
      toast("Paste a snippet or a key first.", "error");
      return;
    }
    button.disabled = true;
    const previous = button.innerHTML;
    button.innerHTML = "Configuring…";
    if (status) status.textContent = "";
    try {
      const payload = await api("/api/providers/apply", { method: "POST", body: { text, providerId, key, model } });
      if (resultBox) {
        resultBox.innerHTML = `
          <div class="card tight" style="border-color:rgba(118,185,0,.45);background:rgba(118,185,0,.06)">
            <div class="row" style="gap:8px"><span class="pill green"><span class="dot"></span>success</span>
              <b style="font-size:12.6px">${esc(payload.message)}</b></div>
            <div class="hint" style="margin-top:6px">${esc(payload.detail ?? "")}</div>
            <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
              <span class="tag mono">${esc(payload.provider?.baseUrl ?? "")}</span>
              ${payload.model ? `<span class="tag on mono">${esc(payload.model)}</span>` : ""}
              <a class="btn sm ghost" href="#/models">Open models →</a>
              <a class="btn sm ghost" href="#/studio${payload.model ? `?model=${encodeURIComponent(payload.model)}` : ""}">Try in studio →</a>
            </div>
          </div>`;
      }
      toast(payload.message, "ok");
      if (keyInput) keyInput.value = "";
      await onChanged();
    } catch (error) {
      if (resultBox) resultBox.innerHTML = `<div class="card tight" style="border-color:rgba(255,90,90,.4)"><div class="hint" style="color:var(--red)">${esc(error.message)}</div>${error.hint ? `<div class="hint" style="margin-top:5px">${esc(error.hint)}</div>` : ""}</div>`;
      if (status) status.textContent = "";
    } finally {
      button.disabled = false;
      button.innerHTML = previous;
    }
  });

  return { detect: () => detect(), renderDetection };
}

export { copy };

/** Modal wrapper around the same panel — used from the Models view. */
export function openSetupModal({ available = [], providers = [], onChanged = () => {} } = {}) {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.hidden = false;
  root.innerHTML = `
    <div class="modal" style="width:min(760px,96vw)" role="dialog" aria-modal="true" aria-label="Quick setup">
      <div class="modal-head">
        <div>
          <h2 style="margin:0">Quick Setup via Code Snippet</h2>
          <div class="hint" style="margin-top:3px">Paste the Python or cURL snippet from NVIDIA NIM, OpenAI or Groq. Paperclip detects the provider, extracts the key, adds the model and configures everything.</div>
        </div>
        <button class="icon-btn" data-close aria-label="Close">${icon("x", "")}</button>
      </div>
      <div class="modal-body" style="display:block">
        ${setupPanel({ available, providers })}
      </div>
    </div>`;

  const close = () => {
    root.hidden = true;
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  root.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  root.addEventListener("click", (event) => {
    if (event.target === root) close();
  });

  const controller = wireSetup(root, {
    available,
    // Refresh the page behind the modal but keep it open: the success panel
    // ("Success! Auto-configured …") is the confirmation the user needs to see.
    onChanged: async () => {
      await onChanged();
    },
  });
  root.querySelector("#snippet-text")?.focus();
  return { close, ...controller };
}
