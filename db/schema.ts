import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const terminalSnapshots = sqliteTable("terminal_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  asOf: text("as_of").notNull(),
  sourceMode: text("source_mode").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_terminal_snapshots_as_of").on(table.asOf)]);

export const currencyObservations = sqliteTable("currency_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currency: text("currency").notNull(),
  metric: text("metric").notNull(),
  value: real("value").notNull(),
  period: text("period").notNull(),
  source: text("source").notNull(),
  observedAt: text("observed_at").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uidx_currency_metric_period_source").on(table.currency, table.metric, table.period, table.source),
  index("idx_currency_metric_observed").on(table.currency, table.metric, table.observedAt),
]);

export const evidenceEntries = sqliteTable("evidence_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pair: text("pair").notNull(),
  factor: text("factor").notNull(),
  score: real("score").notNull(),
  weight: real("weight").notNull(),
  observedAt: text("observed_at").notNull(),
  source: text("source").notNull(),
}, (table) => [index("idx_evidence_pair_observed").on(table.pair, table.observedAt)]);

export const terminalSettings = sqliteTable("terminal_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const modelDebugLogs = sqliteTable("model_debug_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pair: text("pair").notNull(),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  horizon: integer("horizon").notNull(),
  probability: real("probability").notNull(),
  confidence: real("confidence").notNull(),
  regime: text("regime").notNull(),
  contributions: text("contributions", { mode: "json" }).notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [index("idx_model_debug_pair_observed").on(table.pair, table.observedAt)]);

// Additive, insert-only archives. Mutable current observations remain a compatibility view.
export const observationVintages = sqliteTable("observation_vintages", {
  id: text("id").primaryKey(),
  currency: text("currency").notNull(),
  metric: text("metric").notNull(),
  period: text("period").notNull(),
  source: text("source").notNull(),
  receivedAt: text("received_at").notNull(),
  value: real("value").notNull(),
  payload: text("payload").notNull(),
}, t => [index("idx_vintage_lookup").on(t.currency,t.metric,t.period,t.receivedAt)]);

export const productionRecords = sqliteTable("production_records", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  at: text("at").notNull(),
  version: text("version").notNull(),
  payload: text("payload").notNull(),
}, t => [index("idx_production_kind_at").on(t.kind,t.at)]);

// Separate descriptive FX archive. No relationship to Core factors, ML or labels.
// Immutable receipt vintages: changes append; repeated unchanged receipts do not.
export const seasonalityFxRates = sqliteTable('seasonality_fx_rates', {
  date: text('date').notNull(),
  baseCurrency: text('base_currency').notNull(),
  quoteCurrency: text('quote_currency').notNull(),
  close: real('close').notNull(),
  rawValue: real('raw_value').notNull(),
  source: text('source').notNull(),
  sourceSeriesId: text('source_series_id').notNull(),
  sourceTimestamp: text('source_timestamp'),
  ingestedAt: text('ingested_at').notNull(),
  isDerived: integer('is_derived').notNull(),
  derivationMethod: text('derivation_method').notNull(),
  normalizationVersion: text('normalization_version').notNull(),
  dataQualityStatus: text('data_quality_status').notNull(),
  verification: text('verification'),
},t=>[primaryKey({columns:[t.baseCurrency,t.date,t.ingestedAt]})]);

export const seasonalitySyncState = sqliteTable('seasonality_sync_state',{
  key:text('key').primaryKey(),value:text('value').notNull(),updatedAt:text('updated_at').notNull(),
});
export const seasonalitySyncRuns = sqliteTable('seasonality_sync_runs',{
  id:text('id').primaryKey(),at:text('at').notNull(),source:text('source').notNull(),status:text('status').notNull(),payload:text('payload').notNull(),
},t=>[index('idx_seasonality_sync_at').on(t.at)]);
