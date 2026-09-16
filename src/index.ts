#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getRepoHealth } from "./tools/get-repo-health.js";
import { summarizeRecentCommits } from "./tools/summarize-commits.js";
import { findGoodFirstIssues } from "./tools/find-good-first-issues.js";
import { askRepo } from "./tools/ask-repo.js";

const server = new McpServer({
  name: "github-repo-mcp",
  version: "0.1.0",
});

const repoArgs = {
  owner: z.string().describe("Repository owner or organization, e.g. 'anthropics'"),
  repo: z.string().describe("Repository name, e.g. 'anthropic-sdk-python'"),
};

server.registerTool(
  "get_repo_health",
  {
    title: "Get Repo Health",
    description:
      "Computes a maintenance-health score (0-100) for a public GitHub repo from " +
      "commit recency, issue-triage ratio, and contributor diversity. Use this before " +
      "deciding whether to depend on or contribute to a repo.",
    inputSchema: repoArgs,
  },
  async ({ owner, repo }) => {
    const result = await getRepoHealth(owner, repo);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "summarize_recent_commits",
  {
    title: "Summarize Recent Commits",
    description:
      "Fetches commits from the last N days and groups them by type (feature/fix/docs/" +
      "refactor/chore) so an agent can describe what changed without reading raw commit logs.",
    inputSchema: {
      ...repoArgs,
      days: z.number().int().min(1).max(180).default(14).describe("Lookback window in days"),
    },
  },
  async ({ owner, repo, days }) => {
    const result = await summarizeRecentCommits(owner, repo, days);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "find_good_first_issues",
  {
    title: "Find Good First Issues",
    description:
      "Finds open issues labeled for beginners/first-time contributors, then scores each " +
      "for genuine clarity of scope and flags ones that look mislabeled (e.g. touches core " +
      "architecture despite the 'good first issue' label).",
    inputSchema: repoArgs,
  },
  async ({ owner, repo }) => {
    const result = await findGoodFirstIssues(owner, repo);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "ask_repo",
  {
    title: "Ask Repo",
    description:
      "Answers a free-text question about a repo by retrieving relevant excerpts from its " +
      "README. Use this for questions the other structured tools can't answer directly, " +
      "e.g. 'does this support TypeScript?' or 'how do I configure X?'",
    inputSchema: {
      ...repoArgs,
      query: z.string().describe("The question to answer about this repo"),
    },
  },
  async ({ owner, repo, query }) => {
    const result = await askRepo(owner, repo, query);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("github-repo-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
