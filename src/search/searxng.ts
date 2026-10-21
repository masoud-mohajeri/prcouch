import { z } from "zod";
import { isServiceError, ServiceError } from "../errors.js";

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(10),
});

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z
        .string()
        .url()
        .refine((value) => /^https?:\/\//i.test(value)),
      content: z.string().optional().default(""),
    }),
  ),
  unresponsive_engines: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
});

/** Search only; no credentials or page fetching. Configuration is checked lazily. */
export class SearxngClient {
  constructor(
    private readonly baseUrl = process.env.SEARXNG_BASE_URL?.trim() ||
      "http://localhost:8080",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(
    input: z.input<typeof webSearchInputSchema>,
    signal?: AbortSignal,
  ) {
    const { query, limit } = webSearchInputSchema.parse(input);
    let url: URL;
    try {
      url = new URL(`${this.baseUrl.replace(/\/+$/, "")}/search`);
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("Invalid search endpoint");
      }
    } catch {
      throw new ServiceError(
        "searxng",
        "configuration",
        "SEARXNG_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment.",
      );
    }
    url.search = new URLSearchParams({
      q: query,
      format: "json",
      categories: "general",
    }).toString();
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const kind =
          response.status === 429
            ? "rate-limit"
            : response.status === 401 || response.status === 403
              ? "authentication"
              : response.status >= 500
                ? "server"
                : "request";
        throw new ServiceError("searxng", kind, "Search request failed.", {
          statusCode: response.status,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        });
      }
      let data: z.infer<typeof responseSchema>;
      try {
        data = responseSchema.parse(await response.json());
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === "TimeoutError" || cause.name === "AbortError")
        )
          throw cause;
        throw new ServiceError(
          "searxng",
          "incompatible-response",
          "Search returned invalid JSON results.",
          { cause },
        );
      }
      return {
        query,
        results: data.results
          .slice(0, limit)
          .map(({ title, url, content }) => ({ title, url, snippet: content })),
        engineFailures: data.unresponsive_engines.map(([engine, reason]) => ({
          engine,
          reason,
        })),
      };
    } catch (cause) {
      if (isServiceError(cause)) throw cause;
      const timeout =
        cause instanceof Error &&
        (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new ServiceError(
        "searxng",
        timeout ? "timeout" : "network",
        "Unable to complete web search.",
        { cause },
      );
    }
  }
}
