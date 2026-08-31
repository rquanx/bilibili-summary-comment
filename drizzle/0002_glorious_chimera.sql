ALTER TABLE `video_parts` ADD `source_path` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `source_type` text DEFAULT 'bili' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `publish_enabled` integer DEFAULT 1 NOT NULL;