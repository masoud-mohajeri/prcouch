# GitLab review analysis agent

A Node.js and TypeScript agent for exploring GitLab merge-request feedback,
categorizing review comments, saving local analyses, and producing offline HTML
reports. The [AI SDK](https://ai-sdk.dev/) agent loop lives in
[`src/agent/agent.ts`](src/agent/agent.ts).

## Project layout

```text
src/
  cli/       Command-line entry point and terminal error formatting
  agent/     AI orchestration, provider configuration, and separated tool sets
  gitlab/    GitLab API client and review-comment normalization
  analysis/  Saved-analysis storage, validation, and category policy
  research/  Persisted comment research, bounded search, and batch execution
  reports/   Offline HTML report generation
```

## Requirements

- Node.js 22.12 or later
- An OpenAI API key
- A read-only GitLab token (`read_api` or fine-grained **Merge Request: Read**
  permission) that can list the project to analyze

Langfuse credentials are only required when exporting CLI or evaluation traces.

## Quick start

```bash
cp .env.example .env
# Edit .env with your OpenAI and GitLab credentials.
npm install
npm run infra:up
npm start -- "List unresolved review comments in recent merge requests"
```

`infra:up` requires Docker with Compose. It starts SearXNG, Langfuse web/worker,
PostgreSQL, ClickHouse, Redis, and MinIO from `docker-compose.yml`, waits for
readiness, and initializes/migrates the local SQLite analysis database. The agent
runs on the host; it is started separately with `npm start`.

The script creates missing `.env` and `.langfuse.env` files, generates local
service secrets, and adds missing search/tracing URLs. Existing settings and
Langfuse credentials are preserved. OpenAI/GitLab credentials and Langfuse
project API keys still need your configuration. A fresh `.env` leaves tracing
disabled until you add those project keys.

Use `npm run infra:logs` for logs and `npm run infra:down` to stop the stack.
Named Docker volumes and the local SQLite file survive shutdown. Existing
Langfuse volumes retain their original Compose project name. On upgrade from
the standalone SearXNG deployment, the script stops its old search container
and reuses its cache volume in the combined stack.

When run directly in an interactive terminal, `npm start` first prompts for a
GitLab project, then opens a chat session that prompts for further requests
after every response and retains a bounded window of recent conversational
context for follow-up questions. Verbose tool payloads are discarded after a
turn, so the agent re-fetches GitLab data when a follow-up needs those details.
History exists only in memory and is discarded when the process exits. You can
provide a quoted request to run one request after choosing the project.

Project selection requires an interactive terminal; noninteractive/piped runs
are not supported because the project is no longer read from an environment
variable.

The agent requires these settings at startup:

```dotenv
OPENAI_API_KEY=...
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=...
# Optional comma-separated GitLab usernames to exclude from discussion chats.
GITLAB_INVALID_COMMENT_USERS=jenkinspusher,jenkinspuller
```

At the start of every interactive session, the CLI lists the projects available
to the token and prompts you to select one. The selected project is bound to
the agent's GitLab tools for the entire session. `GITLAB_URL` must be set
explicitly, including when using GitLab.com.

Set `OPENAI_MODEL` to a model available to your account; it defaults to
`gpt-5-mini`. Optionally, set `OPENAI_BASE_URL` to use an OpenAI-compatible
API endpoint; it defaults to `https://api.openai.com/v1`. `OPENAI_API_MODE`
defaults to `responses` for OpenAI and `chat` for custom endpoints, where
proxies often support Chat Completions but not the Responses API's multi-turn
tool-call protocol. Set it explicitly to override that behavior.

## What the agent can do

GitLab access is read-only. The agent can retrieve canonical project metadata,
recent merge requests, compact human discussion summaries, and normalized
review comments. Each discussion summary contains its file path, line, and
message strings, excluding notes from usernames in
`GITLAB_INVALID_COMMENT_USERS`.

Recent merged merge requests are ordered by merge time and retrieved across
GitLab pagination. On GitLab instances older than 17.2, which do not support
merge-time ordering, the agent falls back to last-update order and says so in
the result. Requests for comments on the last _N_ merge requests are executed
as one bounded retrieval; the result reports the requested/returned MR count,
GitLab page count, and comment persistence summary.
Each returned normalized comment includes the complete discussion history (all
notes and replies, including system events) in chronological order. It
can filter comments by author, merge request, state, creation date, and resolved
status. Inline comments include file and line context and, where GitLab returns
one, the diff commit SHA.

When the agent retrieves review comments, it saves newly returned comments as
pending work in the local SQLite database. Each row also retains a stringified
`saved_comment_json` payload containing `commentMessageTexts`,
`codeThatComentIsOn`, `commitMessage`, and `fileNewPaht`. Categorization then
analyzes those saved comments with the committed category policy at
[`config/comment-categories.json`](config/comment-categories.json). Completed
analyses include an approved category, resolution, and evidence-based rationale:

```text
data/analytics.sqlite
```

The database is gitignored because it can contain review content and author data.
Set `ANALYSIS_STORE_PATH` to use a different location, and keep that location
access-controlled. The agent never writes to GitLab or to a model-selected
filesystem path.

Use `npm run db:studio` to inspect the local database with Drizzle Studio. It
is a local development tool and can edit data, so do not expose it remotely.

### Add issue categories directly to SQLite

`issue_categories` requires metadata beyond the category code and description.
Use an upsert so rerunning the command safely updates an existing category:

```bash
sqlite3 data/analytics.sqlite "
INSERT INTO issue_categories (
  code, name, description, recommended_solution, default_resolution,
  active, version, created_at, updated_at
) VALUES (
  'type_safety',
  'Type safety',
  'Problems caused by weak, incorrect, missing, or overly broad TypeScript types.',
  'Use strict TypeScript settings and type-aware linting in CI.',
  'open', 1, 1, datetime('now'), datetime('now')
)
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  recommended_solution = excluded.recommended_solution,
  default_resolution = excluded.default_resolution,
  active = excluded.active,
  version = excluded.version,
  updated_at = excluded.updated_at;
"
```

Replace the values with the desired category. If `ANALYSIS_STORE_PATH` is set,
use that SQLite file instead. The next category-policy sync deactivates database
categories absent from `config/comment-categories.json`; add the category there
too when it must remain available for future classifications.

## Examples

```bash
npm start -- "What is the selected GitLab project name?"
npm start -- "List unresolved review comments by Ava, including file, line, and commit SHA."
npm start -- "Categorize the review comments and save each analysis with a rationale."
npm start -- "Generate an HTML report for saved security comments."
```

## Reports

Ask the agent to generate a self-contained HTML dashboard from saved analyses.

By default, reports are timestamped files in `reports/`. Set
`REPORT_OUTPUT_DIR` to change the directory. A report shows what percentage of
the included comments belongs to each issue category. Select a category to see
only its corresponding comments, along with their resolution, merge request,
location, recommended action, rationale, and source. Author data is omitted.
Report files are gitignored because they can contain local review data.

## Configuration

Copy `.env.example` to see every option. In addition to the required agent
credentials, these settings are available:

| Setting                        | Purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `OPENAI_MODEL`                 | Overrides the default `gpt-5-mini` model.                                                   |
| `OPENAI_BASE_URL`              | Optional OpenAI-compatible API endpoint; defaults to `https://api.openai.com/v1`.           |
| `OPENAI_API_MODE`              | `responses` or `chat`; defaults to `responses` for OpenAI and `chat` for a custom base URL. |
| `ANALYSIS_STORE_PATH`          | Changes the local SQLite database path.                                                     |
| `COMMENT_CATEGORY_CONFIG_PATH` | Replaces the validated category/action policy.                                              |
| `REPORT_OUTPUT_DIR`            | Changes where HTML reports are written.                                                     |
| `LANGFUSE_*`                   | Configures Langfuse CLI and evaluation tracing.                                             |

## Local web research with SearXNG

Run `npm run infra:up` to configure and start local search alongside Langfuse.
The script adds missing settings to `.env`:

```dotenv
SEARXNG_BASE_URL=http://localhost:8080
SEARXNG_SECRET=replace_with_a_random_secret
```

It generates the search secret automatically. Verify the JSON API with:

```bash
curl 'http://localhost:8080/search?q=typescript+validation&format=json'
```

The search service binds only to localhost and enables HTML and
JSON search. Open <http://localhost:8080> for its browser UI.
`npm run searxng:logs` shows logs; `npm run searxng:down` stops the service,
retaining its named data volume. After initial setup, `npm run searxng:up`
starts only search; these search-specific commands do not stop Langfuse.
The setup follows the [SearXNG container documentation](https://docs.searxng.org/admin/installation-docker.html).

After fetching and categorizing comments, ask in the CLI:

```text
Use web search to research all analyzed comments in this project.
Use web search to find better solutions for saved security comments in MR !42.
Resume research run <ID>
Research analyzed comments about repeated database queries and suggest improvements.
Use SearXNG to research comment 7:45 and cite supporting documentation.
```

Explicit all-comment or category-filtered requests start a persisted batch.
Selection supports saved category codes, note IDs, MR IID, resolution and date
boundaries within the selected project. Unsupported criteria require clarification
before a run starts; semantic matching is not a batch filter. Ordinary interactive
research still uses paginated lookups (20 per page, maximum 100).

A batch snapshots distinct completed-analysis comment identities, including
resolved comments unless filtered out. It loads context when each task starts
and saves that input with its result. Comments added later require a new run.
Processing uses pages of 10 and at most two concurrent comment tasks. Each task
uses at most three generic queries, with at most 10 results per query and a
30-second request timeout. Equivalent queries share successful responses within
the run, including empty responses; each comment evaluates applicability separately.

The CLI shows the run ID and bounded progress, then counts supported candidates,
insufficient evidence, insufficient context, no action needed, failed and remaining
comments. Pure praise and context too limited to diagnose an issue skip search.
Structured results and search evidence are saved in separate research tables in
the same SQLite database. Existing analyses and reports retain their contents.
Inspect research results with Drizzle Studio; batch output prints aggregate counts.

Interrupt with Ctrl-C or SIGTERM, then select the same project and request
`Resume research run <ID>`. Resume retains completed results and successful search
cache, retries failed/interrupted tasks and continues pending tasks. It uses the
run's original model with current endpoint, credentials and API mode. A new batch
creates a new run and fresh cache. Use one executor per run; there is no
cross-process execution lease. Opening the analysis store applies migrations;
the existing confirmed database reset also removes research runs, tasks and cache.

Network, timeout, rate-limit and server search failures get one retry, respecting
Retry-After up to 60 seconds or waiting two seconds otherwise. Successful empty
responses and individual engine failures are retained without retry. Search or
model authentication/configuration failures, recognized model quota exhaustion,
and repeated model outages interrupt the batch. Malformed model output gets one
retry before the task fails; other task failures can finish alongside successful
results and be retried by resuming.

For an exact GitLab note, use its numeric ID: “Use web search to find a solution
for note ID 444221 based on its analyzed category.” The agent uses
`get_analyzed_comment`, which distinguishes a missing note from one awaiting
analysis. Lists also support `noteIds`; SQLite applies filters before pagination.
Research tools return the stored solution plus category description and
recommended solution from the database. The CLI prints database lookup arguments,
returned counts and exact-lookup status, without printing comment/code payloads.

Search is enabled for explicit research requests and clear research follow-ups,
such as “Can you find an ESLint plugin for this?” Explicit search prohibitions
override that permission. The agent is instructed
to derive generic technical queries, omitting raw comments, source code, and
internal identifiers. This privacy behavior depends on model instructions;
queries reach upstream search engines. Results are titles, snippets, and links,
not full pages, so evidence may be limited and engines may fail or rate-limit.
Citations must match a task's successful search results, including reused results.
This checks provenance; recommendations remain candidates, without full-page
verification or executed code checks. Missing versions and context are recorded
instead of inferred.
The [search API documentation](https://docs.searxng.org/dev/search_api.html)
describes the JSON interface.

SearXNG needs no OpenAI credentials. The existing agent uses `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_MODE` from `.env` to reason
about results. Only the SearXNG secret is passed into the search container.

## Tests and evals

```bash
npm test       # deterministic tests; no API key or network calls
npm run typecheck
npm run evals  # live model evals; requires OPENAI_API_KEY
```

The test suite includes a full fixture-backed review-analysis flow and report
generation. The GitLab golden eval injects fixture responses, so it does not
call a real GitLab instance or require a GitLab token.

## Langfuse tracing

Run `npm run infra:up` to start Langfuse and its backing services together with
SearXNG. Missing `.langfuse.env` credentials are generated automatically. For
manual configuration, copy `.langfuse.env.example` and replace every placeholder
with a strong secret. `DATABASE_URL` must use the same password as
`POSTGRES_PASSWORD`; both Langfuse S3 secret settings must use
`MINIO_ROOT_PASSWORD`. `ENCRYPTION_KEY` must be exactly 64 hexadecimal
characters (generate it with `openssl rand -hex 32`).

```bash
npm run infra:up
```

Open <http://localhost:4000>, create a user, organization, and project, then
create a project API key pair in **Settings → API Keys**. Add that pair to the
agent's `.env` along with the local Langfuse URL:

```dotenv
LANGFUSE_BASE_URL=http://localhost:4000
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
```

With these credentials configured, `npm start` exports each agent turn,
including direct GitLab retrieval, to Langfuse. Completed turns are flushed
before the next prompt, and tracing shuts down when the session ends.
Omit both API keys to disable CLI tracing. Traces contain request input and
agent output, including any returned GitLab data.

Use `npm run langfuse:logs` to follow startup and `npm run infra:down` to
stop the complete stack. `npm run langfuse:up` aliases the full startup script;
`npm run langfuse:down` stops only Langfuse and its backing services. The named
Docker volumes retain Langfuse data after a normal shutdown.

Send the golden eval's traces and deterministic scores to Langfuse:

```bash
npm run evals:langfuse
```

The eval uses the committed local dataset, so no dataset bootstrap is needed.
Results and task traces are available in Langfuse's Experiments view.

## Production notes

Enforce authenticated user and tenant authorization in every tool. Keep write
operations narrow, validate all arguments, require confirmation for
irreversible actions, and redact sensitive data from logs.
