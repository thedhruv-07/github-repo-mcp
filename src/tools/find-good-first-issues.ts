import { github, type Issue } from "../github-client.js";

const BEGINNER_LABELS = [
  "good first issue",
  "good-first-issue",
  "help wanted",
  "beginner friendly",
  "beginner-friendly",
  "easy",
  "starter",
];

// Words that suggest an issue touches deep/architectural code, despite its label —
// this is the "catch the mislabeled issue" logic that makes this tool worth building.
const RED_FLAG_PATTERNS = [
  /\bcore (architecture|engine|logic)\b/i,
  /\bbreaking change\b/i,
  /\brewrite\b/i,
  /\bmigrat(e|ion)\b/i,
  /\bperformance regression\b/i,
  /\bsecurity\b/i,
  /\brace condition\b/i,
];

function labelNames(issue: Issue): string[] {
  return issue.labels.map((l) => (typeof l === "string" ? l : l.name).toLowerCase());
}

function hasBeginnerLabel(issue: Issue): boolean {
  const names = labelNames(issue);
  return BEGINNER_LABELS.some((bl) => names.includes(bl));
}

interface ScoredIssue {
  number: number;
  title: string;
  url: string;
  comments: number;
  age_days: number;
  clarity_score: number; // 0-100, higher = clearer scope
  flags: string[];
  verdict: "good" | "caution" | "skip";
}

function scoreIssue(issue: Issue): ScoredIssue {
  const flags: string[] = [];
  const text = `${issue.title} ${issue.body ?? ""}`;

  let clarity = 60; // baseline

  // Body length: too short = underspecified, wildly long = probably not beginner scope
  const bodyLen = (issue.body ?? "").length;
  if (bodyLen < 20) {
    clarity -= 20;
    flags.push("Very short description — scope may be unclear");
  } else if (bodyLen > 2000) {
    clarity -= 15;
    flags.push("Long, complex description — may not be truly beginner-scoped");
  } else {
    clarity += 10;
  }

  // Red flag keywords despite the beginner label
  for (const pattern of RED_FLAG_PATTERNS) {
    if (pattern.test(text)) {
      clarity -= 25;
      flags.push(`Mentions "${pattern.source.replace(/\\b|\(|\)|\|/g, " ").trim()}" — likely mislabeled`);
    }
  }

  // High comment count often means unresolved debate about approach — riskier for a first contribution
  if (issue.comments > 10) {
    clarity -= 10;
    flags.push("High comment count — may involve unresolved design debate");
  }

  // Very old, untouched issues may already be stale/abandoned by maintainers
  const ageDays = Math.floor((Date.now() - new Date(issue.created_at).getTime()) / 86_400_000);
  if (ageDays > 365) {
    flags.push("Open for over a year — confirm it's still relevant before starting");
  }

  clarity = Math.max(0, Math.min(100, clarity));

  const verdict: ScoredIssue["verdict"] =
    clarity >= 60 ? "good" : clarity >= 35 ? "caution" : "skip";

  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    comments: issue.comments,
    age_days: ageDays,
    clarity_score: clarity,
    flags,
    verdict,
  };
}

export async function findGoodFirstIssues(owner: string, repo: string) {
  const candidateLabelQueries = ["good first issue", "help wanted"];
  const seen = new Map<number, Issue>();

  for (const label of candidateLabelQueries) {
    const issues = await github.getOpenIssues(owner, repo, label).catch(() => []);
    for (const issue of issues) {
      if (!issue.pull_request) seen.set(issue.number, issue);
    }
  }

  // Also pull recent open issues generally, in case labels are used inconsistently,
  // and keep only the ones that actually carry a beginner-style label.
  const general = await github.getOpenIssues(owner, repo).catch(() => []);
  for (const issue of general) {
    if (!issue.pull_request && hasBeginnerLabel(issue)) seen.set(issue.number, issue);
  }

  const scored = Array.from(seen.values())
    .map(scoreIssue)
    .sort((a, b) => b.clarity_score - a.clarity_score);

  return {
    repo: `${owner}/${repo}`,
    candidates_found: scored.length,
    issues: scored,
  };
}
