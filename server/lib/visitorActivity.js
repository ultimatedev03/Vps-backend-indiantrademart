import { db } from './dbClient.js';

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

const countEvents = async (startIso, endIso, eventType = '') => {
  let query = db
    .from('website_visitor_events')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', startIso)
    .lte('created_at', endIso);

  if (eventType) query = query.eq('event_type', eventType);

  const { count, error } = await query;
  if (error && isMissingWebsiteVisitorEventsTable(error)) return 0;
  if (error) throw new Error(error.message || 'Failed to count website visitor activity');
  return safeNum(count);
};

const getRecentEvents = async (limit, includeTechnical = false) => {
  const { data, error } = await db
    .from('website_visitor_events')
    .select('*')
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

const getRecentUniqueVisitors = async (startIso, endIso) => {
  const { data, error } = await db
    .from('website_visitor_events')
    .select('visitor_id, visitor_session_id, created_at')
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .order('created_at', { ascending: false })
    .limit(2000);

  if (error && isMissingWebsiteVisitorEventsTable(error)) return 0;
  if (error) throw new Error(error.message || 'Failed to count unique visitors');

  const keys = new Set();
  (data || []).forEach((row) => {
    const key = String(row?.visitor_id || row?.visitor_session_id || '').trim();
    if (key) keys.add(key);
  });
  return keys.size;
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

  const [
    totalEvents,
    pageViews,
    searches,
    productViews,
    vendorViews,
    uniqueVisitors,
    events,
  ] = await Promise.all([
    countEvents(startIso, endIso),
    countEvents(startIso, endIso, 'PAGE_VIEW'),
    countEvents(startIso, endIso, 'SEARCH'),
    countEvents(startIso, endIso, 'PRODUCT_VIEW'),
    countEvents(startIso, endIso, 'VENDOR_VIEW'),
    getRecentUniqueVisitors(startIso, endIso),
    getRecentEvents(limit, includeTechnical),
  ]);

  return {
    stats: {
      days,
      total_events: totalEvents,
      page_views: pageViews,
      searches,
      product_views: productViews,
      vendor_views: vendorViews,
      unique_visitors: uniqueVisitors,
    },
    events,
  };
}
