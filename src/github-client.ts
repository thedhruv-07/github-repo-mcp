/**
 * Thin wrapper around the GitHub REST API (v3).
 * Uses a personal access token if provided (higher rate limit: 5000/hr vs 60/hr unauthenticated).
 */

const GITHUB_API_BASE = "https://api.github.com";
const token = process.env.GITHUB_TOKEN;

interface FetchOptions {
  method?: string;
  params?: Record<string, string | number>;
}

async function githubFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const url = new URL(`${GITHUB_API_BASE}${path}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-repo-mcp",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url.toString(), { method: options.method ?? "GET", headers });

  if (res.status === 404) {
    throw new Error(`Repository or resource not found: ${path}`);
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(
      `GitHub API rate limit or permission error (remaining: ${remaining ?? "unknown"}). ` +
        `Set GITHUB_TOKEN env var to raise limits.`
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

export interface RepoMeta {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license: { name: string } | null;
  pushed_at: string;
  created_at: string;
  default_branch: string;
  archived: boolean;
}

export interface Commit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  comments: number;
  created_at: string;
  html_url: string;
  pull_request?: unknown; // present if this "issue" is actually a PR
}

export interface Contributor {
  login: string;
  contributions: number;
}

export const github = {
  getRepo: (owner: string, repo: string) => githubFetch<RepoMeta>(`/repos/${owner}/${repo}`),

  getCommits: (owner: string, repo: string, since: string) =>
    githubFetch<Commit[]>(`/repos/${owner}/${repo}/commits`, {
      params: { since, per_page: 100 },
    }),

  getContributors: (owner: string, repo: string) =>
    githubFetch<Contributor[]>(`/repos/${owner}/${repo}/contributors`, {
      params: { per_page: 100 },
    }),

  getOpenIssues: (owner: string, repo: string, labels?: string) =>
    githubFetch<Issue[]>(`/repos/${owner}/${repo}/issues`, {
      params: { state: "open", per_page: 50, ...(labels ? { labels } : {}) },
    }),

  getClosedIssuesRecent: (owner: string, repo: string) =>
    githubFetch<Issue[]>(`/repos/${owner}/${repo}/issues`, {
      params: { state: "closed", per_page: 50, sort: "updated", direction: "desc" },
    }),

  getReadme: (owner: string, repo: string) =>
    githubFetch<{ content: string; encoding: string }>(`/repos/${owner}/${repo}/readme`),

  getFileContent: (owner: string, repo: string, path: string) =>
    githubFetch<{ content: string; encoding: string }>(
      `/repos/${owner}/${repo}/contents/${path}`
    ),

  getDirectory: (owner: string, repo: string, path: string) =>
    githubFetch<Array<{ name: string; path: string; type: string }>>(
      `/repos/${owner}/${repo}/contents/${path}`
    ),

  // sort=comments surfaces the issues with the most discussion, a decent proxy
  // for "threads worth indexing" without fetching every comment on every issue.
  getTopIssues: (owner: string, repo: string, limit: number) =>
    githubFetch<Issue[]>(`/repos/${owner}/${repo}/issues`, {
      params: { state: "all", sort: "comments", direction: "desc", per_page: limit },
    }),
};
