import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../src/analysis/store.js";
import { CommentCategoryPolicy } from "../src/analysis/category-policy.js";
import { GitLabClient } from "../src/gitlab/client.js";
import { CommentReportGenerator } from "../src/reports/report.js";
import {
  analysisToolNames,
  createAgentTools,
  createAnalysisTools,
  createGitLabTools,
  gitLabToolNames,
} from "../src/agent/tools/index.js";

describe("agent tools", () => {
  it("separates GitLab retrieval tools from analysis tools", () => {
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

    expect(Object.keys(createGitLabTools(client))).toEqual(
      Object.values(gitLabToolNames),
    );
    expect(gitLabToolNames).toEqual({
      getProject: "get_project",
      listRecentMergeRequests: "list_recent_merge_requests",
      getMergeRequestDiscussions: "get_merge_request_discussions",
      listComments: "list_comments",
    });
    expect(
      Object.keys(
        createAnalysisTools(analysisStore, categoryPolicy, reportGenerator),
      ),
    ).toEqual(Object.values(analysisToolNames));
    expect(analysisToolNames).toEqual({
      getCommentCategories: "get_comment_categories",
      saveAnalyzedComment: "save_analyzed_comment",
      generateCommentReport: "generate_comment_report",
    });
    expect(
      Object.keys(
        createAgentTools({
          client,
          analysisStore,
          categoryPolicy,
          reportGenerator,
        }),
      ),
    ).toEqual([
      ...Object.values(gitLabToolNames),
      ...Object.values(analysisToolNames),
    ]);
  });
});
