import { api, esc, fmt, md, reportError, optionList, streamChat, toast } from "../lib.js";

const PERSONAS = [
  { label: "Chief of staff", text: "You are a chief of staff for a founder-led company. Be concise, decisive and quantify trade-offs." },
  { label: "Analyst", text: "You are a rigorous business analyst. Separate facts from assumptions and show your reasoning." },
  { label: "Engineer", text: "You are a senior engineer. Prefer concrete code, edge cases and operational cost." },
  { label: "Critic", text: "You are a tough reviewer. Find gaps, risks and unproven claims. Be specific and terse." },
];

export async function render(el, ctx) {
  const catalog = await api.get("/api/models").catch(() => ({ models: [], roles: {} }));
  const chatModels = catalog.models.filter((model) => model.capabilities.includes("chat") || model.capabilities.includes("reasoning"));
  const defaults = await api.get("/api/settings").catch(() => ({}));
  const preferred = catalog.defaultModel ?? defaults.defaultModel ?? defaults.defaults?.chatModel ?? null;
  const defaultModel =
    (preferred && chatModels.some((model) => model.id === preferred) ? preferred : null) ??
    catalog.roles?.operator?.model ??
    chatModels[0]?.id ??
    "";
  const pastedParams = defaults.defaults?.params ?? {};
  const hasVision = chatModels.some((model) => model.capabilities.includes("vision"));

  const state = {
    messages: [],
    model: defaultModel,
    system: "",
    temperature: typeof pastedParams.temperature === "number" ? pastedParams.temperature : 0.4,
    maxTokens: typeof pastedParams.maxTokens === "number" ? Math.min(pastedParams.maxTokens, 8000) : 1200,
    reasoningEffort: pastedParams.reasoningEffort ?? "",
    tools: false,
    json: false,
    image: null,
    streaming: false,
    controller: null,
    usage: null,
  };

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-4)">
      <div>
        <h1 style="font-size:26px">Chat lab</h1>
        <p class="muted small" style="margin-top:6px">Every hosted NIM chat model, streaming over SSE. Tools call real server-side functions — the same ones autopilot uses.</p>
      </div>
      <span class="badge ${ctx.state.status?.config?.simulation ? "badge-amber" : "badge-green"}">
        ${ctx.state.status?.config?.simulation ? "simulated" : `live · ${esc(catalog.roles?.operator?.model?.split("/").pop() ?? "")}`}
      </span>
    </div>

    <div class="chat">
      <div class="stack">
        <div class="chat-log" id="log">
          <div class="empty" style="margin:auto">
            <h3>Ask anything, or test a persona</h3>
            <p class="small">Streaming, tool calling, JSON mode and vision are all wired to the NVIDIA NIM API.</p>
          </div>
        </div>
        <div class="composer">
          <textarea id="input" rows="3" placeholder="Message the model… (⌘/Ctrl + Enter to send)"></textarea>
          <div class="composer-actions">
            <div class="row-wrap">
              <button class="btn btn-primary" id="send">Send</button>
              <button class="btn btn-ghost hide" id="stop">Stop</button>
              <button class="btn btn-ghost btn-sm" id="clear">Clear</button>
              <label class="check small" title="Attach an image for vision models">
                <input type="file" id="image-file" accept="image/*" class="hide" />
                <button class="btn btn-ghost btn-sm" id="attach" ${hasVision ? "" : "disabled title='No vision model in catalog'"}>Attach image</button>
              </label>
              <span class="tiny faint" id="image-note"></span>
            </div>
            <span class="tiny faint mono" id="usage">${esc(ctx.state.status?.config?.simulation ? "simulation" : "")}</span>
          </div>
        </div>
      </div>

      <div class="side-stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Model</span></div>
          <select id="model">${optionList(chatModels.length ? chatModels : [{ id: defaultModel, label: defaultModel }], state.model, { labelKey: "id" })}</select>
          <div class="field-row" style="margin-top:var(--space-3)">
            <div class="field">
              <label for="temperature">Temperature <span class="mono" id="temp-val">${state.temperature}</span></label>
              <input type="range" id="temperature" min="0" max="1.2" step="0.05" value="${state.temperature}" />
            </div>
            <div class="field">
              <label for="maxTokens">Max tokens</label>
              <input type="number" id="maxTokens" min="64" max="8000" step="64" value="${state.maxTokens}" />
            </div>
          </div>
          <div class="field" style="margin-top:var(--space-3)">
            <label for="reasoning">Reasoning effort <span class="tiny faint">(sent as <code>reasoning_effort</code>)</span></label>
            <select id="reasoning">
              <option value="" ${state.reasoningEffort ? "" : "selected"}>model default</option>
              ${["low", "medium", "high"].map((level) => `<option value="${level}" ${state.reasoningEffort === level ? "selected" : ""}>${level}</option>`).join("")}
            </select>
          </div>
          <div class="stack" style="margin-top:var(--space-3);gap:8px">
            <label class="check"><input type="checkbox" id="tools" /> Enable agent tools</label>
            <label class="check"><input type="checkbox" id="json" /> JSON output mode</label>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">System prompt</span></div>
          <textarea id="system" rows="4" placeholder="Optional. Sets the model's role and constraints."></textarea>
          <div class="chips" style="margin-top:8px">
            ${PERSONAS.map((persona) => `<button class="chip" data-persona="${esc(persona.text)}">${esc(persona.label)}</button>`).join("")}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Request preview</span></div>
          <pre style="margin:0;max-height:200px"><code id="preview"></code></pre>
        </div>
      </div>
    </div>
  `;

  const log = el.querySelector("#log");
  const input = el.querySelector("#input");
  const sendBtn = el.querySelector("#send");
  const stopBtn = el.querySelector("#stop");
  const usageEl = el.querySelector("#usage");

  function preview() {
    const body = {
      model: state.model,
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: true,
      messages: `${state.messages.length + (state.system ? 1 : 0)} message(s)`,
      tools: state.tools ? "agent toolset" : false,
      response_format: state.json ? { type: "json_object" } : undefined,
      extra: state.reasoningEffort ? { reasoning_effort: state.reasoningEffort } : undefined,
    };
    el.querySelector("#preview").textContent = JSON.stringify(body, null, 2);
  }

  function paintLog() {
    if (!state.messages.length) return;
    log.innerHTML = state.messages
      .map((message) => {
        const content =
          typeof message.content === "string"
            ? md(message.content)
            : message.content
                .map((part) => (part.type === "text" ? md(part.text) : `<div class="small faint">[image attached]</div>`))
                .join("");
        return `<div class="msg ${esc(message.role)}">
          <span class="msg-head">${esc(message.role)}${message.model ? ` · <span class="mono">${esc(String(message.model).split("/").pop())}</span>` : ""}${message.simulated ? ' · <span class="badge badge-amber">sim</span>' : ""}</span>
          <div class="msg-body md">${content || '<span class="faint">…</span>'}</div>
          ${message.toolCalls?.length ? `<div class="msg-tools">${message.toolCalls.map((call) => `<span class="badge badge-violet">${esc(call.name)}</span>`).join("")}</div>` : ""}
        </div>`;
      })
      .join("");
    log.scrollTop = log.scrollHeight;
  }

  function addMessage(message) {
    state.messages.push(message);
    paintLog();
    return state.messages[state.messages.length - 1];
  }

  async function send() {
    const text = input.value.trim();
    if (!text || state.streaming) return;
    const content = state.image
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: state.image } }]
      : text;
    input.value = "";
    const attachment = state.image;
    state.image = null;
    el.querySelector("#image-note").textContent = "";
    addMessage({ role: "user", content });

    const request = state.messages
      .filter((message) => message.role !== "assistant" || message.content)
      .map((message) => ({ role: message.role, content: message.content }));
    if (state.system) request.unshift({ role: "system", content: state.system });

    const assistant = addMessage({ role: "assistant", content: "", model: state.model });
    state.streaming = true;
    sendBtn.disabled = true;
    stopBtn.classList.remove("hide");
    state.controller = new AbortController();
    try {
      await streamChat(
        {
          model: state.model,
          messages: request,
          temperature: state.temperature,
          maxTokens: state.maxTokens,
          tools: state.tools,
          json: state.json,
          ...(state.reasoningEffort ? { extra: { reasoning_effort: state.reasoningEffort } } : {}),
        },
        {
          signal: state.controller.signal,
          onEvent(event, payload) {
            if (event === "delta" && payload.content) {
              assistant.content += payload.content;
              paintLog();
            } else if (event === "tool_calls" && payload.toolCalls) {
              assistant.toolCalls = payload.toolCalls;
              paintLog();
            } else if (event === "usage" && payload.usage) {
              state.usage = payload.usage;
              usageEl.textContent = `${fmt.tokens(payload.usage.totalTokens)} tokens`;
            } else if (event === "error") {
              toast(payload.message ?? "Stream failed", "error");
            }
          },
        },
      );
    } catch (error) {
      if (error.name !== "AbortError") {
        reportError(error);
        assistant.content = assistant.content || `_Request failed: ${error.message}_`;
      } else {
        assistant.content += "\n\n_(stopped)_";
      }
      paintLog();
    } finally {
      state.streaming = false;
      sendBtn.disabled = false;
      stopBtn.classList.add("hide");
      state.controller = null;
      void attachment;
    }
  }

  el.querySelector("#model").addEventListener("change", (event) => {
    state.model = event.target.value;
    preview();
  });
  el.querySelector("#temperature").addEventListener("input", (event) => {
    state.temperature = Number(event.target.value);
    el.querySelector("#temp-val").textContent = state.temperature;
    preview();
  });
  el.querySelector("#maxTokens").addEventListener("change", (event) => {
    state.maxTokens = Number(event.target.value) || 1200;
    preview();
  });
  el.querySelector("#reasoning").addEventListener("change", (event) => {
    state.reasoningEffort = event.target.value;
    preview();
  });
  el.querySelector("#tools").addEventListener("change", (event) => {
    state.tools = event.target.checked;
    preview();
  });
  el.querySelector("#json").addEventListener("change", (event) => {
    state.json = event.target.checked;
    preview();
  });
  el.querySelector("#system").addEventListener("input", (event) => {
    state.system = event.target.value;
    preview();
  });
  el.querySelectorAll("[data-persona]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.system = chip.dataset.persona;
      el.querySelector("#system").value = state.system;
      preview();
    });
  });
  el.querySelector("#attach").addEventListener("click", () => el.querySelector("#image-file").click());
  el.querySelector("#image-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.image = String(reader.result);
      el.querySelector("#image-note").textContent = `attached ${file.name} (${fmt.bytes(file.size)})`;
    };
    reader.readAsDataURL(file);
  });
  el.querySelector("#clear").addEventListener("click", () => {
    state.messages.length = 0;
    log.innerHTML = `<div class="empty" style="margin:auto"><h3>Conversation cleared</h3><p class="small">Send a message to start again.</p></div>`;
  });
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => state.controller?.abort());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
  });

  preview();
}
