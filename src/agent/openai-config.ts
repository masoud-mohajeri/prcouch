export type OpenAIApiMode = "responses" | "chat";

export type OpenAIConfig = {
  baseURL?: string;
  apiMode: OpenAIApiMode;
};

export function getOpenAIConfig(env = process.env): OpenAIConfig {
  const baseURL = env.OPENAI_BASE_URL?.trim() || undefined;
  // OpenAI-compatible proxies commonly implement Chat Completions but not the
  // Responses API's item-based continuation protocol. Use Chat Completions for
  // a custom endpoint unless the user explicitly selects the Responses API.
  const configuredMode =
    env.OPENAI_API_MODE?.trim().toLowerCase() ||
    (baseURL ? "chat" : "responses");

  if (configuredMode !== "responses" && configuredMode !== "chat") {
    throw new Error('OPENAI_API_MODE must be either "responses" or "chat".');
  }

  return { baseURL, apiMode: configuredMode };
}
