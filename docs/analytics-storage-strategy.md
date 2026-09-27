# Comment Analytics Storage Strategy

## Pipeline

```text
GitLab fetch → save PRs/comments → batch LLM analysis → save analytics → generate report
```

## SQLite tables

| Table | Key data |
| --- | --- |
| `merge_requests` | PR metadata, author, state, and timestamps |
| `discussions` | PR link, relative file path, line, and resolved state |
| `comments` | Comment body, author, timestamps, and nullable analysis fields |
| `issue_categories` | Defined issue categories and their recommended solutions |
| `comment_analytics` | Validated LLM analysis for each comment/category |
| `analysis_batches` | Batch status, model, prompt version, retries, and timing |
| `sync_runs` | GitLab import progress and errors |

## Comment analysis fields

New or changed comments are saved with no analysis result. The `comments` table
should include these fields:

```text
analysis_status        -- pending | processing | completed | failed
analysis_result_json   -- NULL until the LLM result is validated
analyzed_at            -- NULL until completed
analysis_error         -- NULL unless the batch fails
analysis_version       -- prompt/category-policy version
```

## Category catalog

```text
issue_categories
- id
- code                 -- e.g. correctness, security, performance
- name
- description
- recommended_solution
- active
- version
```

## Normalized analytics

Keep the raw structured LLM response in `comments.analysis_result_json` for
traceability, but use a normalized table for reports and filtering:

```text
comment_analytics
- id
- comment_id
- category_id
- solution
- rationale
- confidence
- batch_id
- created_at
```

## Processing flow

1. Fetch the last X PRs and all their discussions/comments.
2. Upsert them into SQLite; new or changed comments receive
   `analysis_status = 'pending'`.
3. A batch worker claims a bounded set of pending comments. Group by discussion
   where possible, and cap batches by token size rather than only comment count.
4. Send each batch to the LLM with the approved category list and require
   structured JSON.
5. Validate the response before writing anything.
6. In one transaction:
   - write `comments.analysis_result_json`
   - insert or update `comment_analytics`
   - set `analysis_status = 'completed'`
   - record the batch outcome
7. Generate reports only from completed `comment_analytics` rows.

## Operational guidance

- Use `comment_analytics` for reports, dashboards, category counts, and finding
  comments in a given issue category.
- When a GitLab comment changes, mark its analysis stale or pending again.
- On failure, retain `analysis_error`, increment the retry count, and never mark
  incomplete results as completed.
- Store the model name, prompt version, and category-policy version with every
  batch so results and reports are reproducible.
