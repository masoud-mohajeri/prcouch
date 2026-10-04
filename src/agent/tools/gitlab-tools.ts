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
        "Get metadata for the configured GitLab project. Use when project identity or metadata is needed. name is the human-readable display name; path_with_namespace is the stable project path.",
      inputSchema: z.object({}),
      execute: async () => ({ project: await client.getProject() }),
    }),
    [gitLabToolNames.getMergeRequest]: tool({
      description:
        "Get one GitLab merge request by its project-local IID, for example 5896 for !5896. Use when the user refers to a specific merge request or when detailed metadata for one merge request is required. Do not pass the GitLab database ID.",
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
        "List merge requests ordered by most recently updated. Supports filtering by state and author and a limit from 1-100. Use to discover or select merge requests when the user has not provided a specific IID, especially before retrieving comments or discussions.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
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
        const [project, result] = await Promise.all([
          client.getProject(),
          client.listRecentMergeRequestsWithMetadata(
            limit,
            state,
            authorUsername,
          ),
        ]);
        return {
          project,
          query: {
            limit,
            state,
            authorUsername: authorUsername ?? null,
          },
          ...result,
        };
      },
    }),
    [gitLabToolNames.getMergeRequestDiscussions]: tool({
      description:
        "Get human review discussions for one merge request by project-local IID and save normalized review comments as pending analysis work. Returns compact discussion summaries including file path, line, and message text when available. Use when all review discussions for a known merge request are needed. Excludes users configured in GITLAB_INVALID_COMMENT_USERS. Do not pass the GitLab database ID.",
      inputSchema: z.object({
        mergeRequestIid: z
          .number()
          .int()
          .positive()
          .describe("Project-local merge request IID"),
      }),
      execute: async ({ mergeRequestIid }) => {
        const [discussions, page] = await Promise.all([
          client.listMergeRequestDiscussions(mergeRequestIid),
          comments.list({
            mergeRequestIid,
            state: "all",
            includeResolved: true,
            limit: 100,
          }),
        ]);
        const persistence = await saveCommentPage(analysisStore, page);
        return { discussions, persistence };
      },
    }),
    [gitLabToolNames.listComments]: tool({
      description:
        "Retrieve normalized GitLab merge-request comments and review discussions with filtering and pagination, and save newly fetched comments as pending analysis work. Use this as the primary tool for searching or filtering review comments across merge requests or within a specific merge request. Supports filters such as author, date, resolution status, merge request, and other comment attributes. For one merge request, pass its project-local IID as mergeRequestIid. Each result may include author, merge request, inline file/line location, commit context, matching diff hunk, commit message, and the complete oldest-to-newest discussion history including replies and system events. authorName performs a case-insensitive substring match against both author name and username.",
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
          mergeRequestLimit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(100)
            .describe(
              "Number of recent merge requests to inspect when mergeRequestIid is omitted",
            ),
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
        const persistence = await saveCommentPage(analysisStore, page);
        return { ...page, persistence };
      },
    }),
  };
}

export async function saveCommentPage(
  analysisStore: AnalysisStore,
  page: Awaited<ReturnType<CommentService["list"]>>,
) {
  return analysisStore.saveFetchedComments(
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
      savedComment: {
        commentMessageTexts: comment.discussionHistory.map((note) => note.body),
        codeThatComentIsOn: comment.codeThatComentIsOn,
        commitMessage: comment.commitMessage,
        fileNewPaht: comment.location.newPath ?? "",
      },
    })),
  );
}
