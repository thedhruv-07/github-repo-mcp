# Demo: github-repo-mcp against facebook/react

Real MCP protocol exchange, captured against the live `facebook/react` repo. Not mocked.

## Setup

```
$ claude mcp list
github-repo-mcp: node C:/.../github-repo-mcp/build/index.js - ✔ Connected
```

## get_repo_health

Request: `{ "owner": "facebook", "repo": "react" }`

```json
{
  "repo": "react/react",
  "description": "The library for web and native user interfaces.",
  "health_score": 70,
  "health_label": "Moderate — some activity, watch the trend",
  "score_breakdown": {
    "recency": 35,
    "triage": 0.26,
    "contributors": 20,
    "baseline": 15
  },
  "signals": {
    "stars": 250483,
    "forks": 51354,
    "open_issues": 1372,
    "closed_issues_last_90d": 12,
    "contributor_count": 100,
    "days_since_last_push": 0,
    "license": "MIT License",
    "archived": false
  }
}
```

## find_good_first_issues

Request: `{ "owner": "facebook", "repo": "react" }`

```json
{
  "repo": "facebook/react",
  "candidates_found": 1,
  "issues": [
    {
      "number": 17355,
      "title": "\"Should not already be working\" in Firefox after a breakpoint/alert",
      "comments": 154,
      "age_days": 2498,
      "clarity_score": 60,
      "flags": [
        "High comment count — may involve unresolved design debate",
        "Open for over a year — confirm it's still relevant before starting"
      ],
      "verdict": "good"
    }
  ]
}
```

Note the mislabel detection at work: a "good first issue" with 154 comments gets flagged
for unresolved design debate instead of being presented at face value.

## ask_repo — the embeddings upgrade in action

Query: **"what license is this under?"** — no word overlap with the README's actual
license section, which is the point.

```json
{
  "repo": "facebook/react",
  "query": "what license is this under?",
  "answer_context": [
    { "source": "README", "relevance": 0.525, "text": "...React is MIT licensed..." },
    { "source": "issue#11940: Facebook Engineers - Thank You For 2017", "relevance": 0.487 },
    { "source": "issue#10294: React 16 RC", "relevance": 0.398 }
  ],
  "note": "Context retrieved via embeddings-based semantic search (Voyage AI + Qdrant cosine similarity)..."
}
```

The top hit is the README's license line, retrieved on pure semantic similarity — the
old keyword-window version required literal shared words and would have missed this
phrasing entirely.
