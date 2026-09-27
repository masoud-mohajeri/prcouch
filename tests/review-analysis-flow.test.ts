import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { executeReviewAnalysisFlow } from "../evals/review-analysis-flow.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("review-analysis evaluation fixture", () => {
  it("runs project lookup through filtered comment analysis, persistence, and HTML reporting without GitLab credentials", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "prcouch-review-analysis-eval-"),
    );
    directories.push(directory);

    const result = await executeReviewAnalysisFlow({
      analysisPath: join(directory, "data", "analytics.sqlite"),
      reportDirectory: join(directory, "reports"),
    });

    expect(result.project).toMatchObject({
      name: "Billing",
      path_with_namespace: "acme/billing",
    });
    expect(result.comments).toMatchObject([
      {
        author: { name: "Ava", username: "ava" },
        location: { newPath: "src/invoice.ts", newLine: 18 },
        commitSha: "invoice-head-sha",
      },
    ]);
    expect(result.record).toMatchObject({
      category: "correctness",
      resolution: "addressed",
    });
    expect(result.report.recordCount).toBe(1);
    expect(await readFile(result.report.path, "utf8")).toContain(
      "Validate invoice numbers",
    );
    expect(result.requests).toEqual(
      expect.arrayContaining([
        "/api/v4/projects/acme%2Fbilling",
        "/api/v4/projects/acme%2Fbilling/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100",
        "/api/v4/projects/acme%2Fbilling/merge_requests/41/discussions?per_page=100&page=1",
      ]),
    );
  });
});
