/**
 * Shared names and raw-Responses required fields for the GitLab analysis
 * surface. The AI SDK schemas live with their implementations; the raw SDK
 * consumes these values so the two loops cannot silently rename a tool.
 */
export const gitLabToolNames = {
  getProject: "get_project",
  listRecentMergeRequests: "list_recent_merge_requests",
  getMergeRequestDiscussions: "get_merge_request_discussions",
  listComments: "list_comments",
  getCommentCategories: "get_comment_categories",
  saveAnalyzedComment: "save_analyzed_comment",
  generateCommentReport: "generate_comment_report",
} as const;

export const gitLabToolNameList = Object.values(gitLabToolNames);

/** The raw Responses API requires explicit required-field arrays. */
export const rawRequiredFields = {
  listRecentMergeRequests: ["limit", "state"],
  getMergeRequestDiscussions: ["mergeRequestIid"],
  listComments: ["state", "includeResolved", "limit"],
  saveAnalyzedComment: [
    "project",
    "mergeRequest",
    "comment",
    "category",
    "resolution",
  ],
} as const;
