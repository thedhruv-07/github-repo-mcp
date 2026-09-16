import { github } from "../github-client.js";

/**
 * Buckets commits by conventional-commit-style prefix when present (feat/fix/docs/refactor),
 * falling back to a heuristic keyword match on the message. This is the structured data
 * an LLM (on the client side, in the calling agent) turns into plain English — the tool's
 * job is to return clean, grouped facts, not to write the prose itself.
 */
type Bucket = "feature" | "fix" | "docs" | "refactor" | "chore" | "other";

const KEYWORD_MAP: Array<[RegExp, Bucket]> = [
  [/^feat(\(.+\))?:/i, "feature"],
  [/^fix(\(.+\))?:/i, "fix"],
  [/^docs?(\(.+\))?:/i, "docs"],
  [/^refactor(\(.+\))?:/i, "refactor"],
  [/^chore(\(.+\))?:/i, "chore"],
  [/\b(add|implement|introduce)\b/i, "feature"],
  [/\b(fix|bug|patch|resolve)\b/i, "fix"],
  [/\b(doc|readme)\b/i, "docs"],
  [/\b(refactor|cleanup|restructure)\b/i, "refactor"],
];

function classify(message: string): Bucket {
  const firstLine = message.split("\n")[0];
  for (const [pattern, bucket] of KEYWORD_MAP) {
    if (pattern.test(firstLine)) return bucket;
  }
  return "other";
}

export async function summarizeRecentCommits(owner: string, repo: string, days: number = 14) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const commits = await github.getCommits(owner, repo, since);

  const grouped: Record<Bucket, Array<{ sha: string; message: string; author: string; date: string }>> = {
    feature: [],
    fix: [],
    docs: [],
    refactor: [],
    chore: [],
    other: [],
  };

  for (const c of commits) {
    const bucket = classify(c.commit.message);
    grouped[bucket].push({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "unknown",
    });
  }

  const uniqueAuthors = new Set(commits.map((c) => c.commit.author?.name ?? "unknown"));

  return {
    repo: `${owner}/${repo}`,
    window_days: days,
    total_commits: commits.length,
    unique_authors: uniqueAuthors.size,
    grouped_by_type: grouped,
  };
}
