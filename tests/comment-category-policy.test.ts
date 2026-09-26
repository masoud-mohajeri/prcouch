import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnalysisStore,
  type AnalyzedCommentInput,
} from "../src/analysis/store.js";
import { AnalyzedCommentService } from "../src/analysis/service.js";
import {
  CommentCategoryPolicy,
  getCommentCategoryConfigPath,
} from "../src/analysis/category-policy.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "prcouch-category-policy-"));
  directories.push(directory);
  return directory;
}

function analysisInput(category = "correctness"): AnalyzedCommentInput {
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
    category,
    resolution: "open",
  };
}

describe("CommentCategoryPolicy", () => {
  it("loads the committed category IDs, actions, and default resolutions", async () => {
    const categories = await new CommentCategoryPolicy().list();

    expect(categories).toHaveLength(11);
    expect(
      categories.find((category) => category.id === "security"),
    ).toMatchObject({
      severity: "critical",
      defaultResolution: "open",
      action: expect.stringContaining("security review"),
    });
    expect(categories.every((category) => category.action.length > 0)).toBe(
      true,
    );
  });

  it("allows only configured categories to be persisted", async () => {
    const directory = await temporaryDirectory();
    const service = new AnalyzedCommentService(
      new AnalysisStore(join(directory, "analysis.json")),
      new CommentCategoryPolicy(),
    );

    await expect(service.save(analysisInput("not-a-category"))).rejects.toThrow(
      'Unknown comment category "not-a-category"',
    );
    await expect(
      service.save(analysisInput("security")),
    ).resolves.toMatchObject({ category: "security" });
  });

  it("rejects malformed, unsupported, and duplicate-ID policy files", async () => {
    const directory = await temporaryDirectory();
    const policyPath = join(directory, "categories.json");
    await writeFile(policyPath, "{ invalid", "utf8");
    await expect(new CommentCategoryPolicy(policyPath).list()).rejects.toThrow(
      "malformed JSON",
    );

    await writeFile(
      policyPath,
      JSON.stringify({ version: 2, categories: [] }),
      "utf8",
    );
    await expect(new CommentCategoryPolicy(policyPath).list()).rejects.toThrow(
      "unsupported version 2",
    );

    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        categories: [
          {
            id: "bug",
            label: "Bug",
            description: "A bug",
            severity: "high",
            defaultResolution: "open",
            action: "Fix it",
          },
          {
            id: "bug",
            label: "Bug again",
            description: "Another bug",
            severity: "high",
            defaultResolution: "open",
            action: "Fix it",
          },
        ],
      }),
      "utf8",
    );
    await expect(new CommentCategoryPolicy(policyPath).list()).rejects.toThrow(
      "Duplicate category ID: bug",
    );
  });

  it("uses the default policy file or an explicit environment override", () => {
    expect(getCommentCategoryConfigPath({})).toMatch(
      /config\/comment-categories\.json$/,
    );
    expect(
      getCommentCategoryConfigPath({
        COMMENT_CATEGORY_CONFIG_PATH: "custom/categories.json",
      }),
    ).toMatch(/custom\/categories\.json$/);
  });
});
