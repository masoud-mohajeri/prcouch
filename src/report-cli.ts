import "dotenv/config";

import { AnalysisStore } from "./analysis-store.js";
import { CommentCategoryPolicy } from "./comment-category-policy.js";
import { CommentReportGenerator } from "./report.js";

const report = await new CommentReportGenerator(new AnalysisStore(), new CommentCategoryPolicy()).generate();
console.log(`Generated ${report.recordCount} analyzed-comment records: ${report.path}`);
