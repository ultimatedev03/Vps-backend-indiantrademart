import { createHash, randomUUID } from 'crypto';
import { cacheGetJson, cacheSetJson, isRedisConfigured } from './redisCache.js';
import { mysqlQuery, withMysqlConnection } from './mysqlPool.js';

const CACHE_KEY_PREFIX = 'bcia:dashboard';
const CACHE_TTL_SECONDS = 10 * 60;
const EVENT_LIMIT = 25000;
const SCORE_LIMIT = 250;

const TRACKED_EVENT_TYPES = new Set([
  'PAGE_VIEW',
  'SEARCH',
  'PRODUCT_VIEW',
  'VENDOR_VIEW',
  'CATEGORY_VIEW',
  'CITY_VIEW',
  'REQUIREMENT_OPEN',
  'REQUIREMENT_SUBMIT',
  'PLAN_VIEW',
]);

const EVENT_WEIGHTS = {
  PAGE_VIEW: 1,
  SEARCH: 9,
  PRODUCT_VIEW: 7,
  VENDOR_VIEW: 4,
  CATEGORY_VIEW: 3,
  CITY_VIEW: 2,
  REQUIREMENT_OPEN: 14,
  REQUIREMENT_SUBMIT: 35,
  PLAN_VIEW: 3,
};

const safeText = (value = '', max = 500) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : '';
};

const normalizeKey = (value = '') =>
  safeText(value, 191)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 191) || 'unknown';

const toDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const mysqlDateTime = (date) =>
  toDate(date)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

const startOfHour = (value) => {
  const date = toDate(value);
  date.setUTCMinutes(0, 0, 0);
  return date;
};

const daysAgo = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.max(1, Number(days) || 1));
  return date;
};

const clampDays = (value, fallback = 30) => {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(days), 1), 90);
};

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const getDemandLabel = (row = {}) =>
  safeText(row.search_query || row.product_interest || row.product_name || row.category || row.entity_name || row.page_title, 500);

const getDemandKey = (label, state = '', city = '') => {
  const fullKey = [normalizeKey(label), normalizeKey(state || 'all-india'), normalizeKey(city || 'all-cities')].join('|');
  if (fullKey.length <= 191) return fullKey;

  const hash = createHash('sha1').update(fullKey).digest('hex').slice(0, 12);
  const shortKey = [
    normalizeKey(label).slice(0, 108),
    normalizeKey(state || 'all-india').slice(0, 28),
    normalizeKey(city || 'all-cities').slice(0, 28),
    hash,
  ].join('|');

  return shortKey.slice(0, 191);
};

const makeBucketKey = (row, label) =>
  [
    mysqlDateTime(startOfHour(row.created_at)),
    safeText(row.event_type, 64).toUpperCase(),
    getDemandKey(label, row.state, row.city),
  ].join('|');

const buildDemandStage = (score) => {
  if (score >= 250) return 'HOT';
  if (score >= 120) return 'RISING';
  if (score >= 45) return 'WATCH';
  return 'LOW';
};

const recommendedActionForStage = (stage, row = {}) => {
  if (stage === 'HOT') {
    return row.city
      ? 'Add verified vendors and premium slots in this city immediately.'
      : 'Create category landing pages and assign sales follow-up for high-intent demand.';
  }
  if (stage === 'RISING') return 'Promote matching vendors, refresh SEO pages, and monitor weekly conversion.';
  if (stage === 'WATCH') return 'Keep tracking. Add content and products if repeated searches continue.';
  return 'Low demand right now. Keep as long-tail SEO coverage.';
};

async function loadRawSignals(days) {
  const start = mysqlDateTime(daysAgo(days));
  const events = await mysqlQuery(
    `SELECT id, visitor_id, visitor_session_id, event_type, page_title, search_query, entity_type,
            entity_id, entity_name, category, city, state, metadata, created_at
       FROM website_visitor_events
      WHERE created_at >= ?
        AND event_type IN (${Array.from(TRACKED_EVENT_TYPES).map(() => '?').join(',')})
      ORDER BY created_at DESC
      LIMIT ${EVENT_LIMIT}`,
    [start, ...Array.from(TRACKED_EVENT_TYPES)]
  );

  const leads = await mysqlQuery(
    `SELECT id, product_name, product_interest, category, city, state, created_at
       FROM leads
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT 5000`,
    [start]
  );

  return { events, leads };
}

async function upsertHourlyAggregates(connection, events = []) {
  const buckets = new Map();

  for (const event of events) {
    const label = getDemandLabel(event);
    if (!label) continue;

    const key = makeBucketKey(event, label);
    const visitorKey = safeText(event.visitor_id || event.visitor_session_id, 191);
    const current = buckets.get(key) || {
      id: randomUUID(),
      bucket_start: mysqlDateTime(startOfHour(event.created_at)),
      event_type: safeText(event.event_type, 64).toUpperCase(),
      demand_key: getDemandKey(label, event.state, event.city),
      display_label: label,
      category: safeText(event.category || event.entity_name, 500),
      state: safeText(event.state, 191),
      city: safeText(event.city, 191),
      entity_type: safeText(event.entity_type, 64).toUpperCase(),
      entity_id: safeText(event.entity_id, 191),
      event_count: 0,
      uniqueVisitors: new Set(),
    };

    current.event_count += 1;
    if (visitorKey) current.uniqueVisitors.add(visitorKey);
    buckets.set(key, current);
  }

  for (const bucket of buckets.values()) {
    // eslint-disable-next-line no-await-in-loop
    await connection.execute(
      `INSERT INTO behavioral_hourly_aggregates
        (id, bucket_start, event_type, demand_key, display_label, category, state, city,
         entity_type, entity_id, event_count, unique_visitors, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         display_label = VALUES(display_label),
         category = VALUES(category),
         entity_type = VALUES(entity_type),
         entity_id = VALUES(entity_id),
         event_count = VALUES(event_count),
         unique_visitors = VALUES(unique_visitors),
         computed_at = NOW()`,
      [
        bucket.id,
        bucket.bucket_start,
        bucket.event_type,
        bucket.demand_key,
        bucket.display_label,
        bucket.category,
        bucket.state,
        bucket.city,
        bucket.entity_type,
        bucket.entity_id,
        bucket.event_count,
        bucket.uniqueVisitors.size,
      ]
    );
  }

  return buckets.size;
}

function scoreSignals(events = [], leads = [], days = 30) {
  const groups = new Map();
  const now = Date.now();
  const recentMs = 7 * 24 * 60 * 60 * 1000;
  const previousMs = 14 * 24 * 60 * 60 * 1000;

  const ensureGroup = (label, state = '', city = '') => {
    const demandKey = getDemandKey(label, state, city);
    if (!groups.has(demandKey)) {
      groups.set(demandKey, {
        id: randomUUID(),
        demand_key: demandKey,
        display_label: label,
        category: '',
        state: safeText(state, 191),
        city: safeText(city, 191),
        window_days: days,
        demand_score: 0,
        intent_score: 0,
        event_count: 0,
        search_count: 0,
        product_views: 0,
        vendor_views: 0,
        requirement_opens: 0,
        requirement_submits: 0,
        lead_count: 0,
        uniqueVisitors: new Set(),
        recentWeighted: 0,
        previousWeighted: 0,
        entities: new Map(),
      });
    }
    return groups.get(demandKey);
  };

  for (const event of events) {
    const label = getDemandLabel(event);
    if (!label) continue;

    const type = safeText(event.event_type, 64).toUpperCase();
    const weight = EVENT_WEIGHTS[type] || 1;
    const group = ensureGroup(label, event.state, event.city);
    const visitorKey = safeText(event.visitor_id || event.visitor_session_id, 191);
    const eventAge = now - toDate(event.created_at).getTime();

    group.category = group.category || safeText(event.category || event.entity_name, 500);
    group.event_count += 1;
    group.demand_score += weight;
    group.intent_score += weight * (['SEARCH', 'REQUIREMENT_OPEN', 'REQUIREMENT_SUBMIT'].includes(type) ? 2 : 1);
    if (visitorKey) group.uniqueVisitors.add(visitorKey);
    if (eventAge <= recentMs) group.recentWeighted += weight;
    else if (eventAge <= previousMs) group.previousWeighted += weight;

    if (type === 'SEARCH') group.search_count += 1;
    if (type === 'PRODUCT_VIEW') group.product_views += 1;
    if (type === 'VENDOR_VIEW') group.vendor_views += 1;
    if (type === 'REQUIREMENT_OPEN') group.requirement_opens += 1;
    if (type === 'REQUIREMENT_SUBMIT') group.requirement_submits += 1;

    const entityKey = safeText(event.entity_id || event.entity_name, 191);
    if (entityKey) {
      const entity = group.entities.get(entityKey) || {
        entity_id: safeText(event.entity_id, 191),
        entity_type: safeText(event.entity_type, 64),
        entity_name: safeText(event.entity_name || label, 500),
        events: 0,
      };
      entity.events += 1;
      group.entities.set(entityKey, entity);
    }
  }

  for (const lead of leads) {
    const label = getDemandLabel(lead);
    if (!label) continue;

    const group = ensureGroup(label, lead.state, lead.city);
    const leadWeight = 32;
    const age = now - toDate(lead.created_at).getTime();
    group.category = group.category || safeText(lead.category, 500);
    group.lead_count += 1;
    group.demand_score += leadWeight;
    group.intent_score += leadWeight * 2;
    if (age <= recentMs) group.recentWeighted += leadWeight;
    else if (age <= previousMs) group.previousWeighted += leadWeight;
  }

  return Array.from(groups.values())
    .map((group) => {
      const uniqueVisitors = group.uniqueVisitors.size;
      const demandScore = Math.round(group.demand_score + uniqueVisitors * 2 + group.lead_count * 12);
      const trendPercent = group.previousWeighted > 0
        ? ((group.recentWeighted - group.previousWeighted) / group.previousWeighted) * 100
        : group.recentWeighted > 0
          ? 100
          : 0;
      const stage = buildDemandStage(demandScore);
      const confidence = Math.min(99, Math.round(20 + group.event_count * 2 + uniqueVisitors * 3 + group.lead_count * 8));
      const recentDaily = group.recentWeighted / 7;
      const trendMultiplier = Math.max(0.6, Math.min(1.8, 1 + trendPercent / 200));
      const forecast7d = Math.round(recentDaily * 7 * trendMultiplier + group.lead_count * 4);
      const forecast30d = Math.round(recentDaily * 30 * trendMultiplier + group.lead_count * 12);

      return {
        ...group,
        unique_visitors: uniqueVisitors,
        demand_score: demandScore,
        intent_score: Math.round(group.intent_score),
        trend_percent: Math.round(trendPercent * 10) / 10,
        confidence,
        demand_stage: stage,
        recommended_action: recommendedActionForStage(stage, group),
        top_entities: Array.from(group.entities.values())
          .sort((a, b) => b.events - a.events)
          .slice(0, 5),
        forecast_7d: forecast7d,
        forecast_30d: forecast30d,
      };
    })
    .sort((a, b) => b.demand_score - a.demand_score)
    .slice(0, SCORE_LIMIT);
}

async function upsertScores(connection, scored = []) {
  for (const row of scored) {
    // eslint-disable-next-line no-await-in-loop
    await connection.execute(
      `INSERT INTO behavioral_demand_scores
        (id, demand_key, display_label, category, state, city, window_days, demand_score,
         intent_score, event_count, search_count, product_views, vendor_views, requirement_opens,
         requirement_submits, lead_count, unique_visitors, trend_percent, confidence,
         demand_stage, recommended_action, top_entities, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         display_label = VALUES(display_label),
         category = VALUES(category),
         demand_score = VALUES(demand_score),
         intent_score = VALUES(intent_score),
         event_count = VALUES(event_count),
         search_count = VALUES(search_count),
         product_views = VALUES(product_views),
         vendor_views = VALUES(vendor_views),
         requirement_opens = VALUES(requirement_opens),
         requirement_submits = VALUES(requirement_submits),
         lead_count = VALUES(lead_count),
         unique_visitors = VALUES(unique_visitors),
         trend_percent = VALUES(trend_percent),
         confidence = VALUES(confidence),
         demand_stage = VALUES(demand_stage),
         recommended_action = VALUES(recommended_action),
         top_entities = VALUES(top_entities),
         computed_at = NOW()`,
      [
        row.id,
        row.demand_key,
        row.display_label,
        row.category,
        row.state,
        row.city,
        row.window_days,
        row.demand_score,
        row.intent_score,
        row.event_count,
        row.search_count,
        row.product_views,
        row.vendor_views,
        row.requirement_opens,
        row.requirement_submits,
        row.lead_count,
        row.unique_visitors,
        row.trend_percent,
        row.confidence,
        row.demand_stage,
        row.recommended_action,
        JSON.stringify(row.top_entities || []),
      ]
    );

    // eslint-disable-next-line no-await-in-loop
    await connection.execute(
      `INSERT INTO behavioral_forecasts
        (id, demand_key, display_label, state, city, window_days, forecast_7d, forecast_30d,
         trend_percent, confidence, model_name, features, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'weighted_behavioral_v1', ?, NOW())
       ON DUPLICATE KEY UPDATE
         display_label = VALUES(display_label),
         forecast_7d = VALUES(forecast_7d),
         forecast_30d = VALUES(forecast_30d),
         trend_percent = VALUES(trend_percent),
         confidence = VALUES(confidence),
         model_name = VALUES(model_name),
         features = VALUES(features),
         computed_at = NOW()`,
      [
        randomUUID(),
        row.demand_key,
        row.display_label,
        row.state,
        row.city,
        row.window_days,
        row.forecast_7d,
        row.forecast_30d,
        row.trend_percent,
        row.confidence,
        JSON.stringify({
          event_count: row.event_count,
          search_count: row.search_count,
          product_views: row.product_views,
          requirement_submits: row.requirement_submits,
          lead_count: row.lead_count,
          recent_weighted: Math.round(row.recentWeighted || 0),
          previous_weighted: Math.round(row.previousWeighted || 0),
        }),
      ]
    );
  }
}

async function markQueueProcessed(days) {
  const start = mysqlDateTime(daysAgo(days));
  await mysqlQuery(
    `UPDATE behavioral_event_queue q
       JOIN website_visitor_events e ON e.id = q.event_id
        SET q.status = 'PROCESSED',
            q.processed_at = NOW(),
            q.attempts = q.attempts + 1
      WHERE q.status = 'PENDING'
        AND e.created_at >= ?`,
    [start]
  );
}

async function getQueueStats() {
  const rows = await mysqlQuery(
    `SELECT status, COUNT(*) AS total
       FROM behavioral_event_queue
      GROUP BY status`
  ).catch(() => []);

  return rows.reduce((acc, row) => {
    acc[String(row.status || 'UNKNOWN').toLowerCase()] = safeNumber(row.total);
    return acc;
  }, { pending: 0, processed: 0, failed: 0 });
}

export async function runBehavioralCommerceIntelligence(options = {}) {
  const days = clampDays(options.days, 30);
  const { events, leads } = await loadRawSignals(days);
  const scored = scoreSignals(events, leads, days);

  let aggregateCount = 0;
  await withMysqlConnection(async (connection) => {
    await connection.beginTransaction();
    try {
      aggregateCount = await upsertHourlyAggregates(connection, events);
      await upsertScores(connection, scored);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  });

  await markQueueProcessed(days).catch(() => {});

  return {
    days,
    events_processed: events.length,
    leads_processed: leads.length,
    hourly_buckets: aggregateCount,
    scores_computed: scored.length,
    computed_at: new Date().toISOString(),
  };
}

async function loadIntelligenceDashboard(days, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 10), 100);
  const forecastLimit = Math.min(safeLimit, 30);

  const rows = await mysqlQuery(
    `SELECT *
       FROM behavioral_demand_scores
      WHERE window_days = ?
      ORDER BY demand_score DESC, trend_percent DESC, unique_visitors DESC
      LIMIT ${safeLimit}`,
    [days]
  );

  const forecasts = await mysqlQuery(
    `SELECT *
       FROM behavioral_forecasts
      WHERE window_days = ?
      ORDER BY forecast_30d DESC, trend_percent DESC
      LIMIT ${forecastLimit}`,
    [days]
  );

  const eventSummary = await mysqlQuery(
    `SELECT event_type, COUNT(*) AS total
       FROM website_visitor_events
      WHERE created_at >= ?
      GROUP BY event_type`,
    [mysqlDateTime(daysAgo(days))]
  ).catch(() => []);

  const latest = rows[0]?.computed_at || forecasts[0]?.computed_at || null;
  const queue = await getQueueStats();

  const normalizedRows = rows.map((row) => ({
    ...row,
    top_entities: parseJson(row.top_entities, []),
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
  }));

  const normalizedForecasts = forecasts.map((row) => ({
    ...row,
    features: parseJson(row.features, {}),
    forecast_7d: safeNumber(row.forecast_7d),
    forecast_30d: safeNumber(row.forecast_30d),
    trend_percent: safeNumber(row.trend_percent),
    confidence: safeNumber(row.confidence),
  }));

  const summaryByType = eventSummary.reduce((acc, row) => {
    acc[String(row.event_type || 'UNKNOWN').toLowerCase()] = safeNumber(row.total);
    return acc;
  }, {});

  const hotCount = normalizedRows.filter((row) => row.demand_stage === 'HOT').length;
  const risingCount = normalizedRows.filter((row) => row.demand_stage === 'RISING').length;
  const topScore = normalizedRows[0]?.demand_score || 0;
  const avgForecast30 = normalizedForecasts.length
    ? Math.round(normalizedForecasts.reduce((sum, row) => sum + row.forecast_30d, 0) / normalizedForecasts.length)
    : 0;

  return {
    algorithm: {
      name: 'Behavioral Commerce Intelligence Algorithm',
      modules: [
        'Visitor Identity & Consent Tracking',
        'Event-Based Ecommerce Analytics',
        'Product/Category Demand Scoring',
        'Sales Forecasting & Vendor Intelligence',
      ],
      stack: {
        frontend: 'JavaScript SDK',
        backend: 'Node.js',
        database: 'MySQL operational DB',
        queue: 'MySQL queue table, Redis-ready',
        dashboard: 'React superadmin dashboard',
        ml: 'Weighted model v1, LightGBM/XGBoost-ready features',
      },
    },
    summary: {
      days,
      total_events: Object.values(summaryByType).reduce((sum, value) => sum + value, 0),
      searches: summaryByType.search || 0,
      product_views: summaryByType.product_view || 0,
      vendor_views: summaryByType.vendor_view || 0,
      requirement_submits: summaryByType.requirement_submit || 0,
      hot_demands: hotCount,
      rising_demands: risingCount,
      top_score: topScore,
      avg_forecast_30d: avgForecast30,
      latest_computed_at: latest,
      queue,
    },
    demand_scores: normalizedRows,
    forecasts: normalizedForecasts,
  };
}

export async function getBehavioralCommerceIntelligence(options = {}) {
  const days = clampDays(options.days, 30);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 10), 100);
  const refresh = options.refresh === true || String(options.refresh || '').toLowerCase() === 'true';
  const cacheKey = `${CACHE_KEY_PREFIX}:${days}:${limit}`;

  if (!refresh && isRedisConfigured()) {
    try {
      const cached = await cacheGetJson(cacheKey);
      if (cached) return cached;
    } catch {
      // Continue without cache.
    }
  }

  const latestRows = await mysqlQuery(
    `SELECT computed_at
       FROM behavioral_demand_scores
      WHERE window_days = ?
      ORDER BY computed_at DESC
      LIMIT 1`,
    [days]
  ).catch(() => []);

  const latestAt = latestRows[0]?.computed_at ? toDate(latestRows[0].computed_at).getTime() : 0;
  const stale = !latestAt || Date.now() - latestAt > 60 * 60 * 1000;
  let job = null;

  if (refresh || stale) {
    job = await runBehavioralCommerceIntelligence({ days });
  }

  const dashboard = await loadIntelligenceDashboard(days, limit);
  const payload = { ...dashboard, job };

  if (isRedisConfigured()) {
    await cacheSetJson(cacheKey, payload, CACHE_TTL_SECONDS).catch(() => {});
  }

  return payload;
}
