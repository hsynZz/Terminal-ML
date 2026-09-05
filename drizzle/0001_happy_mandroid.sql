CREATE TABLE `model_debug_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pair` text NOT NULL,
	`base_currency` text NOT NULL,
	`quote_currency` text NOT NULL,
	`horizon` integer NOT NULL,
	`probability` real NOT NULL,
	`confidence` real NOT NULL,
	`regime` text NOT NULL,
	`contributions` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_debug_pair_observed` ON `model_debug_logs` (`pair`,`observed_at`);