import { github } from "../github-client.js";

/**
 * Health score is computed deterministically from real signals (not an LLM guess).
 * This keeps the number reproducible; an LLM can narrate *why* separately if desired.
 */
function computeHealthScore(input: {
  daysSinceLastPush: number;
  openIssues: number;
  closedIssuesLast90d: number;
  contributorCount: number;
  archived: boolean;
}): { score: number; breakdown: Record<string, number> } {
  if (input.archived) {
    return { score: 0, breakdown: { archived_penalty: -100 } };
  }

  const breakdown: Record<string, number> = {};

  // Recency: full marks if pushed within 30 days, decays to 0 by 365 days
  breakdown.recency = Math.max(0, 35 * (1 - input.daysSinceLastPush / 365));

  // Issue triage ratio: are issues actually getting closed, or just piling up?
  const totalIssueActivity = input.openIssues + input.closedIssuesLast90d;
  breakdown.triage =
    totalIssueActivity === 0
      ? 20 // no issues at all isn't necessarily bad — neutral score
      : 30 * (input.closedIssuesLast90d / totalIssueActivity);

  // Contributor diversity: more independent contributors = lower bus-factor risk
  breakdown.contributors = Math.min(20, input.contributorCount * 2);

  // Baseline for having any real activity at all
  breakdown.baseline = 15;

  const score = Math.round(
    Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  );

  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

function scoreLabel(score: number): string {
  if (score >= 75) return "Healthy — actively maintained";
  if (score >= 50) return "Moderate — some activity, watch the trend";
  if (score >= 25) return "Weak — infrequent maintenance";
  return "Stale or abandoned";
}

export async function getRepoHealth(owner: string, repo: string) {
  const [repoMeta, contributors, closedIssues] = await Promise.all([
    github.getRepo(owner, repo),
    github.getContributors(owner, repo).catch(() => []), // some repos disable this
    github.getClosedIssuesRecent(owner, repo).catch(() => []),
  ]);

  const daysSinceLastPush = Math.floor(
    (Date.now() - new Date(repoMeta.pushed_at).getTime()) / 86_400_000
  );

  const ninetyDaysAgo = Date.now() - 90 * 86_400_000;
  const closedIssuesLast90d = closedIssues.filter(
    (i) => new Date(i.created_at).getTime() >= ninetyDaysAgo && !i.pull_request
  ).length;

  const { score, breakdown } = computeHealthScore({
    daysSinceLastPush,
    openIssues: repoMeta.open_issues_count,
    closedIssuesLast90d,
    contributorCount: contributors.length,
    archived: repoMeta.archived,
  });

  return {
    repo: repoMeta.full_name,
    description: repoMeta.description,
    health_score: score,
    health_label: scoreLabel(score),
    score_breakdown: breakdown,
    signals: {
      stars: repoMeta.stargazers_count,
      forks: repoMeta.forks_count,
      open_issues: repoMeta.open_issues_count,
      closed_issues_last_90d: closedIssuesLast90d,
      contributor_count: contributors.length,
      days_since_last_push: daysSinceLastPush,
      license: repoMeta.license?.name ?? "No license",
      archived: repoMeta.archived,
    },
  };
}
