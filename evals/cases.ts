export type EvalCase = {
  name: string;
  input: string;
  expectedTools: string[];
  expectedText: string[];
  expectedToolSequence?: string[];
  expectedGitLabRequests?: string[];
};

export const cases: EvalCase[] = [
  {
    name: "creates a task",
    input: "Add a task to buy milk tomorrow.",
    expectedTools: ["add_task"],
    expectedText: ["buy milk"],
  },
  {
    name: "lists seeded tasks",
    input: "What tasks do I still have?",
    expectedTools: ["list_tasks"],
    expectedText: ["write project brief"],
  },
  {
    name: "retrieves comments from the last two merge requests",
    input: "Show me the review comments on the last 2 PRs.",
    expectedTools: ["list_recent_merge_requests", "get_merge_request_discussions"],
    expectedToolSequence: [
      "list_recent_merge_requests",
      "get_merge_request_discussions",
      "get_merge_request_discussions",
    ],
    expectedGitLabRequests: [
      "/api/v4/projects/acme%2Fbilling/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=2",
      "/api/v4/projects/acme%2Fbilling/merge_requests/41/discussions?per_page=100&page=1",
      "/api/v4/projects/acme%2Fbilling/merge_requests/42/discussions?per_page=100&page=1",
    ],
    expectedText: ["validate the invoice number", "test the retry path"],
  },
];
