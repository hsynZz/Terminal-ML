CREATE TABLE `currency_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`currency` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`period` text NOT NULL,
	`source` text NOT NULL,
	`observed_at` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_currency_metric_period_source` ON `currency_observations` (`currency`,`metric`,`period`,`source`);--> statement-breakpoint
CREATE INDEX `idx_currency_metric_observed` ON `currency_observations` (`currency`,`metric`,`observed_at`);--> statement-breakpoint
CREATE TABLE `evidence_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pair` text NOT NULL,
	`factor` text NOT NULL,
	`score` real NOT NULL,
	`weight` real NOT NULL,
	`observed_at` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_pair_observed` ON `evidence_entries` (`pair`,`observed_at`);--> statement-breakpoint
CREATE TABLE `terminal_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terminal_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`as_of` text NOT NULL,
	`source_mode` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_terminal_snapshots_as_of` ON `terminal_snapshots` (`as_of`);