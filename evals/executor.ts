import { runTaskAgent, type AgentResult } from "../src/agent.js";
import { GitLabClient } from "../src/gitlab.js";
import { TaskStore } from "../src/task-store.js";
import type { EvalInput } from "./cases.js";

export type EvalOutput = Pick<AgentResult, "text" | "toolCalls"> & {
  gitLabRequests: string[];
};

/**
 * A pure(ish) executor: it accepts one dataset row's data and returns structured
 * output. Laminar can pass this function directly to `evaluate` in the future.
 */
export async function executeEvalCase(input: EvalInput): Promise<EvalOutput> {
  const store = new TaskStore();
  for (const task of input.seedTasks ?? []) store.add(task);

  const { client, requests } = createGitLabFixture(input.gitLabFixture);
  const result = await runTaskAgent(input.query, store, client);
  return { text: result.text, toolCalls: result.toolCalls, gitLabRequests: requests };
}

function createGitLabFixture(fixture: EvalInput["gitLabFixture"]) {
  const requests: string[] = [];
  const client = new GitLabClient(
    { baseUrl: "https://gitlab.example.test", token: "eval-token", project: "acme/billing" },
    async (input) => {
      const url = new URL(input.toString());
      requests.push(`${url.pathname}${url.search}`);

      if (fixture === "recent-merge-request-comments" && url.pathname.endsWith("/merge_requests")) {
        return json([
          { iid: 41, title: "Validate invoice numbers", state: "merged", web_url: "https://gitlab.example.test/acme/billing/-/merge_requests/41" },
          { iid: 42, title: "Retry failed charges", state: "merged", web_url: "https://gitlab.example.test/acme/billing/-/merge_requests/42" },
        ]);
      }
      if (fixture === "recent-merge-request-comments" && url.pathname.endsWith("/merge_requests/41/discussions")) {
        return json([{ id: "41-discussion", individual_note: true, notes: [{ body: "Please validate the invoice number before saving.", author: { name: "Ava", username: "ava" }, system: false }] }]);
      }
      if (fixture === "recent-merge-request-comments" && url.pathname.endsWith("/merge_requests/42/discussions")) {
        return json([{ id: "42-discussion", individual_note: true, notes: [{ body: "Add a test for the retry path.", author: { name: "Ben", username: "ben" }, system: false }] }]);
      }
      return new Response("Not found", { status: 404, statusText: "Not Found" });
    },
  );

  return { client, requests };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
