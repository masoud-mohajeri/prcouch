import { AnalysisStore } from "../../analysis/store.js";
import { CommentCategoryPolicy } from "../../analysis/category-policy.js";
import { GitLabClient, requireGitLabConfig } from "../../gitlab/client.js";
import { CommentReportGenerator } from "../../reports/report.js";

import { createAnalysisTools } from "./analysis-tools.js";
import { createGitLabTools } from "./gitlab-tools.js";
import {
  instrumentToolExecutions,
  type ToolExecutionObserver,
} from "../tool-events.js";

export { analysisToolNames, createAnalysisTools } from "./analysis-tools.js";
export { gitLabToolNames, createGitLabTools } from "./gitlab-tools.js";

export type AgentToolOptions = {
  client?: GitLabClient;
  analysisStore?: AnalysisStore;
  categoryPolicy?: CommentCategoryPolicy;
  reportGenerator?: CommentReportGenerator;
  onToolExecution?: ToolExecutionObserver;
};

/** Combines independent retrieval and analysis tool sets for the agent. */
export function createAgentTools({
  client = new GitLabClient(requireGitLabConfig()),
  analysisStore = new AnalysisStore(),
  categoryPolicy = new CommentCategoryPolicy(),
  reportGenerator = new CommentReportGenerator(analysisStore, categoryPolicy),
  onToolExecution,
}: AgentToolOptions = {}) {
  return instrumentToolExecutions(
    {
      ...createGitLabTools(client, analysisStore),
      ...createAnalysisTools(analysisStore, categoryPolicy, reportGenerator),
    },
    onToolExecution,
  );
}
