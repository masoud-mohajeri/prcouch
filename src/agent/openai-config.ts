import { ServiceError } from "../errors.js";

export type OpenAIApiMode = "responses" | "chat";

export type OpenAIConfig = {
  baseURL?: string;
  apiMode: OpenAIApiMode;
};

export function getOpenAIConfig(env = process.env): OpenAIConfig {
  const baseURL = env.OPENAI_BASE_URL?.trim() || undefined;
  if (baseURL) validateBaseUrl(baseURL);
  // OpenAI-compatible proxies commonly implement Chat Completions but not the
  // Responses API's item-based continuation protocol. Use Chat Completions for
  // a custom endpoint unless the user explicitly selects the Responses API.
  const configuredMode =
    env.OPENAI_API_MODE?.trim().toLowerCase() ||
    (baseURL ? "chat" : "responses");

  if (configuredMode !== "responses" && configuredMode !== "chat") {
    throw new ServiceError(
      "openai",
      "configuration",
      'OPENAI_API_MODE must be either "responses" or "chat".',
    );
  }

  return { baseURL, apiMode: configuredMode };
}

function validateBaseUrl(baseURL: string): void {
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ServiceError(
      "openai",
      "configuration",
      "OPENAI_BASE_URL must be a valid http(s) URL.",
    );
  }
}
