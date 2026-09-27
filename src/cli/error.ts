import {
  getHeader,
  isRecord,
  isServiceError,
  type ServiceError,
} from "../errors.js";

type ApiErrorDetails = {
  statusCode?: number;
  message?: string;
  responseHeaders?: unknown;
  lastError?: unknown;
  errors?: unknown;
  cause?: unknown;
};

type ProviderError = {
  statusCode: number;
  message: string;
  requestId?: string;
};

export function formatCliError(error: unknown): string {
  const serviceError = findServiceError(error);
  if (serviceError) return formatServiceError(serviceError);

  const providerError = findProviderError(error);
  if (providerError && providerError.statusCode >= 500) {
    const requestId = providerError.requestId
      ? ` Request ID: ${providerError.requestId}.`
      : "";
    return `[error] Provider server error (HTTP ${providerError.statusCode}): ${providerError.message}.${requestId} Try again shortly; if it persists, contact your API provider.`;
  }

  return `[error] Request failed: ${getErrorMessage(error)}`;
}

function formatServiceError(error: ServiceError): string {
  const requestId = error.requestId ? ` Request ID: ${error.requestId}.` : "";
  const status = error.statusCode ? ` (HTTP ${error.statusCode})` : "";
  const retryAfter = error.retryAfter
    ? ` Retry after ${error.retryAfter}.`
    : "";

  if (error.service === "gitlab") {
    switch (error.kind) {
      case "configuration":
        return `[error] GitLab configuration issue: ${error.message} Update .env and try again.`;
      case "authentication":
        return `[error] GitLab access was denied${status}. Check GITLAB_TOKEN has read_api (or Merge Request: Read) access and can access GITLAB_PROJECT.${requestId}`;
      case "not-found":
        return `[error] GitLab could not find the configured project${status}. Check GITLAB_URL and GITLAB_PROJECT.${requestId}`;
      case "rate-limit":
        return `[error] GitLab rate limit reached${status}. Wait and try again.${retryAfter}${requestId}`;
      case "server":
        return `[error] GitLab is temporarily unavailable${status}. Try again shortly.${requestId}`;
      case "network":
        return "[error] Cannot reach GitLab. Check GITLAB_URL, your network or VPN, and GitLab availability.";
      case "timeout":
        return "[error] GitLab did not respond in time. Check your network or GitLab availability, then try again.";
      case "incompatible-response":
        return "[error] GitLab returned an incompatible response. Check that GITLAB_URL points to a GitLab instance and try again.";
      default:
        return `[error] GitLab request failed${status}. Check your configuration and try again.${requestId}`;
    }
  }

  switch (error.kind) {
    case "configuration":
      return `[error] OpenAI configuration issue: ${error.message} Update .env and try again.`;
    case "authentication":
      return `[error] OpenAI access was denied${status}. Check OPENAI_API_KEY and the account's permissions.${requestId}`;
    case "not-found":
      return `[error] OpenAI could not find the configured model or endpoint${status}. Check OPENAI_MODEL and OPENAI_BASE_URL.${requestId}`;
    case "rate-limit":
      return `[error] OpenAI rate limit reached${status}. Wait and try again, or check your account limits.${retryAfter}${requestId}`;
    case "server":
      return `[error] OpenAI is temporarily unavailable${status}. Try again shortly.${requestId}`;
    case "network":
      return "[error] Cannot reach the AI provider. Check your network, OPENAI_BASE_URL, and provider availability.";
    case "timeout":
      return "[error] The AI provider did not respond in time. Check your network and try again.";
    case "incompatible-response": {
      const modeHint =
        error.customEndpoint && error.apiMode === "responses"
          ? " Set OPENAI_API_MODE=chat if this endpoint supports Chat Completions only."
          : " Check OPENAI_API_MODE, OPENAI_MODEL, and your provider's API compatibility.";
      return `[error] The AI provider returned an incompatible API response.${modeHint}${requestId}`;
    }
    default:
      return `[error] OpenAI request failed${status}. Check your request and provider configuration.${requestId}`;
  }
}

function findServiceError(error: unknown): ServiceError | undefined {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length) {
    const current = pending.shift();
    if (isServiceError(current)) return current;
    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);
    pending.push(current.cause, current.lastError);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
}

function findProviderError(error: unknown): ProviderError | undefined {
  const pending = [error];
  const visited = new Set<unknown>();

  while (pending.length) {
    const current = pending.shift();
    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);

    const statusCode = current.statusCode;
    if (typeof statusCode === "number") {
      return {
        statusCode,
        message:
          typeof current.message === "string"
            ? current.message
            : "Unknown provider error",
        requestId: getHeader(current.responseHeaders, "x-request-id"),
      };
    }

    pending.push(current.lastError, current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
}

function getErrorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : "Unknown error";
}
