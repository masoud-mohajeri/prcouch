import { pruneMessages, type ModelMessage } from "ai";

/** Keeps interactive history well below typical model and proxy context limits. */
export const MAX_CHAT_HISTORY_CHARS = 24_000;

/**
 * Drops historical tool payloads and oldest complete turns. Tool results can
 * contain full discussions, so retaining them makes a normal follow-up exceed
 * a model's context window. The model can retrieve that data again when needed.
 */
export function compactChatHistory(
  messages: ModelMessage[],
  maxChars = MAX_CHAT_HISTORY_CHARS,
): ModelMessage[] {
  const textOnlyMessages = pruneMessages({
    messages,
    reasoning: "all",
    toolCalls: "all",
  });
  const turns = splitIntoTurns(textOnlyMessages);
  const retainedTurns: ModelMessage[][] = [];
  let retainedChars = 0;

  for (const turn of turns.reverse()) {
    const turnChars = estimateMessagesChars(turn);
    if (retainedChars + turnChars > maxChars) break;

    retainedTurns.unshift(turn);
    retainedChars += turnChars;
  }

  return retainedTurns.flat();
}

function splitIntoTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns;
}

function estimateMessagesChars(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length;
}
