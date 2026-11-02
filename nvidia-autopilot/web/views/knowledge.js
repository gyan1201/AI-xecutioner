import { api, esc, fmt, md, reportError, toast } from "../lib.js";

export async function render(el, ctx) {
  const stats = await api.get("/api/knowledge").catch(() => ({ documentsList: [], chunks: 0, pending: 0 }));

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-4)">
      <div>
        <h1 style="font-size:26px">Knowledge & RAG</h1>
        <p class="muted small" style="margin-top:6px">
          Documents are chunked, embedded with NeMo Retriever, shortlisted by cosine similarity and re-ordered by the NVIDIA reranker.
          Autopilot agents cite this corpus as <code>[K1]</code>, <code>[K2]</code> …
        </p>
      </div>
      <div class="row">
        <span class="pill">${stats.chunks} chunks</span>
        <span class="pill">${stats.documentsList?.length ?? 0} docs</span>
        <span class="pill ${stats.pending ? "badge-amber" : ""}">${stats.pending ?? 0} pending</span>
      </div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Add company knowledge</span></div>
          <div class="field" style="margin-bottom:var(--space-3)">
            <label for="title">Title</label>
            <input id="title" placeholder="e.g. Northwind Q3 strategy memo" />
          </div>
          <div class="field">
            <label for="text">Text <span class="faint">(markdown or plain text)</span></label>
            <textarea id="text" rows="8" placeholder="Paste strategy docs, pricing sheets, customer research, policies…"></textarea>
          </div>
          <div class="row-wrap" style="margin-top:var(--space-3)">
            <button class="btn btn-primary" id="add">Add document</button>
            <label class="btn btn-ghost btn-sm" for="file">Import .md / .txt</label>
            <input type="file" id="file" accept=".md,.txt,.markdown,text/plain" class="hide" />
            <span class="tiny faint" id="add-note"></span>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">Documents</span>
            <button class="btn btn-sm" id="index">${stats.pending ? `Index ${stats.pending} pending →` : "Re-index"}</button>
          </div>
          ${
            stats.documentsList?.length
              ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th class="num">Chars</th><th class="num">Chunks</th><th></th></tr></thead><tbody>
                  ${stats.documentsList
                    .map(
                      (doc) => `<tr>
                        <td>${esc(doc.title)}<div class="tiny faint">${esc(doc.source ?? "upload")} · ${fmt.date(doc.createdAt)}</div></td>
                        <td class="num">${fmt.number(doc.chars)}</td>
                        <td class="num">${doc.chunks || "—"}</td>
                        <td><button class="btn btn-sm btn-ghost" data-remove="${esc(doc.id)}">Remove</button></td>
                      </tr>`,
                    )
                    .join("")}
                </tbody></table></div>`
              : `<div class="empty"><h3>No documents yet</h3><p class="small">Add a strategy memo or pricing sheet — autopilot will retrieve and cite it.</p></div>`
          }
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Retrieval test</span></div>
          <div class="row-wrap">
            <input id="query" placeholder="Ask something only your documents could answer…" style="flex:1;min-width:240px" />
            <select id="topK" style="width:110px">
              <option value="3">top 3</option>
              <option value="5" selected>top 5</option>
              <option value="10">top 10</option>
            </select>
            <label class="check"><input type="checkbox" id="rerank" checked /> rerank</label>
            <button class="btn btn-primary" id="search">Search</button>
          </div>
          <div id="results" style="margin-top:var(--space-3)"></div>
        </div>
      </div>

      <div class="side-stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Pipeline</span></div>
          <ol class="small muted" style="margin:0;padding-left:18px;line-height:1.9">
            <li>Chunk at ~900 chars with 120 char overlap.</li>
            <li>Embed as <code>passage</code> with the embedder role model.</li>
            <li>Embed the query as <code>query</code>.</li>
            <li>Cosine shortlist to 4× top-k.</li>
            <li>Rerank with the reranker role model.</li>
            <li>Inject the top-k passages as <code>[K#]</code> context.</li>
          </ol>
          <div class="kv" style="margin-top:var(--space-3)">
            <dt>Embedder</dt><dd class="mono tiny">${esc(ctx.state.status?.roles?.embedder?.model ?? "—")}</dd>
            <dt>Reranker</dt><dd class="mono tiny">${esc(ctx.state.status?.roles?.reranker?.model ?? "—")}</dd>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Where it lives</span></div>
          <p class="small muted">Stored on this machine under <code>data/knowledge/</code>. Nothing is uploaded anywhere except to the NIM endpoints you configure.</p>
        </div>
      </div>
    </div>
  `;

  const addDocument = async (title, text) => {
    if (!text.trim()) return toast("Add some text first.", "warn");
    try {
      await api.post("/api/knowledge", { title, text });
      toast("Document added — index it to make it retrievable");
      await ctx.refresh();
      location.reload();
    } catch (error) {
      reportError(error);
    }
  };

  el.querySelector("#add").addEventListener("click", () =>
    addDocument(el.querySelector("#title").value.trim(), el.querySelector("#text").value),
  );

  el.querySelector("#file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    el.querySelector("#title").value = el.querySelector("#title").value || file.name.replace(/\.\w+$/, "");
    el.querySelector("#text").value = text;
    el.querySelector("#add-note").textContent = `loaded ${file.name} (${fmt.bytes(file.size)})`;
  });

  el.querySelector("#index").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> indexing`;
    try {
      const result = await api.post("/api/knowledge/index", {});
      toast(`Indexed ${result.indexed} document(s) · ${result.chunks} chunks`);
      location.reload();
    } catch (error) {
      reportError(error);
      button.disabled = false;
      button.textContent = "Re-index";
    }
  });

  el.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this document and its vectors?")) return;
      try {
        await api.del(`/api/knowledge/${button.dataset.remove}`);
        toast("Document removed");
        location.reload();
      } catch (error) {
        reportError(error);
      }
    });
  });

  el.querySelector("#search").addEventListener("click", async (event) => {
    const query = el.querySelector("#query").value.trim();
    if (!query) return toast("Enter a query.", "warn");
    const button = event.currentTarget;
    const results = el.querySelector("#results");
    button.disabled = true;
    results.innerHTML = `<span class="spinner"></span> <span class="small faint">retrieving…</span>`;
    try {
      const response = await api.post("/api/knowledge/search", {
        query,
        topK: Number(el.querySelector("#topK").value),
        rerank: el.querySelector("#rerank").checked,
      });
      if (!response.passages?.length) {
        results.innerHTML = `<div class="empty"><h3>No matches</h3><p class="small">Index your documents first, or try a different query.</p></div>`;
      } else {
        results.innerHTML = `
          <div class="row-wrap" style="margin-bottom:8px">
            <span class="badge ${response.reranked ? "badge-green" : "badge-dim"}">${response.reranked ? "reranked" : "cosine only"}</span>
            <span class="tiny faint">${response.passages.length} passages</span>
          </div>
          <div class="stack">
            ${response.passages
              .map(
                (passage, index) => `<div class="card flat tight">
                  <div class="spread" style="margin-bottom:6px">
                    <span class="badge badge-green">K${index + 1}</span>
                    <span class="tiny mono faint">${esc(passage.title ?? "")} · score ${(passage.rerankScore ?? passage.score ?? 0).toFixed(3)}</span>
                  </div>
                  <div class="small muted">${md(passage.text)}</div>
                </div>`,
              )
              .join("")}
          </div>`;
      }
    } catch (error) {
      reportError(error);
      results.innerHTML = "";
    } finally {
      button.disabled = false;
    }
  });
}
