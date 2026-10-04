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
  reports/   Offline HTML report generation
```

## Requirements

- Node.js 22.12 or later
- An OpenAI API key
- A read-only GitLab token (`read_api` or fine-grained **Merge Request: Read**
  permission) that can list the project to analyze

Langfuse credentials are only required when exporting live evaluation traces.

## Quick start

```bash
cp .env.example .env
# Edit .env with your OpenAI and GitLab credentials.
npm install
npm start -- "List unresolved review comments in recent merge requests"
```

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
| `LANGFUSE_*`                   | Configures Langfuse evaluation tracing.                                                     |

## Tests and evals

```bash
npm test       # deterministic tests; no API key or network calls
npm run typecheck
npm run evals  # live model evals; requires OPENAI_API_KEY
```

The test suite includes a full fixture-backed review-analysis flow and report
generation. The GitLab golden eval injects fixture responses, so it does not
call a real GitLab instance or require a GitLab token.

## Langfuse evaluation tracing

To run Langfuse locally, copy the service configuration and replace every
placeholder with a strong secret. `DATABASE_URL` must use the same password as
`POSTGRES_PASSWORD`; both Langfuse S3 secret settings must use
`MINIO_ROOT_PASSWORD`. `ENCRYPTION_KEY` must be exactly 64 hexadecimal
characters (generate it with `openssl rand -hex 32`).

```bash
cp .langfuse.env.example .langfuse.env
npm run langfuse:up
```

Open <http://localhost:4000>, create a user, organization, and project, then
create a project API key pair in **Settings → API Keys**. Add that pair to the
agent's `.env` along with the local Langfuse URL:

```dotenv
LANGFUSE_BASE_URL=http://localhost:4000
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
```

Use `npm run langfuse:logs` to follow startup and `npm run langfuse:down` to
stop the local services. The named Docker volumes retain Langfuse data after a
normal shutdown.

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
