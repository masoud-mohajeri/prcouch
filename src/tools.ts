import { tool } from "ai";
import { z } from "zod";

import { TaskStore } from "./task-store.js";
import { GitLabClient, requireGitLabConfig } from "./gitlab.js";
import { CommentService } from "./comments.js";
import { AnalysisStore, analyzedCommentInputSchema } from "./analysis-store.js";
import { CommentCategoryPolicy } from "./comment-category-policy.js";
import { AnalyzedCommentService } from "./analyzed-comment-service.js";
import { CommentReportGenerator, reportFiltersSchema } from "./report.js";
import { gitLabToolNames } from "./gitlab-tool-contracts.js";

/**
 * Keep tools narrow, schema-validated, and authorization-aware. Replace this
 * in-memory store with your database and enforce user/tenant checks here.
 */
export function createTaskTools(store: TaskStore) {
  return {
    add_task: tool({
      description: "Create a task for the user. Use only when they ask to add, remember, or create a task.",
      inputSchema: z.object({
        title: z.string().min(1).describe("A concise task title"),
        dueDate: z.string().optional().describe("Optional due date, preserving the user's wording"),
      }),
      execute: async ({ title, dueDate }) => ({ task: store.add(title, dueDate) }),
    }),
    list_tasks: tool({
      description: "List the user's tasks. Use when asked what tasks exist or remain.",
      inputSchema: z.object({
        includeCompleted: z.boolean().default(false).describe("Whether completed tasks should be included"),
      }),
      execute: async ({ includeCompleted }) => ({ tasks: store.list(includeCompleted) }),
    }),
    complete_task: tool({
      description: "Mark a task complete by its ID. Ask for the ID if the task cannot be identified safely.",
      inputSchema: z.object({ id: z.string().min(1).describe("The task ID") }),
      execute: async ({ id }) => {
        const task = store.complete(id);
        return task ? { task } : { error: `No task found with ID ${id}` };
      },
    }),
  };
}

/**
 * Read-only GitLab tools. Credentials and the project are process configuration,
 * not tool arguments, so a model cannot redirect requests or provide a token.
 */
export function createGitLabTools(
  client = new GitLabClient(requireGitLabConfig()),
  analysisStore = new AnalysisStore(),
  categoryPolicy = new CommentCategoryPolicy(),
  reportGenerator = new CommentReportGenerator(analysisStore, categoryPolicy),
) {
  const comments = new CommentService(client);
  const analyzedComments = new AnalyzedCommentService(analysisStore, categoryPolicy);

  return {
    [gitLabToolNames.getProject]: tool({
      description: "Get canonical metadata for the configured GitLab project. Use this when asked for the project name; the returned name is its display name, while path_with_namespace is its stable path.",
      inputSchema: z.object({}),
      execute: async () => ({ project: await client.getProject() }),
    }),
    [gitLabToolNames.listRecentMergeRequests]: tool({
      description: "List the most recently updated GitLab merge requests in the configured project. Use this before retrieving their comments.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10).describe("Number of merge requests to return"),
        state: z.enum(["all", "opened", "closed", "merged"]).default("all").describe("Merge-request state to include"),
      }),
      execute: async ({ limit, state }) => ({ mergeRequests: await client.listRecentMergeRequests(limit, state) }),
    }),
    [gitLabToolNames.getMergeRequestDiscussions]: tool({
      description: "Get every GitLab discussion and review comment, including inline/diff comments, for one merge request. Pass the merge request IID returned by list_recent_merge_requests, not its database ID.",
      inputSchema: z.object({
        mergeRequestIid: z.number().int().positive().describe("Project-local merge request IID"),
      }),
      execute: async ({ mergeRequestIid }) => ({
        discussions: await client.listMergeRequestDiscussions(mergeRequestIid),
      }),
    }),
    [gitLabToolNames.listComments]: tool({
      description: "List normalized human GitLab review comments. Filter authorName case-insensitively by substring against the author's name or username. Inline comments include old/new file and line fields plus commitSha when GitLab provides a diff SHA; commitSha is not a commit message.",
      inputSchema: z.object({
        authorName: z.string().trim().min(1).optional().describe("Optional case-insensitive substring of the author's name or username"),
        mergeRequestIid: z.number().int().positive().optional().describe("Optional project-local merge request IID"),
        state: z.enum(["all", "opened", "closed", "merged"]).default("all").describe("Merge-request state to include"),
        createdAfter: z.string().datetime({ offset: true }).optional().describe("Optional inclusive ISO-8601 UTC/offset timestamp"),
        createdBefore: z.string().datetime({ offset: true }).optional().describe("Optional inclusive ISO-8601 UTC/offset timestamp"),
        includeResolved: z.boolean().default(true).describe("Whether GitLab-resolved notes are included"),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum comments per page"),
        cursor: z.string().regex(/^\d+$/).optional().describe("Cursor returned by a prior list_comments result"),
      }).superRefine(({ createdAfter, createdBefore }, ctx) => {
        if (createdAfter && createdBefore && new Date(createdAfter) > new Date(createdBefore)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["createdAfter"], message: "createdAfter must be before or equal to createdBefore." });
        }
      }),
      execute: async (query) => comments.list(query),
    }),
    [gitLabToolNames.getCommentCategories]: tool({
      description: "List the approved review-comment categories, their severity, default resolution, and recommended action. Use this before categorizing or saving an analyzed comment.",
      inputSchema: z.object({}),
      execute: async () => ({ categories: await categoryPolicy.list() }),
    }),
    [gitLabToolNames.saveAnalyzedComment]: tool({
      description: "Persist a categorized analysis of one GitLab review comment in the configured local analysis JSON store. Use only after get_comment_categories has supplied an approved category, resolution, and evidence-based rationale. The source comment identity and source URL are required; this tool cannot write to a caller-selected path.",
      inputSchema: analyzedCommentInputSchema,
      execute: async (input) => ({ record: await analyzedComments.save(input) }),
    }),
    [gitLabToolNames.generateCommentReport]: tool({
      description: "Generate a self-contained, offline HTML report from saved analyzed comments. It includes summary counts, category/resolution/author/trend charts, and a sortable, filterable detail table. Optional filters only select saved analyses; the output path is controlled by REPORT_OUTPUT_DIR, never by the caller.",
      inputSchema: reportFiltersSchema,
      execute: async (filters) => ({ report: await reportGenerator.generate(filters) }),
    }),
  };
}
