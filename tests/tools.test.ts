import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
      getMergeRequest: "get_merge_request",
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
      clearAnalysisData: "clear_analysis_data",
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

  it("saves comments fetched by either comment-retrieval tool as pending work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prcouch-gitlab-tool-"));
    directories.push(directory);
    const store = new AnalysisStore(join(directory, "analytics.sqlite"));
    const client = new GitLabClient(
      {
        baseUrl: "https://gitlab.example.test",
        token: "test",
        project: "team/service",
      },
      async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/projects/team%2Fservice"))
          return json({
            id: 7,
            name: "Service",
            path_with_namespace: "team/service",
            web_url: "https://gitlab.example.test/team/service",
          });
        if (url.pathname.endsWith("/merge_requests/12"))
          return json({
            id: 12,
            iid: 12,
            title: "Validate invoices",
            state: "opened",
            web_url:
              "https://gitlab.example.test/team/service/-/merge_requests/12",
          });
        if (url.pathname.endsWith("/merge_requests/12/discussions"))
          return json([
            {
              id: "discussion-12",
              notes: [
                {
                  id: 45,
                  body: "Validate the invoice number.",
                  author: { name: "Ava", username: "ava" },
                  created_at: "2026-01-02T03:04:05.000Z",
                  updated_at: "2026-01-02T03:04:05.000Z",
                  system: false,
                },
              ],
            },
          ]);
        if (url.pathname.endsWith("/merge_requests/12/notes")) return json([]);
        return new Response("Not found", { status: 404 });
      },
    );
    const tools = createGitLabTools(client, store);
    const listComments = tools[gitLabToolNames.listComments];
    const getDiscussions = tools[gitLabToolNames.getMergeRequestDiscussions];
    if (!listComments.execute)
      throw new Error("list_comments must be executable");
    if (!getDiscussions.execute)
      throw new Error("get_merge_request_discussions must be executable");

    try {
      const discussionsResult = await getDiscussions.execute(
        { mergeRequestIid: 12 },
        { toolCallId: "discussion-call", messages: [] },
      );
      expect(discussionsResult).toMatchObject({
        persistence: { saved: 1, existing: 0 },
      });
      expect(await store.countPendingComments()).toBe(1);

      const result = await listComments.execute(
        {
          mergeRequestIid: 12,
          mergeRequestLimit: 100,
          state: "all",
          includeResolved: true,
          limit: 25,
        },
        { toolCallId: "test-call", messages: [] },
      );

      expect(result).toMatchObject({
        total: 1,
        persistence: { saved: 0, existing: 1 },
      });
      expect(await store.countPendingComments()).toBe(1);
    } finally {
      store.close();
    }
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
