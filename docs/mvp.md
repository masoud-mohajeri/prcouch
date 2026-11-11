# Categorization MVP

`master` is scoped to reading GitLab review comments, categorizing saved comments
with the configured policy, and generating an offline category report. Langfuse
tracing is optional. Docker and a search engine are not required for this flow.

Web search, comment research, research reports and their infrastructure are kept
on `feature/search-research`, including `docs/in-progress.md` for remaining work.
The removal commit on `master` is `d424242`; preserve it in history.

## Presentation flow

1. Configure the OpenAI and read-only GitLab credentials described in the README.
   Leave both Langfuse keys unset unless tracing is part of the demo.
2. Start in an interactive terminal with a dedicated MVP database:

   ```bash
   ANALYSIS_STORE_PATH=data/mvp.sqlite npm start
   ```

3. Select the project you intend to present. Start with a small retrieval:

   ```text
   Get all comments on the last 2 merged MRs.
   ```

4. In the same session, categorize the saved pending comments:

   ```text
   Categorize all pending comments.
   ```

   Confirm the processed, failed and remaining counts. On a provider failure,
   unfinished comments remain pending; fix the reported problem and repeat this
   request. Previously completed comments are retained.

5. Generate the category report:

   ```text
   Generate an HTML report for all saved analyses.
   ```

   Open the returned file. Show category counts and percentages, navigate to a
   category, then show a comment, available code context and its GitLab link.
   Reports are self-contained and can be opened offline after generation.

## Data and interpretation

- Keep `data/mvp.sqlite` separate from a research database when switching
  branches. Existing databases, reports, credentials and Docker volumes are not
  changed by the Git rollback.
- Use one project per demo database: the pending categorizer and unfiltered
  report operate across that database's saved projects.
- Categories come from `config/comment-categories.json`. The batch assigns one
  category per comment and uses that category's default resolution and solution;
  these are policy values, not a verified fix or researched recommendation.
- Code context depends on the data returned by GitLab. The report explicitly
  shows when no saved code context is available.
- GitLab calls are read-only. Categorization still requires the configured model
  endpoint; report generation can use already saved analyses.

## Verification

- The rollback tree exactly matched pre-search commit `4ee8559` before the MVP
  documentation changes.
- `npm run typecheck` passed after rollback.
- Baseline `npm test`: 75 passed, 5 failed, 80 total. The failures assert older
  categorizer results/error handling and the earlier report layout. Updating
  those three test files requires the requested approval.
- The existing fixture flow completed GitLab response normalization, category
  persistence and offline HTML generation in an isolated temporary database.
- A live company-project/model demonstration has not yet been verified during
  this split; complete the presentation flow above before presenting real data.

## Return to research later

Create an integration branch from `master`, run `git revert d424242`, then merge
`feature/search-research`. Resolve overlaps with later MVP changes and rerun the
checks. Merging the feature branch alone does not restore the reverted code.
