/**
 * Retrieval-augmented generation over the company knowledge base.
 *
 * Pipeline: chunk -> embed (passage) -> cosine shortlist -> NIM rerank -> top-k.
 * This is the same embed/rerank pairing NVIDIA documents for NeMo Retriever,
 * so swapping in a self-hosted NIM only changes the base URL.
 */

const DEFAULT_EMBED_MODEL = "nvidia/llama-3.2-nv-embedqa-1b-v2";
const DEFAULT_RERANK_MODEL = "nvidia/llama-3.2-nv-rerankqa-1b-v2";

export function chunkText(text, { size = 900, overlap = 120 } = {}) {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf("\n\n", end), clean.lastIndexOf(". ", end), clean.lastIndexOf(" ", end));
      if (boundary > start + size * 0.5) end = boundary + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function cosine(a, b) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedMany(nim, { model, inputs, inputType }) {
  const batches = [];
  for (let index = 0; index < inputs.length; index += 16) batches.push(inputs.slice(index, index + 16));
  const vectors = [];
  for (const batch of batches) {
    const response = await nim.embed({ model, input: batch, inputType });
    const data = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const entry of data) vectors.push(entry.embedding);
  }
  return vectors;
}

export function createRetrieval({ nim, store }) {
  return {
    /**
     * Index every pending document. Chunk + embed, then persist the vectors so
     * follow-up searches only need a query embedding.
     */
    async indexPending({ embedModel = DEFAULT_EMBED_MODEL, signal } = {}) {
      const index = store.readKnowledge();
      const pending = index.pending ?? [];
      if (!pending.length) return { indexed: 0, chunks: index.chunks.length };
      let indexed = 0;
      for (const entry of pending) {
        const document = index.documents.find((doc) => doc.id === entry.documentId);
        if (!document) continue;
        const pieces = chunkText(entry.text);
        const vectors = await embedMany(nim, {
          model: embedModel,
          inputs: pieces,
          inputType: "passage",
        });
        pieces.forEach((text, position) => {
          index.chunks.push({
            id: `${entry.documentId}:${position}`,
            documentId: entry.documentId,
            title: document.title,
            position,
            text,
            vector: vectors[position],
          });
        });
        document.chunks = pieces.length;
        document.embedModel = embedModel;
        indexed += 1;
        if (signal?.aborted) break;
      }
      const next = {
        ...index,
        documents: index.documents,
        chunks: index.chunks,
        pending: [],
        updatedAt: new Date().toISOString(),
      };
      store.writeKnowledge(next);
      return { indexed, chunks: next.chunks.length };
    },

    async search(query, { topK = 5, embedModel = DEFAULT_EMBED_MODEL, rerankModel = DEFAULT_RERANK_MODEL, useRerank = true, signal } = {}) {
      const index = store.readKnowledge();
      if (!index.chunks?.length) return { passages: [], simulated: false, source: "empty" };
      const { data } = await nim.embed({ model: embedModel, input: [query], inputType: "query", signal });
      const queryVector = data?.[0]?.embedding ?? [];
      const shortlist = index.chunks
        .map((chunk) => ({ ...chunk, vector: undefined, score: cosine(queryVector, chunk.vector ?? []) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(topK * 4, 20));
      let passages = shortlist.map((chunk) => ({
        chunkId: chunk.id,
        title: chunk.title,
        text: chunk.text,
        score: chunk.score,
      }));
      let reranked = false;
      if (useRerank && passages.length > 1) {
        try {
          const response = await nim.rerank({
            model: rerankModel,
            query,
            passages: passages.map((passage) => ({ text: passage.text })),
            signal,
          });
          const order = (response.rankings ?? []).map((ranking) => ({ index: ranking.index, logit: ranking.logit }));
          if (order.length) {
            passages = order
              .map(({ index: position, logit }) => ({ ...passages[position], rerankScore: logit }))
              .filter(Boolean);
            reranked = true;
          }
        } catch (error) {
          // A reranker failure must not break generation; lexical scores remain.
          if (error?.name !== "AbortError") reranked = false;
          else throw error;
        }
      }
      return { passages: passages.slice(0, topK), reranked, source: "knowledge" };
    },

    async stats() {
      const index = store.readKnowledge();
      return {
        documents: index.documents?.length ?? 0,
        chunks: index.chunks?.length ?? 0,
        pending: index.pending?.length ?? 0,
        updatedAt: index.updatedAt ?? null,
        documentsList: (index.documents ?? []).map(({ id, title, chars, chunks, source, createdAt }) => ({
          id,
          title,
          chars,
          chunks,
          source,
          createdAt,
        })),
      };
    },
  };
}
