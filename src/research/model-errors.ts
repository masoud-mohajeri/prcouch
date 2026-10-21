import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";

import type { OpenAIConfig } from "../agent/openai-config.js";
import { toOpenAIServiceError } from "../agent/openai-error.js";
import { isRecord, isServiceError } from "../errors.js";
import type { ResearchTaskError } from "./contracts.js";

export type ResearchModelFailure = {
  error: ResearchTaskError;
  malformedOutput: boolean;
  stopRun: boolean;
  outage: boolean;
};

/** Inspect structured quota codes without retaining provider messages or bodies. */
export function classifyResearchModelError(
  error: unknown,
  config: OpenAIConfig,
): ResearchModelFailure {
  const pending = [error];
  const visited = new Set<unknown>();
  let malformedOutput = false;
  let quota = false;
  let apiError: APICallError | undefined;
  while (pending.length) {
    const current = pending.pop();
    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);
    malformedOutput ||=
      NoObjectGeneratedError.isInstance(current) ||
      JSONParseError.isInstance(current) ||
      TypeValidationError.isInstance(current);
    if (APICallError.isInstance(current)) {
      apiError ??= current;
      let data = current.data;
      if (!data && current.responseBody) {
        try {
          data = JSON.parse(current.responseBody);
        } catch {
          /* Not a structured quota response. */
        }
      }
      if (isRecord(data) && isRecord(data.error))
        quota ||=
          data.error.code === "insufficient_quota" ||
          data.error.type === "insufficient_quota";
    }
    pending.push(current.cause, current.lastError);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  const serviceError = isServiceError(error)
    ? error
    : toOpenAIServiceError(apiError ?? error, config);
  let code: ResearchTaskError["code"];
  if (quota) code = "quota";
  else if (malformedOutput && !apiError) code = "invalid_output";
  else
    switch (serviceError.kind) {
      case "configuration":
        code = "configuration";
        break;
      case "authentication":
        code = "authentication";
        break;
      case "rate-limit":
        code = "rate_limit";
        break;
      case "network":
        code = "network";
        break;
      case "timeout":
        code = "timeout";
        break;
      case "server":
        code = "provider_outage";
        break;
      case "not-found":
      case "incompatible-response":
        code = "configuration";
        break;
      default:
        code = "request_failed";
    }
  return {
    error: { code, source: "model" },
    malformedOutput: code === "invalid_output",
    stopRun: ["configuration", "authentication", "quota"].includes(code),
    outage: ["network", "timeout", "provider_outage"].includes(code),
  };
}
