import { describe, expect, it } from "vitest";

import { getInitialToolForInput } from "../src/agent/agent.js";

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
  ] as const)("selects %s", (input, expected) => {
    expect(getInitialToolForInput(input)).toBe(expected);
  });

  it("leaves ambiguous requests to the model", () => {
    expect(
      getInitialToolForInput("Can you help me plan my week?"),
    ).toBeUndefined();
  });
});
