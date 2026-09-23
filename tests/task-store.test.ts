import { describe, expect, it } from "vitest";

import { TaskStore } from "../src/task-store.js";

describe("TaskStore", () => {
  it("adds, lists, and completes a task", () => {
    const store = new TaskStore();
    const task = store.add("write tests");
    expect(store.list()).toEqual([task]);
    expect(store.complete(task.id)).toMatchObject({ completed: true });
    expect(store.list()).toEqual([]);
    expect(store.list(true)).toHaveLength(1);
  });
});
