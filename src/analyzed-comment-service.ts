import { AnalysisStore, type AnalyzedCommentInput, type AnalyzedCommentRecord } from "./analysis-store.js";
import { CommentCategoryPolicy } from "./comment-category-policy.js";

/** Ensures a persisted analysis uses a category supplied by the shared policy. */
export class AnalyzedCommentService {
  constructor(
    private readonly store: AnalysisStore,
    private readonly categoryPolicy: CommentCategoryPolicy,
  ) {}

  async save(input: AnalyzedCommentInput): Promise<AnalyzedCommentRecord> {
    await this.categoryPolicy.require(input.category);
    return this.store.upsert(input);
  }
}
