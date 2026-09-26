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

Both agent loops expose two read-only GitLab tools: one lists the most recently
updated merge requests and the other retrieves every discussion (including inline
review comments) for a selected merge request. They have no write endpoint or
repository access.

All of `OPENAI_API_KEY`, `GITLAB_URL`, `GITLAB_TOKEN`, and `GITLAB_PROJECT`
are required at startup. The agent stops with a configuration error if any are
missing; `GITLAB_URL` does not have a default value.

Use the raw OpenAI SDK loop instead:

```bash
npm run openai-sdk -- "Add a task to buy milk tomorrow"
```

The default model is `gpt-5-mini`; set `OPENAI_MODEL` in `.env` to a model available to your account.

## Evals

```bash
npm test       # no API key or model calls
npm run evals  # local live evals; requires OPENAI_API_KEY only
```

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
