import { describe, expect, it } from "vitest";

import {
  getMergeRequestListRequest,
  getInitialToolForInput,
  getNamedMergeRequestIid,
  getRecentMergeRequestCommentRequest,
  isCategorizePendingCommentsRequest,
  isWebResearchRequest,
  systemPrompt,
  getNamedNoteId,
} from "../src/agent/agent.js";

describe("getInitialToolForInput", () => {
  it("routes numeric note research to exact lookup", () => {
    const input =
      "use web search tool to find solution for comment with note id 444221 based on analyzed category";
    expect(getNamedNoteId(input)).toBe(444221);
    expect(getInitialToolForInput(input)).toBe("get_analyzed_comment");
    expect(getNamedNoteId("Research comment ID 234:444221")).toBeUndefined();
    expect(getNamedNoteId("Research noteId 444221")).toBe(444221);
  });
  it.each([
    "Use web search to find better solutions for comments on the last 2 PRs",
    "Research and analyze comments for PR !42",
    "Use SearXNG for MR !42",
    "Search the web for saved security comments",
  ])("routes research through the agent: %s", (input) => {
    expect(isWebResearchRequest(input)).toBe(true);
    expect(getInitialToolForInput(input)).toBe("list_analyzed_comments");
    expect(getRecentMergeRequestCommentRequest(input)).toBeUndefined();
    expect(getMergeRequestListRequest(input)).toBeUndefined();
    expect(isCategorizePendingCommentsRequest(input)).toBe(false);
  });

  it("requires explicit research intent and instructs privacy and citations", () => {
    expect(
      isWebResearchRequest("Find a better solution for this comment"),
    ).toBe(false);
    expect(isWebResearchRequest("Analyze comments without web search")).toBe(
      false,
    );
    expect(systemPrompt).toContain("Never send raw comments");
    expect(systemPrompt).toMatch(/source\s+links returned by search_web/);
    expect(systemPrompt).toContain("Research is chat-only");
  });
  it.each([
    ["Show me the review comments on the last 2 PRs.", "list_comments"],
    ["List recent review comments in merge requests.", "list_comments"],
    ["List unresolved review comments.", "list_comments"],
    ["List unresolved review comments for PR !5896", "list_comments"],
    ["What is the configured project name?", "get_project"],
    ["Show comment categories.", "get_comment_categories"],
    ["Generate a report for security comments.", "generate_comment_report"],
    ["no filter", "list_recent_merge_requests"],
    ["give me infos about this PR !5896", "get_merge_request"],
  ] as const)("selects %s", (input, expected) => {
    expect(getInitialToolForInput(input)).toBe(expected);
  });

  it("leaves ambiguous requests to the model", () => {
    expect(
      getInitialToolForInput("Can you help me plan my week?"),
    ).toBeUndefined();
  });

  it("recognizes natural-language pending-comment categorization requests", () => {
    expect(
      isCategorizePendingCommentsRequest("Categorize pending comments"),
    ).toBe(true);
    expect(
      isCategorizePendingCommentsRequest(
        "Analyze them and assign them an issue category",
      ),
    ).toBe(true);
    expect(
      isCategorizePendingCommentsRequest("Assign review comments categories"),
    ).toBe(true);
    expect(isCategorizePendingCommentsRequest("Show comment categories")).toBe(
      false,
    );
  });

  it("parses simple MR list requests without relying on model inference", () => {
    expect(
      getMergeRequestListRequest("give me list of last merged PRs"),
    ).toEqual({ limit: 10, state: "merged" });
    expect(getMergeRequestListRequest("last 3 open merge requests")).toEqual({
      limit: 3,
      state: "opened",
    });
    expect(getMergeRequestListRequest("no filter")).toEqual({
      limit: 10,
      state: "all",
    });
    expect(
      getMergeRequestListRequest("give me infos about PR !5896"),
    ).toBeUndefined();
    expect(getNamedMergeRequestIid("give me infos about PR !5896")).toBe(5896);
  });

  it("parses bounded comment retrieval across recent merge requests", () => {
    expect(
      getRecentMergeRequestCommentRequest(
        "get all the comments on last 100 merged PRs in the project",
      ),
    ).toEqual({ limit: 100, state: "merged" });
    expect(
      getRecentMergeRequestCommentRequest("get comments for PR !5896"),
    ).toBeUndefined();
  });
});
