import "dotenv/config";

import { cases } from "./cases.js";
import { runTaskAgent } from "../src/agent.js";
import { GitLabClient } from "../src/gitlab.js";
import { TaskStore } from "../src/task-store.js";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required to run live evals.");
}

let failures = 0;
for (const testCase of cases) {
  const store = new TaskStore();
  if (testCase.name === "lists seeded tasks") store.add("write project brief");
  const { client: gitLabClient, requests } = createGitLabEvalClient();
  const result = await runTaskAgent(testCase.input, store, gitLabClient);
  const text = result.text.toLowerCase();
  const missingTools = testCase.expectedTools.filter((name) => !result.toolCalls.includes(name));
  const missingText = testCase.expectedText.filter((phrase) => !text.includes(phrase));
  const invalidToolSequence = testCase.expectedToolSequence
    && JSON.stringify(result.toolCalls) !== JSON.stringify(testCase.expectedToolSequence);
  const invalidGitLabRequests = testCase.expectedGitLabRequests
    && JSON.stringify(requests) !== JSON.stringify(testCase.expectedGitLabRequests);
  const passed = missingTools.length === 0 && missingText.length === 0 && !invalidToolSequence && !invalidGitLabRequests;
  console.log(`${passed ? "PASS" : "FAIL"} ${testCase.name}`);
  if (!passed) {
    failures += 1;
    if (missingTools.length) console.log(`  Missing tool calls: ${missingTools.join(", ")}`);
    if (missingText.length) console.log(`  Missing text: ${missingText.join(", ")}`);
    if (invalidToolSequence) console.log(`  Tool sequence: ${result.toolCalls.join(", ")}`);
    if (invalidGitLabRequests) console.log(`  GitLab requests: ${requests.join(", ")}`);
  }
}

if (failures) process.exit(1);

function createGitLabEvalClient() {
  const requests: string[] = [];
  const client = new GitLabClient(
    { baseUrl: "https://gitlab.example.test", token: "eval-token", project: "acme/billing" },
    async (input) => {
      const url = new URL(input.toString());
      requests.push(`${url.pathname}${url.search}`);

      if (url.pathname.endsWith("/merge_requests")) {
        return json([
          { iid: 41, title: "Validate invoice numbers", state: "merged", web_url: "https://gitlab.example.test/acme/billing/-/merge_requests/41" },
          { iid: 42, title: "Retry failed charges", state: "merged", web_url: "https://gitlab.example.test/acme/billing/-/merge_requests/42" },
        ]);
      }
      if (url.pathname.endsWith("/merge_requests/41/discussions")) {
        return json([{ id: "41-discussion", individual_note: true, notes: [{ body: "Please validate the invoice number before saving.", author: { name: "Ava", username: "ava" }, system: false }] }]);
      }
      if (url.pathname.endsWith("/merge_requests/42/discussions")) {
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
