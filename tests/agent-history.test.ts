import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

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
          firstResponse,
          { role: "user", content: "How many open comments does it have?" },
        ],
      }),
    );
    expect(history).toEqual([
      { role: "user", content: "What is the project name?" },
      firstResponse,
      { role: "user", content: "How many open comments does it have?" },
      secondResponse,
    ]);
  });
});
