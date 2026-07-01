import { createClient } from '@clickhouse/client';
import { isKafkaConfigured } from './kafkaAnalytics.js';

const sanitizeEnvValue = (value) => {
  if (typeof value !== 'string') return '';
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
};

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = sanitizeEnvValue(process.env[key]);
    if (value) return value;
  }
  return '';
};

const safeIdentifier = (value, fallback) => {
  const cleaned = String(value || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned) ? cleaned : fallback;
};

const quoteIdent = (value) => `\`${safeIdentifier(value, 'default')}\``;
const databaseName = () => safeIdentifier(readEnv('CLICKHOUSE_DATABASE') || 'indiantrademart_analytics', 'indiantrademart_analytics');
const tablePath = (table) => `${quoteIdent(databaseName())}.${quoteIdent(table)}`;
const insertTableName = (table) => safeIdentifier(table, table);

const toClickHouseDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().slice(0, 19).replace('T', ' ');
};

const safeText = (value = '', max = 1000) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : '';
};

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const isClickHouseConfigured = () => Boolean(readEnv('CLICKHOUSE_URL', 'CLICKHOUSE_HOST'));

let client;

export const getClickHouseClient = () => {
  if (client) return client;

  const url = readEnv('CLICKHOUSE_URL', 'CLICKHOUSE_HOST');
  if (!url) {
    throw new Error('ClickHouse is not configured. Set CLICKHOUSE_URL.');
  }

  client = createClient({
    url,
    username: readEnv('CLICKHOUSE_USERNAME', 'CLICKHOUSE_USER') || 'default',
    password: readEnv('CLICKHOUSE_PASSWORD') || '',
    database: databaseName(),
    request_timeout: Number(process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS || 10000),
  });

  return client;
};

const queryRows = async (query) => {
  const result = await getClickHouseClient().query({ query, format: 'JSONEachRow' });
  return result.json();
};

export async function setupClickHouseBehavioralSchema() {
  if (!isClickHouseConfigured()) return { enabled: false };

  const db = quoteIdent(databaseName());
  const activeClient = getClickHouseClient();
  await activeClient.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });

  await activeClient.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${tablePath('behavioral_events')} (
        event_id String,
        visitor_id String,
        visitor_session_id String,
        visitor_name String,
        visitor_email String,
        visitor_phone String,
        visitor_company String,
        visitor_contact_source String,
        event_type LowCardinality(String),
        page_url String,
        page_path String,
        page_title String,
        referrer String,
        utm_source String,
        utm_medium String,
        utm_campaign String,
        search_query String,
        entity_type LowCardinality(String),
        entity_id String,
        entity_name String,
        category String,
        city String,
        state String,
        metadata String,
        created_at DateTime,
        inserted_at DateTime DEFAULT now()
      )
      ENGINE = ReplacingMergeTree(inserted_at)
      PARTITION BY toYYYYMM(created_at)
      ORDER BY (event_id)
    `,
  });

  await activeClient.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${tablePath('behavioral_hourly_aggregates')} (
        bucket_start DateTime,
        event_type LowCardinality(String),
        demand_key String,
        display_label String,
        category String,
        state String,
        city String,
        entity_type LowCardinality(String),
        entity_id String,
        event_count UInt64,
        unique_visitors UInt64,
        computed_at DateTime
      )
      ENGINE = ReplacingMergeTree(computed_at)
      PARTITION BY toYYYYMM(bucket_start)
      ORDER BY (bucket_start, event_type, demand_key, state, city)
    `,
  });

  await activeClient.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${tablePath('behavioral_demand_scores')} (
        demand_key String,
        display_label String,
        category String,
        state String,
        city String,
        window_days UInt16,
        demand_score Float64,
        intent_score Float64,
        event_count UInt64,
        search_count UInt64,
        product_views UInt64,
        vendor_views UInt64,
        requirement_opens UInt64,
        requirement_submits UInt64,
        lead_count UInt64,
        unique_visitors UInt64,
        trend_percent Float64,
        confidence UInt8,
        demand_stage LowCardinality(String),
        recommended_action String,
        top_entities String,
        computed_at DateTime
      )
      ENGINE = ReplacingMergeTree(computed_at)
      PARTITION BY window_days
      ORDER BY (window_days, demand_key, state, city)
    `,
  });

  await activeClient.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${tablePath('behavioral_forecasts')} (
        demand_key String,
        display_label String,
        state String,
        city String,
        window_days UInt16,
        forecast_7d Float64,
        forecast_30d Float64,
        trend_percent Float64,
        confidence UInt8,
        model_name LowCardinality(String),
        features String,
        computed_at DateTime
      )
      ENGINE = ReplacingMergeTree(computed_at)
      PARTITION BY window_days
      ORDER BY (window_days, demand_key, state, city)
    `,
  });

  return { enabled: true, database: databaseName() };
}

export async function writeClickHouseEvents(events = []) {
  if (!isClickHouseConfigured() || !events.length) return { enabled: isClickHouseConfigured(), inserted: 0 };
  await setupClickHouseBehavioralSchema();

  const values = events.map((event) => ({
    event_id: safeText(event.id || event.event_id, 191),
    visitor_id: safeText(event.visitor_id, 191),
    visitor_session_id: safeText(event.visitor_session_id, 191),
    visitor_name: safeText(event.visitor_name, 500),
    visitor_email: safeText(event.visitor_email, 191),
    visitor_phone: safeText(event.visitor_phone, 64),
    visitor_company: safeText(event.visitor_company, 500),
    visitor_contact_source: safeText(event.visitor_contact_source, 191),
    event_type: safeText(event.event_type, 64).toUpperCase(),
    page_url: safeText(event.page_url, 2000),
    page_path: safeText(event.page_path, 512),
    page_title: safeText(event.page_title, 500),
    referrer: safeText(event.referrer, 2000),
    utm_source: safeText(event.utm_source, 191),
    utm_medium: safeText(event.utm_medium, 191),
    utm_campaign: safeText(event.utm_campaign, 191),
    search_query: safeText(event.search_query, 500),
    entity_type: safeText(event.entity_type, 64),
    entity_id: safeText(event.entity_id, 191),
    entity_name: safeText(event.entity_name, 500),
    category: safeText(event.category, 500),
    city: safeText(event.city, 191),
    state: safeText(event.state, 191),
    metadata: event.metadata ? JSON.stringify(event.metadata) : '',
    created_at: toClickHouseDateTime(event.created_at),
  })).filter((event) => event.event_id);

  if (!values.length) return { enabled: true, inserted: 0 };

  await getClickHouseClient().insert({
    table: insertTableName('behavioral_events'),
    values,
    format: 'JSONEachRow',
  });

  return { enabled: true, inserted: values.length };
}

export async function writeClickHouseBehavioralData({ events = [], buckets = [], scored = [], days = 30 } = {}) {
  if (!isClickHouseConfigured()) return { enabled: false };
  await setupClickHouseBehavioralSchema();

  const computedAt = toClickHouseDateTime(new Date());
  const activeClient = getClickHouseClient();
  const eventResult = await writeClickHouseEvents(events);
  const bucketRows = Array.from(buckets instanceof Map ? buckets.values() : buckets).map((bucket) => ({
    bucket_start: toClickHouseDateTime(bucket.bucket_start),
    event_type: safeText(bucket.event_type, 64).toUpperCase(),
    demand_key: safeText(bucket.demand_key, 500),
    display_label: safeText(bucket.display_label, 500),
    category: safeText(bucket.category, 500),
    state: safeText(bucket.state, 191),
    city: safeText(bucket.city, 191),
    entity_type: safeText(bucket.entity_type, 64),
    entity_id: safeText(bucket.entity_id, 191),
    event_count: safeNumber(bucket.event_count),
    unique_visitors: safeNumber(bucket.uniqueVisitors?.size ?? bucket.unique_visitors),
    computed_at: computedAt,
  }));

  if (bucketRows.length) {
    await activeClient.insert({
      table: insertTableName('behavioral_hourly_aggregates'),
      values: bucketRows,
      format: 'JSONEachRow',
    });
  }

  const scoreRows = scored.map((row) => ({
    demand_key: safeText(row.demand_key, 500),
    display_label: safeText(row.display_label, 500),
    category: safeText(row.category, 500),
    state: safeText(row.state, 191),
    city: safeText(row.city, 191),
    window_days: safeNumber(row.window_days || days),
    demand_score: safeNumber(row.demand_score),
    intent_score: safeNumber(row.intent_score),
    event_count: safeNumber(row.event_count),
    search_count: safeNumber(row.search_count),
    product_views: safeNumber(row.product_views),
    vendor_views: safeNumber(row.vendor_views),
    requirement_opens: safeNumber(row.requirement_opens),
    requirement_submits: safeNumber(row.requirement_submits),
    lead_count: safeNumber(row.lead_count),
    unique_visitors: safeNumber(row.unique_visitors),
    trend_percent: safeNumber(row.trend_percent),
    confidence: safeNumber(row.confidence),
    demand_stage: safeText(row.demand_stage, 32),
    recommended_action: safeText(row.recommended_action, 1000),
    top_entities: JSON.stringify(row.top_entities || []),
    computed_at: computedAt,
  }));

  if (scoreRows.length) {
    await activeClient.insert({
      table: insertTableName('behavioral_demand_scores'),
      values: scoreRows,
      format: 'JSONEachRow',
    });

    await activeClient.insert({
      table: insertTableName('behavioral_forecasts'),
      values: scored.map((row) => ({
        demand_key: safeText(row.demand_key, 500),
        display_label: safeText(row.display_label, 500),
        state: safeText(row.state, 191),
        city: safeText(row.city, 191),
        window_days: safeNumber(row.window_days || days),
        forecast_7d: safeNumber(row.forecast_7d),
        forecast_30d: safeNumber(row.forecast_30d),
        trend_percent: safeNumber(row.trend_percent),
        confidence: safeNumber(row.confidence),
        model_name: 'weighted_behavioral_v1',
        features: JSON.stringify({
          event_count: row.event_count,
          search_count: row.search_count,
          product_views: row.product_views,
          requirement_submits: row.requirement_submits,
          lead_count: row.lead_count,
          recent_weighted: Math.round(row.recentWeighted || 0),
          previous_weighted: Math.round(row.previousWeighted || 0),
        }),
        computed_at: computedAt,
      })),
      format: 'JSONEachRow',
    });
  }

  return {
    enabled: true,
    database: databaseName(),
    events_inserted: eventResult.inserted || 0,
    buckets_inserted: bucketRows.length,
    scores_inserted: scoreRows.length,
  };
}

export async function readClickHouseBehavioralDashboard({ days = 30, limit = 50 } = {}) {
  if (!isClickHouseConfigured()) return null;

  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 10), 100);
  const forecastLimit = Math.min(safeLimit, 30);
  const since = toClickHouseDateTime(new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000));

  const rows = await queryRows(`
    SELECT *
      FROM ${tablePath('behavioral_demand_scores')} FINAL
     WHERE window_days = ${safeDays}
     ORDER BY demand_score DESC, trend_percent DESC, unique_visitors DESC
     LIMIT ${safeLimit}
  `);

  const forecasts = await queryRows(`
    SELECT *
      FROM ${tablePath('behavioral_forecasts')} FINAL
     WHERE window_days = ${safeDays}
     ORDER BY forecast_30d DESC, trend_percent DESC
     LIMIT ${forecastLimit}
  `);

  const eventSummary = await queryRows(`
    SELECT event_type, countDistinct(event_id) AS total
      FROM ${tablePath('behavioral_events')} FINAL
     WHERE created_at >= toDateTime('${since}')
     GROUP BY event_type
  `);

  return {
    source: 'clickhouse',
    rows,
    forecasts,
    eventSummary,
    warehouse: {
      clickhouse_enabled: true,
      kafka_enabled: isKafkaConfigured(),
      database: databaseName(),
    },
  };
}
