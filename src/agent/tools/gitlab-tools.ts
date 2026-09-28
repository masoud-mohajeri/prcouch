import { tool } from "ai";
import { z } from "zod";

import {
  AnalysisStore,
  type FetchedCommentInput,
} from "../../analysis/store.js";
import { GitLabClient, requireGitLabConfig } from "../../gitlab/client.js";
import { CommentService } from "../../gitlab/comments.js";

export const gitLabToolNames = {
  getProject: "get_project",
  getMergeRequest: "get_merge_request",
  listRecentMergeRequests: "list_recent_merge_requests",
  getMergeRequestDiscussions: "get_merge_request_discussions",
  listComments: "list_comments",
} as const;

/**
 * Read-only GitLab retrieval tools. Credentials and the project are process
 * configuration, not tool arguments, so a model cannot redirect requests or
 * provide a token.
 */
export function createGitLabTools(
  client = new GitLabClient(requireGitLabConfig()),
  analysisStore = new AnalysisStore(),
) {
  const comments = new CommentService(client);

  return {
    [gitLabToolNames.getProject]: tool({
      description:
        "Get canonical metadata for the configured GitLab project. Use this when asked for the project name; the returned name is its display name, while path_with_namespace is its stable path.",
      inputSchema: z.object({}),
      execute: async () => ({ project: await client.getProject() }),
    }),
    [gitLabToolNames.getMergeRequest]: tool({
      description:
        "Retrieve metadata for one GitLab merge request by its project-local IID. Use this when the user names a specific merge request such as !5896.",
      inputSchema: z.object({
        mergeRequestIid: z
          .number()
          .int()
          .positive()
          .describe(
            "Project-local merge request IID, for example 5896 for !5896",
          ),
      }),
      execute: async ({ mergeRequestIid }) => ({
        mergeRequest: await client.getMergeRequest(mergeRequestIid),
      }),
    }),
    [gitLabToolNames.listRecentMergeRequests]: tool({
      description:
        "List the most recently updated GitLab merge requests in the configured project, optionally limited to one author's username. Use this before retrieving their comments.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(1)
          .describe("Number of merge requests to return"),
        state: z
          .enum(["all", "opened", "closed", "merged"])
          .default("all")
          .describe("Merge-request state to include"),
        authorUsername: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional exact GitLab username of the merge-request author",
          ),
      }),
      execute: async ({ limit, state, authorUsername }) => {
        const [project, mergeRequests] = await Promise.all([
          client.getProject(),
          client.listRecentMergeRequests(limit, state, authorUsername),
        ]);
        return {
          project,
          query: {
            limit,
            state,
            authorUsername: authorUsername ?? null,
          },
          mergeRequests,
        };
      },
    }),
    [gitLabToolNames.getMergeRequestDiscussions]: tool({
      description:
        "Retrieve compact human discussion summaries for one GitLab merge request. Use this after listing recent merge requests when the user needs each discussion's file path, line, and message text. Pass the project-local IID returned by list_recent_merge_requests, not its database ID. Usernames in GITLAB_INVALID_COMMENT_USERS are excluded.",
      inputSchema: z.object({
        mergeRequestIid: z
          .number()
          .int()
          .positive()
          .describe("Project-local merge request IID"),
      }),
      execute: async ({ mergeRequestIid }) => ({
        discussions: await client.listMergeRequestDiscussions(mergeRequestIid),
      }),
    }),
    [gitLabToolNames.listComments]: tool({
      description:
        "Retrieve normalized GitLab review discussions and comments, including inline and general merge-request notes, and save newly retrieved comments locally as pending analysis work. For a specific merge request, pass mergeRequestIid. Use this for filtered review-comment requests: each item includes its author, merge request, inline location, commit-SHA context, and full oldest-to-newest note/reply history, including system events. Filter authorName case-insensitively by substring against the author name or username. A commitSha is a diff SHA, not a commit message.",
      inputSchema: z
        .object({
          authorName: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Optional case-insensitive substring of the author's name or username",
            ),
          mergeRequestIid: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional project-local merge request IID"),
          state: z
            .enum(["all", "opened", "closed", "merged"])
            .default("all")
            .describe("Merge-request state to include"),
          createdAfter: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Optional inclusive ISO-8601 UTC/offset timestamp"),
          createdBefore: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Optional inclusive ISO-8601 UTC/offset timestamp"),
          includeResolved: z
            .boolean()
            .default(true)
            .describe("Whether GitLab-resolved notes are included"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(25)
            .describe("Maximum comments per page"),
          cursor: z
            .string()
            .regex(/^\d+$/)
            .optional()
            .describe("Cursor returned by a prior list_comments result"),
        })
        .superRefine(({ createdAfter, createdBefore }, ctx) => {
          if (
            createdAfter &&
            createdBefore &&
            new Date(createdAfter) > new Date(createdBefore)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["createdAfter"],
              message: "createdAfter must be before or equal to createdBefore.",
            });
          }
        }),
      execute: async (query) => {
        const page = await comments.list(query);
        const persistence = await analysisStore.saveFetchedComments(
          page.items.map<FetchedCommentInput>((comment) => ({
            project: {
              id: page.project.id,
              pathWithNamespace: page.project.path_with_namespace,
              webUrl: page.project.web_url,
            },
            mergeRequest: {
              iid: comment.mergeRequest.iid,
              title: comment.mergeRequest.title,
              webUrl: comment.mergeRequest.webUrl,
            },
            comment: {
              discussionId: comment.discussionId,
              noteId: comment.noteId,
              body: comment.body,
              sourceUrl: comment.sourceUrl,
              createdAt: comment.createdAt,
              author: comment.author,
              location: comment.location,
              commitSha: comment.commitSha,
            },
          })),
        );
        return { ...page, persistence };
      },
    }),
  };
}
