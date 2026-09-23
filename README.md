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
npm run evals  # live model calls; checks tool choice, order, mock GitLab requests, and response content
```

Add cases in `evals/cases.ts` as your product behavior grows. These evals are deliberately small: they test observable outcomes (which tool was called and the returned text), rather than brittle exact phrasing.

## Production notes

The example store is only process memory. Before deploying, replace it with a database and enforce authenticated user/tenant authorization inside every tool. Keep side-effecting tools narrow, validate their arguments, require confirmation for irreversible actions, and log tool calls/results with sensitive data redacted.

The OpenAI [Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create) documents custom function tools and the function-call output loop used in the raw SDK example.
