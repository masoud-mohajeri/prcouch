import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import { isServiceError } from "../errors.js";
import { SearxngClient, webSearchInputSchema } from "../search/searxng.js";
import {
  researchSearchResponseSchema,
  type ResearchSearchResponse,
} from "./contracts.js";
import { normalizeResearchQuery, ResearchStore } from "./store.js";

const commentQueriesSchema = z
  .array(webSearchInputSchema.shape.query)
  .min(1)
  .max(3);

/** One instance per run execution; SQLite retains successful searches on resume. */
export class ResearchSearch {
  private readonly taskQueries = new Map<string, Set<string>>();
  private readonly inFlight = new Map<
    string,
    Promise<ResearchSearchResponse>
  >();

  constructor(
    private readonly store: ResearchStore,
    private readonly projectId: number,
    private readonly runId: string,
    private readonly client: Pick<
      SearxngClient,
      "search"
    > = new SearxngClient(),
    private readonly wait: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void> = (milliseconds, signal) =>
      sleep(milliseconds, undefined, { signal }),
    private readonly signal?: AbortSignal,
  ) {}

  /** Supply the complete diagnosis query plan once for each claimed task attempt. */
  async searchComment(
    commentId: string,
    attempt: number,
    queries: readonly string[],
  ): Promise<ResearchSearchResponse[]> {
    const parsedQueries = commentQueriesSchema.parse(queries);
    this.requireActiveTask(commentId, attempt);
    const taskKey = `${commentId}:${attempt}`;
    const requested = new Set([
      ...(this.taskQueries.get(taskKey) ?? []),
      ...parsedQueries.map(normalizeResearchQuery),
    ]);
    if (requested.size > 3)
      throw new Error(
        "Research tasks allow at most three queries per attempt.",
      );
    this.taskQueries.set(taskKey, requested);
    const successfulSearches: ResearchSearchResponse[] = [];
    const seen = new Set<string>();
    for (const query of parsedQueries) {
      this.requireActiveTask(commentId, attempt);
      const key = normalizeResearchQuery(query);
      if (seen.has(key)) continue;
      seen.add(key);
      const response = await this.search(query);
      this.requireActiveTask(commentId, attempt);
      // Keep each task's evidence separate even when the underlying request is shared.
      successfulSearches.push(researchSearchResponseSchema.parse(response));
    }
    return successfulSearches;
  }

  private search(query: string): Promise<ResearchSearchResponse> {
    const cached = this.store.getCachedSearch(
      this.projectId,
      this.runId,
      query,
    );
    if (cached) return Promise.resolve(cached.response);
    const key = normalizeResearchQuery(query);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.searchAndCache(query).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async searchAndCache(query: string): Promise<ResearchSearchResponse> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.requireRunningRun();
      let response: ResearchSearchResponse;
      try {
        // SearxngClient enforces the 30-second request/body timeout and result limit.
        response = await this.client.search({ query, limit: 10 }, this.signal);
      } catch (error) {
        if (!isServiceError(error) || error.service !== "searxng") throw error;
        if (error.kind === "authentication" || error.kind === "configuration") {
          this.store.interruptRun(this.projectId, this.runId);
          throw error;
        }
        if (
          attempt === 1 ||
          !["network", "timeout", "rate-limit", "server"].includes(error.kind)
        )
          throw error;
        this.requireRunningRun();
        await this.wait(retryDelay(error.retryAfter), this.signal);
        continue;
      }
      this.requireRunningRun();
      const parsed = researchSearchResponseSchema.parse(response);
      if (
        normalizeResearchQuery(parsed.query) !== normalizeResearchQuery(query)
      )
        throw new Error(
          "Search response query does not match the requested query.",
        );
      // Empty successful responses and individual engine failures are cached, not retried.
      return this.store.cacheSearch(this.projectId, this.runId, parsed)
        .response;
    }
    throw new Error("Research search exhausted its retry limit.");
  }

  private requireRunningRun(): void {
    this.signal?.throwIfAborted();
    if (this.store.getRun(this.projectId, this.runId).status !== "running")
      throw new Error("Research search requires a running run.");
  }

  private requireActiveTask(commentId: string, attempt: number): void {
    this.requireRunningRun();
    const task = this.store.getTask(this.projectId, this.runId, commentId);
    if (task.status !== "running" || task.attempts !== attempt)
      throw new Error("Research search requires an active task claim.");
  }
}

function retryDelay(retryAfter: string | undefined): number {
  if (retryAfter !== undefined) {
    const value = retryAfter.trim();
    // HTTP dates start with a weekday; avoid Date.parse accepting invalid
    // delay values such as "-1" or "1.5" as calendar dates.
    const date = /^[A-Za-z]{3,9}[, ]/.test(value)
      ? Date.parse(/GMT$/i.test(value) ? value : `${value} GMT`)
      : Number.NaN;
    const milliseconds = /^\d+$/.test(value)
      ? Number(value) * 1_000
      : date - Date.now();
    if (!Number.isNaN(milliseconds))
      return Math.min(60_000, Math.max(0, milliseconds));
  }
  return 2_000;
}
