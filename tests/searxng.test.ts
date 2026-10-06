import { describe, expect, it, vi } from "vitest";
import { SearxngClient } from "../src/search/searxng.js";
import { formatCliError } from "../src/cli/error.js";

describe("SearXNG search", () => {
  it("preserves timeouts while reading the response body", async () => {
    const response = new Response("{}");
    vi.spyOn(response, "json").mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );
    const client = new SearxngClient(
      "http://localhost:8080",
      async () => response,
    );
    await expect(client.search({ query: "validation" })).rejects.toMatchObject({
      service: "searxng",
      kind: "timeout",
    });
  });
  it("uses encoded JSON queries, limits results and reports engine failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Docs",
              url: "https://example.test/docs",
              content: "Validation",
            },
            { title: "More", url: "https://example.test/more" },
          ],
          unresponsive_engines: [["bing", "timeout"]],
        }),
      ),
    );
    const result = await new SearxngClient(
      "http://localhost:8080/",
      fetchImpl,
    ).search({ query: "types & validation", limit: 1 });
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("q")).toBe(
      "types & validation",
    );
    expect(new URL(String(url)).searchParams.get("format")).toBe("json");
    expect(options?.headers).toEqual({ Accept: "application/json" });
    expect(result.results).toEqual([
      {
        title: "Docs",
        url: "https://example.test/docs",
        snippet: "Validation",
      },
    ]);
    expect(result.engineFailures).toEqual([
      { engine: "bing", reason: "timeout" },
    ]);
  });

  it("accepts empty results", async () => {
    const client = new SearxngClient(
      "http://localhost:8080",
      async () => new Response('{"results":[]}'),
    );
    expect(await client.search({ query: "validation" })).toEqual({
      query: "validation",
      results: [],
      engineFailures: [],
    });
  });

  it.each([403, 429, 503])(
    "classifies HTTP %s without exposing response text",
    async (status) => {
      const client = new SearxngClient(
        "http://localhost:8080",
        async () => new Response("private error", { status }),
      );
      await expect(
        client.search({ query: "validation" }),
      ).rejects.toMatchObject({
        service: "searxng",
        statusCode: status,
        kind:
          status === 403
            ? "authentication"
            : status === 429
              ? "rate-limit"
              : "server",
      });
    },
  );

  it.each([
    "not json",
    '{"results":{}}',
    '{"results":[{"title":"Unsafe","url":"javascript:alert(1)"}]}',
  ])("rejects incompatible responses: %s", async (body) => {
    const client = new SearxngClient(
      "http://localhost:8080",
      async () => new Response(body),
    );
    await expect(client.search({ query: "validation" })).rejects.toMatchObject({
      service: "searxng",
      kind: "incompatible-response",
    });
  });

  it.each(["TimeoutError", "AbortError", "TypeError"])(
    "classifies %s",
    async (name) => {
      const client = new SearxngClient("http://localhost:8080", async () => {
        throw new DOMException("failed", name);
      });
      await expect(
        client.search({ query: "validation" }),
      ).rejects.toMatchObject({
        service: "searxng",
        kind: name === "TypeError" ? "network" : "timeout",
      });
    },
  );

  it("rejects invalid configuration before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new SearxngClient("file:///tmp/search", fetchImpl).search({
        query: "validation",
      }),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("formats search failures as SearXNG errors", async () => {
    try {
      await new SearxngClient("http://localhost:8080", async () => {
        throw new TypeError("private details");
      }).search({ query: "validation" });
    } catch (error) {
      expect(formatCliError(error)).toContain("Cannot reach SearXNG");
      expect(formatCliError(error)).not.toContain("OpenAI");
      expect(formatCliError(error)).not.toContain("private details");
    }
  });
});
