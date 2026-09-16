# github-repo-mcp

An MCP (Model Context Protocol) server that lets any AI agent — Claude Desktop, Claude
Code, Cursor — reason about a public GitHub repository directly, instead of the human
manually reading READMEs, commit logs, and issue trackers.

## Why this exists

Evaluating an unfamiliar repo ("is this actively maintained? is this issue actually
beginner-friendly? what changed recently?") is repetitive manual work every developer
does. This server turns that into four callable tools any MCP-compatible agent can use.

## Tools

| Tool | What it does |
|---|---|
| `get_repo_health` | Deterministic 0–100 health score from commit recency, issue-triage ratio, and contributor count. Flags archived repos immediately. |
| `summarize_recent_commits` | Groups commits from the last N days by type (feature/fix/docs/refactor/chore) for a quick "what changed" view. |
| `find_good_first_issues` | Finds beginner-labeled issues, scores each for genuine clarity, and flags ones that look mislabeled (e.g. touches core architecture despite the "good first issue" tag). |
| `ask_repo` | Free-text Q&A over README + `docs/*.md` + top issue threads via embeddings-based semantic search (Voyage AI + Qdrant cosine similarity). |

## Setup

```bash
npm install
cp .env.example .env
# Add a GitHub personal access token to .env — raises the rate limit from 60/hr to 5000/hr.
# No special scopes needed for public repo data: https://github.com/settings/tokens
#
# ask_repo also needs, both free tier:
#   VOYAGE_API_KEY  — https://dashboard.voyageai.com/ (API Keys -> Create new key)
#   QDRANT_URL, QDRANT_API_KEY — https://cloud.qdrant.io/ (create a free cluster)
npm run build
```

## Running locally with Claude Desktop

Add this to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github-repo-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/github-repo-mcp/build/index.js"],
      "env": { "GITHUB_TOKEN": "your_token_here" }
    }
  }
}
```

Restart Claude Desktop, then try: *"Use github-repo-mcp to check the health of
facebook/react and find me a good first issue."*

## Architecture notes

- **GitHub API, not scraping** — clean, documented, generously rate-limited with a token.
- **Deterministic scoring, generative explanation** — `get_repo_health`'s score is a fixed
  formula (recency + issue triage + contributor diversity), not an LLM guess. This keeps
  the number reproducible; an LLM (in the calling agent) can narrate *why* on top of it.
- **Mislabel detection in `find_good_first_issues`** — real "good first issue" labels are
  often wrong. The tool checks body length, red-flag keywords (architecture, migration,
  security), and comment count to catch issues that are mislabeled, not just present them
  at face value.

## Demo

See [docs/demo.md](docs/demo.md) for a real (not mocked) protocol exchange against
`facebook/react`, including the embeddings-based `ask_repo` retrieving the correct
answer for a query that shares no words with the source text.

## How `ask_repo` retrieval works

`ask_repo` started as keyword-window retrieval over the README (see git history) and
was upgraded to embeddings-based RAG, implemented in `src/rag.ts`:

1. On first query for a repo, chunk README + `docs/*.md` (top-level, cap 15 files) +
   top 8 most-discussed issue threads (title + body, ~500-word chunks, 50-word overlap)
2. Embed each chunk with Voyage AI (`voyage-3.5-lite`)
3. Store vectors in Qdrant Cloud, one collection per repo (`repo_<owner>_<name>`)
4. On every query: embed the question, cosine-similarity search top-5 chunks
5. Subsequent queries for the same repo skip re-indexing (checked via the collection's
   `points_count`) — only the query itself gets embedded

**Why embeddings over keyword matching:** keyword overlap requires literal shared
words — "how do I install React?" and a README section titled "Getting Started" share
zero words and would never match. Embeddings place semantically similar text near each
other in vector space regardless of exact wording, so retrieval survives paraphrasing
and synonyms — the actual failure mode keyword search hits in practice.

**Known simplifications** (marked `ponytail:` in `src/rag.ts`), each with a stated
upgrade path:
- Issue threads index title+body only, not the full comment discussion (avoids one
  extra API call per issue) — fetch `/issues/{n}/comments` if answers need to reflect
  resolution discussion, not just the original report.
- Chunk sizing uses word count as a token-count approximation, not a real tokenizer.
- No staleness check — a repo indexed once stays indexed even if its docs change.
  Add a TTL or a `pushed_at` check against the stored index if content goes stale.

## License

MIT
