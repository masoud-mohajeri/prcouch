import { describe, expect, it } from "vitest";

import { getInitialToolForInput } from "../src/agent.js";

describe("getInitialToolForInput", () => {
  it.each([
    ["Add a task to buy milk tomorrow.", "add_task"],
    ["What tasks do I still have?", "list_tasks"],
    ["Show me the review comments on the last 2 PRs.", "list_recent_merge_requests"],
  ] as const)("selects %s", (input, expected) => {
    expect(getInitialToolForInput(input)).toBe(expected);
  });

  it("leaves ambiguous requests to the model", () => {
    expect(getInitialToolForInput("Can you help me plan my week?")).toBeUndefined();
  });
});
