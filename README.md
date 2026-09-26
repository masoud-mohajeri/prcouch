# OpenAI tool-calling agent boilerplate

A minimal Node.js/TypeScript agent with:

- **AI SDK** as the primary agent loop (`src/agent.ts`)
- **OpenAI SDK** Responses API tool-calling example (`src/openai-sdk-agent.ts`)
- schema-validated task tools and an intentionally replaceable in-memory store
- deterministic unit tests and lightweight live, task-specific evals

## Setup

```bash
cp .env.example .env
# Add OPENAI_API_KEY to .env
npm install
npm start -- "Add a task to buy milk tomorrow"
```

To let the agent retrieve comments from recent GitLab merge requests, add these
to `.env`:

```bash
GITLAB_TOKEN=...       # read_api, or fine-grained Merge Request: Read
GITLAB_PROJECT=group/project
GITLAB_URL=https://gitlab.com
```

Both agent loops expose read-only GitLab tools for canonical project metadata,
recent merge requests, discussions, and normalized review comments. The
`list_comments` tool can filter by author (case-insensitive name/username
substring), merge request, state, date range, and resolved state. Inline results
include old/new file and line fields plus the GitLab diff `commitSha` when it is
available; that SHA is not a human-readable commit message. The tools have no
write endpoint or repository access.

Analyzed comments saved through `save_analyzed_comment` are kept in a local,
versioned JSON ledger at `data/analyzed-comments.json` by default. Set
`ANALYSIS_STORE_PATH` to place it elsewhere. The ledger is gitignored because
it may contain review content and author information.

The committed [comment category policy](config/comment-categories.json) defines
the allowed category IDs, severity, default resolution, and recommended action.
Use `get_comment_categories` before saving an analysis; deployments can set
`COMMENT_CATEGORY_CONFIG_PATH` to use a validated replacement policy.

Generate an offline HTML dashboard from saved analyses:

```bash
npm run report
```

It writes a timestamped file to `reports/` by default (or `REPORT_OUTPUT_DIR`)
with summary metrics, category/resolution/author/trend charts, and a sortable,
filterable comment table. Reports are gitignored because they contain local
review data.

All of `OPENAI_API_KEY`, `GITLAB_URL`, `GITLAB_TOKEN`, and `GITLAB_PROJECT`
are required at startup. The agent stops with a configuration error if any are
missing; `GITLAB_URL` does not have a default value.

Use the raw OpenAI SDK loop instead:

```bash
npm run openai-sdk -- "Add a task to buy milk tomorrow"
```

The default model is `gpt-5-mini`; set `OPENAI_MODEL` in `.env` to a model available to your account.

## Review-analysis workflow

After configuring GitLab and OpenAI, interact with the primary agent using
natural-language requests such as:

```bash
npm start -- "What is the configured GitLab project name?"
npm start -- "List unresolved review comments by Ava, including their file, line, and commit SHA."
npm start -- "Categorize the review comments and save the analysis with a rationale."
npm start -- "Generate an HTML report for saved security comments."
```

The agent uses the shared category policy before saving analysis. Its local JSON
ledger and HTML reports may contain source-code review content, author names,
and links; keep `ANALYSIS_STORE_PATH` and `REPORT_OUTPUT_DIR` in access-
controlled local storage. Do not commit either output directory.

## Evals

```bash
npm test       # no API key or model calls
npm run evals  # local live evals; requires OPENAI_API_KEY only
```

`npm test` also runs a deterministic full-flow fixture covering project lookup,
filtered inline-comment retrieval, approved-category persistence, and an HTML
report. It uses temporary paths and fixture GitLab responses only.

The GitLab golden eval never calls a real GitLab instance. It injects a fixture
client and verifies all of the following:

- The agent lists recent merge requests before requesting discussions.
- It fetches every expected discussion endpoint for the returned merge requests.
- Its answer includes the review feedback returned by the fixture.

The evals are structured for Laminar:

- [cases.ts](evals/cases.ts) is a dataset of `data`, `target`, and `metadata`.
- [executor.ts](evals/executor.ts) runs one data row and returns structured agent output.
- [scorers.ts](evals/scorers.ts) exports named, deterministic 0-or-1 evaluators.

### Self-hosted Laminar

This project includes the Laminar TypeScript SDK and an `npm` wrapper around
Laminar's official Docker Compose quickstart. It requires Node.js 22.12+ and
Docker Desktop with Docker Compose v2.

Start the local Laminar stack:

```bash
npm run laminar:up
```

The first command clones Laminar's official Compose files into the ignored
`.laminar-stack/` directory and starts the containers. Once they are ready,
open <http://localhost:5667>, create a project, and create a project API key.
Then add it to `.env` along with your OpenAI key:

```bash
OPENAI_API_KEY=...
LMNR_PROJECT_API_KEY=...
LMNR_BASE_URL=http://localhost
LMNR_HTTP_PORT=8000
LMNR_GRPC_PORT=8001
LMNR_FRONTEND_PORT=5667
```

Run the golden eval and send its traces and scores to your local Laminar project:

```bash
npm run evals:laminar
```

This uses the same `cases`, `executeEvalCase`, and `evaluators` as the local
runner; it does not need a real GitLab token because the golden eval injects
fixture data. Laminar receives the evaluation metadata and scores over HTTP on
port 8000 and traces over gRPC on port 8001.

Useful stack commands:

```bash
npm run laminar:logs    # follow container logs
npm run laminar:down    # stop the stack but retain its data volumes
npm run laminar:update  # fast-forward the cloned Laminar repository and restart
```

See [Laminar's self-hosted evaluation guide](https://laminar.sh/docs/evaluations/self-hosted)
for the networking details and [its Docker Compose quickstart](https://github.com/lmnr-ai/lmnr#self-hosting-with-docker-compose)
for the stack components.

## Production notes

The example store is only process memory. Before deploying, replace it with a database and enforce authenticated user/tenant authorization inside every tool. Keep side-effecting tools narrow, validate their arguments, require confirmation for irreversible actions, and log tool calls/results with sensitive data redacted.

The OpenAI [Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create) documents custom function tools and the function-call output loop used in the raw SDK example.
