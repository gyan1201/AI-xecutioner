/**
 * Hybrid retrieval over company knowledge: embed → cosine → rerank.
 *
 * Both halves are real NIM calls (embeddings + ranking). Vectors are cached per
 * document body so re-running an issue does not re-embed unchanged text.
 */

import { cosine } from "../nim/sim.mjs";

const CHUNK_CHARS = 620;
const cache = new Map(); // `${docId}:${hash}` → { chunks: [{ text, vector }] }

function hashString(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export function chunkText(body, size = CHUNK_CHARS) {
  const paragraphs = String(body ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + paragraph).length > size && current) {
      chunks.push(current.trim());
      current = "";
    }
    if (paragraph.length > size) {
      for (let i = 0; i < paragraph.length; i += size) chunks.push(paragraph.slice(i, i + size));
      continue;
    }
    current += `${paragraph}\n\n`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [String(body ?? "").slice(0, size)];
}

export function clearRetrievalCache() {
  cache.clear();
}

export async function indexCompany({ company, nim, signal }) {
  const docs = company.knowledge ?? [];
  const indexed = [];
  for (const doc of docs) {
    const key = `${doc.id}:${hashString(doc.body)}`;
    if (cache.has(key)) {
      indexed.push({ doc, chunks: cache.get(key).chunks });
      continue;
    }
    const chunks = chunkText(doc.body);
    const result = await nim.embed({ input: chunks, inputType: "passage", signal });
    const rows = chunks.map((text, index) => ({ text, vector: result.vectors[index] ?? [] }));
    cache.set(key, { chunks: rows, model: result.model });
    indexed.push({ doc, chunks: rows });
  }
  return indexed;
}

/**
 * @returns {{ passages: Array<{docId,title,text,score,rerankScore,rank,index}>, embedModel, rerankModel, candidates }}
 */
export async function searchKnowledge({ company, nim, query, topK = 4, signal, useRerank = true }) {
  const indexed = await indexCompany({ company, nim, signal });
  if (!indexed.length) return { passages: [], candidates: 0, embedModel: null, rerankModel: null };
  const queryVector = (await nim.embed({ input: [query], inputType: "query", signal })).vectors[0] ?? [];

  const candidates = [];
  for (const { doc, chunks } of indexed) {
    for (const chunk of chunks) {
      candidates.push({
        docId: doc.id,
        title: doc.title,
        tags: doc.tags ?? [],
        text: chunk.text,
        vector: chunk.vector,
        score: cosine(queryVector, chunk.vector),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const shortlist = candidates.slice(0, Math.min(12, candidates.length));

  let ranked = shortlist;
  let rerankModel = null;
  if (useRerank && shortlist.length > 1) {
    const rerank = await nim.rerank({
      query,
      passages: shortlist.map((candidate) => candidate.text),
      topN: Math.min(topK, shortlist.length),
      signal,
    });
    rerankModel = rerank.model;
    ranked = rerank.rankings.map((row, position) => ({
      ...shortlist[row.index],
      rerankScore: row.score,
      rank: position + 1,
      score: row.score,
    }));
  } else {
    ranked = shortlist.slice(0, topK).map((row, index) => ({ ...row, rank: index + 1, rerankScore: null }));
  }

  return {
    passages: ranked.map(({ vector, ...rest }) => rest),
    candidates: candidates.length,
    embedModel: indexed[0]?.doc ? cache.get(`${indexed[0].doc.id}:${hashString(indexed[0].doc.body)}`)?.model ?? null : null,
    rerankModel,
  };
}

/** Prompt-ready context block with source markers the review gate can check. */
export function renderContext(passages = []) {
  if (!passages.length) return "<knowledge>\n(no company knowledge matched this request)\n</knowledge>";
  const body = passages
    .map((passage, index) => `[${index + 1}] ${passage.title} — ${passage.text.replace(/\s+/g, " ").slice(0, 700)}`)
    .join("\n\n");
  return `<knowledge>\n${body}\n</knowledge>`;
}
