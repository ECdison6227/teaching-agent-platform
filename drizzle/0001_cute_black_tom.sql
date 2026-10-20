CREATE TABLE `import_items` (
	`course_id` text NOT NULL,
	`key` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_item_course_key` ON `import_items` (`course_id`,`key`);