import { tool } from "ai";
import { z } from "zod";

import {
  AnalysisStore,
  analyzedCommentInputSchema,
} from "../../analysis/store.js";
import { CommentCategoryPolicy } from "../../analysis/category-policy.js";
import { AnalyzedCommentService } from "../../analysis/service.js";
import {
  CommentReportGenerator,
  reportFiltersSchema,
} from "../../reports/report.js";

export const analysisToolNames = {
  getCommentCategories: "get_comment_categories",
  saveAnalyzedComment: "save_analyzed_comment",
  generateCommentReport: "generate_comment_report",
  clearAnalysisData: "clear_analysis_data",
} as const;

/** Tools for categorizing, storing, and reporting on saved comment analyses. */
export function createAnalysisTools(
  analysisStore = new AnalysisStore(),
  categoryPolicy = new CommentCategoryPolicy(),
  reportGenerator = new CommentReportGenerator(analysisStore, categoryPolicy),
) {
  const analyzedComments = new AnalyzedCommentService(
    analysisStore,
    categoryPolicy,
  );

  return {
    [analysisToolNames.getCommentCategories]: tool({
      description:
        "Get the approved review-comment classification policy, including available categories, severity, default resolution, and recommended action. Use before categorizing a comment or calling save_analyzed_comment. Only categories returned by this tool are valid for saved analyses.",
      inputSchema: z.object({}),
      execute: async () => ({ categories: await categoryPolicy.list() }),
    }),
    [analysisToolNames.saveAnalyzedComment]: tool({
      description:
        "Save or update the analysis of one GitLab review comment. Use only after selecting an approved category from get_comment_categories. Provide the source comment identity, source URL, approved category, resolution, and an evidence-based rationale. Repeated calls for the same source comment update its existing analysis rather than creating a duplicate. The storage location is configured by the system and cannot be selected by the caller.",
      inputSchema: analyzedCommentInputSchema,
      execute: async (input) => ({
        record: await analyzedComments.save(input),
      }),
    }),
    [analysisToolNames.generateCommentReport]: tool({
      description:
        "Generate a standalone offline HTML report from saved comment analyses. Use after comments have been analyzed and saved. Supports filtering saved analyses, including review-date filters (commentCreatedAfter, commentCreatedBefore) and analysis-date filters (analyzedAfter, analyzedBefore). The report summarizes category percentages and provides drill-down details including comment, resolution, merge request, location, recommended action, rationale, and source. Author information is excluded. The output directory is controlled by REPORT_OUTPUT_DIR; the caller cannot choose an arbitrary output path.",
      inputSchema: reportFiltersSchema,
      execute: async (filters) => ({
        report: await reportGenerator.generate(filters),
      }),
    }),
    [analysisToolNames.clearAnalysisData]: tool({
      description:
        "Irreversibly delete all locally stored analysis-session data while preserving the SQLite schema and migration history. This includes fetched comments, analyses, categories, batches, projects, merge requests, discussions, and sync runs. Use only when the user explicitly asks to reset or delete the analysis data and has confirmed the deletion in a separate message. Never call based on implied consent. This action cannot be undone.",
      inputSchema: z.object({}),
      execute: async () => ({ deleted: await analysisStore.clearAllData() }),
    }),
  };
}
