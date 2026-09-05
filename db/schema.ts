import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
