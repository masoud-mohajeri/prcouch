export type ServiceName = "gitlab" | "openai";

export type ServiceErrorKind =
  | "configuration"
  | "network"
  | "timeout"
  | "authentication"
  | "not-found"
  | "rate-limit"
  | "server"
  | "incompatible-response"
  | "request";

/**
 * A safe, structured error at an integration boundary. `message` is retained
 * for logs and tests; the CLI uses the fields below to give users an action
 * they can take without printing credentials or response bodies.
 */
export class ServiceError extends Error {
  readonly name = "ServiceError";

  constructor(
    readonly service: ServiceName,
    readonly kind: ServiceErrorKind,
    message: string,
    options: {
      cause?: unknown;
      statusCode?: number;
      requestId?: string;
      retryAfter?: string;
      apiMode?: "responses" | "chat";
      customEndpoint?: boolean;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    this.apiMode = options.apiMode;
    this.customEndpoint = options.customEndpoint;
  }

  readonly statusCode?: number;
  readonly requestId?: string;
  readonly retryAfter?: string;
  readonly apiMode?: "responses" | "chat";
  readonly customEndpoint?: boolean;
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}

export function getHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
