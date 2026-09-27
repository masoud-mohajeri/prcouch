import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnalysisStore,
  getAnalysisStorePath,
  type AnalyzedCommentInput,
} from "../src/analysis/store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "prcouch-analysis-store-"));
  directories.push(directory);
  return {
    directory,
    path: join(directory, "nested", "analytics.sqlite"),
    store: new AnalysisStore(join(directory, "nested", "analytics.sqlite")),
  };
}

function input(
  overrides: Partial<AnalyzedCommentInput> = {},
): AnalyzedCommentInput {
  return {
    project: {
      id: 7,
      pathWithNamespace: "team/service",
      webUrl: "https://gitlab.example.test/team/service",
    },
    mergeRequest: {
      iid: 12,
      title: "Validate invoices",
      webUrl: "https://gitlab.example.test/team/service/-/merge_requests/12",
    },
    comment: {
      discussionId: "discussion-12",
      noteId: 45,
      body: "Validate the invoice number.",
      sourceUrl:
        "https://gitlab.example.test/team/service/-/merge_requests/12#note_45",
      createdAt: "2026-01-02T03:04:05.000Z",
      author: { name: "Ava", username: "ava" },
      location: {
        oldPath: null,
        newPath: "src/invoice.ts",
        oldLine: null,
        newLine: 18,
      },
      commitSha: "abcdef",
    },
    category: "correctness",
    resolution: "open",
    rationale: "The missing validation can save malformed invoice data.",
    ...overrides,
  };
}

describe("AnalysisStore", () => {
  it("applies the analytics schema on a new database", async () => {
    const { path, store } = await createStore();
    store.close();
    const database = new Database(path, { readonly: true });

    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(
        expect.arrayContaining([
          "analysis_batches",
          "comment_analytics",
          "comments",
          "discussions",
          "issue_categories",
          "merge_requests",
          "projects",
          "sync_runs",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("creates a migrated SQLite database and records generated analysis metadata", async () => {
    const { store, path } = await createStore();

    const record = await store.upsert(input());

    expect(record).toMatchObject({
      id: "7:45",
      category: "correctness",
      resolution: "open",
    });
    expect(record.analyzedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(await store.list()).toEqual([record]);
    expect(path).toMatch(/analytics\.sqlite$/);
  });

  it("preserves an existing project/note row and serializes distinct writes", async () => {
    const { store } = await createStore();
    const second = input({
      comment: {
        ...input().comment,
        noteId: 46,
        sourceUrl:
          "https://gitlab.example.test/team/service/-/merge_requests/12#note_46",
      },
    });

    await Promise.all([store.upsert(input()), store.upsert(second)]);
    await expect(
      store.upsert(input({ category: "security", resolution: "addressed" })),
    ).rejects.toThrow("Comment 7:45 already exists");

    expect(await store.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "7:45",
          category: "correctness",
          resolution: "open",
        }),
        expect.objectContaining({
          id: "7:46",
          category: "correctness",
          resolution: "open",
        }),
      ]),
    );
  });

  it("starts empty and rejects invalid analysis input", async () => {
    const { store } = await createStore();

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.upsert(input({ category: "   " }))).rejects.toThrow(
      "String must contain at least 1 character",
    );
    await expect(
      store.upsert(input({ resolution: "invalid" as "open" })),
    ).rejects.toThrow("Invalid enum value");
  });

  it("uses the default path or a configured path without accepting a tool argument", () => {
    expect(getAnalysisStorePath({})).toMatch(/data\/analytics\.sqlite$/);
    expect(
      getAnalysisStorePath({ ANALYSIS_STORE_PATH: "custom/comments.sqlite" }),
    ).toMatch(/custom\/comments\.sqlite$/);
  });
});
