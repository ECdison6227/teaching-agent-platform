PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`code` text NOT NULL,
	`type` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text,
	`answer` text,
	`analysis` text,
	`kp_id` text,
	`kp_confidence` real DEFAULT 0 NOT NULL,
	`answer_method` text,
	`page_ids` text NOT NULL,
	`source` text NOT NULL,
	`confidence` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kp_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_questions`("id", "course_id", "code", "type", "prompt", "options", "answer", "analysis", "kp_id", "kp_confidence", "answer_method", "page_ids", "source", "confidence", "verified", "review_status") SELECT "id", "course_id", "code", "type", "prompt", "options", "answer", "analysis", "kp_id", 0, CASE WHEN "answer" IS NOT NULL AND trim("answer") != '' THEN 'source' ELSE NULL END, "page_ids", "source", "confidence", "verified", "review_status" FROM `questions`;--> statement-breakpoint
DROP TABLE `questions`;--> statement-breakpoint
ALTER TABLE `__new_questions` RENAME TO `questions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `question_course_code` ON `questions` (`course_id`,`code`);