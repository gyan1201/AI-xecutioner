import { api, copy, esc, icon, md, money, num, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Studio";

const TABS = [
  { key: "chat", label: "Chat", capability: "chat", endpoint: "POST /v1/chat/completions", blurb: "Multi-turn generation with reasoning and JSON mode." },
  { key: "vision", label: "Vision", capability: "vision", endpoint: "POST /v1/chat/completions", blurb: "Image + text input to a multimodal NIM." },
  { key: "embeddings", label: "Embeddings", capability: "embedding", endpoint: "POST /v1/embeddings", blurb: "Dense vectors for retrieval — try several inputs at once." },
  { key: "rerank", label: "Rerank", capability: "rerank", endpoint: "POST /v1/ranking", blurb: "Cross-encoder ordering of candidate passages." },
  { key: "image", label: "Image", capability: "image", endpoint: "POST /v1/genai/{model}", blurb: "Visual generative AI artifacts, returned as base64." },
  { key: "safety", label: "Safety", capability: "safety", endpoint: "POST /v1/chat/completions", blurb: "NeMo Guardrails verdict before an agent sees the text." },
  { key: "parse", label: "Doc parse", capability: "parse", endpoint: "POST /v1/chat/completions", blurb: "OCR + tables + layout from a page image." },
  { key: "translate", label: "Translate", capability: "translate", endpoint: "POST /v1/chat/completions", blurb: "Riva translation with structure preserved." },
  { key: "biology", label: "Biology", capability: "protein", endpoint: "POST /v1/biology/{task}", blurb: "BioNeMo protein / molecule / genomics endpoints." },
  { key: "raw", label: "Raw", capability: null, endpoint: "ANY /v1/{path}", blurb: "Passthrough for any NIM endpoint not covered above." },
];

export async function render(root, ctx) {
  if (!ctx.state.models) {
    const data = await api("/api/models");
    ctx.state.models = data.models;
  }
  const models = ctx.state.models;
  const tabKey = ctx.query.tab ?? "chat";
  const tab = TABS.find((entry) => entry.key === tabKey) ?? TABS[0];
  const config = ctx.state.bootstrap?.config;
  const presetModel = ctx.query.model ?? "";

  const capabilityModels = tab.capability ? models.filter((model) => model.capabilities.includes(tab.capability)) : models;
  const defaultModel =
    capabilityModels.find((model) => model.id === presetModel)?.id ??
    capabilityModels.find((model) => model.verified)?.id ??
    capabilityModels[0]?.id ??
    "nvidia/nemotron-3-super-120b-a12b";

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "NVIDIA NIM",
      title: "Studio",
      subtitle: `Every endpoint family the app uses, one form each. ${config?.mode === "live" ? `Calling <span class="mono">${esc(config.baseUrl)}</span> with key ${esc(config.keyHint)}.` : "In simulation every call is answered locally and labelled."}`,
      actions: `<span class="pill ${config?.mode === "live" ? "green" : ""}"><span class="dot"></span>${config?.mode === "live" ? "live" : "simulated"}</span>`,
    })}

    <div class="tabs">
      ${TABS.map((entry) => `<button class="tab ${entry.key === tab.key ? "on" : ""}" data-tab="${entry.key}">${esc(entry.label)}</button>`).join("")}
    </div>

    <div class="row-between" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <span class="pill mono">${esc(tab.endpoint)}</span>
        <span class="hint">${esc(tab.blurb)}</span>
      </div>
      <span class="hint">${tab.capability ? `${capabilityModels.length} model${capabilityModels.length === 1 ? "" : "s"} support this` : "any model"}</span>
    </div>

    <div class="split">
      <div class="card">
        <div class="card-title">Request</div>
        ${formFor(tab, capabilityModels, defaultModel)}
        <div class="row" style="gap:7px;margin-top:12px">
          <button class="btn primary" data-action="run">${icon("play", "nav-icon")} Run</button>
          <button class="btn ghost" data-action="curl">${icon("terminal", "nav-icon")} Copy as curl</button>
          <span class="grow"></span>
          <span class="hint" id="studio-elapsed"></span>
        </div>
      </div>
      <div class="card">
        <div class="row-between" style="margin-bottom:8px">
          <div class="card-title" style="margin:0">Response</div>
          <span class="hint" id="studio-meta"></span>
        </div>
        <div id="studio-output" class="out empty">Run a request to see the response.</div>
        ${tab.key === "image" ? `<div id="studio-image"></div>` : ""}
      </div>
    </div>

    <div class="section-title">Endpoint coverage</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">
      ${TABS.map(
        (entry) => `<button class="card tight" data-jump="${entry.key}" style="text-align:left;cursor:pointer;display:block">
          <div class="row" style="gap:7px"><b style="font-size:12.4px">${esc(entry.label)}</b><span class="grow"></span><span class="tag mono">${esc(entry.endpoint.split(" ")[0])}</span></div>
          <div class="hint mono" style="font-size:10px;margin-top:4px">${esc(entry.endpoint.split(" ")[1])}</div>
        </button>`,
      ).join("")}
    </div>
  `;

  root.querySelectorAll("[data-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
      next.set("tab", button.dataset.tab);
      location.hash = `/studio?${next}`;
    }),
  );
  root.querySelectorAll("[data-jump]").forEach((button) =>
    button.addEventListener("click", () => {
      location.hash = `/studio?tab=${button.dataset.jump}`;
    }),
  );

  const output = root.querySelector("#studio-output");
  const metaEl = root.querySelector("#studio-meta");
  const imageHost = root.querySelector("#studio-image");

  const setBusy = (busy) => {
    const button = root.querySelector('[data-action="run"]');
    button.disabled = busy;
    button.innerHTML = busy ? `<span class="blink">▍</span> Calling NIM…` : `${icon("play", "nav-icon")} Run`;
  };

  const run = async () => {
    setBusy(true);
    const started = performance.now();
    const timer = setInterval(() => {
      const elapsed = root.querySelector("#studio-elapsed");
      if (elapsed) elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
    }, 100);
    output.className = "out";
    output.textContent = "Waiting for the model…";
    try {
      const { path, body } = collect(tab, root);
      root.__lastRequest = { path, body };
      const result = await api(path, { method: "POST", body });
      if (tab.key === "chat" || tab.key === "vision" || tab.key === "parse" || tab.key === "translate") {
        output.className = "out";
        output.innerHTML = md(result.text || "_(empty response)_");
        if (result.note) output.innerHTML += `<div class="hint" style="margin-top:10px">${esc(result.note)}</div>`;
      } else if (tab.key === "embeddings") {
        output.innerHTML = `<div class="stack">
          <div class="row" style="gap:10px;flex-wrap:wrap"><span class="pill accent">${result.dimensions} dims</span><span class="pill">${result.count} vector(s)</span></div>
          ${result.preview
            .map(
              (vector, index) => `<div>
                <div class="hint">vector ${index + 1} · norm ${vector.norm} · ${vector.nonzero} of ${result.dimensions} dims non-zero · strongest components</div>
                <div class="out mono" style="margin-top:4px;font-size:11px">${vector.top.map(([dim, value]) => `<span class="tag mono">#${dim} ${value > 0 ? "+" : ""}${value}</span>`).join(" ")}</div>
              </div>`,
            )
            .join("")}
        </div>`;
      } else if (tab.key === "rerank") {
        output.innerHTML = `<div class="stack">${result.rankings
          .map(
            (row) => `<div class="card tight">
              <div class="row-between"><span class="pill accent">rank ${row.rank}</span><span class="mono hint">${Number(row.score).toFixed(4)}</span></div>
              <div class="hint" style="margin-top:5px">${esc(row.passage)}</div>
              <div class="progress" style="margin-top:6px"><i style="width:${Math.round(Math.min(1, Math.abs(Number(row.score))) * 100)}%;background:var(--blue)"></i></div>
            </div>`,
          )
          .join("")}</div>`;
      } else if (tab.key === "image") {
        output.innerHTML = `<div class="hint">${result.artifacts.length} artifact(s) · ${result.simulated ? "simulated" : "live NIM"} · seed ${result.artifacts[0]?.seed ?? "—"}</div>`;
        imageHost.innerHTML = result.artifacts
          .map((artifact) => `<img class="result-img" style="margin-top:10px" src="${esc(artifact.dataUri)}" alt="${esc(tab.label)} artifact" />`)
          .join("");
      } else if (tab.key === "safety") {
        const unsafe = result.unsafe || result.verdict === "unsafe";
        output.innerHTML = `<div class="stack">
          <div class="row" style="gap:8px"><span class="pill ${unsafe ? "red" : "green"}">${esc(result.verdict ?? (unsafe ? "unsafe" : "safe"))}</span><span class="mono hint">score ${result.score}</span></div>
          <div class="hint">${esc(result.rationale ?? "")}</div>
          ${(result.categories ?? []).length ? `<div class="chips">${result.categories.map((cat) => `<span class="tag">${esc(cat)}</span>`).join("")}</div>` : ""}
        </div>`;
      } else {
        output.textContent = JSON.stringify(result, null, 2);
      }
      const usage = result.usage ?? {};
      const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
      metaEl.innerHTML = [
        `<span class="pill ${result.simulated ? "" : "green"}">${result.simulated ? "simulated" : "live"}</span>`,
        `<span class="mono">${result.latencyMs ?? "—"}ms</span>`,
        tokens ? `<span class="mono">${num(tokens)} tok</span>` : "",
        usage.images ? `<span class="mono">${usage.images} img</span>` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    } catch (error) {
      output.className = "out";
      output.innerHTML = `<span style="color:var(--red)">${esc(error.message)}</span>${error.hint ? `<div class="hint" style="margin-top:6px">${esc(error.hint)}</div>` : ""}`;
      metaEl.innerHTML = `<span class="pill red">error</span>`;
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  };

  root.querySelector('[data-action="run"]').addEventListener("click", run);
  root.querySelector('[data-action="curl"]').addEventListener("click", () => {
    const { path, body } = collect(tab, root);
    const endpoint = `${config?.baseUrl ?? "https://integrate.api.nvidia.com/v1"}${path.replace("/api/studio/chat", "/chat/completions").replace("/api/studio/embed", "/embeddings").replace("/api/studio/rerank", "/ranking").replace("/api/studio/image", "/genai")}`;
    copy(`curl -s ${endpoint} \\\n  -H "Authorization: Bearer $NVIDIA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`);
  });
  root.querySelectorAll("input, textarea, select").forEach((field) =>
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) run();
    }),
  );
  if (ctx.query.model && tab.key === "chat") {
    /* preset model already applied via select default */
  }
}

function modelSelect(models, selected) {
  return `<select class="select" name="model">
    ${models
      .map(
        (model) => `<option value="${esc(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.name)} · ${esc(model.family)}${model.verified ? " · live" : ""}</option>`,
      )
      .join("")}
    ${models.length === 0 ? `<option value="nvidia/nemotron-3-super-120b-a12b">Nemotron 3 Super</option>` : ""}
  </select>`;
}

function formFor(tab, models, selected) {
  const modelField = `<div class="field"><label>Model</label>${modelSelect(models, selected)}</div>`;
  switch (tab.key) {
    case "chat":
      return `${modelField}
        <div class="field"><label>System</label><textarea class="textarea" name="system" style="min-height:64px">You are a precise assistant inside Paperclip, a company that runs on NVIDIA NIM. Answer with evidence.</textarea></div>
        <div class="field"><label>Prompt</label><textarea class="textarea" name="prompt" style="min-height:110px">Summarise why activation beats acquisition for a self-serve analytics product in three bullets.</textarea></div>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label>Temperature</label><input class="input" type="number" name="temperature" value="0.4" min="0" max="2" step="0.1" /></div>
          <div class="field"><label>Max tokens</label><input class="input" type="number" name="maxTokens" value="700" min="16" max="16000" /></div>
        </div>`;
    case "vision":
      return `${modelField}
        <div class="field"><label>Image URL or data URI</label><input class="input" name="image" placeholder="https://… or data:image/png;base64,…" /></div>
        <div class="field"><label>Prompt</label><textarea class="textarea" name="prompt" style="min-height:90px">Describe what matters in this image, then extract any numbers you can read.</textarea></div>`;
    case "embeddings":
      return `${modelField}
        <div class="field"><label>Inputs (one per line)</label><textarea class="textarea" name="input" style="min-height:120px">Activation is the bottleneck, not acquisition.
Trials stall on day three before the first saved insight.
Usage-based pricing expands better than seat pricing.</textarea></div>
        <div class="field"><label>Input type</label><select class="select" name="inputType"><option value="query">query</option><option value="passage">passage</option></select></div>`;
    case "rerank":
      return `${modelField}
        <div class="field"><label>Query</label><input class="input" name="query" value="Why do trials stall on day three?" /></div>
        <div class="field"><label>Candidates (one per line)</label><textarea class="textarea" name="passages" style="min-height:140px">Median first-query wait is 24 seconds and nine users thought the product was broken.
Seat-based pricing produces predictable revenue but stalls expansion.
The empty sources page came up unprompted in seven interviews.
Warehouse backfill covers 14 days and 21,884 events.</textarea></div>`;
    case "image":
      return `${modelField}
        <div class="field"><label>Prompt</label><textarea class="textarea" name="prompt" style="min-height:90px">An abstract product visual for an analytics onboarding flow: dark background, green light trails converging into a single point.</textarea></div>
        <div class="grid" style="grid-template-columns:1fr 1fr 1fr">
          <div class="field"><label>Width</label><input class="input" type="number" name="width" value="1024" min="256" max="2048" /></div>
          <div class="field"><label>Height</label><input class="input" type="number" name="height" value="1024" min="256" max="2048" /></div>
          <div class="field"><label>Steps</label><input class="input" type="number" name="steps" value="30" min="1" max="100" /></div>
        </div>
        <div class="field"><label>Seed (optional)</label><input class="input" type="number" name="seed" placeholder="random" /></div>`;
    case "safety":
      return `${modelField}
        <div class="field"><label>Text to classify</label><textarea class="textarea" name="text" style="min-height:120px">Please publish the customer-impact paragraph on the public status page before legal has seen it.</textarea></div>
        <div class="hint">Runs before and after every agent run when guardrails are enabled.</div>`;
    case "parse":
      return `${modelField}
        <div class="field"><label>Page image URL or data URI</label><input class="input" name="image" placeholder="data:image/png;base64,…" /></div>
        <div class="field"><label>Instruction</label><textarea class="textarea" name="prompt" style="min-height:76px">Extract all text, tables and layout. Preserve reading order.</textarea></div>`;
    case "translate":
      return `${modelField}
        <div class="field"><label>Text</label><textarea class="textarea" name="text" style="min-height:100px">Activation is the bottleneck. Trials stall on day three, before the first saved insight.</textarea></div>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div class="field"><label>From</label><input class="input" name="source" value="en" /></div>
          <div class="field"><label>To</label><select class="select" name="target"><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="ja">Japanese</option><option value="hi">Hindi</option><option value="ar">Arabic</option></select></div>
        </div>`;
    case "biology":
      return `${modelField}
        <div class="field"><label>Task</label><select class="select" name="task"><option value="protein-structure">protein-structure (Boltz2)</option><option value="protein-sequence">protein-sequence</option><option value="molecule">molecule generation</option><option value="genomics">genomics</option></select></div>
        <div class="field"><label>Sequence / payload</label><textarea class="textarea" name="sequence" style="min-height:80px" placeholder="MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ">MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ</textarea></div>
        <div class="hint">BioNeMo NIMs return structures, embeddings or scores depending on the task. The simulator returns a placeholder.</div>`;
    default:
      return `<div class="field"><label>Method</label><select class="select" name="method"><option>POST</option><option>GET</option><option>PATCH</option></select></div>
        <div class="field"><label>Path</label><input class="input" name="path" value="/chat/completions" placeholder="/models" /></div>
        <div class="field"><label>JSON body</label><textarea class="textarea code-area" name="body" style="min-height:170px">{
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "messages": [{ "role": "user", "content": "ping" }],
  "max_tokens": 32
}</textarea></div>
        <div class="hint">Passthrough to any endpoint on the configured base URL. Errors come back typed with a hint.</div>`;
  }
}

function collect(tab, root) {
  const get = (name) => root.querySelector(`[name="${name}"]`)?.value ?? "";
  const model = get("model");
  switch (tab.key) {
    case "chat":
      return {
        path: "/api/studio/chat",
        body: {
          model,
          system: get("system"),
          prompt: get("prompt"),
          temperature: Number(get("temperature")) || 0.4,
          maxTokens: Number(get("maxTokens")) || 700,
        },
      };
    case "vision":
      return {
        path: "/api/studio/chat",
        body: {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: get("prompt") },
                ...(get("image") ? [{ type: "image_url", image_url: { url: get("image") } }] : []),
              ],
            },
          ],
          maxTokens: 600,
        },
      };
    case "embeddings":
      return {
        path: "/api/studio/embed",
        body: { model, input: get("input").split("\n").filter(Boolean), inputType: get("inputType") },
      };
    case "rerank":
      return {
        path: "/api/studio/rerank",
        body: { model, query: get("query"), passages: get("passages").split("\n").filter(Boolean), topN: 4 },
      };
    case "image":
      return {
        path: "/api/studio/image",
        body: {
          model,
          prompt: get("prompt"),
          width: Number(get("width")) || 1024,
          height: Number(get("height")) || 1024,
          steps: Number(get("steps")) || 30,
          seed: get("seed") ? Number(get("seed")) : undefined,
        },
      };
    case "safety":
      return { path: "/api/studio/safety", body: { model, text: get("text") } };
    case "parse":
      return { path: "/api/studio/parse", body: { model, image: get("image"), prompt: get("prompt") } };
    case "translate":
      return { path: "/api/studio/translate", body: { model, text: get("text"), source: get("source"), target: get("target") } };
    case "biology":
      return { path: "/api/studio/biology", body: { model, task: get("task"), sequence: get("sequence") } };
    default: {
      let body = {};
      try {
        body = JSON.parse(get("body"));
      } catch {
        body = {};
      }
      return { path: "/api/studio/raw", body: { method: get("method"), path: get("path"), body } };
    }
  }
}
