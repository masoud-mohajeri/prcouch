import { AnalysisStore } from "../../analysis/store.js";
import { CommentCategoryPolicy } from "../../analysis/category-policy.js";
import { GitLabClient, requireGitLabConfig } from "../../gitlab/client.js";
import { CommentReportGenerator } from "../../reports/report.js";

import { createAnalysisTools } from "./analysis-tools.js";
import { createGitLabTools } from "./gitlab-tools.js";

export { analysisToolNames, createAnalysisTools } from "./analysis-tools.js";
export { gitLabToolNames, createGitLabTools } from "./gitlab-tools.js";

/** Combines independent retrieval and analysis tool sets for the agent. */
export function createAgentTools(
  client = new GitLabClient(requireGitLabConfig()),
  analysisStore = new AnalysisStore(),
  categoryPolicy = new CommentCategoryPolicy(),
  reportGenerator = new CommentReportGenerator(analysisStore, categoryPolicy),
) {
  return {
    ...createGitLabTools(client),
    ...createAnalysisTools(analysisStore, categoryPolicy, reportGenerator),
  };
}
