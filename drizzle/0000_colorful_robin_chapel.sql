CREATE TABLE `gap_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gap_key` text NOT NULL,
	`bvid` text NOT NULL,
	`video_title` text,
	`from_page_no` integer NOT NULL,
	`from_cid` integer NOT NULL,
	`to_page_no` integer NOT NULL,
	`to_cid` integer NOT NULL,
	`gap_start_at` text NOT NULL,
	`gap_end_at` text NOT NULL,
	`gap_seconds` integer NOT NULL,
	`notified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gap_notifications_gap_key` ON `gap_notifications` (`gap_key`);--> statement-breakpoint
CREATE INDEX `idx_gap_notifications_bvid_notified_at` ON `gap_notifications` (`bvid`,`notified_at`,`id`);--> statement-breakpoint
CREATE TABLE `pipeline_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text,
	`video_id` integer,
	`bvid` text,
	`video_title` text,
	`page_no` integer,
	`cid` integer,
	`part_title` text,
	`scope` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`details_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_created_at` ON `pipeline_events` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_bvid_created_at` ON `pipeline_events` (`bvid`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_run_id` ON `pipeline_events` (`run_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `recent_reprocess_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer,
	`bvid` text NOT NULL,
	`video_title` text,
	`candidate_key` text NOT NULL,
	`reasons_json` text NOT NULL,
	`paste_pages_json` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`details_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_recent_reprocess_runs_candidate_status` ON `recent_reprocess_runs` (`candidate_key`,`status`,`finished_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_recent_reprocess_runs_bvid_created_at` ON `recent_reprocess_runs` (`bvid`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `video_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`page_no` integer NOT NULL,
	`cid` integer NOT NULL,
	`part_title` text NOT NULL,
	`duration_sec` integer DEFAULT 0 NOT NULL,
	`subtitle_path` text,
	`subtitle_source` text,
	`subtitle_lang` text,
	`subtitle_text` text,
	`prompt_text` text,
	`summary_text` text,
	`summary_text_processed` text,
	`summary_hash` text,
	`published` integer DEFAULT 0 NOT NULL,
	`published_comment_rpid` integer,
	`published_at` text,
	`is_deleted` integer DEFAULT 0 NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_video_parts_video_id` ON `video_parts` (`video_id`);--> statement-breakpoint
CREATE INDEX `idx_video_parts_video_page` ON `video_parts` (`video_id`,`page_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_parts_video_cid` ON `video_parts` (`video_id`,`cid`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bvid` text NOT NULL,
	`aid` integer NOT NULL,
	`title` text NOT NULL,
	`owner_mid` integer,
	`owner_name` text,
	`owner_dir_name` text,
	`work_dir_name` text,
	`page_count` integer DEFAULT 0 NOT NULL,
	`root_comment_rpid` integer,
	`top_comment_rpid` integer,
	`publish_needs_rebuild` integer DEFAULT 0 NOT NULL,
	`publish_rebuild_reason` text,
	`last_scan_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_bvid_unique` ON `videos` (`bvid`);--> statement-breakpoint
CREATE UNIQUE INDEX `videos_aid_unique` ON `videos` (`aid`);