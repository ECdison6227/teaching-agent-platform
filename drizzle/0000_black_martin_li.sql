CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`order` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`institution` text,
	`logo_asset_id` text,
	`language` text DEFAULT 'zh' NOT NULL,
	`owner_id` text DEFAULT 'anonymous' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`persona` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courses_slug_unique` ON `courses` (`slug`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`type` text DEFAULT 'import' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`step` text DEFAULT '等待 worker' NOT NULL,
	`error` text,
	`cost_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`heartbeat_at` text,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_queue` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `knowledge_points` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`order` integer NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`keywords` text NOT NULL,
	`has_slides` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kp_course_code` ON `knowledge_points` (`course_id`,`code`);--> statement-breakpoint
CREATE TABLE `page_notes` (
	`page_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`points` text NOT NULL,
	`keys` text NOT NULL,
	`model` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`qa_status` text NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`source_id` text NOT NULL,
	`index` integer NOT NULL,
	`source_page` integer NOT NULL,
	`image_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`raw_text` text NOT NULL,
	`title` text NOT NULL,
	`kp_id` text,
	`elements` text,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kp_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_page` ON `pages` (`course_id`,`index`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`code` text NOT NULL,
	`type` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text,
	`answer` text,
	`analysis` text,
	`kp_id` text NOT NULL,
	`page_ids` text NOT NULL,
	`source` text NOT NULL,
	`confidence` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kp_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_course_code` ON `questions` (`course_id`,`code`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`sha256` text NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`storage_key` text NOT NULL,
	`pdf_key` text,
	`text_key` text,
	`uploaded_by` text DEFAULT 'anonymous' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_dedup` ON `sources` (`course_id`,`kind`,`sha256`);