import { describe, expect, it } from "vitest";

import { cases } from "../evals/cases.js";
import { score } from "../evals/scorers.js";

describe("golden-eval scorers", () => {
  it("requires the expected GitLab tool sequence, requests, and comment coverage", () => {
    const testCase = cases.find(
      (item) => item.metadata.name === "recent-merge-request-comments",
    )!;
    const scores = score(
      {
        text: "Review feedback: validate the invoice number and test the retry path.",
        toolCalls: testCase.target.toolSequence,
        gitLabRequests: testCase.target.gitLabRequests!,
      },
      testCase.target,
    );

    expect(scores).toEqual({
      toolSequence: 1,
      gitLabRequests: 1,
      answerCoverage: 1,
    });
  });

  it("rejects an answer that skips a GitLab discussion call", () => {
    const testCase = cases.find(
      (item) => item.metadata.name === "recent-merge-request-comments",
    )!;
    const scores = score(
      {
        text: "validate the invoice number and test the retry path",
        toolCalls: testCase.target.toolSequence.slice(0, 2),
        gitLabRequests: testCase.target.gitLabRequests!,
      },
      testCase.target,
    );

    expect(scores.toolSequence).toBe(0);
  });
});
