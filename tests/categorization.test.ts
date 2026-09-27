import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: mocks.generateObject,
}));

import { PendingCommentCategorizer } from "../src/analysis/categorization.js";
import { CommentCategoryPolicy } from "../src/analysis/category-policy.js";
import { AnalysisStore } from "../src/analysis/store.js";

describe("PendingCommentCategorizer", () => {
  beforeEach(() => mocks.generateObject.mockReset());

  it("sends exactly the SQLite categories and ten pending comments in two messages, then persists assignments", async () => {
    const { store, path } = await createStoreWithPendingComments(10);
    mocks.generateObject.mockResolvedValue({
      object: {
        assignments: Array.from({ length: 10 }, (_, index) => ({
          commentId: index + 1,
          categoryId: "correctness",
        })),
      },
    });

    const progress: number[] = [];
    const result = await new PendingCommentCategorizer(
      store,
      new CommentCategoryPolicy(),
    ).categorize({
      model: {} as LanguageModel,
      modelName: "test-model",
      onProgress: (event) => {
        if (event.type === "persisted") progress.push(event.completed);
      },
    });

    expect(mocks.generateObject).toHaveBeenCalledTimes(1);
    const call = mocks.generateObject.mock.calls[0]?.[0];
    expect(call.messages).toHaveLength(2);
    expect(
      call.messages.map((message: { role: string }) => message.role),
    ).toEqual(["assistant", "user"]);
    expect(JSON.parse(call.messages[0].content).categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: "correctness" }),
      ]),
    );
    expect(JSON.parse(call.messages[1].content).comments).toHaveLength(10);
    expect(result).toEqual({
      processed: 10,
      remaining: 0,
      categoryCounts: { correctness: 10 },
    });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const database = new Database(path);
    expect(
      database
        .prepare(
          "SELECT analysis_status AS status, analysis_result_json AS result FROM comments ORDER BY id",
        )
        .all(),
    ).toEqual(
      Array.from({ length: 10 }, () => ({
        status: "completed",
        result: JSON.stringify({ category: "correctness", resolution: "open" }),
      })),
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM comment_analytics").get(),
    ).toEqual({ count: 10 });
    database.close();
    store.close();
  });

  it("retries an incomplete response once and leaves the comments pending if it remains invalid", async () => {
    const { store, path } = await createStoreWithPendingComments(2);
    mocks.generateObject.mockResolvedValue({
      object: { assignments: [{ commentId: 1, categoryId: "correctness" }] },
    });

    await expect(
      new PendingCommentCategorizer(
        store,
        new CommentCategoryPolicy(),
      ).categorize({
        model: {} as LanguageModel,
        modelName: "test-model",
      }),
    ).rejects.toThrow("after one retry");
    expect(mocks.generateObject).toHaveBeenCalledTimes(2);

    const database = new Database(path);
    expect(
      database
        .prepare("SELECT analysis_status AS status FROM comments ORDER BY id")
        .all(),
    ).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(
      database
        .prepare(
          "SELECT status, retry_count AS retryCount FROM analysis_batches",
        )
        .get(),
    ).toEqual({ status: "failed", retryCount: 1 });
    database.close();
    store.close();
  });
});

async function createStoreWithPendingComments(count: number) {
  const directory = await mkdtemp(join(tmpdir(), "prcouch-categorization-"));
  const path = join(directory, "analytics.sqlite");
  const store = new AnalysisStore(path);
  const database = new Database(path);
  const now = "2026-01-01T00:00:00.000Z";
  database
    .prepare(
      "INSERT INTO projects (id, path_with_namespace, web_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(1, "group/project", "https://gitlab.test/group/project", now, now);
  database
    .prepare(
      "INSERT INTO merge_requests (project_id, iid, title, web_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      1,
      7,
      "Improve categorization",
      "https://gitlab.test/group/project/-/merge_requests/7",
      now,
      now,
    );
  const mergeRequestId = (
    database.prepare("SELECT id FROM merge_requests").get() as { id: number }
  ).id;
  database
    .prepare(
      "INSERT INTO discussions (merge_request_id, gitlab_discussion_id, resolved, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(mergeRequestId, "discussion-1", 0, now, now);
  const discussionId = (
    database.prepare("SELECT id FROM discussions").get() as { id: number }
  ).id;
  const insertComment = database.prepare(
    "INSERT INTO comments (project_id, merge_request_id, discussion_id, note_id, body, source_url, author_name, author_username, comment_created_at, analysis_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let index = 1; index <= count; index += 1) {
    insertComment.run(
      1,
      mergeRequestId,
      discussionId,
      index,
      `Comment ${index}`,
      `https://gitlab.test/note/${index}`,
      "Ava",
      "ava",
      now,
      "pending",
      now,
      now,
    );
  }
  database.close();
  return { store, path };
}
