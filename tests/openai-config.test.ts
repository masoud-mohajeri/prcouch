import { describe, expect, it } from "vitest";

import { getOpenAIConfig } from "../src/openai-config.js";

describe("getOpenAIConfig", () => {
  it("uses Chat Completions for a configured base URL and trims it", () => {
    expect(
      getOpenAIConfig({ OPENAI_BASE_URL: " https://api.example.test/v1/ " }),
    ).toEqual({ baseURL: "https://api.example.test/v1/", apiMode: "chat" });
  });

  it("supports OpenAI-compatible Chat Completions endpoints", () => {
    expect(getOpenAIConfig({ OPENAI_API_MODE: "CHAT" })).toEqual({
      baseURL: undefined,
      apiMode: "chat",
    });
  });

  it("allows a Responses-compatible custom endpoint to opt in explicitly", () => {
    expect(
      getOpenAIConfig({
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_API_MODE: "responses",
      }),
    ).toEqual({ baseURL: "https://api.example.test/v1", apiMode: "responses" });
  });

  it("rejects unsupported API modes", () => {
    expect(() => getOpenAIConfig({ OPENAI_API_MODE: "completion" })).toThrow(
      'OPENAI_API_MODE must be either "responses" or "chat".',
    );
  });
});
