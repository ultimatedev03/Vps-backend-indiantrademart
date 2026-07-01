import express from 'express';
import { randomUUID } from 'crypto';
import { db } from '../lib/dbClient.js';
import { logger } from '../utils/logger.js';
import { publishBehavioralEvent } from '../lib/kafkaAnalytics.js';

const router = express.Router();

const ALLOWED_EVENT_TYPES = new Set([
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

const INTERNAL_PATH_PREFIXES = [
  '/admin',
  '/employee',
  '/finance-portal',
  '/hr',
  '/management',
  '/migration-tools',
  '/superadmin',
  '/vendor',
  '/buyer',
];

const asText = (value = '', max = 500) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : '';
};

const normalizeEventType = (value = '') => {
  const normalized = asText(value, 64).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return ALLOWED_EVENT_TYPES.has(normalized) ? normalized : 'PAGE_VIEW';
};

const safeIp = (req) => {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return asText(forwarded || req.ip || req.socket?.remoteAddress || '', 64);
};

const tryParseUrl = (value = '') => {
  const raw = asText(value, 2000);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    try {
      return new URL(raw, 'https://indiantrademart.com');
    } catch {
      return null;
    }
  }
};

const normalizePath = (body = {}) => {
  const explicitPath = asText(body.page_path || body.path || '', 512);
  if (explicitPath) return explicitPath.startsWith('/') ? explicitPath : `/${explicitPath}`;
  const parsed = tryParseUrl(body.page_url);
  return parsed?.pathname ? parsed.pathname.slice(0, 512) : '/';
};

const isInternalPath = (path = '') => {
  const normalized = String(path || '').trim().toLowerCase();
  return INTERNAL_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
};

const getUtm = (body = {}, key = '') => {
  const fromBody = asText(body[key], 191);
  if (fromBody) return fromBody;
  const parsed = tryParseUrl(body.page_url);
  return parsed ? asText(parsed.searchParams.get(key) || '', 191) || null : null;
};

const normalizeMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const out = {};
  Object.entries(value).slice(0, 30).forEach(([key, item]) => {
    const safeKey = asText(key, 64).replace(/[^A-Za-z0-9_.:-]/g, '_');
    if (!safeKey) return;
    if (item === null || item === undefined) {
      out[safeKey] = null;
      return;
    }
    if (['string', 'number', 'boolean'].includes(typeof item)) {
      out[safeKey] = typeof item === 'string' ? asText(item, 500) : item;
    }
  });

  return Object.keys(out).length ? out : null;
};

router.post('/events', async (req, res) => {
  try {
    const body = req.body || {};
    const visitorId = asText(body.visitor_id || body.visitorId || '', 191);
    const visitorSessionId = asText(body.visitor_session_id || body.visitorSessionId || '', 191);

    if (!visitorId && !visitorSessionId) {
      return res.status(400).json({ success: false, error: 'visitor_id or visitor_session_id is required' });
    }

    const pagePath = normalizePath(body);
    if (isInternalPath(pagePath)) {
      return res.json({ success: true, ignored: true });
    }

    const event = {
      id: randomUUID(),
      visitor_id: visitorId || null,
      visitor_session_id: visitorSessionId || null,
      visitor_name: asText(body.visitor_name || body.visitorName || '', 500) || null,
      visitor_email: asText(body.visitor_email || body.visitorEmail || '', 191).toLowerCase() || null,
      visitor_phone: asText(body.visitor_phone || body.visitorPhone || '', 64) || null,
      visitor_company: asText(body.visitor_company || body.visitorCompany || '', 500) || null,
      visitor_contact_source: asText(body.visitor_contact_source || body.visitorContactSource || '', 191) || null,
      event_type: normalizeEventType(body.event_type || body.eventType),
      page_url: asText(body.page_url || body.url || '', 2000) || null,
      page_path: pagePath || '/',
      page_title: asText(body.page_title || body.title || '', 500) || null,
      referrer: asText(body.referrer || '', 2000) || null,
      utm_source: getUtm(body, 'utm_source'),
      utm_medium: getUtm(body, 'utm_medium'),
      utm_campaign: getUtm(body, 'utm_campaign'),
      utm_term: getUtm(body, 'utm_term'),
      utm_content: getUtm(body, 'utm_content'),
      search_query: asText(body.search_query || body.searchQuery || '', 500) || null,
      entity_type: asText(body.entity_type || body.entityType || '', 64).toUpperCase() || null,
      entity_id: asText(body.entity_id || body.entityId || '', 191) || null,
      entity_name: asText(body.entity_name || body.entityName || '', 500) || null,
      category: asText(body.category || '', 500) || null,
      city: asText(body.city || '', 191) || null,
      state: asText(body.state || '', 191) || null,
      ip_address: safeIp(req) || null,
      user_agent: asText(body.user_agent || req.headers?.['user-agent'] || '', 1000) || null,
      metadata: normalizeMetadata(body.metadata),
      created_at: new Date().toISOString(),
    };

    const { error } = await db.from('website_visitor_events').insert([event]);
    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to save visitor event' });
    }

    try {
      await db.from('behavioral_event_queue').insert([
        {
          id: randomUUID(),
          event_id: event.id,
          visitor_id: event.visitor_id || event.visitor_session_id || null,
          event_type: event.event_type,
          payload: event,
          status: 'PENDING',
          attempts: 0,
          created_at: event.created_at,
        },
      ]);
    } catch (queueError) {
      logger.warn('[VisitorTracking] Behavioral queue insert skipped:', queueError?.message || queueError);
    }

    publishBehavioralEvent(event).catch((kafkaError) => {
      logger.warn('[VisitorTracking] Kafka publish skipped:', kafkaError?.message || kafkaError);
    });

    return res.status(201).json({ success: true, event_id: event.id });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to save visitor event' });
  }
});

export default router;
