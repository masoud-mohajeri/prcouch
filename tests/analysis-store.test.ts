import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AnalysisStore, getAnalysisStorePath, type AnalyzedCommentInput } from "../src/analysis-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "prcouch-analysis-store-"));
  directories.push(directory);
  return { directory, path: join(directory, "nested", "analyzed-comments.json"), store: new AnalysisStore(join(directory, "nested", "analyzed-comments.json")) };
}

function input(overrides: Partial<AnalyzedCommentInput> = {}): AnalyzedCommentInput {
  return {
    project: { id: 7, pathWithNamespace: "team/service", webUrl: "https://gitlab.example.test/team/service" },
    mergeRequest: { iid: 12, title: "Validate invoices", webUrl: "https://gitlab.example.test/team/service/-/merge_requests/12" },
    comment: {
      discussionId: "discussion-12",
      noteId: 45,
      body: "Validate the invoice number.",
      sourceUrl: "https://gitlab.example.test/team/service/-/merge_requests/12#note_45",
      createdAt: "2026-01-02T03:04:05.000Z",
      author: { name: "Ava", username: "ava" },
      location: { oldPath: null, newPath: "src/invoice.ts", oldLine: null, newLine: 18 },
      commitSha: "abcdef",
    },
    category: "correctness",
    resolution: "open",
    rationale: "The missing validation can save malformed invoice data.",
    ...overrides,
  };
}

describe("AnalysisStore", () => {
  it("creates a versioned JSON file and records generated analysis metadata", async () => {
    const { store, path } = await createStore();

    const record = await store.upsert(input());

    expect(record).toMatchObject({ id: "7:45", category: "correctness", resolution: "open" });
    expect(record.analyzedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(await store.list()).toEqual([record]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, records: [record] });
  });

  it("upserts immutable project/note keys and serializes concurrent writes", async () => {
    const { store } = await createStore();
    const second = input({
      comment: {
        ...input().comment,
        noteId: 46,
        sourceUrl: "https://gitlab.example.test/team/service/-/merge_requests/12#note_46",
      },
    });

    await Promise.all([store.upsert(input()), store.upsert(second)]);
    await store.upsert(input({ category: "security", resolution: "addressed" }));

    expect(await store.list()).toMatchObject([
      { id: "7:45", category: "security", resolution: "addressed" },
      { id: "7:46", category: "correctness", resolution: "open" },
    ]);
  });

  it("treats an empty file as a new store and rejects invalid analysis input", async () => {
    const { store, path } = await createStore();
    await writeFile(path, "", "utf8").catch(async () => {
      // The parent directory has not been created yet; the first write creates it through the store.
      await store.upsert(input());
      await writeFile(path, "", "utf8");
    });

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.upsert(input({ category: "   " }))).rejects.toThrow("String must contain at least 1 character");
    await expect(store.upsert(input({ resolution: "invalid" as "open" }))).rejects.toThrow("Invalid enum value");
  });

  it("reports malformed and unsupported-version files clearly", async () => {
    const { store, path } = await createStore();
    await store.upsert(input());
    await writeFile(path, "{ not JSON", "utf8");
    await expect(store.list()).rejects.toThrow("malformed JSON");

    await writeFile(path, JSON.stringify({ version: 2, records: [] }), "utf8");
    await expect(store.list()).rejects.toThrow("unsupported version 2");
  });

  it("uses the default path or a configured path without accepting a tool argument", () => {
    expect(getAnalysisStorePath({})).toMatch(/data\/analyzed-comments\.json$/);
    expect(getAnalysisStorePath({ ANALYSIS_STORE_PATH: "custom/comments.json" })).toMatch(/custom\/comments\.json$/);
  });
});
