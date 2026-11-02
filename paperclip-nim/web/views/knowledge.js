import { api, esc, icon, modal, num, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Knowledge";

export async function render(root, ctx) {
  const data = await api(`/api/companies/${ctx.companyId}/knowledge`);
  const docs = data.documents;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "NVIDIA NIM",
      title: "Knowledge",
      subtitle: `${docs.length} documents · embedded with ${esc((data.embedModel ?? "nvidia/nemotron-3.5-embed-8b").split("/").pop())} and reranked before every answer`,
      actions: `<button class="btn primary" data-action="new">${icon("plus", "nav-icon")} Add document</button>`,
    })}

    <div class="split" style="grid-template-columns:minmax(0,1.25fr) minmax(0,1fr)">
      <div class="card pad-0" style="overflow:hidden">
        <div class="row-between" style="padding:12px 14px;border-bottom:1px solid var(--border)">
          <div class="card-title" style="margin:0">Documents</div>
          <span class="hint">${num(docs.reduce((sum, doc) => sum + (doc.chars ?? 0), 0))} chars</span>
        </div>
        <div class="doc-list" id="doc-list">
          ${docs
            .map(
              (doc) => `<div class="doc" data-doc="${esc(doc.id)}">
                ${icon("knowledge", "nav-icon")}
                <div class="grow" style="min-width:0">
                  <div style="font-size:12.8px;font-weight:500" class="truncate">${esc(doc.title)}</div>
                  <div class="hint truncate">${esc((doc.body ?? "").slice(0, 110))}</div>
                </div>
                <div class="row" style="gap:4px">${(doc.tags ?? []).slice(0, 2).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</div>
              </div>`,
            )
            .join("") || `<div class="hint" style="padding:16px">No documents. Add one so agents can cite something.</div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Retrieval playground</div>
        <p class="hint" style="margin-bottom:10px">Runs the real pipeline: embed query → cosine over chunks → rerank with the NeMo Retriever ranking NIM.</p>
        <div class="row" style="gap:6px">
          <input class="input" id="retrieval-query" placeholder="e.g. why do trials stall on day three?" />
          <button class="btn primary" data-action="search">Search</button>
        </div>
        <div id="retrieval-results" class="stack" style="margin-top:12px"></div>
      </div>
    </div>
  `;

  root.querySelectorAll("[data-doc]").forEach((node) =>
    node.addEventListener("click", () => {
      const doc = docs.find((entry) => entry.id === node.dataset.doc);
      openDoc(ctx, doc, root);
    }),
  );

  root.querySelector('[data-action="new"]').addEventListener("click", () => openDoc(ctx, null, root));

  const search = async () => {
    const query = root.querySelector("#retrieval-query").value.trim();
    if (!query) return;
    const results = root.querySelector("#retrieval-results");
    results.innerHTML = `<div class="hint">Embedding and reranking…</div>`;
    try {
      const response = await api(`/api/companies/${ctx.companyId}/knowledge/search`, { method: "POST", body: { query, topK: 4 } });
      results.innerHTML = `
        <div class="hint">${response.candidates} chunks embedded · ${response.passages.length} reranked</div>
        ${response.passages
          .map(
            (passage, index) => `<div class="card tight" style="border-color:var(--border)">
              <div class="row-between" style="margin-bottom:4px">
                <span class="row" style="gap:6px;font-size:12px"><span class="pill accent">#${index + 1}</span>${esc(passage.title)}</span>
                <span class="mono" style="font-size:10.5px;color:var(--dim)">${Number(passage.score).toFixed(3)}</span>
              </div>
              <div class="hint" style="font-size:11.5px">${esc(passage.text.slice(0, 240))}…</div>
              <div class="progress" style="margin-top:6px"><i style="width:${Math.round(Number(passage.score) * 100)}%;background:var(--blue)"></i></div>
            </div>`,
          )
          .join("")}`;
    } catch (error) {
      results.innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
    }
  };
  root.querySelector('[data-action="search"]').addEventListener("click", search);
  root.querySelector("#retrieval-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
  });
}

function openDoc(ctx, doc, root) {
  modal({
    title: doc ? "Edit document" : "Add document",
    wide: true,
    submitLabel: doc ? "Save" : "Add to knowledge",
    footer: doc
      ? `<button class="btn danger" type="button" id="delete-doc">Delete</button><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn primary" type="submit" form="modal-form">Save</button>`
      : undefined,
    body: `
      <div class="field"><label>Title</label><input class="input" name="title" required value="${esc(doc?.title ?? "")}" placeholder="Activation metrics and definitions" /></div>
      <div class="field"><label>Body</label><textarea class="textarea" name="body" style="min-height:260px">${esc(doc?.body ?? "")}</textarea></div>
      <div class="field"><label>Tags (comma separated)</label><input class="input" name="tags" value="${esc((doc?.tags ?? []).join(", "))}" placeholder="metrics, activation" /></div>
    `,
    async onSubmit(data) {
      const payload = {
        title: data.title,
        body: data.body,
        tags: String(data.tags ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
      if (doc) await api(`/api/companies/${ctx.companyId}/knowledge/${doc.id}`, { method: "PATCH", body: payload });
      else await api(`/api/companies/${ctx.companyId}/knowledge`, { method: "POST", body: payload });
      toast(doc ? "Document saved" : "Document indexed");
      render(root, ctx);
    },
  });
  if (doc) {
    document.querySelector("#delete-doc")?.addEventListener("click", async () => {
      const lib = await import("../lib.js");
      const ok = await lib.confirmDialog({ title: `Delete “${doc.title}”?`, message: "Agents will no longer be able to cite this document.", confirmLabel: "Delete", danger: true });
      if (!ok) return;
      await api(`/api/companies/${ctx.companyId}/knowledge/${doc.id}`, { method: "DELETE" });
      toast("Document deleted");
      render(root, ctx);
    });
  }
}
