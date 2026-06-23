import express from 'express';
import { db } from '../lib/dbClient.js';

const router = express.Router();

const MAINTENANCE_KEY = 'maintenance_mode';

const defaultPublicConfig = {
  maintenance_mode: false,
  maintenance_message: '',
  allow_vendor_registration: true,
  public_notice_enabled: false,
  public_notice_message: '',
  public_notice_variant: 'info',
};

const booleanValue = (value, fallback = false) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const token = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(token)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
};

const toPublicConfig = (row = null) => ({
  maintenance_mode: booleanValue(row?.maintenance_mode, false),
  maintenance_message: row?.maintenance_message || '',
  allow_vendor_registration: booleanValue(row?.allow_vendor_registration, true),
  public_notice_enabled: booleanValue(row?.public_notice_enabled, false),
  public_notice_message: row?.public_notice_message || '',
  public_notice_variant: row?.public_notice_variant || 'info',
});

const normalizeRoute = (value = '') => {
  const withoutQuery = String(value || '').split('?')[0].split('#')[0].trim();
  if (!withoutQuery) return '';
  const withSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : '/';
};

const pageControlMatches = (requestedRoute, controlRoute) => {
  const requested = normalizeRoute(requestedRoute);
  const control = normalizeRoute(controlRoute);
  if (!requested || !control) return false;
  if (control === '/') return requested === '/';
  return requested === control || requested.startsWith(`${control}/`);
};

router.get('/system-config', async (_req, res) => {
  try {
    const { data, error } = await db
      .from('system_config')
      .select('maintenance_mode, maintenance_message, allow_vendor_registration, public_notice_enabled, public_notice_message, public_notice_variant')
      .eq('config_key', MAINTENANCE_KEY)
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      config: data ? toPublicConfig(data) : defaultPublicConfig,
    });
  } catch (error) {
    console.error('[publicConfig] system-config fetch failed:', error);
    res.status(200).json({
      success: true,
      degraded: true,
      config: defaultPublicConfig,
    });
  }
});

router.get('/page-status', async (req, res) => {
  try {
    const route = String(req.query.route || '').trim();
    let query = db
      .from('page_status')
      .select('page_route, is_blanked, error_message, updated_at')
      .order('updated_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    let statuses = Array.isArray(data)
      ? data.map((row) => ({
          ...row,
          is_blanked: booleanValue(row?.is_blanked, false),
        }))
      : [];

    if (route) {
      statuses = statuses
        .filter((row) => pageControlMatches(route, row?.page_route))
        .sort((a, b) => normalizeRoute(b?.page_route).length - normalizeRoute(a?.page_route).length)
        .slice(0, 1);
    }

    res.json({
      success: true,
      statuses,
    });
  } catch (error) {
    console.error('[publicConfig] page-status fetch failed:', error);
    res.status(200).json({
      success: true,
      degraded: true,
      statuses: [],
    });
  }
});

export default router;
