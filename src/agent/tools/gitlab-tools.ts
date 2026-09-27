import { tool } from "ai";
import { z } from "zod";

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
        "Get metadata for one GitLab merge request by its project-local IID. Use this when the user asks about a specific merge request such as !5896; do not list recent merge requests instead.",
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
        "Get compact GitLab discussions for one merge request. Each discussion has line, comments (an array of message strings), and filePath; usernames in GITLAB_INVALID_COMMENT_USERS are excluded. Pass the merge request IID returned by list_recent_merge_requests, not its database ID.",
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
        "List normalized human GitLab merge-request comments, including inline discussion notes and general MR notes. Each item includes discussionHistory with every note and reply in that discussion, ordered oldest to newest, including system events. Filter authorName case-insensitively by substring against the item's author name or username. Inline comments include old/new file and line fields plus commitSha when GitLab provides a diff SHA; commitSha is not a commit message.",
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
      execute: async (query) => comments.list(query),
    }),
  };
}
