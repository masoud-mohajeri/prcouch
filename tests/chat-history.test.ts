import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { compactChatHistory } from "../src/agent/chat-history.js";

describe("compactChatHistory", () => {
  it("drops large tool payloads and oldest complete turns", () => {
    const firstTurn: ModelMessage[] = [
      { role: "user", content: "List unresolved comments." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "list_comments",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "list_comments",
            output: { type: "json", value: { comments: "x".repeat(50_000) } },
          },
        ],
      },
      { role: "assistant", content: "I found 25 unresolved comments." },
    ];
    const latestTurn: ModelMessage[] = [
      { role: "user", content: "How many are security-related?" },
      { role: "assistant", content: "Three are security-related." },
    ];

    expect(
      compactChatHistory(
        [...firstTurn, ...latestTurn],
        JSON.stringify(latestTurn).length,
      ),
    ).toEqual(latestTurn);
  });
});
