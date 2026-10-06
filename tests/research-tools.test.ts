import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { CommentCategoryPolicy } from "../src/analysis/category-policy.js";
import {
  AnalysisStore,
  type AnalyzedCommentInput,
} from "../src/analysis/store.js";
import { GitLabClient } from "../src/gitlab/client.js";
import { SearxngClient } from "../src/search/searxng.js";
import {
  analyzedCommentFiltersSchema,
  createResearchTools,
} from "../src/agent/tools/research-tools.js";

function comment(
  projectId: number,
  noteId: number,
  category = "correctness",
): AnalyzedCommentInput {
  return {
    project: {
      id: projectId,
      pathWithNamespace: `team/project-${projectId}`,
      webUrl: `https://gitlab.test/${projectId}`,
    },
    mergeRequest: {
      iid: 42,
      title: "Validation",
      webUrl: `https://gitlab.test/${projectId}/42`,
    },
    comment: {
      noteId,
      discussionId: `d-${noteId}`,
      body: "Validate input",
      sourceUrl: `https://gitlab.test/${projectId}/42#note_${noteId}`,
      createdAt: "2026-01-02T00:00:00Z",
      author: { name: "Reviewer", username: "reviewer" },
    },
    category,
    resolution: "open",
    rationale: "Missing validation",
  };
}

describe("research tools", () => {
  it("finds numeric notes beyond the first page and returns database metadata and analysis status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prcouch-exact-note-"));
    const path = join(directory, "analytics.sqlite");
    const store = new AnalysisStore(path);
    try {
      for (let noteId = 1; noteId <= 30; noteId++)
        await store.upsert(comment(7, noteId));
      await store.upsert(comment(8, 1));
      await store.saveFetchedComments([comment(7, 31)]);
      const db = new Database(path);
      db.prepare(
        "UPDATE issue_categories SET description = ?, recommended_solution = ? WHERE code = ?",
      ).run(
        "Database category description",
        "Database category action",
        "correctness",
      );
      db.prepare(
        "UPDATE comment_analytics SET solution = ? WHERE comment_id = (SELECT id FROM comments WHERE project_id = ? AND note_id = ?)",
      ).run("Stored comment solution", 7, 1);
      db.close();
      const client = new GitLabClient(
        { baseUrl: "https://gitlab.test", token: "test", project: "7" },
        async () =>
          new Response(
            JSON.stringify({ id: 7, path_with_namespace: "team/project-7" }),
          ),
      );
      const tools = createResearchTools(client, store);
      const context = { toolCallId: "test", messages: [] };
      const page = await tools.list_analyzed_comments.execute!(
        analyzedCommentFiltersSchema.parse({}),
        context,
      );
      if (Symbol.asyncIterator in page) throw new Error("Expected one result");
      expect(page.records.map((record) => record.comment.noteId)).not.toContain(
        1,
      );
      const exact = await tools.get_analyzed_comment.execute!(
        { noteId: 1 },
        context,
      );
      expect(exact).toMatchObject({
        status: "completed",
        record: {
          id: "7:1",
          solution: "Stored comment solution",
          recommendedAction: "Database category action",
          categoryDetails: {
            description: "Database category description",
            recommendedSolution: "Database category action",
          },
        },
      });
      const filtered = await tools.list_analyzed_comments.execute!(
        analyzedCommentFiltersSchema.parse({ noteIds: [1], limit: 1 }),
        context,
      );
      expect(filtered).toMatchObject({
        total: 1,
        nextOffset: null,
        records: [{ id: "7:1" }],
      });
      expect(
        await tools.get_analyzed_comment.execute!({ noteId: 31 }, context),
      ).toMatchObject({
        status: "not_analyzed",
        analysisStatus: "pending",
        record: null,
      });
      expect(
        await tools.get_analyzed_comment.execute!({ noteId: 99 }, context),
      ).toMatchObject({ status: "not_found", record: null });
      const emptyPage = await tools.list_analyzed_comments.execute!(
        analyzedCommentFiltersSchema.parse({ noteIds: [1], offset: 5 }),
        context,
      );
      expect(emptyPage).toMatchObject({ total: 1, records: [] });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("scopes completed analyses to the selected project, filters and paginates without writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prcouch-research-"));
    const store = new AnalysisStore(join(directory, "analytics.sqlite"));
    try {
      await store.upsert(
        comment(7, 45),
        await new CommentCategoryPolicy().require("correctness"),
      );
      await store.upsert(
        comment(7, 46),
        await new CommentCategoryPolicy().require("correctness"),
      );
      await store.upsert(comment(7, 47, "security"));
      await store.upsert(
        comment(8, 48),
        await new CommentCategoryPolicy().require("correctness"),
      );
      const client = new GitLabClient(
        { baseUrl: "https://gitlab.test", token: "test", project: "7" },
        async () =>
          new Response(
            JSON.stringify({ id: 7, path_with_namespace: "team/project-7" }),
          ),
      );
      const tools = createResearchTools(client, store);
      const execute = async (input: object) => {
        const result = await tools.list_analyzed_comments.execute!(
          analyzedCommentFiltersSchema.parse(input),
          { toolCallId: "test", messages: [] },
        );
        if (Symbol.asyncIterator in result)
          throw new Error("Expected a single tool result");
        return result;
      };
      const before = await store.list();
      const page = await execute({
        categories: ["correctness"],
        mergeRequestIid: 42,
        limit: 1,
      });
      expect(page).toMatchObject({ total: 2, nextOffset: 1 });
      expect(page.records).toHaveLength(1);
      expect(page.records[0]?.recommendedAction).toBeTruthy();
      const next = await execute({
        categories: ["correctness"],
        limit: 1,
        offset: 1,
      });
      expect(next.nextOffset).toBeNull();
      expect(next.records[0]?.id).not.toBe(page.records[0]?.id);
      expect(
        (await execute({ ids: ["7:45", "8:48"] })).records.map(
          (record) => record.id,
        ),
      ).toEqual(["7:45"]);
      expect(
        (
          await execute({
            category: "security",
            resolution: "open",
            commentCreatedAfter: "2026-01-01T00:00:00Z",
          })
        ).total,
      ).toBe(1);
      expect(
        (await execute({ commentCreatedBefore: "2026-01-01T00:00:00Z" })).total,
      ).toBe(0);
      expect(
        (await execute({ analyzedBefore: "2020-01-01T00:00:00Z" })).total,
      ).toBe(0);
      expect(await store.list()).toEqual(before);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid pagination and date ranges", () => {
    expect(analyzedCommentFiltersSchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(analyzedCommentFiltersSchema.safeParse({ offset: -1 }).success).toBe(
      false,
    );
    expect(
      analyzedCommentFiltersSchema.safeParse({
        commentCreatedAfter: "2026-02-01T00:00:00Z",
        commentCreatedBefore: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("enforces explicit search authorization before contacting SearXNG", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"results":[]}'));
    const client = new GitLabClient({
      baseUrl: "https://gitlab.test",
      token: "test",
      project: "7",
    });
    const store = { list: vi.fn() } as unknown as AnalysisStore;
    const search = new SearxngClient("http://localhost:8080", fetchImpl);
    const blocked = createResearchTools(client, store, search);
    await expect(
      blocked.search_web.execute!(
        { query: "validation", limit: 10 },
        { toolCallId: "test", messages: [] },
      ),
    ).rejects.toMatchObject({ service: "searxng", kind: "request" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const allowed = createResearchTools(client, store, search, true);
    await allowed.search_web.execute!(
      { query: "validation", limit: 10 },
      { toolCallId: "test", messages: [] },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
