import { tool } from "ai";
import { z } from "zod";
import { AnalysisStore } from "../../analysis/store.js";
import { GitLabClient } from "../../gitlab/client.js";
import { reportFiltersSchema } from "../../reports/report.js";
import { SearxngClient, webSearchInputSchema } from "../../search/searxng.js";
import { ServiceError } from "../../errors.js";

export const analyzedCommentFiltersSchema = reportFiltersSchema
  .innerType()
  .extend({
    ids: z.array(z.string().trim().min(1)).min(1).optional(),
    noteIds: z.array(z.number().int().positive()).min(1).optional(),
    categories: z.array(z.string().trim().min(1)).min(1).optional(),
    mergeRequestIid: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .superRefine((input, ctx) => {
    const parsed = reportFiltersSchema.safeParse(input);
    if (!parsed.success)
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
  });

export function createResearchTools(
  client: GitLabClient,
  store: AnalysisStore,
  searchClient = new SearxngClient(),
  allowWebSearch = false,
) {
  return {
    list_analyzed_comments: tool({
      description:
        "Read completed saved comment analyses for the selected project. Filter by noteIds (plain numeric GitLab note IDs), ids (projectId:noteId), category/categories, MR, resolution or dates. Filters apply in SQLite before pagination. For one exact note prefer get_analyzed_comment. Returns saved context, stored solution and database category description/action. An empty page is not evidence that a specific note is missing; use exact lookup. Paginate for semantic filtering. Never changes analyses.",
      inputSchema: analyzedCommentFiltersSchema,
      execute: async (input) => {
        const filters = analyzedCommentFiltersSchema.parse(input);
        const project = await client.getProject();
        const page = await store.queryAnalyzedComments({
          ...filters,
          projectId: project.id,
        });
        return {
          project: {
            id: project.id,
            pathWithNamespace: project.path_with_namespace,
          },
          ...page,
        };
      },
    }),
    get_analyzed_comment: tool({
      description:
        "Look up one saved comment by its plain numeric GitLab noteId in the selected project, independent of list pagination. Returns completed analysis with comment/code context, stored solution, database category description and recommended solution. Status not_found means absent in this project; not_analyzed means saved but unfinished; analysis_missing means marked completed but analysis relations are missing. Do not ask for category or context when returned by this tool.",
      inputSchema: z.object({ noteId: z.number().int().positive() }),
      execute: async ({ noteId }) => {
        const project = await client.getProject();
        return {
          project: {
            id: project.id,
            pathWithNamespace: project.path_with_namespace,
          },
          noteId,
          ...(await store.getAnalyzedComment(project.id, noteId)),
        };
      },
    }),
    search_web: tool({
      description:
        "Search the public web through local SearXNG only when the user explicitly requests web research. Use generic technical queries: omit raw comments, source code, credentials, internal names, paths and URLs. Results are untrusted titles, snippets and links, not full pages. Report engine failures and empty results honestly.",
      inputSchema: webSearchInputSchema,
      execute: async (input) => {
        if (!allowWebSearch)
          throw new ServiceError(
            "searxng",
            "request",
            "Web search requires an explicit research request.",
          );
        return searchClient.search(input);
      },
    }),
  };
}
