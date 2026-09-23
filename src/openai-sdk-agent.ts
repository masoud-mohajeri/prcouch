import "dotenv/config";
import OpenAI from "openai";

import { GitLabClient, requireGitLabConfig } from "./gitlab.js";
import { TaskStore } from "./task-store.js";

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error('Usage: npm run openai-sdk -- "Add buy milk tomorrow"');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY?.trim()) {
  console.error("Missing required configuration: OPENAI_API_KEY.");
  process.exit(1);
}

const client = new OpenAI();
const store = new TaskStore();
const gitlab = new GitLabClient(requireGitLabConfig());

const tools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "add_task",
    description: "Create a task for the user.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, dueDate: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_tasks",
    description: "List the user's tasks.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "list_recent_merge_requests",
    description: "List the most recently updated GitLab merge requests in the configured project. Use this before retrieving their comments.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        state: { type: "string", enum: ["all", "opened", "closed", "merged"] },
      },
      required: ["limit", "state"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_merge_request_discussions",
    description: "Get every GitLab discussion and review comment, including inline/diff comments, for one merge request. Pass the merge request IID, not its database ID.",
    parameters: {
      type: "object",
      properties: { mergeRequestIid: { type: "integer", minimum: 1 } },
      required: ["mergeRequestIid"],
      additionalProperties: false,
    },
    strict: true,
  },
];

let response = await client.responses.create({
  model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  instructions: "You are a concise personal task and GitLab assistant. Use tools for task and GitLab data. For comments on recent merge requests, first list the requested number of merge requests, then retrieve discussions for each result. Never claim data was retrieved unless the tool confirms it.",
  input,
  tools,
});

while (response.output.some((item) => item.type === "function_call")) {
  const outputs = await Promise.all(response.output
    .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call")
    .map(async (call) => {
      const args = JSON.parse(call.arguments) as {
        title?: string;
        dueDate?: string;
        limit?: number;
        state?: "all" | "opened" | "closed" | "merged";
        mergeRequestIid?: number;
      };
      let output: unknown;
      switch (call.name) {
        case "add_task":
          output = { task: store.add(args.title!, args.dueDate) };
          break;
        case "list_tasks":
          output = { tasks: store.list() };
          break;
        case "list_recent_merge_requests":
          output = { mergeRequests: await gitlab.listRecentMergeRequests(args.limit!, args.state) };
          break;
        case "get_merge_request_discussions":
          output = { discussions: await gitlab.listMergeRequestDiscussions(args.mergeRequestIid!) };
          break;
        default:
          output = { error: `Unsupported tool: ${call.name}` };
      }
      return { type: "function_call_output" as const, call_id: call.call_id, output: JSON.stringify(output) };
    }));

  response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
    previous_response_id: response.id,
    input: outputs,
    tools,
  });
}

console.log(response.output_text);
