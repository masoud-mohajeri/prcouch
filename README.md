# GitLab review analysis agent

A Node.js and TypeScript agent for exploring GitLab merge-request feedback,
categorizing review comments, saving local analyses, and producing offline HTML
reports. It includes two tool-calling implementations:

- an [AI SDK](https://ai-sdk.dev/) agent loop (`src/agent.ts`)
- a raw [OpenAI Responses API](https://developers.openai.com/api/docs/guides/function-calling) example (`src/openai-sdk-agent.ts`)

The project also retains a small in-memory task example to demonstrate
side-effecting, schema-validated tools.

## Requirements

- Node.js 22.12 or later
- An OpenAI API key
- A GitLab project and a read-only GitLab token (`read_api` or fine-grained
  **Merge Request: Read** permission)

Docker Desktop with Docker Compose v2 is only required for self-hosted Laminar
evaluation tracing.

## Quick start

```bash
cp .env.example .env
# Edit .env with your OpenAI and GitLab credentials.
npm install
npm start -- "List unresolved review comments in recent merge requests"
```

The primary and raw SDK agent loops require all four settings below at startup:

```dotenv
OPENAI_API_KEY=...
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=...
GITLAB_PROJECT=group/project
```

`GITLAB_PROJECT` can be a namespace/project path or a numeric GitLab project
ID. `GITLAB_URL` must be set explicitly, including when using GitLab.com.

Set `OPENAI_MODEL` to a model available to your account; it defaults to
`gpt-5-mini`. Optionally, set `OPENAI_BASE_URL` to use an OpenAI-compatible
API endpoint; it defaults to `https://api.openai.com/v1`.

## What the agent can do

GitLab access is read-only. The agent can retrieve canonical project metadata,
recent merge requests, their discussions, and normalized review comments. It
can filter comments by author, merge request, state, creation date, and resolved
status. Inline comments include file and line context and, where GitLab returns
one, the diff commit SHA.

For review analysis, the agent first reads the committed category policy at
[`config/comment-categories.json`](config/comment-categories.json), then saves
an approved category, resolution, and evidence-based rationale for each comment.
Saved analyses live in a local JSON ledger:

```text
data/analyzed-comments.json
```

The ledger is gitignored because it can contain review content and author data.
Set `ANALYSIS_STORE_PATH` to use a different location, and keep that location
access-controlled. The agent never writes to GitLab or to a model-selected
filesystem path.

## Examples

```bash
npm start -- "What is the configured GitLab project name?"
npm start -- "List unresolved review comments by Ava, including file, line, and commit SHA."
npm start -- "Categorize the review comments and save each analysis with a rationale."
npm start -- "Generate an HTML report for saved security comments."
```

Run the same workflow through the raw OpenAI SDK implementation:

```bash
npm run openai-sdk -- "List unresolved review comments in recent merge requests"
```

## Reports

Generate a self-contained HTML dashboard from the saved analyses:

```bash
npm run report
```

By default, reports are timestamped files in `reports/`. Set
`REPORT_OUTPUT_DIR` to change the directory. A report includes summary metrics,
category, resolution, author, and trend charts, plus a sortable and filterable
comment table. Report files are gitignored because they can contain local review
data.

## Configuration

Copy `.env.example` to see every option. In addition to the required agent
credentials, these settings are available:

| Setting | Purpose |
| --- | --- |
| `OPENAI_MODEL` | Overrides the default `gpt-5-mini` model. |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible API endpoint; defaults to `https://api.openai.com/v1`. |
| `ANALYSIS_STORE_PATH` | Changes the local JSON analysis ledger path. |
| `COMMENT_CATEGORY_CONFIG_PATH` | Replaces the validated category/action policy. |
| `REPORT_OUTPUT_DIR` | Changes where HTML reports are written. |
| `LMNR_*` | Configures self-hosted Laminar evaluation tracing. |

## Tests and evals

```bash
npm test       # deterministic tests; no API key or network calls
npm run typecheck
npm run evals  # live model evals; requires OPENAI_API_KEY
```

The test suite includes a full fixture-backed review-analysis flow and report
generation. The GitLab golden eval injects fixture responses, so it does not
call a real GitLab instance or require a GitLab token.

## Self-hosted Laminar

Start the local Laminar stack:

```bash
npm run laminar:up
```

The command clones Laminar's official Compose configuration into the ignored
`.laminar-stack/` directory and starts it. Open <http://localhost:5667>, create
a project and API key, then add `LMNR_PROJECT_API_KEY` to `.env`. The supplied
default ports are 8000 (HTTP), 8001 (gRPC), and 5667 (UI).

Send the golden eval's traces and scores to that local project:

```bash
npm run evals:laminar
```

Useful stack commands:

```bash
npm run laminar:logs
npm run laminar:down
npm run laminar:update
```

## Production notes

The task store is intentionally process-local. Before deploying, replace it
with durable storage and enforce authenticated user and tenant authorization in
every tool. Keep write operations narrow, validate all arguments, require
confirmation for irreversible actions, and redact sensitive data from logs.
