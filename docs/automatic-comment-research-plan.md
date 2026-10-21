# Automatic research for analyzed review comments

Status: steps 1–6 implemented. Step 7 documentation and existing-suite checks
complete; new deterministic test coverage awaits approval under AGENTS
instructions. Implementation verification remains incomplete until that scope is
approved and covered, or explicitly waived.

## Implementation steps

Implement in order. Each step should be independently reviewable; the contracts
and limits in the sections below remain the acceptance criteria. This is a
documentation plan only, not approval to refactor or add/modify tests.

### Step 1 — Define research contracts and category prompts

- Add focused research modules following the existing `src/analysis` service/
  storage boundaries, without refactoring existing analysis modules.
- Define validated run/task lifecycle, input snapshot and result schemas,
  including evidence status, citations and safe errors.
- Add the versioned shared prompt and category instructions. Include database
  descriptions/actions, unknown-category fallback and untrusted-input delimiters.
- Define identity/schema/citation validation and the no-search outcomes for pure
  praise and context too limited to diagnose an issue.

Done when: contracts cover every required outcome and reject invalid identities,
schemas and citation URLs outside the task's successful searches.

### Step 2 — Persist runs, tasks and search cache

- Extend `src/db/schema.ts` and generate Drizzle migrations for the separate
  research tables, uniqueness constraints and project/run relationships.
- Add storage operations for run creation, task claiming/results, cached searches,
  progress counts and interruption/resume.
- Create the run and snapshot distinct selected comment identities atomically,
  using database-side filters and completed-analysis selection. Process the
  snapshot in pages of 10; do not use a model to select database rows.
- Reuse `src/analysis/store.ts` selection/exact lookup patterns. Load current
  context per task and persist the input actually used with its result.
- Include research data in database reset, preserving its confirmation flow.

Done when: duplicate analyses create one task per comment, project isolation is
enforced and a saved run can retain completed results/cache across interruption.

### Step 3 — Add bounded search with run-scoped reuse

- Reuse `src/search/searxng.ts`; enforce at most three generic queries per
  comment, 10 results per query and the existing 30-second timeout.
- Normalize cache keys by trimming, collapsing whitespace and lowercasing.
  Share successful responses, including empty responses, within the run; coalesce
  concurrent identical queries so they do not issue duplicate requests.
- Preserve successful response snippets/URLs and engine-failure metadata for
  per-comment evidence attribution.
- Retry eligible request failures once using the specified Retry-After/backoff
  limits. Stop on authentication/configuration failures; do not retry successful
  empty responses or individual engine failures.

Done when: limits/retry rules are enforced and cache reuse preserves the evidence
available to each task. A new run starts with a fresh cache.

### Step 4 — Implement single-comment research

- Reuse `src/agent/openai-config.ts` and existing provider error handling for the
  configured model, base URL, token and API mode.
- Diagnose from saved context, generate generic queries, then evaluate returned
  evidence against this comment using the shared/category prompt.
- Produce no-search results for pure praise or insufficient context; otherwise
  return the validated fix, prevention, requirements, limitations and citations.
- Retry malformed model output once. Persist a safe task failure if still
  invalid; classify provider authentication/quota and repeated-outage failures
  for the runner to stop dispatch.

Done when: one task produces either a validated outcome or a safe failure,
without changing saved analysis, GitLab or code.

### Step 5 — Implement batch execution and resume

- Add a dedicated research service to create runs and dispatch snapshot pages,
  with at most two comment tasks active concurrently.
- Persist lifecycle transitions, attempts, input snapshots and results as work
  progresses; calculate outcome/failed/remaining counts from stored tasks.
- Stop further dispatch on fatal search/provider failures and preserve unfinished
  work. Handle shutdown/interruption so a run remains resumable.
- Resume only runs belonging to the selected project. Retain completed results
  and cache; retry failed/interrupted tasks and continue pending tasks.

Done when: every selected comment is accounted for, bounded concurrency holds
and interruption/resume does not rerun completed work.

### Step 6 — Wire CLI requests and progress

- Connect explicit all-comment/category-filtered requests and `Resume research
run <ID>` to the service through existing CLI/agent routing boundaries.
- Reuse structured filters from `src/agent/tools/research-tools.ts`; preserve
  exact-note lookup and ordinary interactive research.
- Enable search for clear research follow-ups using retained conversation in
  `src/cli/chat-session.ts`/agent routing. Explicit search prohibitions take
  precedence; ordinary analysis keeps its existing behavior.
- Show bounded progress and final outcome/failed/remaining counts with the run
  ID, following existing CLI progress conventions.

Done when: explicit batch/resume requests reach the runner and interactive
requests retain the specified behavior without an unbounded terminal report.

### Step 7 — Verify and complete implementation

- Before adding/modifying tests, obtain approval for the concrete test scope
  below. Existing approval is limited to the previously approved tests.
- With approval, add deterministic mocked coverage for contracts/provenance,
  selection/project isolation, cache/retries, concurrency, interruption/resume,
  reset and CLI routing, using the acceptance checklist below.
- Run `npm run typecheck`, focused regressions and `npm test`. Record the five
  previously confirmed baseline failures separately; verify their current status
  rather than assuming any new failure is pre-existing.
- Document usage, run/resume behavior and evidence limits. Update this document's
  status only after implementation and verification are complete.

Done when: acceptance checks pass, baseline failures are distinguished from
regressions and remaining gaps are explicit. No categorization/report fixes or
deferred features are included.

## Goal and scope

On an explicit CLI request, research all completed comment analyses in the
selected GitLab project. Return an immediate fix and a practical way to prevent
recurrence, supported by search evidence. Every selected comment gets an outcome.

- Use a dedicated batch runner, following the existing categorization/service/
  storage boundaries; do not rely on one long chat agent turn.
- Keep GitLab read-only. Preserve original categories, analyses and solutions.
- Save research separately in SQLite so interrupted runs can resume.
- No automatic startup runs, scheduling, code changes, package installation,
  research report integration, arbitrary SQL tools, or new search provider.
- Reuse SearXNG and existing `.env` OpenAI model, base URL, token and API mode.

## Execution and interfaces

1. Add a research service and CLI routing for explicit batch requests, such as
   "Use web search to research all analyzed comments in this project."
   Category-limited batch requests reuse structured database filters. Existing
   exact-note and ordinary interactive research stay available.
2. Snapshot distinct selected comment identities at run creation. Include every
   completed analysis regardless of resolution; comments added or changed after
   that snapshot belong to a new run. Load current context when processing each
   selected comment and record the input used with its result.
3. Process pages of 10 comments, with at most two comment research tasks running
   concurrently. Never load the full database into a model prompt. Use the
   existing database-side selection and exact-note lookup capabilities.
4. For each comment, identify the concrete issue and generate at most three
   generic technical search queries. Supply saved discussion/code context,
   database category description/action and stored solution to the model.
   Do not infer dependency versions or missing type definitions.
5. Share successful search results within a run for identical normalized queries:
   trim, collapse whitespace and lowercase. This reuses searches for equivalent
   issues without adding a separate clustering or similarity system. Evaluate
   applicability separately for every comment.
6. Search returns at most 10 results per query with the existing 30-second
   timeout. Allow one retry for network, timeout, rate-limit or server failures;
   respect Retry-After, capped at 60 seconds, otherwise wait two seconds.
   Authentication/configuration failures stop the run. Do not retry empty results
   or failed individual engines when the overall request succeeded.
7. Produce a schema-validated result per comment. Retry malformed model output
   once; otherwise record a task failure. Provider authentication/quota failures
   or repeated provider outages stop the run and preserve remaining work.
8. Show progress and final counts for supported candidates, insufficient evidence,
   insufficient context, no action needed, failed and remaining comments. Include
   the run ID. Do not print an unbounded report of every comment in the terminal.
9. Support "Resume research run <ID>" for the selected project. Retain completed
   results and cache; retry failed or interrupted tasks. An ordinary new batch
   request creates a new run and fresh search cache.

Follow-up research requests such as "Can you find an ESLint plugin for this?"
must enable search when they clearly continue a research turn. Use the retained
user conversation to establish that context; a prohibition on search overrides
it. Ordinary analysis turns still do not enable search automatically.

## Storage and result contract

Add Drizzle migrations for research runs, per-comment tasks/results and a
run-scoped search cache. Keep these separate from existing analysis records.

- Run: ID, project ID, requested filters, model, prompt version, timestamps and
  lifecycle status: pending, running, completed or interrupted.
- Task: run ID, comment identity, input snapshot, lifecycle status, attempts,
  timestamps, safe error and structured result. Enforce one task per run/comment.
- Cache: run ID, normalized query, retrieval time and successful search response.
- Result: comment ID, diagnosed issue, immediate fix, automated prevention or why
  none fits, applicability requirements, limitations, missing context, citations
  and evidence status.
- Evidence status: supported_candidate, insufficient_evidence,
  insufficient_context or no_action_needed. Task failure is separate from a
  successfully produced result with weak evidence.
- Citations contain URL, title and the supporting search snippet. Reject citation
  URLs absent from that task's successful searches, including cached searches.
  Preserve engine failure metadata and distinguish it from an empty successful
  search. URL membership verifies provenance, not the truth of a claim.
- Validate comment identity and output schema before persisting. No model-selected
  filesystem paths or executable configuration.
- Existing database reset must also clear research tasks/cache/runs. Retain the
  current reset confirmation requirement.

## Shared research prompt

Use one versioned shared prompt plus the matching category instruction below.
Inject data as clearly delimited input; treat comments and search snippets as
untrusted data, never as instructions.

```text
Research this saved review issue using web search.

INPUT
Comment identity, comment/discussion text, saved code context,
analyzed category and description, stored solution,
and known language/framework/dependency versions.

TASK
1. Identify the concrete issue supported by the supplied context.
   Treat the category and existing solution as guidance, not conclusions.
2. Recommend the smallest appropriate implementation fix.
3. Find an existing way to detect or prevent recurrence automatically.
   Prefer built-in checks and established rules over custom tooling.
4. Apply the category-specific instructions below.

EVIDENCE
Prefer official documentation and primary sources.
For each recommended package or rule, provide its exact name,
source URL, relevant behavior, prerequisites and limitations.
Explain how that behavior addresses this particular comment.
Cite only sources returned by research.
Search with generic technical queries; omit private code and identifiers.
Evidence is search snippets, not full documentation or executed checks.

CONSTRAINTS
Do not invent fields, types, versions, configuration or code context.
If necessary information is missing, identify it explicitly.
Do not claim a tool fully prevents an issue unless evidence supports that.
Do not modify code, saved analysis or GitLab.
Return the supplied structured output schema with the exact comment identity.
```

| Category          | Additional instruction                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_change`     | Determine the requested behavior/workflow change. Find an existing check detecting that specific violation, or explain the manual check needed.                     |
| `bug`             | Identify the triggering input and incorrect behavior. Recommend a regression-test scenario and relevant detection tools; do not invent expected behavior.           |
| `security`        | Identify the vulnerability mechanism and trust boundary. Prefer authoritative security/vendor guidance. Separate mitigation from scanners and state coverage gaps.  |
| `performance`     | Identify the suspected bottleneck. Recommend a measurable benchmark/profiling method and evidence-backed optimizations; do not promise measured speedups.           |
| `correctness`     | Identify the violated invariant, type contract or edge case. Find compiler checks, type-aware lint rules, validation or tests matching that failure.                |
| `maintainability` | Identify the concrete readability, coupling or duplication problem. Prefer a small local improvement; suggest automation only when it detects the actual pattern.   |
| `testing`         | Identify missing behavior coverage and the appropriate test level. Propose supported inputs/assertions; do not substitute coverage percentage for meaningful tests. |
| `documentation`   | Identify missing or incorrect knowledge and the precise documentation change. Research tooling only when it addresses the demonstrated problem.                     |
| `style`           | Find the exact formatter/linter rule enforcing the convention. State prerequisites and autofix support; identify possible tooling conflicts.                        |
| `question`        | Identify the unresolved decision and missing facts. Research relevant alternatives and tradeoffs; do not assume a code change is requested.                         |
| `praise`          | Pure praise needs no action or web search. If an actionable concern is also present, research that concern without rewriting the original category.                 |
| `other`           | Establish a concrete actionable issue before searching. Otherwise return insufficient context instead of generic advice.                                            |

Unknown/new categories use the `other` instruction plus their database description.
Pure praise gets a no_action_needed result without search. Missing context that
prevents a useful diagnosis gets an insufficient_context result without forcing
speculative searches.

## Verification and acceptance

Use deterministic mocked model/search responses. Test changes require user
approval under AGENTS instructions before implementation; prior approval covers
the existing search/selection/routing tests, not blanket approval for a new batch
test suite.

- Exact note lookup works beyond page 1; filters and selected-project isolation
  apply before pagination. Multiple analysis rows do not duplicate tasks.
- Every selected comment has a task and final outcome, including praise and
  insufficient-context cases. Query reuse never loses per-comment attribution.
- Category instructions select the correct focus; unknown categories use the
  fallback. Custom database descriptions/actions remain authoritative input.
- Citation validation rejects invented URLs. Invalid schemas/identities are not
  saved. Search failures and snippets never become claims of verified fixes.
- Interrupt/resume preserves completed work, retries interrupted/failed tasks,
  and rejects a run belonging to another project. Reset clears research data.
- Concurrency, query/result limits and retry rules are enforced. Provider outages
  stop further dispatch; remaining work is resumable.
- Explicit batch requests and research follow-ups use the research flow;
  ordinary analysis and explicit no-search requests retain their behavior.
- Run typecheck, focused regressions and the existing suite. Track the five
  previously confirmed baseline failures separately; do not expand scope to fix
  categorization/report behavior.

## Reliability limits and deferred work

The current SearXNG integration reads titles, snippets and links only. Results
are candidates, not documentation-verified or code-tested fixes. A future page
reader would need separate URL-access safeguards and evidence validation; it is
not part of this implementation. Search-engine access failures remain external
dependencies. Privacy of generic queries depends on model instructions.

Run one executor per run: execution is guarded within a service instance, without
a cross-process lease. Resume uses the stored model name and current provider
configuration. Quota detection recognizes structured `insufficient_quota` codes;
other provider-specific quota responses may be classified as rate limits.

## Current verification record

Verified on 2026-10-06:

- `npm run typecheck`: passed.
- Focused existing regressions: 49 passed across `agent`, `agent-history`,
  `research-tools`, `searxng`, `chat-history` and `analysis-store` tests.
- Full `npm test`: 100 passed, five failed. Current failure names match the five
  previously reproduced on clean HEAD; no additional failures appeared.
- Prettier check: passed for modified/new TypeScript, migration metadata and
  implementation documentation.
- Earlier implementation checks used temporary mocked scripts for contracts,
  migration/selection, persistence/reset, query reuse/retries, model outcomes,
  bounded concurrency, interruption/resume and CLI routing. Those scripts are
  not committed regression coverage. New deterministic tests remain pending
  approval; existing tests alone do not cover the full acceptance checklist.
- No live provider/SearXNG or terminal-signal end-to-end verification performed.
  Cancellation was checked through injected abort signals and mocked services.

Known baseline failures, retained outside this implementation's scope:

| Test file                            | Failure                                                                     | Observed mismatch                                              |
| ------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `tests/categorization.test.ts`       | Sends SQLite categories and ten pending comments, then persists assignments | Result includes additional `failed`/`recoveredBatches` fields. |
| `tests/categorization.test.ts`       | Retries incomplete response and leaves comments pending                     | Expects rejection; implementation resolves failure counts.     |
| `tests/report.test.ts`               | Generates an offline Review Health Report                                   | Missing expected `Critical / high unresolved` text.            |
| `tests/report.test.ts`               | Applies filters and generates an empty state                                | Missing expected `Ben` text.                                   |
| `tests/review-analysis-flow.test.ts` | Fixture-backed project lookup through HTML reporting                        | Missing expected `Validate invoice numbers` text.              |

Usage and persistence behavior are documented in
[README.md](../README.md#local-web-research-with-searxng).

Example motivating the evidence requirement: unsafe narrowing assertions have
a dedicated `@typescript-eslint/no-unsafe-type-assertion` rule requiring type
information; `no-unnecessary-type-assertion` targets assertions that do not change
the expression type. Recommend exact tools based on their documented behavior,
not merely a category or similarly named rule.

References:

- https://typescript-eslint.io/rules/no-unsafe-type-assertion/
- https://typescript-eslint.io/rules/no-unnecessary-type-assertion/
- https://docs.searxng.org/dev/search_api.html
