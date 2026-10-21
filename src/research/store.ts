import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import {
  AnalysisStore,
  analyzedCommentInputSchema,
} from "../analysis/store.js";
import {
  researchRuns,
  researchSearchCache,
  researchTasks,
  projects,
  issueCategories,
} from "../db/schema.js";
import {
  researchCommentIdSchema,
  researchEvidenceStatusSchema,
  researchFiltersSchema,
  researchInputSnapshotSchema,
  researchRunSchema,
  researchSearchResponseSchema,
  researchTaskErrorSchema,
  researchTaskSchema,
  researchTaskStatusSchema,
  validateResearchResult,
  type ResearchFilters,
  type ResearchInputSnapshot,
  type ResearchRun,
  type ResearchSearchResponse,
  type ResearchTask,
  type ResearchTaskError,
} from "./contracts.js";

export function normalizeResearchQuery(query: string): string {
  return researchSearchResponseSchema.shape.query
    .parse(query)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Research-only writes; AnalysisStore supplies selection and current context. */
export class ResearchStore {
  private readonly sqlite: Database.Database;
  private readonly db;

  constructor(private readonly analysisStore: AnalysisStore) {
    // AnalysisStore has already applied migrations to this database.
    this.sqlite = new Database(analysisStore.path);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(this.sqlite);
  }

  close(): void {
    this.sqlite.close();
  }

  /** Allow an empty research snapshot for a verified project with no saved notes. */
  ensureProject(input: {
    id: number;
    pathWithNamespace: string;
    webUrl: string;
  }): void {
    const project = analyzedCommentInputSchema.shape.project.parse(input);
    const now = new Date().toISOString();
    this.db
      .insert(projects)
      .values({ ...project, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
  }

  /** Historical categories remain valid filters for completed saved analyses. */
  listCategories() {
    return this.db
      .select({
        code: issueCategories.code,
        name: issueCategories.name,
        description: issueCategories.description,
      })
      .from(issueCategories)
      .orderBy(asc(issueCategories.code))
      .all();
  }

  createRun(input: {
    projectId: number;
    filters?: ResearchFilters;
    model: string;
    promptVersion: string;
  }): ResearchRun {
    const now = new Date().toISOString();
    const run = researchRunSchema.parse({
      ...input,
      id: randomUUID(),
      filters: researchFiltersSchema.parse(input.filters ?? {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    });
    const selection = this.analysisStore.getAnalyzedCommentSelectionQuery({
      ...run.filters,
      projectId: run.projectId,
    });
    this.sqlite.transaction(() => {
      this.db
        .insert(researchRuns)
        .values({
          ...run,
          filtersJson: JSON.stringify(run.filters),
        })
        .run();
      this.db.run(sql`
        INSERT INTO research_tasks
          (run_id, comment_id, status, attempts, created_at, updated_at)
        SELECT ${run.id}, selected.comment_id, 'pending', 0, ${now}, ${now}
        FROM (${selection}) AS selected
      `);
    })();
    return run;
  }

  getRun(projectId: number, runId: string): ResearchRun {
    const row = this.db
      .select()
      .from(researchRuns)
      .where(
        and(eq(researchRuns.id, runId), eq(researchRuns.projectId, projectId)),
      )
      .get();
    if (!row)
      throw new Error("Research run was not found in the selected project.");
    return researchRunSchema.parse({
      id: row.id,
      projectId: row.projectId,
      filters: JSON.parse(row.filtersJson),
      model: row.model,
      promptVersion: row.promptVersion,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
  }

  startRun(projectId: number, runId: string): ResearchRun {
    return this.sqlite.transaction(() => {
      const run = this.getRun(projectId, runId);
      if (run.status !== "pending")
        throw new Error(
          "Only a pending research run can start; use resume for existing work.",
        );
      const now = new Date().toISOString();
      this.db
        .update(researchRuns)
        .set({ status: "running", startedAt: now, updatedAt: now })
        .where(eq(researchRuns.id, runId))
        .run();
      return this.getRun(projectId, runId);
    })();
  }

  listTasks(
    projectId: number,
    runId: string,
    options: {
      afterCommentId?: string;
      statuses?: ResearchTask["status"][];
    } = {},
  ): { tasks: ResearchTask[]; nextCursor: string | null } {
    this.getRun(projectId, runId);
    const predicates = [eq(researchTasks.runId, runId)];
    if (options.afterCommentId)
      predicates.push(
        gt(
          researchTasks.commentId,
          researchCommentIdSchema.parse(options.afterCommentId),
        ),
      );
    if (options.statuses)
      predicates.push(
        inArray(
          researchTasks.status,
          options.statuses.map((status) =>
            researchTaskStatusSchema.parse(status),
          ),
        ),
      );
    const rows = this.db
      .select()
      .from(researchTasks)
      .where(and(...predicates))
      .orderBy(asc(researchTasks.commentId))
      .limit(11)
      .all();
    const tasks = rows.slice(0, 10).map((row) => this.readTask(row));
    return {
      tasks,
      nextCursor: rows.length > 10 ? tasks[tasks.length - 1].commentId : null,
    };
  }

  getTask(projectId: number, runId: string, commentId: string): ResearchTask {
    this.getRun(projectId, runId);
    const row = this.db
      .select()
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.runId, runId),
          eq(researchTasks.commentId, researchCommentIdSchema.parse(commentId)),
        ),
      )
      .get();
    if (!row) throw new Error("Comment is not in the research run snapshot.");
    return this.readTask(row);
  }

  /** Load current context before claiming; a missing context becomes a safe failure. */
  async claimTask(
    projectId: number,
    runId: string,
    commentId: string,
    knownVersions: ResearchInputSnapshot["knownVersions"] = [],
  ): Promise<ResearchTask | null> {
    this.getTask(projectId, runId, commentId);
    if (!commentId.startsWith(`${projectId}:`))
      throw new Error("Comment belongs to another project.");
    const context = await this.analysisStore.getAnalyzedComment(
      projectId,
      Number(commentId.split(":")[1]),
    );
    const snapshot =
      context.status === "completed"
        ? researchInputSnapshotSchema.parse({
            capturedAt: new Date().toISOString(),
            record: context.record,
            knownVersions,
          })
        : null;
    return this.sqlite.transaction(() => {
      this.requireRunningRun(projectId, runId);
      const task = this.getTask(projectId, runId, commentId);
      if (task.status !== "pending") return null;
      const now = new Date().toISOString();
      this.db
        .update(researchTasks)
        .set({
          status: snapshot ? "running" : "failed",
          attempts: task.attempts + 1,
          startedAt: now,
          updatedAt: now,
          inputSnapshotJson: snapshot ? JSON.stringify(snapshot) : null,
          errorJson: snapshot
            ? null
            : JSON.stringify({
                code: "context_unavailable",
                source: "context",
              }),
        })
        .where(
          and(
            eq(researchTasks.runId, runId),
            eq(researchTasks.commentId, commentId),
          ),
        )
        .run();
      return this.getTask(projectId, runId, commentId);
    })();
  }

  completeTask(
    projectId: number,
    runId: string,
    commentId: string,
    attempt: number,
    output: unknown,
    successfulSearches: readonly ResearchSearchResponse[],
  ): ResearchTask {
    return this.sqlite.transaction(() => {
      const task = this.requireClaim(projectId, runId, commentId, attempt);
      const searches = successfulSearches.map((search) =>
        researchSearchResponseSchema.parse(search),
      );
      for (const search of searches) {
        const cached = this.getCachedSearch(projectId, runId, search.query);
        if (
          !cached ||
          JSON.stringify(cached.response) !== JSON.stringify(search)
        )
          throw new Error(
            "Task evidence does not match a successful cached search.",
          );
      }
      const result = validateResearchResult(output, commentId, searches);
      const now = new Date().toISOString();
      researchTaskSchema.parse({
        ...task,
        status: "completed",
        result,
        error: null,
        completedAt: now,
        updatedAt: now,
      });
      this.db
        .update(researchTasks)
        .set({
          status: "completed",
          resultJson: JSON.stringify(result),
          successfulSearchesJson: JSON.stringify(searches),
          errorJson: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(researchTasks.runId, runId),
            eq(researchTasks.commentId, commentId),
          ),
        )
        .run();
      return this.getTask(projectId, runId, commentId);
    })();
  }

  failTask(
    projectId: number,
    runId: string,
    commentId: string,
    attempt: number,
    error: ResearchTaskError,
  ): ResearchTask {
    const safeError = researchTaskErrorSchema.parse(error);
    return this.sqlite.transaction(() => {
      this.requireClaim(projectId, runId, commentId, attempt);
      this.db
        .update(researchTasks)
        .set({
          status: "failed",
          errorJson: JSON.stringify(safeError),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(researchTasks.runId, runId),
            eq(researchTasks.commentId, commentId),
          ),
        )
        .run();
      return this.getTask(projectId, runId, commentId);
    })();
  }

  getCachedSearch(projectId: number, runId: string, query: string) {
    this.getRun(projectId, runId);
    const row = this.db
      .select()
      .from(researchSearchCache)
      .where(
        and(
          eq(researchSearchCache.runId, runId),
          eq(
            researchSearchCache.normalizedQuery,
            normalizeResearchQuery(query),
          ),
        ),
      )
      .get();
    return row
      ? {
          retrievedAt: row.retrievedAt,
          response: researchSearchResponseSchema.parse(
            JSON.parse(row.responseJson),
          ),
        }
      : null;
  }

  cacheSearch(
    projectId: number,
    runId: string,
    response: ResearchSearchResponse,
  ) {
    const parsed = researchSearchResponseSchema.parse(response);
    return this.sqlite.transaction(() => {
      this.requireRunningRun(projectId, runId);
      this.db
        .insert(researchSearchCache)
        .values({
          runId,
          normalizedQuery: normalizeResearchQuery(parsed.query),
          retrievedAt: new Date().toISOString(),
          responseJson: JSON.stringify(parsed),
        })
        .onConflictDoNothing()
        .run();
      // First successful response is immutable throughout this run.
      return this.getCachedSearch(projectId, runId, parsed.query)!;
    })();
  }

  interruptRun(projectId: number, runId: string): ResearchRun {
    return this.sqlite.transaction(() => {
      const run = this.getRun(projectId, runId);
      if (run.status === "completed")
        throw new Error("Completed research runs cannot be interrupted.");
      const now = new Date().toISOString();
      this.db
        .update(researchTasks)
        .set({ status: "interrupted", updatedAt: now })
        .where(
          and(
            eq(researchTasks.runId, runId),
            eq(researchTasks.status, "running"),
          ),
        )
        .run();
      this.db
        .update(researchRuns)
        .set({ status: "interrupted", updatedAt: now })
        .where(eq(researchRuns.id, runId))
        .run();
      return this.getRun(projectId, runId);
    })();
  }

  /** Explicit recovery also handles a run left running by a process crash. */
  resumeRun(projectId: number, runId: string): ResearchRun {
    return this.sqlite.transaction(() => {
      this.getRun(projectId, runId);
      const now = new Date().toISOString();
      this.db
        .update(researchTasks)
        .set({
          status: "pending",
          errorJson: null,
          startedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(researchTasks.runId, runId),
            inArray(researchTasks.status, ["running", "interrupted", "failed"]),
          ),
        )
        .run();
      this.db
        .update(researchRuns)
        .set({
          status: "running",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(researchRuns.id, runId))
        .run();
      return this.getRun(projectId, runId);
    })();
  }

  completeRun(projectId: number, runId: string): ResearchRun {
    return this.sqlite.transaction(() => {
      this.requireRunningRun(projectId, runId);
      if (this.getProgress(projectId, runId).remaining)
        throw new Error("Research run still has unfinished tasks.");
      const now = new Date().toISOString();
      this.db
        .update(researchRuns)
        .set({ status: "completed", completedAt: now, updatedAt: now })
        .where(eq(researchRuns.id, runId))
        .run();
      return this.getRun(projectId, runId);
    })();
  }

  getProgress(projectId: number, runId: string) {
    this.getRun(projectId, runId);
    const rows = this.db
      .select({
        status: researchTasks.status,
        evidenceStatus: sql<
          string | null
        >`json_extract(${researchTasks.resultJson}, '$.evidenceStatus')`,
        count: sql<number>`count(*)`,
      })
      .from(researchTasks)
      .where(eq(researchTasks.runId, runId))
      .groupBy(
        researchTasks.status,
        sql`json_extract(${researchTasks.resultJson}, '$.evidenceStatus')`,
      )
      .all();
    const counts = {
      total: 0,
      completed: 0,
      failed: 0,
      remaining: 0,
      supported_candidate: 0,
      insufficient_evidence: 0,
      insufficient_context: 0,
      no_action_needed: 0,
    };
    for (const row of rows) {
      counts.total += row.count;
      if (row.status === "completed") {
        counts.completed += row.count;
        const status = researchEvidenceStatusSchema.parse(row.evidenceStatus);
        counts[status] += row.count;
      } else if (row.status === "failed") counts.failed += row.count;
      else counts.remaining += row.count;
    }
    return counts;
  }

  private requireRunningRun(projectId: number, runId: string): void {
    if (this.getRun(projectId, runId).status !== "running")
      throw new Error("Research run must be running for this operation.");
  }

  private requireClaim(
    projectId: number,
    runId: string,
    commentId: string,
    attempt: number,
  ): ResearchTask {
    this.requireRunningRun(projectId, runId);
    const task = this.getTask(projectId, runId, commentId);
    if (task.status !== "running" || task.attempts !== attempt)
      throw new Error("Research task claim is no longer active.");
    return task;
  }

  private readTask(row: typeof researchTasks.$inferSelect): ResearchTask {
    return researchTaskSchema.parse({
      runId: row.runId,
      commentId: row.commentId,
      inputSnapshot: row.inputSnapshotJson
        ? JSON.parse(row.inputSnapshotJson)
        : null,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      error: row.errorJson ? JSON.parse(row.errorJson) : null,
      result: row.resultJson ? JSON.parse(row.resultJson) : null,
    });
  }
}
