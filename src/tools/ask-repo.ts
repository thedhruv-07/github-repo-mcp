import { retrieve } from "../rag.js";

/**
 * Answers a free-text question by embedding it and retrieving the most semantically
 * similar chunks from README + docs/*.md + top issue threads (cosine similarity over
 * Voyage AI embeddings, stored in Qdrant). See rag.ts for the indexing/retrieval logic
 * and why this replaced the earlier keyword-window version.
 */
export async function askRepo(owner: string, repo: string, query: string) {
  const matches = await retrieve(owner, repo, query);

  if (matches.length === 0) {
    return {
      repo: `${owner}/${repo}`,
      query,
      answer_context: [],
      note: "No indexable content found (no README, docs/*.md, or issues with enough text).",
    };
  }

  return {
    repo: `${owner}/${repo}`,
    query,
    answer_context: matches,
    note:
      "Context retrieved via embeddings-based semantic search (Voyage AI + Qdrant cosine " +
      "similarity) over README, docs/*.md, and top issue threads. The calling agent should " +
      "synthesize an answer from these excerpts.",
  };
}
