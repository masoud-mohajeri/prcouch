import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

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
  // The category policy is enforced by AnalyzedCommentService before storage.
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

const analysisFileSchema = z.object({
  version: z.literal(1),
  records: z.array(analyzedCommentRecordSchema),
});

type AnalysisFile = z.infer<typeof analysisFileSchema>;

const writeLocks = new Map<string, Promise<unknown>>();

export function getAnalysisStorePath(env = process.env): string {
  const configuredPath = env.ANALYSIS_STORE_PATH?.trim();
  return resolve(configuredPath || "data/analyzed-comments.json");
}

/**
 * A local, versioned JSON ledger. Writes are atomic and serialized per file
 * within this process so concurrent tool calls do not lose records.
 */
export class AnalysisStore {
  readonly path: string;

  constructor(path = getAnalysisStorePath()) {
    this.path = resolve(path);
  }

  async list(): Promise<AnalyzedCommentRecord[]> {
    return (await this.read()).records;
  }

  async upsert(input: AnalyzedCommentInput): Promise<AnalyzedCommentRecord> {
    return this.withWriteLock(async () => {
      const parsed = analyzedCommentInputSchema.parse(input);
      const record: AnalyzedCommentRecord = {
        ...parsed,
        id: `${parsed.project.id}:${parsed.comment.noteId}`,
        analyzedAt: new Date().toISOString(),
      };
      const file = await this.read();
      const existingIndex = file.records.findIndex((item) => item.id === record.id);
      if (existingIndex >= 0) file.records[existingIndex] = record;
      else file.records.push(record);
      await this.write(file);
      return record;
    });
  }

  private async read(): Promise<AnalysisFile> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) return { version: 1, records: [] };
      throw error;
    }
    if (!contents.trim()) return { version: 1, records: [] };

    let data: unknown;
    try {
      data = JSON.parse(contents);
    } catch (error: unknown) {
      throw new Error(`Analysis store contains malformed JSON at ${this.path}: ${errorMessage(error)}`);
    }
    if (isObject(data) && "version" in data && data.version !== 1) {
      throw new Error(`Analysis store at ${this.path} has unsupported version ${String(data.version)}.`);
    }
    const parsed = analysisFileSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Analysis store at ${this.path} has an invalid schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return parsed.data;
  }

  private async write(file: AnalysisFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = writeLocks.get(this.path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    writeLocks.set(this.path, operation);
    try {
      return await operation;
    } finally {
      if (writeLocks.get(this.path) === operation) writeLocks.delete(this.path);
    }
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
