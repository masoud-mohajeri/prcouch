import { z } from "zod";

import { analyzedCommentRecordSchema } from "../analysis/store.js";
import { reportFiltersSchema } from "../reports/report.js";

const textSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });

/** Public identity used by saved analyses, independent of SQLite row IDs. */
export const researchCommentIdSchema = z.string().regex(/^[1-9]\d*:[1-9]\d*$/);
export const researchRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "interrupted",
]);
export const researchTaskStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
]);
export const researchEvidenceStatusSchema = z.enum([
  "supported_candidate",
  "insufficient_evidence",
  "insufficient_context",
  "no_action_needed",
]);

export const researchFiltersSchema = reportFiltersSchema
  .innerType()
  .extend({
    ids: z.array(researchCommentIdSchema).min(1).optional(),
    noteIds: z.array(z.number().int().positive()).min(1).optional(),
    categories: z.array(textSchema).min(1).optional(),
    mergeRequestIid: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((filters, ctx) => {
    const parsed = reportFiltersSchema.safeParse(filters);
    if (!parsed.success)
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
  });

/** Capture the exact saved record and known versions used for this task. */
export const researchInputSnapshotSchema = z
  .object({
    capturedAt: timestampSchema,
    record: analyzedCommentRecordSchema.extend({
      id: researchCommentIdSchema,
      solution: z.string().nullable(),
      categoryDetails: z.object({
        code: textSchema,
        name: textSchema,
        description: z.string(),
        recommendedSolution: z.string(),
      }),
      recommendedAction: z.string(),
    }),
    knownVersions: z.array(
      z.object({ name: textSchema, version: textSchema }).strict(),
    ),
  })
  .strict()
  .superRefine(({ record }, ctx) => {
    if (record.id !== `${record.project.id}:${record.comment.noteId}`)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record", "id"],
        message: "Research comment identity does not match its project/note.",
      });
    if (record.category !== record.categoryDetails.code)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["record", "categoryDetails", "code"],
        message: "Research category details do not match the saved category.",
      });
  });

const publicUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  }, "Citation URLs must use HTTP(S) without credentials.");

/** Successful SearXNG responses, including empty results and engine failures. */
export const researchSearchResponseSchema = z.object({
  query: textSchema.max(500),
  results: z
    .array(
      z.object({
        url: publicUrlSchema,
        title: z.string(),
        snippet: z.string(),
      }),
    )
    .max(10),
  engineFailures: z.array(z.object({ engine: z.string(), reason: z.string() })),
});

export const researchResultSchema = z
  .object({
    commentId: researchCommentIdSchema,
    diagnosedIssue: textSchema,
    immediateFix: textSchema.nullable(),
    automatedPrevention: textSchema.describe(
      "Existing prevention method, or why no automated method fits.",
    ),
    applicabilityRequirements: z.array(textSchema),
    limitations: z.array(textSchema),
    missingContext: z.array(textSchema),
    citations: z.array(
      z
        .object({
          url: publicUrlSchema,
          title: z.string(),
          snippet: z.string(),
        })
        .strict(),
    ),
    evidenceStatus: researchEvidenceStatusSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.evidenceStatus === "supported_candidate") {
      if (!result.citations.length || result.immediateFix === null)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Supported candidates require a fix and search citations.",
        });
    }
    if (result.evidenceStatus === "insufficient_context") {
      if (!result.missingContext.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["missingContext"],
          message:
            "Insufficient context must identify the missing information.",
        });
    }
    if (
      result.evidenceStatus === "no_action_needed" ||
      result.evidenceStatus === "insufficient_context"
    ) {
      if (result.immediateFix !== null || result.citations.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "No-search outcomes cannot contain fixes or citations.",
        });
    }
  });

/** Diagnosis decides whether search is appropriate before queries are sent. */
export const researchDiagnosisSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      commentId: researchCommentIdSchema,
      outcome: z.literal("research"),
      diagnosedIssue: textSchema,
      queries: z.array(textSchema.max(500)).min(1).max(3),
    })
    .strict(),
  z
    .object({
      commentId: researchCommentIdSchema,
      outcome: z.literal("no_action_needed"),
      diagnosedIssue: textSchema,
      reason: textSchema,
    })
    .strict(),
  z
    .object({
      commentId: researchCommentIdSchema,
      outcome: z.literal("insufficient_context"),
      diagnosedIssue: textSchema,
      reason: textSchema,
      missingContext: z.array(textSchema).min(1),
    })
    .strict(),
]);

/** Fixed codes only: never persist provider bodies, credentials or raw errors. */
export const researchTaskErrorSchema = z
  .object({
    code: z.enum([
      "configuration",
      "authentication",
      "quota",
      "rate_limit",
      "network",
      "timeout",
      "provider_outage",
      "request_failed",
      "invalid_output",
      "context_unavailable",
    ]),
    source: z.enum(["model", "search", "context", "validation"]),
  })
  .strict();

export const researchRunSchema = z
  .object({
    id: textSchema,
    projectId: z.number().int().positive(),
    filters: researchFiltersSchema,
    model: textSchema,
    promptVersion: textSchema,
    status: researchRunStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (
      (run.status === "running" && !run.startedAt) ||
      (run.status === "completed" && !run.completedAt) ||
      (run.status !== "completed" && run.completedAt !== null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Run state does not match its lifecycle timestamps.",
      });
    if (run.filters.ids?.some((id) => !id.startsWith(`${run.projectId}:`)))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["filters", "ids"],
        message: "Selected comment identities must belong to the run project.",
      });
  });

export const researchTaskSchema = z
  .object({
    runId: textSchema,
    commentId: researchCommentIdSchema,
    inputSnapshot: researchInputSnapshotSchema.nullable(),
    status: researchTaskStatusSchema,
    attempts: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    error: researchTaskErrorSchema.nullable(),
    result: researchResultSchema.nullable(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (
      (task.inputSnapshot && task.inputSnapshot.record.id !== task.commentId) ||
      (task.result && task.result.commentId !== task.commentId)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Task, input and result comment identities must match.",
      });
    if (
      (task.status === "completed" &&
        (!task.result ||
          !task.inputSnapshot ||
          !task.completedAt ||
          task.error)) ||
      (task.status !== "completed" && task.result !== null) ||
      (task.status !== "completed" && task.completedAt !== null) ||
      (task.status === "failed" && !task.error) ||
      (task.status === "running" &&
        (!task.inputSnapshot ||
          !task.startedAt ||
          !task.attempts ||
          task.error))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Task state does not match its result/error fields.",
      });
  });

export type ResearchInputSnapshot = z.infer<typeof researchInputSnapshotSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;
export type ResearchSearchResponse = z.infer<
  typeof researchSearchResponseSchema
>;
export type ResearchDiagnosis = z.infer<typeof researchDiagnosisSchema>;
export type ResearchRun = z.infer<typeof researchRunSchema>;
export type ResearchTask = z.infer<typeof researchTaskSchema>;
export type ResearchTaskError = z.infer<typeof researchTaskErrorSchema>;
export type ResearchFilters = z.infer<typeof researchFiltersSchema>;

/** Validate against only the successful searches attributed to this task. */
export function validateResearchResult(
  output: unknown,
  commentId: string,
  successfulSearches: readonly ResearchSearchResponse[],
): ResearchResult {
  const expectedId = researchCommentIdSchema.parse(commentId);
  const result = researchResultSchema.parse(output);
  if (result.commentId !== expectedId)
    throw new Error("Research result has an unexpected comment identity.");
  const searches = successfulSearches.map((search) =>
    researchSearchResponseSchema.parse(search),
  );
  if (
    searches.length &&
    (result.evidenceStatus === "no_action_needed" ||
      result.evidenceStatus === "insufficient_context")
  )
    throw new Error("No-search outcomes must not have search responses.");
  for (const citation of result.citations) {
    if (
      !searches.some((search) =>
        search.results.some(
          (source) =>
            source.url === citation.url &&
            source.title === citation.title &&
            source.snippet === citation.snippet,
        ),
      )
    )
      throw new Error(
        "Research citation is absent from this task's search evidence.",
      );
  }
  return result;
}
