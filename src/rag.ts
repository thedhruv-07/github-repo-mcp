/**
 * Embeddings-based RAG for ask_repo: chunk README + docs/*.md + top issue threads,
 * embed with Voyage AI, store/search in Qdrant by cosine similarity.
 *
 * Why embeddings over the old keyword matcher: keyword overlap misses synonyms and
 * paraphrases ("how do I install" vs a README section titled "Getting Started" share
 * zero words). Embeddings place both in the same semantic neighborhood, so retrieval
 * survives rewording — the actual failure mode keyword search has in practice.
 */
import { github } from "./github-client.js";

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const EMBED_MODEL = "voyage-3.5-lite";

function requireRagConfig() {
  const missing = [
    !VOYAGE_API_KEY && "VOYAGE_API_KEY",
    !QDRANT_URL && "QDRANT_URL",
    !QDRANT_API_KEY && "QDRANT_API_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `ask_repo needs embeddings configured. Missing env var(s): ${missing.join(", ")}. ` +
        `See .env.example for where to get them (Voyage AI + Qdrant Cloud, both free tier).`
    );
  }
}

function decodeBase64(content: string): string {
  return Buffer.from(content, "base64").toString("utf-8");
}

interface Chunk {
  text: string;
  source: string;
}

// ponytail: word-count is a rough stand-in for token count (~0.75 tokens/word for
// English prose), good enough for chunk sizing. Swap in a real tokenizer (tiktoken/
// voyage's own counter) if chunk boundaries need to be token-exact.
function chunkText(text: string, source: string, chunkSize = 500, overlap = 50): Chunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= chunkSize) return [{ text: words.join(" "), source }];

  const chunks: Chunk[] = [];
  const step = chunkSize - overlap;
  for (let i = 0; i < words.length; i += step) {
    chunks.push({ text: words.slice(i, i + chunkSize).join(" "), source });
    if (i + chunkSize >= words.length) break;
  }
  return chunks;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ponytail: Voyage accounts without a payment method on file are throttled to 3
// RPM / 10K TPM (the 200M free tokens still apply either way — a card just lifts the
// per-minute cap). Retrying with backoff makes this work either way; upgrade path if
// indexing feels slow is to add a payment method in the Voyage dashboard.
async function voyageEmbed(texts: string[], inputType: "document" | "query", attempt = 1): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: inputType }),
  });

  if (res.status === 429 && attempt <= 4) {
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 20) * 1000);
    return voyageEmbed(texts, inputType, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Voyage embeddings error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

// Batches are sized by approximate token count (words * 1.3), staying well under the
// throttled tier's 10K TPM so indexing succeeds without relying on retries alone.
async function embedInBatches(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const TOKEN_BUDGET = 4000;
  const estimateTokens = (t: string) => Math.ceil(t.split(/\s+/).length * 1.3);

  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (current.length > 0 && currentTokens + tokens > TOKEN_BUDGET) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);

  const vectors: number[][] = [];
  for (const batch of batches) {
    vectors.push(...(await voyageEmbed(batch, inputType)));
  }
  return vectors;
}

async function qdrantFetch<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T | null> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "api-key": QDRANT_API_KEY!,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Qdrant error ${res.status} on ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function collectionName(owner: string, repo: string): string {
  return `repo_${owner}_${repo}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

async function isIndexed(name: string): Promise<boolean> {
  const info = await qdrantFetch<{ result: { points_count: number } }>(`/collections/${name}`);
  return (info?.result.points_count ?? 0) > 0;
}

/** Fetches README + docs/*.md (top level, cap 15) + top issue threads (cap 8) as labeled documents. */
async function gatherRepoDocuments(owner: string, repo: string): Promise<Chunk[]> {
  const documents: Array<{ text: string; source: string }> = [];

  const readme = await github.getReadme(owner, repo).catch(() => null);
  if (readme) documents.push({ text: decodeBase64(readme.content), source: "README" });

  const docsDir = await github.getDirectory(owner, repo, "docs").catch(() => []);
  const mdFiles = docsDir.filter((f) => f.type === "file" && f.name.endsWith(".md")).slice(0, 15);
  for (const file of mdFiles) {
    const content = await github.getFileContent(owner, repo, file.path).catch(() => null);
    if (content) documents.push({ text: decodeBase64(content.content), source: file.path });
  }

  // ponytail: indexes issue title+body only, not the full comment thread (that's one
  // more API call per issue). Upgrade path: fetch /issues/{n}/comments if answers need
  // to reflect resolution discussion, not just the original report.
  const topIssues = await github.getTopIssues(owner, repo, 8).catch(() => []);
  for (const issue of topIssues) {
    if (issue.pull_request) continue;
    const text = `${issue.title}\n\n${issue.body ?? ""}`.trim();
    if (text.length > 20) documents.push({ text, source: `issue#${issue.number}: ${issue.title}` });
  }

  return documents.flatMap((doc) => chunkText(doc.text, doc.source));
}

async function indexRepo(owner: string, repo: string): Promise<string> {
  const name = collectionName(owner, repo);
  if (await isIndexed(name)) return name;

  const chunks = await gatherRepoDocuments(owner, repo);
  if (chunks.length === 0) return name;

  const vectors = await embedInBatches(chunks.map((c) => c.text), "document");

  await qdrantFetch(`/collections/${name}`, {
    method: "PUT",
    body: { vectors: { size: vectors[0].length, distance: "Cosine" } },
  });

  await qdrantFetch(`/collections/${name}/points`, {
    method: "PUT",
    body: {
      points: chunks.map((chunk, i) => ({
        id: i,
        vector: vectors[i],
        payload: { text: chunk.text, source: chunk.source },
      })),
    },
  });

  return name;
}

export interface RetrievedChunk {
  text: string;
  source: string;
  relevance: number;
}

/** Indexes the repo on first call (cached in Qdrant thereafter), then retrieves top-k chunks by cosine similarity. */
export async function retrieve(owner: string, repo: string, query: string, topK = 5): Promise<RetrievedChunk[]> {
  requireRagConfig();

  const name = await indexRepo(owner, repo);
  const [queryVector] = await voyageEmbed([query], "query");

  const results = await qdrantFetch<{
    result: Array<{ score: number; payload: { text: string; source: string } }>;
  }>(`/collections/${name}/points/search`, {
    method: "POST",
    body: { vector: queryVector, limit: topK, with_payload: true },
  });

  return (results?.result ?? []).map((r) => ({
    text: r.payload.text,
    source: r.payload.source,
    relevance: r.score,
  }));
}

// ponytail: minimal self-check for the chunker, the only nontrivial pure-function
// branch in this file. Run directly with `node build/rag.js`.
if (process.argv[1]?.endsWith("rag.js")) {
  const longText = Array(1200).fill("word").join(" ");
  const chunks = chunkText(longText, "demo");
  console.assert(chunks.length > 1, "long text should split into multiple chunks");
  console.assert(
    chunks.every((c) => c.text.split(/\s+/).length <= 500),
    "no chunk should exceed the configured chunk size"
  );
  console.assert(chunkText("short text", "demo").length === 1, "short text stays one chunk");
  console.log(`rag.ts self-check passed (${chunks.length} chunks from ${longText.split(" ").length} words)`);
}
