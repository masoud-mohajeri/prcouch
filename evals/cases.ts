/**
 * This is a Laminar-compatible evaluation dataset: each row separates the
 * executor input (`data`) from its expected outcome (`target`).
 */
export type EvalInput = {
  query: string;
  gitLabFixture?: "recent-merge-request-comments";
};

export type EvalTarget = {
  toolSequence: string[];
  gitLabRequests?: string[];
  answerIncludes: string[];
};

export type EvalCase = {
  data: EvalInput;
  target: EvalTarget;
  metadata: { name: string };
};

export const cases: EvalCase[] = [
  {
    data: {
      query: "Show me the review comments on the last 2 PRs.",
      gitLabFixture: "recent-merge-request-comments",
    },
    target: {
      toolSequence: [
        "list_recent_merge_requests",
        "get_merge_request_discussions",
        "get_merge_request_discussions",
      ],
      gitLabRequests: [
        "/api/v4/projects/acme%2Fbilling/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=2",
        "/api/v4/projects/acme%2Fbilling/merge_requests/41/discussions?per_page=100&page=1",
        "/api/v4/projects/acme%2Fbilling/merge_requests/42/discussions?per_page=100&page=1",
      ],
      answerIncludes: ["validate the invoice number", "test the retry path"],
    },
    metadata: { name: "recent-merge-request-comments" },
  },
];
