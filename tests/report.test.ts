import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AnalysisStore, type AnalyzedCommentInput } from "../src/analysis-store.js";
import { CommentCategoryPolicy } from "../src/comment-category-policy.js";
import { CommentReportGenerator, getReportDirectory } from "../src/report.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "prcouch-report-"));
  directories.push(directory);
  const store = new AnalysisStore(join(directory, "analysis.json"));
  const reportsDirectory = join(directory, "reports");
  const generator = new CommentReportGenerator(store, new CommentCategoryPolicy(), reportsDirectory);
  return { store, generator, reportsDirectory };
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
    ...overrides,
  };
}

describe("CommentReportGenerator", () => {
  it("generates an offline HTML report with charts, controls, and escaped review data", async () => {
    const { store, generator, reportsDirectory } = await fixture();
    await store.upsert(input({
      comment: { ...input().comment, body: '<img src=x onerror="alert(1)">', author: { name: "Ava", username: "ava" } },
      category: "security",
      resolution: "addressed",
    }));
    await store.upsert(input({
      comment: {
        ...input().comment,
        noteId: 46,
        sourceUrl: "https://gitlab.example.test/team/service/-/merge_requests/12#note_46",
        author: { name: "Ben", username: "ben" },
      },
      category: "testing",
      resolution: "needs_discussion",
    }));

    const report = await generator.generate();
    const html = await readFile(report.path, "utf8");

    expect(report.path.startsWith(`${reportsDirectory}/`)).toBe(true);
    expect(report.recordCount).toBe(2);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Self-contained offline report");
    expect(html).toContain("Categories");
    expect(html).toContain("Resolutions");
    expect(html).toContain("Comments by author");
    expect(html).toContain("Analysis trend");
    expect(html.match(/<svg/g)).toHaveLength(4);
    expect(html).toContain('id="comment-filter"');
    expect(html).toContain("data-sort-column");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("cdn");
  });

  it("applies saved-analysis filters and generates an explicit empty state", async () => {
    const { store, generator } = await fixture();
    await store.upsert(input());
    await store.upsert(input({
      comment: { ...input().comment, noteId: 46, sourceUrl: "https://gitlab.example.test/team/service/-/merge_requests/12#note_46", author: { name: "Ben", username: "ben" } },
      category: "testing",
    }));

    const filtered = await generator.generate({ authorName: "ben", category: "testing" });
    const filteredHtml = await readFile(filtered.path, "utf8");
    const empty = await generator.generate({ category: "security" });
    const emptyHtml = await readFile(empty.path, "utf8");

    expect(filtered.recordCount).toBe(1);
    expect(filteredHtml).toContain("Ben");
    expect(filteredHtml).not.toContain("Ava");
    expect(empty.recordCount).toBe(0);
    expect(emptyHtml).toContain("No matching analyzed comments.");
    expect(emptyHtml).not.toContain("<svg");
  });

  it("rejects inverted report-date filters and honors a report-directory override", async () => {
    const { generator } = await fixture();

    await expect(generator.generate({
      analyzedAfter: "2026-01-03T00:00:00.000Z",
      analyzedBefore: "2026-01-02T00:00:00.000Z",
    })).rejects.toThrow("analyzedAfter must be before or equal to analyzedBefore");
    expect(getReportDirectory({ REPORT_OUTPUT_DIR: "custom/reports" })).toMatch(/custom\/reports$/);
  });
});
