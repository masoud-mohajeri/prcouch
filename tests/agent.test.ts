import { describe, expect, it } from "vitest";

import {
  getMergeRequestListRequest,
  getInitialToolForInput,
  isCategorizePendingCommentsRequest,
} from "../src/agent/agent.js";

describe("getInitialToolForInput", () => {
  it.each([
    [
      "Show me the review comments on the last 2 PRs.",
      "list_recent_merge_requests",
    ],
    [
      "List recent review comments in merge requests.",
      "list_recent_merge_requests",
    ],
    ["List unresolved review comments.", "list_comments"],
    ["What is the configured project name?", "get_project"],
    ["Show comment categories.", "get_comment_categories"],
    ["Generate a report for security comments.", "generate_comment_report"],
    ["no filter", "list_recent_merge_requests"],
  ] as const)("selects %s", (input, expected) => {
    expect(getInitialToolForInput(input)).toBe(expected);
  });

  it("leaves ambiguous requests to the model", () => {
    expect(
      getInitialToolForInput("Can you help me plan my week?"),
    ).toBeUndefined();
  });

  it("recognizes explicit pending-comment categorization requests", () => {
    expect(
      isCategorizePendingCommentsRequest("Categorize pending comments"),
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
  });
});
