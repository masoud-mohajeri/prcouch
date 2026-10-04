import { generateObject, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";

import { CommentCategoryPolicy } from "./category-policy.js";
import {
  AnalysisStore,
  type CategoryAssignment,
  type PendingComment,
  type StoredCommentCategory,
} from "./store.js";

const BATCH_SIZE = 10;

const assignmentResponseSchema = z.object({
  assignments: z.array(
    z.object({
      commentId: z.number().int().positive(),
      categoryId: z.string().trim().min(1),
    }),
  ),
});

export type CategorizationProgressEvent =
  | { type: "loaded"; total: number }
  | { type: "persisted"; completed: number; total: number };

export type CategorizationResult = {
  processed: number;
  remaining: number;
  failed: number;
  recoveredBatches: number;
  lastError?: string;
  categoryCounts: Record<string, number>;
};

/** Categorizes one SQLite-backed batch without exposing database writes to a model. */
export class PendingCommentCategorizer {
  constructor(
    private readonly store: AnalysisStore,
    private readonly categoryPolicy: CommentCategoryPolicy,
  ) {}

  async categorize({
    model,
    modelName,
    onProgress,
  }: {
    model: LanguageModel;
    modelName: string;
    onProgress?: (event: CategorizationProgressEvent) => void;
  }): Promise<CategorizationResult> {
    await this.store.syncCategories(await this.categoryPolicy.list());
    const [categories, total, recoveredBatches] = await Promise.all([
      this.store.listStoredCategories(),
      this.store.countPendingComments(),
      this.store.recoverInterruptedAnalysisBatches(),
    ]);
    if (!categories.length)
      throw new Error("No active SQLite comment categories are available.");
    onProgress?.({ type: "loaded", total });
    let processed = 0;
    let failed = 0;
    let lastError: string | undefined;
    const categoryCounts: Record<string, number> = {};

    while (true) {
      const comments = await this.store.listPendingComments(BATCH_SIZE);
      if (
        !comments.length ||
        comments.every((comment) => comment.analysisError)
      )
        break;

      const batchId = await this.store.createAnalysisBatch(modelName);
      const messages = buildCategorizationMessages(categories, comments);
      let batchError: unknown;
      let assignments: CategoryAssignment[] | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await generateObject({
            model,
            messages,
            schema: assignmentResponseSchema,
            temperature: 0,
          });
          assignments = validateAssignments(
            result.object.assignments,
            comments,
            categories,
          );
          await this.store.completeCategorizationBatch(
            batchId,
            assignments,
            categories,
            modelName,
          );
          break;
        } catch (error) {
          batchError = error;
        }
      }

      if (!assignments) {
        lastError = errorMessage(batchError);
        failed += comments.length;
        await this.store.failAnalysisBatch(
          batchId,
          lastError,
          1,
          comments.map((comment) => comment.id),
        );
        continue;
      }

      processed += assignments.length;
      mergeCategoryCounts(categoryCounts, countCategories(assignments));
      assignments.forEach((_, index) =>
        onProgress?.({
          type: "persisted",
          completed: processed - assignments.length + index + 1,
          total,
        }),
      );
    }

    return {
      processed,
      remaining: await this.store.countPendingComments(),
      failed,
      recoveredBatches,
      ...(lastError ? { lastError } : {}),
      categoryCounts,
    };
  }
}

export function buildCategorizationMessages(
  categories: StoredCommentCategory[],
  comments: PendingComment[],
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: JSON.stringify({
        categories: categories.map((category) => ({
          categoryId: category.code,
          name: category.name,
          description: category.description,
          recommendedSolution: category.recommendedSolution,
        })),
        instructions:
          "These are the active categories fetched from SQLite. Assign exactly one listed categoryId to every requested comment. Return no categories outside this catalog.",
      }),
    },
    {
      role: "user",
      content: JSON.stringify({
        request:
          "Categorize these review comments. Return exactly one assignment for each commentId.",
        comments: comments.map((comment) => ({
          commentId: comment.id,
          body: comment.body,
          author: comment.author,
          mergeRequest: comment.mergeRequest,
          location: comment.location,
        })),
      }),
    },
  ];
}

function validateAssignments(
  assignments: CategoryAssignment[],
  comments: PendingComment[],
  categories: StoredCommentCategory[],
): CategoryAssignment[] {
  const expectedIds = new Set(comments.map((comment) => comment.id));
  const categoryIds = new Set(categories.map((category) => category.code));
  const receivedIds = new Set<number>();
  for (const assignment of assignments) {
    if (!expectedIds.has(assignment.commentId)) {
      throw new Error(
        `The model returned unknown comment ID ${assignment.commentId}.`,
      );
    }
    if (receivedIds.has(assignment.commentId)) {
      throw new Error(
        `The model returned duplicate comment ID ${assignment.commentId}.`,
      );
    }
    if (!categoryIds.has(assignment.categoryId)) {
      throw new Error(
        `The model returned unknown category "${assignment.categoryId}".`,
      );
    }
    receivedIds.add(assignment.commentId);
  }
  if (receivedIds.size !== expectedIds.size) {
    const missing = [...expectedIds].filter((id) => !receivedIds.has(id));
    throw new Error(`The model omitted comment IDs: ${missing.join(", ")}.`);
  }
  return assignments;
}

function countCategories(
  assignments: CategoryAssignment[],
): Record<string, number> {
  return assignments.reduce<Record<string, number>>((counts, assignment) => {
    counts[assignment.categoryId] = (counts[assignment.categoryId] ?? 0) + 1;
    return counts;
  }, {});
}

function mergeCategoryCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [category, count] of Object.entries(source))
    target[category] = (target[category] ?? 0) + count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
