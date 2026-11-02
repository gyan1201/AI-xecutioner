import { api, esc, fmt, optionList, reportError, toast } from "../lib.js";

const SIZES = ["1024x1024", "1344x768", "768x1344"];
const IDEAS = [
  "Dark control room with a glowing green neural core, cinematic lighting, product marketing visual",
  "Minimal SaaS hero illustration, dark background, lime accents, isometric data pipelines",
  "Abstract NVIDIA-green energy ribbons forming a company org chart, 3D render",
];

export async function render(el, ctx) {
  const catalog = await api.get("/api/models").catch(() => ({ models: [] }));
  const imageModels = catalog.models.filter((model) => model.capabilities.includes("image"));
  const defaultModel = catalog.roles?.artist?.model ?? imageModels[0]?.id ?? "";

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-4)">
      <div>
        <h1 style="font-size:26px">Visual studio</h1>
        <p class="muted small" style="margin-top:6px">
          NVIDIA-hosted diffusion endpoints (<code>/v1/genai/{publisher}/{model}</code>). Generated visuals are saved as run artifacts when the autopilot asks for them.
        </p>
      </div>
      <span class="badge badge-dim">${imageModels.length} image models</span>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Prompt</span></div>
          <textarea id="prompt" rows="4" placeholder="Describe the visual…"></textarea>
          <div class="field-row" style="margin-top:var(--space-3)">
            <div class="field">
              <label for="model">Model</label>
              <select id="model">${optionList(imageModels.length ? imageModels : [{ id: defaultModel }], defaultModel, { labelKey: "id" })}</select>
            </div>
            <div class="field">
              <label for="size">Size</label>
              <select id="size">${SIZES.map((size) => `<option value="${size}">${size}</option>`).join("")}</select>
            </div>
            <div class="field">
              <label for="steps">Steps <span class="faint">(optional)</span></label>
              <input type="number" id="steps" min="1" max="60" placeholder="auto" />
            </div>
          </div>
          <div class="row-wrap" style="margin-top:var(--space-3)">
            <button class="btn btn-primary" id="generate">Generate</button>
            <button class="btn btn-ghost btn-sm" id="enhance">Improve prompt with NIM</button>
            <span class="tiny faint" id="studio-note"></span>
          </div>
          <div class="chips" style="margin-top:var(--space-3)">
            ${IDEAS.map((idea) => `<button class="chip" data-idea="${esc(idea)}">${esc(idea.slice(0, 42))}…</button>`).join("")}
          </div>
        </div>
        <div id="output"></div>
      </div>

      <div class="side-stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Notes</span></div>
          <p class="small muted">
            Response shapes differ by family: NVIDIA/Stability endpoints take <code>text_prompts</code>, FLUX-style endpoints take
            <code>prompt</code>. The server sends the family-appropriate payload and reads <code>artifacts[].base64</code>.
          </p>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">In autopilot</span></div>
          <p class="small muted">
            The operator agent can call <code>generate_visual</code> mid-run. Images land in the run's artifacts panel next to the markdown deliverables.
          </p>
        </div>
      </div>
    </div>
  `;

  const output = el.querySelector("#output");

  el.querySelectorAll("[data-idea]").forEach((chip) => {
    chip.addEventListener("click", () => {
      el.querySelector("#prompt").value = chip.dataset.idea;
    });
  });

  el.querySelector("#enhance").addEventListener("click", async (event) => {
    const prompt = el.querySelector("#prompt").value.trim();
    if (!prompt) return toast("Write a rough prompt first.", "warn");
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const model = ctx.state.status?.roles?.operator?.model;
      const response = await api.post("/api/chat", {
        model,
        maxTokens: 300,
        messages: [
          { role: "system", content: "You rewrite image prompts for diffusion models. Return one vivid prompt, no preamble, under 60 words." },
          { role: "user", content: prompt },
        ],
      });
      el.querySelector("#prompt").value = String(response.content ?? "").trim();
      toast("Prompt rewritten");
    } catch (error) {
      reportError(error);
    } finally {
      button.disabled = false;
    }
  });

  el.querySelector("#generate").addEventListener("click", async (event) => {
    const prompt = el.querySelector("#prompt").value.trim();
    if (!prompt) return toast("Describe the visual first.", "warn");
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> generating`;
    output.innerHTML = `<div class="card flat"><span class="spinner"></span> <span class="small faint">rendering with ${esc(el.querySelector("#model").value)}…</span></div>`;
    try {
      const started = Date.now();
      const result = await api.post("/api/images", {
        prompt,
        model: el.querySelector("#model").value,
        size: el.querySelector("#size").value,
        steps: Number(el.querySelector("#steps").value) || undefined,
      });
      const artifact = result.artifacts?.[0];
      if (!artifact) throw new Error("The endpoint returned no image artifact.");
      const src = `data:${artifact.mimeType ?? "image/jpeg"};base64,${artifact.base64}`;
      output.innerHTML = `
        <div class="card">
          <div class="card-head">
            <span class="card-title">Result</span>
            <div class="row">
              <span class="badge ${result.simulated ? "badge-amber" : "badge-green"}">${result.simulated ? "simulated" : "live NIM"}</span>
              <a class="btn btn-sm btn-ghost" href="${src}" download="nvidia-visual.${artifact.mimeType?.includes("svg") ? "svg" : "jpg"}">Download</a>
            </div>
          </div>
          <div class="figure"><img src="${src}" alt="${esc(prompt)}" /></div>
          <div class="row-wrap tiny faint" style="margin-top:10px">
            <span class="mono">${esc(result.model ?? "")}</span>
            <span>· ${fmt.duration(started, Date.now())}</span>
            <span>· ${fmt.bytes(Math.round((artifact.base64.length * 3) / 4))}</span>
          </div>
        </div>`;
    } catch (error) {
      reportError(error);
      output.innerHTML = `<div class="banner red"><span>✕</span><div><strong>Generation failed.</strong> ${esc(error.message)}${error.hint ? ` — ${esc(error.hint)}` : ""}</div></div>`;
    } finally {
      button.disabled = false;
      button.textContent = "Generate";
    }
  });
}
