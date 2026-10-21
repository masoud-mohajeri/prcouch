import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";

import { getOpenAIConfig, type OpenAIConfig } from "../agent/openai-config.js";
import { isServiceError, ServiceError } from "../errors.js";
import {
  researchDiagnosisSchema,
  researchResultSchema,
  validateResearchResult,
  type ResearchTask,
  type ResearchTaskError,
} from "./contracts.js";
import {
  classifyResearchModelError,
  type ResearchModelFailure,
} from "./model-errors.js";
import { buildResearchMessages, RESEARCH_PROMPT_VERSION } from "./prompts.js";
import { ResearchSearch } from "./search.js";
import { ResearchStore } from "./store.js";

const diagnosisResponseSchema = z
  .object({ diagnosis: researchDiagnosisSchema })
  .strict();

export type CommentResearchOutcome = {
  task: ResearchTask;
  stopRun: boolean;
  error?: ResearchTaskError;
};

class ModelResearchError extends Error {
  constructor(readonly failure: ResearchModelFailure) {
    super("Comment research model request failed.");
  }
}

/** One instance per run execution so consecutive provider outages are shared. */
export class CommentResearcher {
  private consecutiveProviderOutages = 0;

  constructor(
    private readonly store: ResearchStore,
    private readonly search: ResearchSearch,
    private readonly projectId: number,
    private readonly runId: string,
    private readonly options: {
      model?: LanguageModel;
      config?: OpenAIConfig;
      signal?: AbortSignal;
    } = {},
  ) {}

  /** Process an already claimed task; never selects comments or starts a batch. */
  async researchComment(
    commentId: string,
    attempt: number,
  ): Promise<CommentResearchOutcome> {
    const task = this.requireActiveTask(commentId, attempt);
    const snapshot = task.inputSnapshot!;
    try {
      const run = this.store.getRun(this.projectId, this.runId);
      if (run.promptVersion !== RESEARCH_PROMPT_VERSION)
        throw new ServiceError(
          "openai",
          "configuration",
          "Research prompt version is not supported.",
        );
      const config = this.options.config ?? getOpenAIConfig();
      const model = this.options.model ?? this.createModel(run.model, config);
      const diagnosis = await this.generateValidated(
        model,
        config,
        commentId,
        attempt,
        buildResearchMessages(snapshot, "diagnosis"),
        diagnosisResponseSchema,
        (output) => {
          const parsed = diagnosisResponseSchema.parse(output).diagnosis;
          if (parsed.commentId !== commentId)
            throw new Error(
              "Diagnosis comment identity does not match the task.",
            );
          return parsed;
        },
      );
      this.requireActiveTask(commentId, attempt);
      if (diagnosis.outcome !== "research") {
        const result = validateResearchResult(
          {
            commentId,
            diagnosedIssue: diagnosis.diagnosedIssue,
            immediateFix: null,
            automatedPrevention: diagnosis.reason,
            applicabilityRequirements: [],
            limitations: [],
            missingContext:
              diagnosis.outcome === "insufficient_context"
                ? diagnosis.missingContext
                : [],
            citations: [],
            evidenceStatus: diagnosis.outcome,
          },
          commentId,
          [],
        );
        return {
          task: this.store.completeTask(
            this.projectId,
            this.runId,
            commentId,
            attempt,
            result,
            [],
          ),
          stopRun: false,
        };
      }
      const searches = await this.search.searchComment(
        commentId,
        attempt,
        diagnosis.queries,
      );
      const messages: ModelMessage[] = [
        ...buildResearchMessages(snapshot, "result", searches),
        { role: "user", content: JSON.stringify({ diagnosis }) },
      ];
      const result = await this.generateValidated(
        model,
        config,
        commentId,
        attempt,
        messages,
        researchResultSchema,
        (output) => validateResearchResult(output, commentId, searches),
      );
      return {
        task: this.store.completeTask(
          this.projectId,
          this.runId,
          commentId,
          attempt,
          result,
          searches,
        ),
        stopRun: false,
      };
    } catch (error) {
      let safeError: ResearchTaskError;
      let stopRun = false;
      if (error instanceof ModelResearchError) {
        safeError = error.failure.error;
        stopRun = error.failure.stopRun;
      } else if (isServiceError(error) && error.service === "searxng") {
        let code: ResearchTaskError["code"] = "request_failed";
        switch (error.kind) {
          case "configuration":
          case "authentication":
          case "network":
          case "timeout":
            code = error.kind;
            break;
          case "rate-limit":
            code = "rate_limit";
            break;
          case "server":
            code = "provider_outage";
            break;
        }
        safeError = { code, source: "search" };
        stopRun =
          error.kind === "configuration" || error.kind === "authentication";
      } else if (isServiceError(error) && error.service === "openai") {
        const failure = classifyResearchModelError(error, {
          apiMode: "responses",
        });
        safeError = failure.error;
        stopRun = failure.stopRun;
      } else {
        const current = this.store.getTask(
          this.projectId,
          this.runId,
          commentId,
        );
        if (
          current.attempts === attempt &&
          current.status === "interrupted" &&
          this.store.getRun(this.projectId, this.runId).status === "interrupted"
        )
          return { task: current, stopRun: true };
        // Storage/programming errors must remain visible rather than becoming model failures.
        throw error;
      }
      const current = this.store.getTask(this.projectId, this.runId, commentId);
      if (current.attempts !== attempt)
        throw new Error("Research task claim is no longer active.");
      const run = this.store.getRun(this.projectId, this.runId);
      if (run.status !== "running" || current.status !== "running")
        return { task: current, stopRun: true, error: safeError };
      const failed = this.store.failTask(
        this.projectId,
        this.runId,
        commentId,
        attempt,
        safeError,
      );
      if (stopRun) this.store.interruptRun(this.projectId, this.runId);
      return { task: failed, stopRun, error: safeError };
    }
  }

  private async generateValidated<T>(
    model: LanguageModel,
    config: OpenAIConfig,
    commentId: string,
    attempt: number,
    messages: ModelMessage[],
    schema: z.ZodTypeAny,
    validate: (output: unknown) => T,
  ): Promise<T> {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const inputMessages = messages.filter(
      (message) => message.role !== "system",
    );
    for (let outputAttempt = 0; outputAttempt < 2; outputAttempt += 1) {
      this.requireActiveTask(commentId, attempt);
      let output: unknown;
      try {
        output = (
          await generateObject({
            model,
            schema,
            messages: inputMessages,
            system:
              outputAttempt === 0
                ? system
                : `${system}\n\nThe previous output failed validation. Follow the supplied schema, use the exact comment identity, and copy citations only from this task's supplied searches.`,
            maxRetries: 0,
            abortSignal: this.options.signal,
          })
        ).object;
        this.consecutiveProviderOutages = 0;
      } catch (error) {
        const failure = classifyResearchModelError(error, config);
        if (failure.outage) {
          this.consecutiveProviderOutages += 1;
          failure.stopRun ||= this.consecutiveProviderOutages >= 2;
        } else this.consecutiveProviderOutages = 0;
        if (failure.malformedOutput && outputAttempt === 0) continue;
        throw new ModelResearchError(failure);
      }
      try {
        return validate(output);
      } catch {
        if (outputAttempt === 1)
          throw new ModelResearchError({
            error: { code: "invalid_output", source: "validation" },
            malformedOutput: true,
            stopRun: false,
            outage: false,
          });
      }
    }
    throw new Error("Comment research exhausted its output retry limit.");
  }

  private createModel(modelName: string, config: OpenAIConfig): LanguageModel {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey)
      throw new ServiceError(
        "openai",
        "configuration",
        "Missing required configuration: OPENAI_API_KEY.",
      );
    const provider = createOpenAI({ apiKey, baseURL: config.baseURL });
    return config.apiMode === "chat"
      ? provider.chat(modelName)
      : provider.responses(modelName);
  }

  private requireActiveTask(commentId: string, attempt: number): ResearchTask {
    const task = this.store.getTask(this.projectId, this.runId, commentId);
    if (
      this.store.getRun(this.projectId, this.runId).status !== "running" ||
      task.status !== "running" ||
      task.attempts !== attempt ||
      !task.inputSnapshot
    )
      throw new Error(
        "Comment research requires an active task claim and input snapshot.",
      );
    return task;
  }
}
