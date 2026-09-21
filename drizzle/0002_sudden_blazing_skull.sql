CREATE TABLE `observation_vintages` (
	`id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`metric` text NOT NULL,
	`period` text NOT NULL,
	`source` text NOT NULL,
	`received_at` text NOT NULL,
	`value` real NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_vintage_lookup` ON `observation_vintages` (`currency`,`metric`,`period`,`received_at`);--> statement-breakpoint
CREATE TABLE `production_records` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`version` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_production_kind_at` ON `production_records` (`kind`,`at`);