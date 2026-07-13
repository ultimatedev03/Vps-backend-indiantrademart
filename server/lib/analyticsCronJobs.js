import cron from 'node-cron';
import { runBehavioralCommerceIntelligence } from './behavioralCommerceIntelligence.js';
import { mysqlQuery, withMysqlConnection } from './mysqlPool.js';
import { logger } from '../utils/logger.js';

const LOCK_NAME = 'itm_behavioral_analytics_cron';
const TIMEZONE = process.env.ANALYTICS_CRON_TIMEZONE || 'Asia/Kolkata';

const envInt = (name, fallback, min, max) => {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const isEnabled = () => {
  const configured = String(process.env.ANALYTICS_CRON_ENABLED || '').trim().toLowerCase();
  if (configured) return ['1', 'true', 'yes', 'on'].includes(configured);
  return process.env.NODE_ENV === 'production';
};

async function withAdvisoryLock(task) {
  return withMysqlConnection(async (connection) => {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [LOCK_NAME]);
    if (Number(rows?.[0]?.acquired || 0) !== 1) return { skipped: true, reason: 'lock_busy' };

    try {
      return await task();
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    }
  });
}

async function deleteInChunks(sql, params, chunkSize) {
  let deleted = 0;
  let iterations = 0;
  const maxIterations = 200;

  while (iterations < maxIterations) {
    const result = await mysqlQuery(`${sql} LIMIT ${chunkSize}`, params);
    const affected = Number(result?.affectedRows || 0);
    deleted += affected;
    iterations += 1;
    if (affected < chunkSize) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return deleted;
}

export async function runAnalyticsRetention() {
  const rawDays = envInt('ANALYTICS_RAW_RETENTION_DAYS', 180, 30, 730);
  const queueDays = envInt('ANALYTICS_QUEUE_RETENTION_DAYS', 30, 7, 365);
  const aggregateDays = envInt('ANALYTICS_AGGREGATE_RETENTION_DAYS', 400, 90, 1825);
  const chunkSize = envInt('ANALYTICS_RETENTION_CHUNK_SIZE', 5000, 100, 20000);

  const queueDeleted = await deleteInChunks(
    `DELETE FROM behavioral_event_queue
      WHERE status IN ('PROCESSED', 'FAILED')
        AND COALESCE(processed_at, created_at) < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [queueDays],
    chunkSize
  );
  const rawDeleted = await deleteInChunks(
    `DELETE FROM website_visitor_events
      WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [rawDays],
    chunkSize
  );
  const aggregatesDeleted = await deleteInChunks(
    `DELETE FROM behavioral_hourly_aggregates
      WHERE bucket_start < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [aggregateDays],
    chunkSize
  );

  return { queueDeleted, rawDeleted, aggregatesDeleted, rawDays, queueDays, aggregateDays };
}

export async function runScheduledBehavioralAnalytics() {
  return withAdvisoryLock(async () => {
    const result = await runBehavioralCommerceIntelligence({ days: 30 });
    logger.log('[AnalyticsCron] Behavioral intelligence refreshed', result);
    return result;
  });
}

export async function runScheduledAnalyticsRetention() {
  return withAdvisoryLock(async () => {
    const result = await runAnalyticsRetention();
    logger.log('[AnalyticsCron] Retention completed', result);
    return result;
  });
}

export function initializeAnalyticsCronJobs() {
  if (!isEnabled()) {
    logger.log('[AnalyticsCron] Disabled outside production or by configuration');
    return [];
  }

  const analyticsJob = cron.schedule(
    process.env.ANALYTICS_REFRESH_CRON || '*/30 * * * *',
    () => runScheduledBehavioralAnalytics().catch((error) => {
      logger.error('[AnalyticsCron] Refresh failed:', error);
    }),
    { timezone: TIMEZONE }
  );
  const retentionJob = cron.schedule(
    process.env.ANALYTICS_RETENTION_CRON || '20 3 * * *',
    () => runScheduledAnalyticsRetention().catch((error) => {
      logger.error('[AnalyticsCron] Retention failed:', error);
    }),
    { timezone: TIMEZONE }
  );

  logger.log(`[AnalyticsCron] Ready: refresh every 30 minutes; retention daily (${TIMEZONE})`);
  return [analyticsJob, retentionJob];
}
