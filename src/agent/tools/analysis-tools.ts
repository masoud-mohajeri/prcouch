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
        "List the approved review-comment categories, their severity, default resolution, and recommended action. Use this before categorizing or saving an analyzed comment.",
      inputSchema: z.object({}),
      execute: async () => ({ categories: await categoryPolicy.list() }),
    }),
    [analysisToolNames.saveAnalyzedComment]: tool({
      description:
        "Persist a categorized analysis of one GitLab review comment in the configured local analysis JSON store. Use only after get_comment_categories has supplied an approved category, resolution, and evidence-based rationale. The source comment identity and source URL are required; this tool cannot write to a caller-selected path.",
      inputSchema: analyzedCommentInputSchema,
      execute: async (input) => ({
        record: await analyzedComments.save(input),
      }),
    }),
    [analysisToolNames.generateCommentReport]: tool({
      description:
        "Generate a self-contained, offline HTML report from saved analyzed comments. It includes summary counts, category/resolution/author/trend charts, and a sortable, filterable detail table. Optional filters only select saved analyses; the output path is controlled by REPORT_OUTPUT_DIR, never by the caller.",
      inputSchema: reportFiltersSchema,
      execute: async (filters) => ({
        report: await reportGenerator.generate(filters),
      }),
    }),
  };
}
