import { APICallError, InvalidResponseDataError } from "ai";
import { describe, expect, it } from "vitest";

import { toOpenAIServiceError } from "../src/agent/openai-error.js";

describe("toOpenAIServiceError", () => {
  it("keeps OpenAI rate limits actionable and preserves the request ID", () => {
    const error = new APICallError({
      message: "Too many requests",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "x-request-id": "req_123", "retry-after": "20" },
    });

    expect(toOpenAIServiceError(error, { apiMode: "responses" })).toMatchObject(
      {
        service: "openai",
        kind: "rate-limit",
        statusCode: 429,
        requestId: "req_123",
        retryAfter: "20",
      },
    );
  });

  it("identifies malformed provider payloads as interface incompatibilities", () => {
    const error = new InvalidResponseDataError({
      data: { unexpected: true },
    });

    expect(
      toOpenAIServiceError(error, {
        baseURL: "https://provider.example/v1",
        apiMode: "responses",
      }),
    ).toMatchObject({ service: "openai", kind: "incompatible-response" });
  });
});
