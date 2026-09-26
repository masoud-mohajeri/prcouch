import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../src/analysis-store.js";
import { CommentCategoryPolicy } from "../src/comment-category-policy.js";
import { GitLabClient } from "../src/gitlab.js";
import {
  gitLabToolNameList,
  gitLabToolNames,
  rawRequiredFields,
} from "../src/gitlab-tool-contracts.js";
import { CommentReportGenerator } from "../src/report.js";
import { createGitLabTools } from "../src/tools.js";

describe("GitLab tool contracts", () => {
  it("keeps the AI SDK and raw SDK GitLab-analysis tool names in one shared contract", () => {
    const client = new GitLabClient(
      {
        baseUrl: "https://gitlab.example.test",
        token: "test",
        project: "team/service",
      },
      async () => new Response("not used", { status: 500 }),
    );
    const analysisStore = new AnalysisStore(
      join(tmpdir(), "prcouch-tool-contracts.json"),
    );
    const categoryPolicy = new CommentCategoryPolicy();
    const reportGenerator = new CommentReportGenerator(
      analysisStore,
      categoryPolicy,
      join(tmpdir(), "prcouch-tool-reports"),
    );

    expect(
      Object.keys(
        createGitLabTools(
          client,
          analysisStore,
          categoryPolicy,
          reportGenerator,
        ),
      ),
    ).toEqual(gitLabToolNameList);
    expect(gitLabToolNames).toEqual({
      getProject: "get_project",
      listRecentMergeRequests: "list_recent_merge_requests",
      getMergeRequestDiscussions: "get_merge_request_discussions",
      listComments: "list_comments",
      getCommentCategories: "get_comment_categories",
      saveAnalyzedComment: "save_analyzed_comment",
      generateCommentReport: "generate_comment_report",
    });
  });

  it("keeps raw Responses required fields explicit for the shared tool contracts", () => {
    expect(rawRequiredFields).toEqual({
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
    });
  });
});
