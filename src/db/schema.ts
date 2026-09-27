import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey(),
  pathWithNamespace: text("path_with_namespace").notNull(),
  webUrl: text("web_url").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const mergeRequests = sqliteTable(
  "merge_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    iid: integer("iid").notNull(),
    title: text("title").notNull(),
    webUrl: text("web_url").notNull(),
    state: text("state"),
    authorUsername: text("author_username"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("merge_requests_project_iid_unique").on(
      table.projectId,
      table.iid,
    ),
  ],
);

export const discussions = sqliteTable(
  "discussions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mergeRequestId: integer("merge_request_id")
      .notNull()
      .references(() => mergeRequests.id, { onDelete: "cascade" }),
    gitlabDiscussionId: text("gitlab_discussion_id").notNull(),
    oldPath: text("old_path"),
    newPath: text("new_path"),
    oldLine: integer("old_line"),
    newLine: integer("new_line"),
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("discussions_merge_request_gitlab_id_unique").on(
      table.mergeRequestId,
      table.gitlabDiscussionId,
    ),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mergeRequestId: integer("merge_request_id")
      .notNull()
      .references(() => mergeRequests.id, { onDelete: "cascade" }),
    discussionId: integer("discussion_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" }),
    noteId: integer("note_id").notNull(),
    body: text("body").notNull(),
    sourceUrl: text("source_url").notNull(),
    authorName: text("author_name").notNull(),
    authorUsername: text("author_username").notNull(),
    commentCreatedAt: text("comment_created_at").notNull(),
    oldPath: text("old_path"),
    newPath: text("new_path"),
    oldLine: integer("old_line"),
    newLine: integer("new_line"),
    commitSha: text("commit_sha"),
    analysisStatus: text("analysis_status").notNull().default("pending"),
    analysisResultJson: text("analysis_result_json"),
    analyzedAt: text("analyzed_at"),
    analysisError: text("analysis_error"),
    analysisVersion: text("analysis_version"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("comments_project_note_unique").on(
      table.projectId,
      table.noteId,
    ),
    index("comments_analysis_status_index").on(table.analysisStatus),
    index("comments_discussion_index").on(table.discussionId),
  ],
);

export const issueCategories = sqliteTable("issue_categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  recommendedSolution: text("recommended_solution").notNull(),
  defaultResolution: text("default_resolution").notNull().default("open"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const analysisBatches = sqliteTable("analysis_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  categoryPolicyVersion: text("category_policy_version"),
  retryCount: integer("retry_count").notNull().default(0),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const commentAnalytics = sqliteTable(
  "comment_analytics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    commentId: integer("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => issueCategories.id),
    resolution: text("resolution").notNull(),
    solution: text("solution"),
    rationale: text("rationale"),
    confidence: integer("confidence"),
    batchId: integer("batch_id").references(() => analysisBatches.id),
    analyzedBy: text("analyzed_by"),
    model: text("model"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("comment_analytics_comment_category_unique").on(
      table.commentId,
      table.categoryId,
    ),
    index("comment_analytics_category_index").on(table.categoryId),
  ],
);

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
