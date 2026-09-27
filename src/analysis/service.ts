import {
  AnalysisStore,
  type AnalyzedCommentInput,
  type AnalyzedCommentRecord,
} from "./store.js";
import { CommentCategoryPolicy } from "./category-policy.js";

/** Ensures a persisted analysis uses a category supplied by the shared policy. */
export class AnalyzedCommentService {
  constructor(
    private readonly store: AnalysisStore,
    private readonly categoryPolicy: CommentCategoryPolicy,
  ) {}

  async save(input: AnalyzedCommentInput): Promise<AnalyzedCommentRecord> {
    const category = await this.categoryPolicy.require(input.category);
    return this.store.upsert(input, category);
  }
}
