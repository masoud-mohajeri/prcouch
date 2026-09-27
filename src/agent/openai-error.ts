import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  TypeValidationError,
  UnsupportedFunctionalityError,
} from "ai";

import { ServiceError } from "../errors.js";
import type { OpenAIConfig } from "./openai-config.js";

/** Turn AI SDK/provider failures into a small, safe set of user actions. */
export function toOpenAIServiceError(
  error: unknown,
  config: OpenAIConfig,
): ServiceError {
  const options = {
    cause: error,
    apiMode: config.apiMode,
    customEndpoint: Boolean(config.baseURL),
  } as const;

  if (isIncompatibleResponse(error)) {
    return new ServiceError(
      "openai",
      "incompatible-response",
      "The AI provider returned a response that does not match the selected API interface.",
      options,
    );
  }

  const apiError = findApiCallError(error);
  if (apiError) {
    const statusCode = apiError.statusCode;
    const requestId =
      getHeader(apiError.responseHeaders, "x-request-id") ??
      getHeader(apiError.responseHeaders, "request-id");
    const errorOptions = {
      ...options,
      statusCode,
      requestId,
      retryAfter: getHeader(apiError.responseHeaders, "retry-after"),
    };

    if (statusCode === 401 || statusCode === 403)
      return new ServiceError(
        "openai",
        "authentication",
        "The AI provider rejected the API key or account permissions.",
        errorOptions,
      );
    if (statusCode === 404)
      return new ServiceError(
        "openai",
        config.apiMode === "responses" && config.baseURL
          ? "incompatible-response"
          : "not-found",
        "The configured AI model or API endpoint was not found.",
        errorOptions,
      );
    if (statusCode === 429)
      return new ServiceError(
        "openai",
        "rate-limit",
        "The AI provider rate limit was reached.",
        errorOptions,
      );
    if (statusCode && statusCode >= 500)
      return new ServiceError(
        "openai",
        "server",
        "The AI provider is temporarily unavailable.",
        errorOptions,
      );
    if (
      config.apiMode === "responses" &&
      Boolean(config.baseURL) &&
      statusCode !== undefined &&
      isResponseProtocolError(apiError.message)
    ) {
      return new ServiceError(
        "openai",
        "incompatible-response",
        "The configured endpoint does not support the Responses API interface.",
        errorOptions,
      );
    }

    return new ServiceError(
      "openai",
      "request",
      "The AI provider rejected this request.",
      errorOptions,
    );
  }

  if (isTimeoutError(error))
    return new ServiceError(
      "openai",
      "timeout",
      "The AI provider request timed out.",
      options,
    );

  if (isNetworkError(error))
    return new ServiceError(
      "openai",
      "network",
      "Could not connect to the AI provider.",
      options,
    );

  return new ServiceError(
    "openai",
    "request",
    getMessage(error) ?? "The AI provider request failed.",
    options,
  );
}

function isIncompatibleResponse(error: unknown): boolean {
  return (
    InvalidResponseDataError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    UnsupportedFunctionalityError.isInstance(error) ||
    hasNestedError(
      error,
      (item) =>
        InvalidResponseDataError.isInstance(item) ||
        JSONParseError.isInstance(item) ||
        TypeValidationError.isInstance(item) ||
        UnsupportedFunctionalityError.isInstance(item),
    )
  );
}

function findApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) return error;
  let found: APICallError | undefined;
  hasNestedError(error, (item) => {
    if (APICallError.isInstance(item)) {
      found = item;
      return true;
    }
    return false;
  });
  return found;
}

function hasNestedError(
  error: unknown,
  matches: (item: unknown) => boolean,
): boolean {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || visited.has(current))
      continue;
    visited.add(current);
    if (matches(current)) return true;
    const record = current as Record<string, unknown>;
    pending.push(record.cause, record.lastError);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return false;
}

function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
}

function isResponseProtocolError(message: string): boolean {
  return /(?:responses? api|response format|unsupported|not implemented|unknown endpoint|tool.{0,30}(?:unsupported|invalid))/i.test(
    message,
  );
}

function isTimeoutError(error: unknown): boolean {
  return hasNestedError(error, (item) =>
    item instanceof DOMException
      ? item.name === "TimeoutError"
      : item instanceof Error &&
        /(?:timeout|timed out|abort)/i.test(item.message),
  );
}

function isNetworkError(error: unknown): boolean {
  return hasNestedError(error, (item) => {
    if (!(item instanceof Error)) return false;
    const code = (item as Error & { code?: unknown }).code;
    return (
      (typeof code === "string" &&
        /^(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT)$/i.test(
          code,
        )) ||
      /(?:fetch failed|network|socket|connect|dns)/i.test(item.message)
    );
  });
}

function getMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}
