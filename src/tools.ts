import { tool } from "ai";
import { z } from "zod";

import { TaskStore } from "./task-store.js";
import { GitLabClient, requireGitLabConfig } from "./gitlab.js";

/**
 * Keep tools narrow, schema-validated, and authorization-aware. Replace this
 * in-memory store with your database and enforce user/tenant checks here.
 */
export function createTaskTools(store: TaskStore) {
  return {
    add_task: tool({
      description: "Create a task for the user. Use only when they ask to add, remember, or create a task.",
      inputSchema: z.object({
        title: z.string().min(1).describe("A concise task title"),
        dueDate: z.string().optional().describe("Optional due date, preserving the user's wording"),
      }),
      execute: async ({ title, dueDate }) => ({ task: store.add(title, dueDate) }),
    }),
    list_tasks: tool({
      description: "List the user's tasks. Use when asked what tasks exist or remain.",
      inputSchema: z.object({
        includeCompleted: z.boolean().default(false).describe("Whether completed tasks should be included"),
      }),
      execute: async ({ includeCompleted }) => ({ tasks: store.list(includeCompleted) }),
    }),
    complete_task: tool({
      description: "Mark a task complete by its ID. Ask for the ID if the task cannot be identified safely.",
      inputSchema: z.object({ id: z.string().min(1).describe("The task ID") }),
      execute: async ({ id }) => {
        const task = store.complete(id);
        return task ? { task } : { error: `No task found with ID ${id}` };
      },
    }),
  };
}

/**
 * Read-only GitLab tools. Credentials and the project are process configuration,
 * not tool arguments, so a model cannot redirect requests or provide a token.
 */
export function createGitLabTools(client = new GitLabClient(requireGitLabConfig())) {

  return {
    list_recent_merge_requests: tool({
      description: "List the most recently updated GitLab merge requests in the configured project. Use this before retrieving their comments.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10).describe("Number of merge requests to return"),
        state: z.enum(["all", "opened", "closed", "merged"]).default("all").describe("Merge-request state to include"),
      }),
      execute: async ({ limit, state }) => ({ mergeRequests: await client.listRecentMergeRequests(limit, state) }),
    }),
    get_merge_request_discussions: tool({
      description: "Get every GitLab discussion and review comment, including inline/diff comments, for one merge request. Pass the merge request IID returned by list_recent_merge_requests, not its database ID.",
      inputSchema: z.object({
        mergeRequestIid: z.number().int().positive().describe("Project-local merge request IID"),
      }),
      execute: async ({ mergeRequestIid }) => ({
        discussions: await client.listMergeRequestDiscussions(mergeRequestIid),
      }),
    }),
  };
}
