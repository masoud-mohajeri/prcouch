import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";

import {
  commentAnalytics,
  comments,
  discussions,
  issueCategories,
  mergeRequests,
  projects,
} from "../db/schema.js";
import type { CommentCategory } from "./category-policy.js";

export const resolutionSchema = z.enum([
  "open",
  "addressed",
  "wont_fix",
  "duplicate",
  "needs_discussion",
  "not_actionable",
]);

const locationSchema = z.object({
  oldPath: z.string().min(1).nullable().default(null),
  newPath: z.string().min(1).nullable().default(null),
  oldLine: z.number().int().positive().nullable().default(null),
  newLine: z.number().int().positive().nullable().default(null),
});

/** The data required to persist one AI/human analysis of a GitLab note. */
export const analyzedCommentInputSchema = z.object({
  project: z.object({
    id: z.number().int().positive(),
    pathWithNamespace: z.string().min(1),
    webUrl: z.string().url(),
  }),
  mergeRequest: z.object({
    iid: z.number().int().positive(),
    title: z.string().min(1),
    webUrl: z.string().url(),
  }),
  comment: z.object({
    discussionId: z.string().min(1),
    noteId: z.number().int().positive(),
    body: z.string(),
    sourceUrl: z.string().url(),
    createdAt: z.string().datetime({ offset: true }),
    author: z.object({
      name: z.string().min(1),
      username: z.string().min(1),
    }),
    location: locationSchema.default({
      oldPath: null,
      newPath: null,
      oldLine: null,
      newLine: null,
    }),
    commitSha: z.string().min(1).nullable().default(null),
  }),
  category: z.string().trim().min(1),
  resolution: resolutionSchema,
  rationale: z.string().trim().min(1).optional(),
  analyzedBy: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
});

export type AnalyzedCommentInput = z.input<typeof analyzedCommentInputSchema>;

export const analyzedCommentRecordSchema = analyzedCommentInputSchema.extend({
  id: z.string().min(1),
  analyzedAt: z.string().datetime({ offset: true }),
});

export type AnalyzedCommentRecord = z.infer<typeof analyzedCommentRecordSchema>;

export function getAnalysisStorePath(env = process.env): string {
  const configuredPath = env.ANALYSIS_STORE_PATH?.trim();
  return resolve(configuredPath || "data/analytics.sqlite");
}

/** SQLite-backed persistence for local review analyses. */
export class AnalysisStore {
  readonly path: string;
  private readonly sqlite: Database.Database;
  private readonly db;

  constructor(path = getAnalysisStorePath()) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.sqlite = new Database(this.path);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: resolve("drizzle") });
  }

  async list(): Promise<AnalyzedCommentRecord[]> {
    const rows = this.db
      .select({
        projectId: projects.id,
        projectPathWithNamespace: projects.pathWithNamespace,
        projectWebUrl: projects.webUrl,
        mergeRequestIid: mergeRequests.iid,
        mergeRequestTitle: mergeRequests.title,
        mergeRequestWebUrl: mergeRequests.webUrl,
        discussionId: discussions.gitlabDiscussionId,
        noteId: comments.noteId,
        body: comments.body,
        sourceUrl: comments.sourceUrl,
        commentCreatedAt: comments.commentCreatedAt,
        authorName: comments.authorName,
        authorUsername: comments.authorUsername,
        oldPath: comments.oldPath,
        newPath: comments.newPath,
        oldLine: comments.oldLine,
        newLine: comments.newLine,
        commitSha: comments.commitSha,
        category: issueCategories.code,
        resolution: commentAnalytics.resolution,
        rationale: commentAnalytics.rationale,
        analyzedBy: commentAnalytics.analyzedBy,
        model: commentAnalytics.model,
        analyzedAt: comments.analyzedAt,
      })
      .from(commentAnalytics)
      .innerJoin(comments, eq(commentAnalytics.commentId, comments.id))
      .innerJoin(projects, eq(comments.projectId, projects.id))
      .innerJoin(mergeRequests, eq(comments.mergeRequestId, mergeRequests.id))
      .innerJoin(discussions, eq(comments.discussionId, discussions.id))
      .innerJoin(
        issueCategories,
        eq(commentAnalytics.categoryId, issueCategories.id),
      )
      .where(eq(comments.analysisStatus, "completed"))
      .orderBy(desc(comments.analyzedAt), desc(comments.noteId))
      .all();

    return rows.map((row) =>
      analyzedCommentRecordSchema.parse({
        id: `${row.projectId}:${row.noteId}`,
        project: {
          id: row.projectId,
          pathWithNamespace: row.projectPathWithNamespace,
          webUrl: row.projectWebUrl,
        },
        mergeRequest: {
          iid: row.mergeRequestIid,
          title: row.mergeRequestTitle,
          webUrl: row.mergeRequestWebUrl,
        },
        comment: {
          discussionId: row.discussionId,
          noteId: row.noteId,
          body: row.body,
          sourceUrl: row.sourceUrl,
          createdAt: row.commentCreatedAt,
          author: { name: row.authorName, username: row.authorUsername },
          location: {
            oldPath: row.oldPath,
            newPath: row.newPath,
            oldLine: row.oldLine,
            newLine: row.newLine,
          },
          commitSha: row.commitSha,
        },
        category: row.category,
        resolution: row.resolution,
        rationale: row.rationale ?? undefined,
        analyzedBy: row.analyzedBy ?? undefined,
        model: row.model ?? undefined,
        analyzedAt: row.analyzedAt,
      }),
    );
  }

  async upsert(
    input: AnalyzedCommentInput,
    category?: CommentCategory,
  ): Promise<AnalyzedCommentRecord> {
    const parsed = analyzedCommentInputSchema.parse(input);
    const analyzedAt = new Date().toISOString();
    const record: AnalyzedCommentRecord = {
      ...parsed,
      id: `${parsed.project.id}:${parsed.comment.noteId}`,
      analyzedAt,
    };

    this.sqlite.transaction(() => {
      const now = analyzedAt;
      this.db
        .insert(projects)
        .values({
          id: parsed.project.id,
          pathWithNamespace: parsed.project.pathWithNamespace,
          webUrl: parsed.project.webUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: projects.id,
          set: {
            pathWithNamespace: parsed.project.pathWithNamespace,
            webUrl: parsed.project.webUrl,
            updatedAt: now,
          },
        })
        .run();

      this.db
        .insert(mergeRequests)
        .values({
          projectId: parsed.project.id,
          iid: parsed.mergeRequest.iid,
          title: parsed.mergeRequest.title,
          webUrl: parsed.mergeRequest.webUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [mergeRequests.projectId, mergeRequests.iid],
          set: {
            title: parsed.mergeRequest.title,
            webUrl: parsed.mergeRequest.webUrl,
            updatedAt: now,
          },
        })
        .run();
      const mergeRequestId = this.requireId(
        this.db
          .select({ id: mergeRequests.id })
          .from(mergeRequests)
          .where(
            and(
              eq(mergeRequests.projectId, parsed.project.id),
              eq(mergeRequests.iid, parsed.mergeRequest.iid),
            ),
          )
          .get(),
        "merge request",
      );

      this.db
        .insert(discussions)
        .values({
          mergeRequestId,
          gitlabDiscussionId: parsed.comment.discussionId,
          oldPath: parsed.comment.location.oldPath,
          newPath: parsed.comment.location.newPath,
          oldLine: parsed.comment.location.oldLine,
          newLine: parsed.comment.location.newLine,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [discussions.mergeRequestId, discussions.gitlabDiscussionId],
          set: {
            oldPath: parsed.comment.location.oldPath,
            newPath: parsed.comment.location.newPath,
            oldLine: parsed.comment.location.oldLine,
            newLine: parsed.comment.location.newLine,
            updatedAt: now,
          },
        })
        .run();
      const discussionId = this.requireId(
        this.db
          .select({ id: discussions.id })
          .from(discussions)
          .where(
            and(
              eq(discussions.mergeRequestId, mergeRequestId),
              eq(discussions.gitlabDiscussionId, parsed.comment.discussionId),
            ),
          )
          .get(),
        "discussion",
      );

      const analysisResultJson = JSON.stringify({
        category: parsed.category,
        resolution: parsed.resolution,
        rationale: parsed.rationale,
        analyzedBy: parsed.analyzedBy,
        model: parsed.model,
      });
      this.db
        .insert(comments)
        .values({
          projectId: parsed.project.id,
          mergeRequestId,
          discussionId,
          noteId: parsed.comment.noteId,
          body: parsed.comment.body,
          sourceUrl: parsed.comment.sourceUrl,
          authorName: parsed.comment.author.name,
          authorUsername: parsed.comment.author.username,
          commentCreatedAt: parsed.comment.createdAt,
          oldPath: parsed.comment.location.oldPath,
          newPath: parsed.comment.location.newPath,
          oldLine: parsed.comment.location.oldLine,
          newLine: parsed.comment.location.newLine,
          commitSha: parsed.comment.commitSha,
          analysisStatus: "completed",
          analysisResultJson,
          analyzedAt,
          analysisError: null,
          analysisVersion: "v1",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [comments.projectId, comments.noteId],
          set: {
            mergeRequestId,
            discussionId,
            body: parsed.comment.body,
            sourceUrl: parsed.comment.sourceUrl,
            authorName: parsed.comment.author.name,
            authorUsername: parsed.comment.author.username,
            commentCreatedAt: parsed.comment.createdAt,
            oldPath: parsed.comment.location.oldPath,
            newPath: parsed.comment.location.newPath,
            oldLine: parsed.comment.location.oldLine,
            newLine: parsed.comment.location.newLine,
            commitSha: parsed.comment.commitSha,
            analysisStatus: "completed",
            analysisResultJson,
            analyzedAt,
            analysisError: null,
            analysisVersion: "v1",
            updatedAt: now,
          },
        })
        .run();
      const commentId = this.requireId(
        this.db
          .select({ id: comments.id })
          .from(comments)
          .where(
            and(
              eq(comments.projectId, parsed.project.id),
              eq(comments.noteId, parsed.comment.noteId),
            ),
          )
          .get(),
        "comment",
      );

      const categoryValues = category
        ? {
            code: category.id,
            name: category.label,
            description: category.description,
            recommendedSolution: category.action,
            active: true,
            version: 1,
          }
        : {
            code: parsed.category,
            name: parsed.category,
            description: "",
            recommendedSolution: "",
            active: true,
            version: 1,
          };
      this.db
        .insert(issueCategories)
        .values({ ...categoryValues, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: issueCategories.code,
          set: { ...categoryValues, updatedAt: now },
        })
        .run();
      const categoryId = this.requireId(
        this.db
          .select({ id: issueCategories.id })
          .from(issueCategories)
          .where(eq(issueCategories.code, parsed.category))
          .get(),
        "category",
      );

      // The current public save API represents one analysis per comment.
      this.db
        .delete(commentAnalytics)
        .where(eq(commentAnalytics.commentId, commentId))
        .run();
      this.db
        .insert(commentAnalytics)
        .values({
          commentId,
          categoryId,
          resolution: parsed.resolution,
          solution: category?.action,
          rationale: parsed.rationale,
          analyzedBy: parsed.analyzedBy,
          model: parsed.model,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    })();

    return record;
  }

  close(): void {
    this.sqlite.close();
  }

  private requireId(value: { id: number } | undefined, entity: string): number {
    if (value) return value.id;
    throw new Error(`Could not persist ${entity}.`);
  }
}
