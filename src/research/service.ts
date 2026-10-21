import type { LanguageModel } from "ai";

import type { OpenAIConfig } from "../agent/openai-config.js";
import type { SearxngClient } from "../search/searxng.js";
import { CommentResearcher } from "./comment.js";
import type {
  ResearchFilters,
  ResearchInputSnapshot,
  ResearchRun,
  ResearchTaskError,
} from "./contracts.js";
import { RESEARCH_PROMPT_VERSION } from "./prompts.js";
import { ResearchSearch } from "./search.js";
import { ResearchStore } from "./store.js";

export type ResearchBatchCounts = ReturnType<ResearchStore["getProgress"]>;
export type ResearchBatchProgressEvent = {
  type: "started" | "progress" | "finished";
  runId: string;
  status: ResearchRun["status"];
  counts: ResearchBatchCounts;
};
export type ResearchBatchResult = {
  run: ResearchRun;
  counts: ResearchBatchCounts;
  lastError?: ResearchTaskError;
};
export type ResearchBatchOptions = {
  signal?: AbortSignal;
  knownVersions?: ResearchInputSnapshot["knownVersions"];
  onProgress?: (event: ResearchBatchProgressEvent) => void;
};

/** Explicit batch execution only; callers own the store and shutdown signal. */
export class ResearchService {
  private activeRunId: string | undefined;

  constructor(
    private readonly store: ResearchStore,
    private readonly options: {
      model?: LanguageModel;
      config?: OpenAIConfig;
      searchClient?: Pick<SearxngClient, "search">;
    } = {},
  ) {}

  async start(
    input: ResearchBatchOptions & {
      projectId: number;
      filters?: ResearchFilters;
    },
  ): Promise<ResearchBatchResult> {
    this.requireIdle();
    const configuredModel = this.options.model;
    const modelName = configuredModel
      ? typeof configuredModel === "string"
        ? configuredModel
        : configuredModel.modelId
      : (process.env.OPENAI_MODEL ?? "gpt-5-mini");
    const run = this.store.createRun({
      projectId: input.projectId,
      filters: input.filters,
      model: modelName,
      promptVersion: RESEARCH_PROMPT_VERSION,
    });
    this.store.startRun(input.projectId, run.id);
    return this.execute(input.projectId, run.id, input);
  }

  async resume(
    projectId: number,
    runId: string,
    options: ResearchBatchOptions = {},
  ): Promise<ResearchBatchResult> {
    this.requireIdle();
    // Store checks project ownership before changing any run/task state.
    this.store.resumeRun(projectId, runId);
    return this.execute(projectId, runId, options);
  }

  private async execute(
    projectId: number,
    runId: string,
    options: ResearchBatchOptions,
  ): Promise<ResearchBatchResult> {
    this.activeRunId = runId;
    const controller = new AbortController();
    let stopped = false;
    let fatalError: { error: unknown } | undefined;
    let lastError: ResearchTaskError | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        const run = this.store.getRun(projectId, runId);
        if (run.status === "running") this.store.interruptRun(projectId, runId);
      } catch (error) {
        fatalError ??= { error };
      } finally {
        controller.abort();
      }
    };
    const emit = (type: ResearchBatchProgressEvent["type"]) => {
      options.onProgress?.({
        type,
        runId,
        status: this.store.getRun(projectId, runId).status,
        counts: this.store.getProgress(projectId, runId),
      });
    };
    const search = new ResearchSearch(
      this.store,
      projectId,
      runId,
      this.options.searchClient,
      undefined,
      controller.signal,
    );
    const researcher = new CommentResearcher(
      this.store,
      search,
      projectId,
      runId,
      {
        model: this.options.model,
        config: this.options.config,
        signal: controller.signal,
      },
    );
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      if (options.signal?.aborted) stop();
      emit("started");
      while (
        !stopped &&
        this.store.getRun(projectId, runId).status === "running"
      ) {
        const page = this.store.listTasks(projectId, runId, {
          statuses: ["pending"],
        });
        if (!page.tasks.length) break;
        let nextIndex = 0;
        const worker = async () => {
          try {
            while (!stopped && nextIndex < page.tasks.length) {
              if (this.store.getRun(projectId, runId).status !== "running") {
                stop();
                break;
              }
              const selected = page.tasks[nextIndex++];
              const task = await this.store.claimTask(
                projectId,
                runId,
                selected.commentId,
                options.knownVersions ?? [],
              );
              if (stopped) break;
              if (!task) continue;
              if (task.status === "running") {
                const outcome = await researcher.researchComment(
                  task.commentId,
                  task.attempts,
                );
                if (outcome.error && !stopped) lastError = outcome.error;
                if (outcome.stopRun) stop();
              } else if (task.error) lastError = task.error;
              emit("progress");
            }
          } catch (error) {
            if (!stopped) {
              fatalError ??= { error };
              stop();
            }
          }
        };
        // Both workers settle before returning, closing stores or allowing resume.
        const workers = await Promise.allSettled([worker(), worker()]);
        for (const result of workers) {
          if (result.status === "rejected") {
            fatalError ??= { error: result.reason };
            stop();
          }
        }
        if (fatalError) throw fatalError.error;
      }
      if (fatalError) throw fatalError.error;
      if (!stopped && this.store.getRun(projectId, runId).status === "running")
        this.store.completeRun(projectId, runId);
      emit("finished");
      return {
        run: this.store.getRun(projectId, runId),
        counts: this.store.getProgress(projectId, runId),
        ...(lastError ? { lastError } : {}),
      };
    } catch (error) {
      stop();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", stop);
      this.activeRunId = undefined;
    }
  }

  private requireIdle(): void {
    if (this.activeRunId)
      throw new Error("This research service already has an active run.");
  }
}
