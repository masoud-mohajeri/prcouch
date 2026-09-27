CREATE TABLE `analysis_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`category_policy_version` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`completed_at` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `comment_analytics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`resolution` text NOT NULL,
	`solution` text,
	`rationale` text,
	`confidence` integer,
	`batch_id` integer,
	`analyzed_by` text,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `issue_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `analysis_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_analytics_comment_category_unique` ON `comment_analytics` (`comment_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `comment_analytics_category_index` ON `comment_analytics` (`category_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`merge_request_id` integer NOT NULL,
	`discussion_id` integer NOT NULL,
	`note_id` integer NOT NULL,
	`body` text NOT NULL,
	`source_url` text NOT NULL,
	`author_name` text NOT NULL,
	`author_username` text NOT NULL,
	`comment_created_at` text NOT NULL,
	`old_path` text,
	`new_path` text,
	`old_line` integer,
	`new_line` integer,
	`commit_sha` text,
	`analysis_status` text DEFAULT 'pending' NOT NULL,
	`analysis_result_json` text,
	`analyzed_at` text,
	`analysis_error` text,
	`analysis_version` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comments_project_note_unique` ON `comments` (`project_id`,`note_id`);--> statement-breakpoint
CREATE INDEX `comments_analysis_status_index` ON `comments` (`analysis_status`);--> statement-breakpoint
CREATE INDEX `comments_discussion_index` ON `comments` (`discussion_id`);--> statement-breakpoint
CREATE TABLE `discussions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`merge_request_id` integer NOT NULL,
	`gitlab_discussion_id` text NOT NULL,
	`old_path` text,
	`new_path` text,
	`old_line` integer,
	`new_line` integer,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discussions_merge_request_gitlab_id_unique` ON `discussions` (`merge_request_id`,`gitlab_discussion_id`);--> statement-breakpoint
CREATE TABLE `issue_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`recommended_solution` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_categories_code_unique` ON `issue_categories` (`code`);--> statement-breakpoint
CREATE TABLE `merge_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`iid` integer NOT NULL,
	`title` text NOT NULL,
	`web_url` text NOT NULL,
	`state` text,
	`author_username` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_requests_project_iid_unique` ON `merge_requests` (`project_id`,`iid`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`path_with_namespace` text NOT NULL,
	`web_url` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
