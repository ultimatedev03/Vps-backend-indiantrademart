import { db } from './dbClient.js';
import { mysqlQuery } from './mysqlPool.js';

const safeNum = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const clampLimit = (value, fallback = 20, max = 100) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.trunc(numeric), max);
};

const clampDays = (value, fallback = 7, max = 90) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.trunc(numeric), max);
};

const isMissingWebsiteVisitorEventsTable = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('website_visitor_events') &&
    (message.includes("doesn't exist") || message.includes('does not exist') || message.includes('unknown table'))
  );
};

const getRecentEvents = async (startIso, endIso, limit, includeTechnical = false) => {
  const { data, error } = await db
    .from('website_visitor_events')
    .select('*')
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error && isMissingWebsiteVisitorEventsTable(error)) return [];
  if (error) throw new Error(error.message || 'Failed to fetch website visitor activity');

  return (data || []).map((row) => {
    if (includeTechnical) return row;
    const { ip_address: _ipAddress, user_agent: _userAgent, ...safeRow } = row;
    return safeRow;
  });
};

const getVisitorInsights = async (startIso, endIso) => {
  try {
    const [summaryRows, searchRows, pageRows, eventRows] = await Promise.all([
      mysqlQuery(
        `SELECT COUNT(*) AS total_events,
                SUM(event_type = 'PAGE_VIEW') AS page_views,
                SUM(event_type = 'SEARCH') AS searches,
                SUM(event_type = 'PRODUCT_VIEW') AS product_views,
                SUM(event_type = 'VENDOR_VIEW') AS vendor_views,
                COUNT(DISTINCT COALESCE(NULLIF(visitor_id, ''), NULLIF(visitor_session_id, ''))) AS unique_visitors
           FROM website_visitor_events
          WHERE created_at >= ? AND created_at <= ?`,
        [startIso, endIso]
      ),
      mysqlQuery(
        `SELECT MIN(search_query) AS search_query,
                COUNT(*) AS event_count,
                COUNT(DISTINCT COALESCE(NULLIF(visitor_id, ''), NULLIF(visitor_session_id, ''))) AS unique_visitors,
                MAX(created_at) AS latest_at
           FROM website_visitor_events
          WHERE event_type = 'SEARCH'
            AND created_at >= ? AND created_at <= ?
            AND search_query IS NOT NULL AND TRIM(search_query) <> ''
          GROUP BY LOWER(TRIM(search_query))
          ORDER BY event_count DESC, latest_at DESC
          LIMIT 12`,
        [startIso, endIso]
      ),
      mysqlQuery(
        `SELECT page_path,
                MIN(NULLIF(page_title, '')) AS page_title,
                COUNT(*) AS page_views,
                COUNT(DISTINCT COALESCE(NULLIF(visitor_id, ''), NULLIF(visitor_session_id, ''))) AS unique_visitors,
                MAX(created_at) AS latest_at
           FROM website_visitor_events
          WHERE event_type = 'PAGE_VIEW'
            AND created_at >= ? AND created_at <= ?
            AND page_path IS NOT NULL AND TRIM(page_path) <> ''
          GROUP BY page_path
          ORDER BY page_views DESC, latest_at DESC
          LIMIT 12`,
        [startIso, endIso]
      ),
      mysqlQuery(
        `SELECT event_type, COUNT(*) AS event_count,
                COUNT(DISTINCT COALESCE(NULLIF(visitor_id, ''), NULLIF(visitor_session_id, ''))) AS unique_visitors
           FROM website_visitor_events
          WHERE created_at >= ? AND created_at <= ?
          GROUP BY event_type
          ORDER BY event_count DESC`,
        [startIso, endIso]
      ),
    ]);

    return {
      summary: {
        total_events: safeNum(summaryRows?.[0]?.total_events),
        page_views: safeNum(summaryRows?.[0]?.page_views),
        searches: safeNum(summaryRows?.[0]?.searches),
        product_views: safeNum(summaryRows?.[0]?.product_views),
        vendor_views: safeNum(summaryRows?.[0]?.vendor_views),
        unique_visitors: safeNum(summaryRows?.[0]?.unique_visitors),
      },
      topSearches: (searchRows || []).map((row) => ({
        ...row,
        event_count: safeNum(row.event_count),
        unique_visitors: safeNum(row.unique_visitors),
      })),
      topPages: (pageRows || []).map((row) => ({
        ...row,
        page_views: safeNum(row.page_views),
        unique_visitors: safeNum(row.unique_visitors),
      })),
      eventBreakdown: (eventRows || []).map((row) => ({
        ...row,
        event_count: safeNum(row.event_count),
        unique_visitors: safeNum(row.unique_visitors),
      })),
    };
  } catch (error) {
    if (isMissingWebsiteVisitorEventsTable(error)) {
      return { summary: {}, topSearches: [], topPages: [], eventBreakdown: [] };
    }
    throw error;
  }
};

export async function getWebsiteVisitorActivity(options = {}) {
  const days = clampDays(options.days, 7, 90);
  const limit = clampLimit(options.limit, 20, 100);
  const includeTechnical = options.includeTechnical === true;

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const [insights, events] = await Promise.all([
    getVisitorInsights(startIso, endIso),
    getRecentEvents(startIso, endIso, limit, includeTechnical),
  ]);

  return {
    stats: {
      days,
      total_events: insights.summary?.total_events || 0,
      page_views: insights.summary?.page_views || 0,
      searches: insights.summary?.searches || 0,
      product_views: insights.summary?.product_views || 0,
      vendor_views: insights.summary?.vendor_views || 0,
      unique_visitors: insights.summary?.unique_visitors || 0,
    },
    events,
    top_searches: insights.topSearches,
    top_pages: insights.topPages,
    event_breakdown: insights.eventBreakdown,
  };
}
