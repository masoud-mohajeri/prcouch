import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mocks.generateText,
  };
});

import { runGitLabAgent } from "../src/agent/agent.js";
import { GitLabClient } from "../src/gitlab/client.js";

describe("runGitLabAgent chat history", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    mocks.generateText.mockReset();
  });

  it("keeps prior turns in memory for a follow-up request", async () => {
    const firstResponse = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "The project is Acme." }],
    };
    const secondResponse = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "It has two open comments." }],
    };
    mocks.generateText
      .mockResolvedValueOnce({
        text: "The project is Acme.",
        response: { messages: [firstResponse] },
        steps: [],
      })
      .mockResolvedValueOnce({
        text: "It has two open comments.",
        response: { messages: [secondResponse] },
        steps: [],
      });

    const history: ModelMessage[] = [];
    const gitLabClient = new GitLabClient({
      baseUrl: "https://gitlab.example.test",
      token: "test-token",
      project: "group/project",
    });
    await runGitLabAgent("What is the project name?", {
      chatHistory: history,
      gitLabClient,
    });
    await runGitLabAgent("How many open comments does it have?", {
      chatHistory: history,
      gitLabClient,
    });

    expect(mocks.generateText.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        messages: [
          { role: "user", content: "What is the project name?" },
          { role: "assistant", content: "The project is Acme." },
          { role: "user", content: "How many open comments does it have?" },
        ],
      }),
    );
    expect(history).toEqual([
      { role: "user", content: "What is the project name?" },
      { role: "assistant", content: "The project is Acme." },
      { role: "user", content: "How many open comments does it have?" },
      { role: "assistant", content: "It has two open comments." },
    ]);
  });

  it("formats simple merge-request lists from verified GitLab data without generating text", async () => {
    const client = new GitLabClient(
      {
        baseUrl: "https://gitlab.example.test",
        token: "test-token",
        project: "group/project",
      },
      async (url) => {
        if (String(url).includes("/merge_requests?")) {
          return new Response(
            JSON.stringify([
              {
                iid: 77,
                title: "Fix the list",
                state: "merged",
                web_url:
                  "https://gitlab.example.test/group/project/-/merge_requests/77",
              },
            ]),
          );
        }
        return new Response(
          JSON.stringify({ path_with_namespace: "group/project" }),
        );
      },
    );

    const chatHistory: ModelMessage[] = [];
    const result = await runGitLabAgent("give me list of last merged PRs", {
      gitLabClient: client,
      chatHistory,
    });

    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual(["list_recent_merge_requests"]);
    expect(result.text).toContain("Project: group/project");
    expect(result.text).toContain("Result: 1 merged merge request found.");
    expect(result.text).toContain("!77 — Fix the list");
    expect(chatHistory).toEqual([
      { role: "user", content: "give me list of last merged PRs" },
      { role: "assistant", content: result.text },
    ]);
  });

  it("retrieves bounded recent-MR comments directly without asking the model to orchestrate tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prcouch-agent-comments-"));
    const previousStorePath = process.env.ANALYSIS_STORE_PATH;
    process.env.ANALYSIS_STORE_PATH = join(directory, "analytics.sqlite");
    const client = new GitLabClient(
      {
        baseUrl: "https://gitlab.example.test",
        token: "test-token",
        project: "group/project",
      },
      async (url) => {
        if (String(url).endsWith("/projects/group%2Fproject")) {
          return new Response(
            JSON.stringify({
              id: 7,
              path_with_namespace: "group/project",
              web_url: "https://gitlab.example.test/group/project",
            }),
          );
        }
        if (String(url).includes("/merge_requests?"))
          return new Response(JSON.stringify([]));
        return new Response("Not found", { status: 404 });
      },
    );

    try {
      const result = await runGitLabAgent(
        "get all comments on last 100 merged PRs",
        { gitLabClient: client },
      );

      expect(mocks.generateText).not.toHaveBeenCalled();
      expect(result.toolCalls).toEqual(["list_comments"]);
      expect(result.text).toContain("Merge requests: 0 of 100 requested");
      expect(result.text).toContain("ordered by merge time");
    } finally {
      if (previousStorePath === undefined)
        delete process.env.ANALYSIS_STORE_PATH;
      else process.env.ANALYSIS_STORE_PATH = previousStorePath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retrieves a named merge request instead of falling back to a recent list", async () => {
    const client = new GitLabClient(
      {
        baseUrl: "https://gitlab.example.test",
        token: "test-token",
        project: "group/project",
      },
      async (url) => {
        if (String(url).endsWith("/merge_requests/5896")) {
          return new Response(
            JSON.stringify({
              iid: 5896,
              title: "Resolve demo issues",
              state: "opened",
              web_url:
                "https://gitlab.example.test/group/project/-/merge_requests/5896",
              updated_at: "2026-09-27T10:00:00.000Z",
              author: { name: "Ada Lovelace", username: "ada" },
            }),
          );
        }
        return new Response(
          JSON.stringify({ path_with_namespace: "group/project" }),
        );
      },
    );

    const result = await runGitLabAgent("give me infos about this PR !5896", {
      gitLabClient: client,
    });

    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual(["get_merge_request"]);
    expect(result.text).toContain("Merge request: !5896 — Resolve demo issues");
    expect(result.text).toContain("Author: Ada Lovelace (@ada)");
  });
});
