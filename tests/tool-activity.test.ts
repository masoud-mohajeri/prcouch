import { describe, expect, it, vi } from "vitest";

import { instrumentToolExecutions } from "../src/agent/tool-events.js";
import { createToolActivityReporter } from "../src/cli/tool-activity.js";

describe("tool activity reporter", () => {
  it("reports a tool's execution outcome without changing its context", async () => {
    const onToolExecution = vi.fn();
    const execute = vi.fn(async (_input: object, context: object) => context);
    const tools = instrumentToolExecutions(
      { get_project: { execute } },
      onToolExecution,
    );
    const context = { toolCallId: "call-1" };

    await expect(tools.get_project.execute?.({}, context)).resolves.toBe(
      context,
    );
    expect(execute).toHaveBeenCalledWith({}, context);
    expect(onToolExecution).toHaveBeenNthCalledWith(1, {
      type: "started",
      toolName: "get_project",
    });
    expect(onToolExecution).toHaveBeenNthCalledWith(2, {
      type: "finished",
      toolName: "get_project",
      succeeded: true,
    });
  });

  it("ignores observer failures", async () => {
    const execute = vi.fn(async () => 42);
    const tools = instrumentToolExecutions({ get_project: { execute } }, () => {
      throw new Error("terminal unavailable");
    });

    await expect(tools.get_project.execute?.()).resolves.toBe(42);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("shows the active tool together with completed tool history", () => {
    const message = vi.fn();
    const reporter = createToolActivityReporter({ message });

    reporter({ type: "started", toolName: "list_comments" });
    reporter({
      type: "finished",
      toolName: "list_comments",
      succeeded: true,
    });
    reporter({ type: "started", toolName: "get_merge_request_discussions" });

    expect(message.mock.calls).toEqual([
      ["Working: list_comments"],
      ["Preparing response · Completed: list_comments"],
      ["Working: get_merge_request_discussions · Completed: list_comments"],
    ]);
  });

  it("marks a failed tool in the displayed history", () => {
    const message = vi.fn();
    const reporter = createToolActivityReporter({ message });

    reporter({ type: "started", toolName: "get_project" });
    reporter({ type: "finished", toolName: "get_project", succeeded: false });

    expect(message).toHaveBeenLastCalledWith(
      "Preparing response · Failed: get_project",
    );
  });

  it("keeps a tool active until all of its concurrent calls finish", () => {
    const message = vi.fn();
    const reporter = createToolActivityReporter({ message });

    reporter({
      type: "started",
      toolName: "get_merge_request_discussions",
    });
    reporter({
      type: "started",
      toolName: "get_merge_request_discussions",
    });
    reporter({
      type: "finished",
      toolName: "get_merge_request_discussions",
      succeeded: true,
    });

    expect(message).toHaveBeenLastCalledWith(
      "Working: get_merge_request_discussions · Completed: get_merge_request_discussions",
    );
  });
});
