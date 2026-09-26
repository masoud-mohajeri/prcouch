import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { resolutionSchema } from "./store.js";

const categorySchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "Category IDs must be lowercase snake_case."),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  defaultResolution: resolutionSchema,
  action: z.string().trim().min(1),
});

export const commentCategoryConfigSchema = z
  .object({
    version: z.literal(1),
    categories: z.array(categorySchema).min(1),
  })
  .superRefine(({ categories }, context) => {
    const ids = new Set<string>();
    for (const [index, category] of categories.entries()) {
      if (ids.has(category.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", index, "id"],
          message: `Duplicate category ID: ${category.id}.`,
        });
      }
      ids.add(category.id);
    }
  });

export type CommentCategory = z.infer<typeof categorySchema>;
export type CommentCategoryConfig = z.infer<typeof commentCategoryConfigSchema>;

export function getCommentCategoryConfigPath(env = process.env): string {
  const configuredPath = env.COMMENT_CATEGORY_CONFIG_PATH?.trim();
  return resolve(configuredPath || "config/comment-categories.json");
}

/** Loads and validates the shared category/action policy once per instance. */
export class CommentCategoryPolicy {
  readonly path: string;
  private configPromise: Promise<CommentCategoryConfig> | undefined;

  constructor(path = getCommentCategoryConfigPath()) {
    this.path = resolve(path);
  }

  async list(): Promise<CommentCategory[]> {
    return (await this.load()).categories;
  }

  async require(categoryId: string): Promise<CommentCategory> {
    const category = (await this.load()).categories.find(
      (item) => item.id === categoryId,
    );
    if (category) return category;
    const validIds = (await this.load()).categories
      .map((item) => item.id)
      .join(", ");
    throw new Error(
      `Unknown comment category "${categoryId}". Use one of: ${validIds}.`,
    );
  }

  private load(): Promise<CommentCategoryConfig> {
    this.configPromise ??= this.readConfig();
    return this.configPromise;
  }

  private async readConfig(): Promise<CommentCategoryConfig> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      throw new Error(
        `Unable to read comment category policy at ${this.path}: ${errorMessage(error)}`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error: unknown) {
      throw new Error(
        `Comment category policy contains malformed JSON at ${this.path}: ${errorMessage(error)}`,
      );
    }
    if (isObject(data) && "version" in data && data.version !== 1) {
      throw new Error(
        `Comment category policy at ${this.path} has unsupported version ${String(data.version)}.`,
      );
    }
    const parsed = commentCategoryConfigSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `Comment category policy at ${this.path} has an invalid schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return parsed.data;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
