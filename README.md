# GitLab review assistant

Turn GitLab review comments into useful feedback for future code reviews.

The assistant saves comments, groups them by issue type, and creates short review
instructions from actionable feedback. You can browse the results in an HTML
report or give the generated checklist to an agent reviewing your code.

## Get started

You need:

- Node.js 22.12 or later.
- An OpenAI API key.
- A GitLab token with read-only access to the projects you want to review
  (`read_api` or fine-grained **Merge Request: Read** permission).

1. Install the dependencies and copy the settings file:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Open `.env` and fill in your credentials:

   ```dotenv
   OPENAI_API_KEY=your_openai_api_key
   GITLAB_URL=https://gitlab.com
   GITLAB_TOKEN=your_read_only_gitlab_token
   ```

   Use your organization's GitLab address if it hosts its own instance.

3. Start the assistant:

   ```bash
   npm start
   ```

4. Choose a project, then type your request. You can keep asking follow-up
   questions in the same session.

Run the assistant in an interactive terminal; piped input is not supported.

## Everyday use

A typical session has three steps. Enter these requests in the chat:

1. **Collect comments:** “Get review comments from the last 10 merged merge requests.”
2. **Categorize them:** “Categorize all pending comments.”
3. **View the results:** “Generate an HTML report for all saved comments.”

You can also ask:

- “What is the selected GitLab project name?”
- “List unresolved review comments by Ava.”
- “Generate an HTML report for saved security comments.”

Newly collected comments are saved for categorization. Previously saved comments
are kept, so you can build up review history over multiple sessions. The chat
conversation itself is forgotten when you close the assistant.

Categorization groups comments by issue type, such as bugs, security, or testing.
It does not check whether the code has since been fixed.

## Review checklists

During categorization, each actionable comment gets a short instruction for a
future reviewer. For example:

> Check nullable API fields before accessing nested properties.

Praise, unresolved questions, and comments without a clear actionable issue do not
get an instruction. Previously categorized comments are not processed again, so
older comments may have no instruction.

Each project gets a checklist in `reports/review-checklist-<project-id>.md`.
Repeated instructions appear once. The file is rebuilt from saved instructions
after each categorization run, so edits to the generated file will be overwritten.
If writing the file fails, the saved analysis is kept; ask to categorize again to
retry creating the checklist.

To use it in future reviews:

1. Copy the checklist into the repository being reviewed, for example as
   `docs/review-checklist.md`.
2. Add this line to that repository's `AGENTS.md`:

   ```text
   During code review, read and apply docs/review-checklist.md.
   ```

## HTML reports

Ask for a report, then open the generated `.html` file in your browser. Reports
are saved in `reports/` and work offline.

Each report includes:

- An overview of issue categories and comment counts.
- Comments grouped by category, with their file location, available code context,
  recommended solution, and a link to GitLab.
- Each saved review instruction beside its corresponding comment.
- An **All review instructions** section, with links back to the comments.

On smaller screens, instructions appear below the comment. Comments without an
instruction show “No review instruction saved.” If you filter a report, its
instructions section includes only the matching comments.

Generate a new report to see newly saved instructions; existing HTML files do not
update automatically.

## Settings and saved data

The assistant reads GitLab data without changing merge requests or posting
comments. Review comments are sent to your configured AI provider for analysis.
Saved data stays in `data/analytics.sqlite`; reports and checklists stay in
`reports/`. These folders are excluded from Git because they can contain private
review content.

Most users only need the three credentials above. Optional settings in `.env`:

| Setting                        | What it changes                                                               |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `OPENAI_MODEL`                 | AI model; defaults to `gpt-5-mini`.                                           |
| `OPENAI_BASE_URL`              | Address of an alternative, OpenAI-compatible AI service.                      |
| `OPENAI_API_MODE`              | API connection mode: `responses` or `chat`. Normally chosen automatically.    |
| `GITLAB_INVALID_COMMENT_USERS` | Comma-separated usernames to leave out of discussion summaries, such as bots. |
| `ANALYSIS_STORE_PATH`          | Location of the saved review database.                                        |
| `REPORT_OUTPUT_DIR`            | Folder for HTML reports and Markdown checklists.                              |
| `COMMENT_CATEGORY_CONFIG_PATH` | Location of a custom category configuration.                                  |

To change the available categories, edit
[`config/comment-categories.json`](config/comment-categories.json).
See [`.env.example`](.env.example) for all settings.

## For contributors

```bash
npm test
npm run typecheck
npm run format:check
```

Tests use local examples without API credentials. `npm run evals` checks behavior
using a live AI model and requires an OpenAI API key.

For a guided walkthrough, see the [demo guide](docs/mvp.md). For storage details,
see [the storage guide](docs/analytics-storage-strategy.md).

Optional Langfuse tracing records requests and responses, including returned
GitLab data. Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and
`LANGFUSE_BASE_URL` in `.env` to enable it; leave both keys unset to disable it.
For a local instance, configure `.langfuse.env` from `.langfuse.env.example` and
run `npm run langfuse:up`. Stop it with `npm run langfuse:down`.
