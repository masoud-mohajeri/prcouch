CREATE TABLE `research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`filters_json` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_runs_project_index` ON `research_runs` (`project_id`);--> statement-breakpoint
CREATE TABLE `research_search_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`normalized_query` text NOT NULL,
	`retrieved_at` text NOT NULL,
	`response_json` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_cache_run_query_unique` ON `research_search_cache` (`run_id`,`normalized_query`);--> statement-breakpoint
CREATE TABLE `research_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`input_snapshot_json` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`error_json` text,
	`result_json` text,
	`successful_searches_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_tasks_run_comment_unique` ON `research_tasks` (`run_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `research_tasks_run_status_index` ON `research_tasks` (`run_id`,`status`);
