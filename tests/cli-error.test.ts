import { describe, expect, it } from "vitest";

import { formatCliError } from "../src/cli/error.js";

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
});
