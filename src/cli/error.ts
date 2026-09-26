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
  const providerError = findProviderError(error);
  if (providerError && providerError.statusCode >= 500) {
    const requestId = providerError.requestId
      ? ` Request ID: ${providerError.requestId}.`
      : "";
    return `[error] Provider server error (HTTP ${providerError.statusCode}): ${providerError.message}.${requestId} Try again shortly; if it persists, contact your API provider.`;
  }

  return `[error] Request failed: ${getErrorMessage(error)}`;
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

function getHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
}

function getErrorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : "Unknown error";
}

function isRecord(value: unknown): value is ApiErrorDetails {
  return typeof value === "object" && value !== null;
}
