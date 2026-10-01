CREATE TABLE `seasonality_fx_rates` (
	`date` text NOT NULL,
	`base_currency` text NOT NULL,
	`quote_currency` text NOT NULL,
	`close` real NOT NULL,
	`raw_value` real NOT NULL,
	`source` text NOT NULL,
	`source_series_id` text NOT NULL,
	`source_timestamp` text,
	`ingested_at` text NOT NULL,
	`is_derived` integer NOT NULL,
	`derivation_method` text NOT NULL,
	`normalization_version` text NOT NULL,
	`data_quality_status` text NOT NULL,
	`verification` text,
	PRIMARY KEY(`base_currency`, `date`, `ingested_at`)
);
--> statement-breakpoint
CREATE TABLE `seasonality_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_seasonality_sync_at` ON `seasonality_sync_runs` (`at`);--> statement-breakpoint
CREATE TABLE `seasonality_sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
