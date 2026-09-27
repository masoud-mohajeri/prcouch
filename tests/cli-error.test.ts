import { describe, expect, it } from "vitest";

import { formatCliError } from "../src/cli/error.js";
import { ServiceError } from "../src/errors.js";

describe("formatCliError", () => {
  it("reports nested provider server errors with their request ID", () => {
    const error = {
      message: "Failed after 3 attempts",
      lastError: {
        statusCode: 500,
        message: "Database error",
        responseHeaders: { "x-request-id": "request-123" },
      },
    };

    expect(formatCliError(error)).toBe(
      "[error] Provider server error (HTTP 500): Database error. Request ID: request-123. Try again shortly; if it persists, contact your API provider.",
    );
  });

  it("reports non-server errors without a stack trace", () => {
    expect(formatCliError(new Error("Missing required configuration"))).toBe(
      "[error] Request failed: Missing required configuration",
    );
  });

  it("gives GitLab credential failures a safe, actionable message", () => {
    expect(
      formatCliError(
        new ServiceError("gitlab", "authentication", "token rejected", {
          statusCode: 403,
          requestId: "gitlab-request-123",
        }),
      ),
    ).toBe(
      "[error] GitLab access was denied (HTTP 403). Check GITLAB_TOKEN has read_api (or Merge Request: Read) access and can list the selected project. Request ID: gitlab-request-123.",
    );
  });

  it("explains how to fix a Responses-only interface mismatch", () => {
    expect(
      formatCliError(
        new ServiceError(
          "openai",
          "incompatible-response",
          "unsupported response format",
          { apiMode: "responses", customEndpoint: true },
        ),
      ),
    ).toBe(
      "[error] The AI provider returned an incompatible API response. Set OPENAI_API_MODE=chat if this endpoint supports Chat Completions only.",
    );
  });
});
