import { logger } from '../utils/logger.js';
import express from 'express';
import { db } from '../lib/dbClient.js';
import { mysqlQuery } from '../lib/mysqlPool.js';
import { notifyUser } from '../lib/notify.js';
import { writeAuditLog } from '../lib/audit.js';
import {
  clearAuthCookies,
  createCsrfToken,
  getPublicUserByEmail,
  getPublicUserById,
  hashPassword,
  normalizeEmail,
  setPublicUserPassword,
  setAuthCookies,
  signAuthToken,
  upsertPublicUser,
} from '../lib/auth.js';
import {
  loginSuperAdmin,
  requireSuperAdmin,
  requireGodMode,
  changeSuperAdminPassword,
  resolveSuperAdminSessionToken,
} from '../lib/superadminAuth.js';
import { getWebsiteVisitorActivity } from '../lib/visitorActivity.js';
import { getBehavioralCommerceIntelligence } from '../lib/behavioralCommerceIntelligence.js';
import {
  buildSearch360ActorFromSuperadmin,
  createSearch360Escalation,
  searchVendors360,
  updateSearch360CaseStatus,
} from '../lib/search360.js';
import { normalizePlanFeatures } from '../lib/vendorPlanCatalog.js';

const router = express.Router();

// SUPERADMIN (ITM Owner) can only create ADMIN role employees.
// ADMIN creates HR/FINANCE. HR creates SALES/SUPPORT/DATA_ENTRY/MANAGER/VP.
const EMPLOYEE_ALLOWED_ROLES = ['ADMIN'];

const normalizeRole = (role) => String(role || '').trim().toUpperCase();

const nowIso = () => new Date().toISOString();

const compactText = (value) => String(value || '').trim();
const IMPERSONATION_TARGETS = new Set(['VENDOR', 'BUYER']);
const INTERNAL_PUBLIC_ROLES = new Set([
  'ADMIN',
  'HR',
  'FINANCE',
  'DATA_ENTRY',
  'DATAENTRY',
  'SUPPORT',
  'SALES',
  'MANAGER',
  'VP',
  'SUPERADMIN',
  'GODMODE',
]);

const normalizeImpersonationTarget = (value) => {
  const normalized = normalizeRole(value);
  return IMPERSONATION_TARGETS.has(normalized) ? normalized : '';
};

const normalizeBooleanInput = (value, fallback = false) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const token = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(token)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
};

async function findPublicUserByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;

  const { data, error } = await db
    .from('users')
    .select('id, email')
    .eq('email', target)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data || null;
}

async function findAuthUserByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const publicUser = await findPublicUserByEmail(target);
  return publicUser?.id ? { id: publicUser.id, email: publicUser.email } : null;
}

async function ensureEmployeeAuthUser(employee, password) {
  const existingId = employee?.user_id || null;
  if (existingId) {
    const { data, error } = await db
      .from('users')
      .select('id')
      .eq('id', existingId)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (data?.id) {
      return { userId: existingId, created: false };
    }
  }

  const email = normalizeEmail(employee?.email);
  if (!email) {
    const err = new Error('Employee user not found');
    err.statusCode = 404;
    throw err;
  }

  const role = normalizeRole(employee?.role || 'DATA_ENTRY');
  const fullName = String(employee?.full_name || '').trim();
  const phone = String(employee?.phone || '').trim() || null;

  let publicUser = null;
  try {
    publicUser = await findAuthUserByEmail(email);
  } catch (error) {
    logger.warn('[SuperAdmin] Failed to find user by email:', error?.message || error);
  }

  let created = false;
  if (!publicUser) {
    if (!password) {
      const err = new Error('Password required to create employee user');
      err.statusCode = 400;
      throw err;
    }

    const password_hash = await hashPassword(password);
    const inserted = await upsertPublicUser({
      email,
      full_name: fullName,
      role,
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });

    publicUser = { id: inserted.id, email: inserted.email };
    created = true;
  }

  const userId = publicUser.id;

  await db
    .from('employees')
    .update({ user_id: userId })
    .eq('id', employee.id);

  return { userId, created };
}

async function insertSuperadminWithFallback(payload) {
  const first = await db
    .from('superadmin_users')
    .insert([payload])
    .select('id, email, role, is_active, created_at')
    .maybeSingle();

  if (!first?.error || !Object.prototype.hasOwnProperty.call(payload, 'full_name')) {
    return first;
  }

  const text = `${first.error?.message || ''} ${first.error?.details || ''} ${first.error?.hint || ''}`.toLowerCase();
  const missingFullName =
    (text.includes(`'full_name'`) || text.includes(`"full_name"`) || text.includes('column "full_name"')) &&
    (text.includes('schema cache') || text.includes('does not exist'));

  if (!missingFullName) {
    return first;
  }

  const retryPayload = { ...payload };
  delete retryPayload.full_name;

  return db
    .from('superadmin_users')
    .insert([retryPayload])
    .select('id, email, role, is_active, created_at')
    .maybeSingle();
}

function clampLimit(limit, fallback = 200, max = 1000) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const toNonNegativeNumber = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const toPositiveInteger = (value, fallback = 1) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
};

const toNonNegativeInteger = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(0, Math.floor(n));
};

const PLAN_CURRENCIES = new Set([
  'INR',
  'USD',
  'EUR',
  'GBP',
  'AED',
  'SAR',
  'QAR',
  'SGD',
  'AUD',
  'CAD',
  'JPY',
  'CNY',
  'BDT',
  'NPR',
]);

const normalizePlanCurrency = (value) => {
  const code = String(value || '').trim().toUpperCase();
  return PLAN_CURRENCIES.has(code) ? code : 'INR';
};

const PLAN_REGION_CODES = new Set(['EU', 'GCC', 'NORTH_AMERICA', 'APAC', 'MENA']);

const normalizeMarketCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);

const normalizeMarketCodeList = (value, { countryOnly = false } = {}) => {
  const parts = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((part) => part.trim());

  return Array.from(
    new Set(
      parts
        .map(normalizeMarketCode)
        .filter((code) => code && (!countryOnly || (/^[A-Z]{2}$/.test(code) && !PLAN_REGION_CODES.has(code))))
    )
  );
};

const normalizeRegionalPrices = (value) => {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row) => {
      const currency = normalizePlanCurrency(row?.currency);
      const price = toNonNegativeNumber(row?.price ?? row?.current_price, 0);
      const originalPrice = toNonNegativeNumber(row?.original_price, 0);
      const discountPercent = Math.max(0, Math.min(100, toNonNegativeNumber(row?.discount_percent, 0)));
      return {
        currency,
        country_codes: normalizeMarketCodeList(row?.country_codes || row?.countries, { countryOnly: true }),
        region_codes: normalizeMarketCodeList(row?.region_codes || row?.regions),
        price,
        original_price: originalPrice,
        discount_percent: discountPercent,
        discount_label: String(row?.discount_label || '').trim(),
        extra_lead_price: toNonNegativeNumber(row?.extra_lead_price, 0),
      };
    })
    .filter((row) => row.currency !== 'INR' && row.price > 0);
};

function normalizeObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  return {};
}

function buildPlanFeatures(existingFeatures, payload = {}) {
  const base = normalizeObject(existingFeatures);
  const incoming = normalizeObject(payload?.features);
  const baseCoverage = normalizeObject(base.coverage);
  const incomingCoverage = normalizeObject(incoming.coverage);
  const next = {
    ...base,
    ...incoming,
  };

  const hasPricingInput =
    hasOwn(payload, 'original_price') ||
    hasOwn(payload, 'discount_percent') ||
    hasOwn(payload, 'discount_label') ||
    hasOwn(payload, 'currency') ||
    hasOwn(payload, 'regional_prices') ||
    hasOwn(payload, 'extra_lead_price');

  if (hasPricingInput) {
    const pricing = {
      ...normalizeObject(base.pricing),
      ...normalizeObject(incoming.pricing),
    };

    if (hasOwn(payload, 'original_price')) {
      pricing.original_price = toNonNegativeNumber(payload.original_price, 0);
    }
    if (hasOwn(payload, 'discount_percent')) {
      pricing.discount_percent = Math.max(0, Math.min(100, toNonNegativeNumber(payload.discount_percent, 0)));
    }
    if (hasOwn(payload, 'discount_label')) {
      pricing.discount_label = String(payload.discount_label || '').trim();
    }
    if (hasOwn(payload, 'currency')) {
      pricing.currency = normalizePlanCurrency(payload.currency);
    }
    if (hasOwn(payload, 'regional_prices')) {
      pricing.regional_prices = normalizeRegionalPrices(payload.regional_prices);
    }
    if (hasOwn(payload, 'extra_lead_price')) {
      pricing.extra_lead_price = toNonNegativeNumber(payload.extra_lead_price, 0);
    }

    next.pricing = pricing;
  }

  const hasBadgeInput = hasOwn(payload, 'badge_label') || hasOwn(payload, 'badge_variant');
  if (hasBadgeInput) {
    const badge = {
      ...normalizeObject(base.badge),
      ...normalizeObject(incoming.badge),
    };
    if (hasOwn(payload, 'badge_label')) badge.label = String(payload.badge_label || '').trim();
    if (hasOwn(payload, 'badge_variant')) badge.variant = String(payload.badge_variant || '').trim() || 'neutral';
    next.badge = badge;
  }

  const resolveCoverageLimit = (key) => {
    if (hasOwn(payload, key)) return toNonNegativeInteger(payload[key], 0);
    if (hasOwn(incoming, key)) return toNonNegativeInteger(incoming[key], 0);
    if (hasOwn(incomingCoverage, key)) return toNonNegativeInteger(incomingCoverage[key], 0);
    if (hasOwn(baseCoverage, key)) return toNonNegativeInteger(baseCoverage[key], 0);
    if (hasOwn(base, key)) return toNonNegativeInteger(base[key], 0);
    return undefined;
  };

  const statesLimit = resolveCoverageLimit('states_limit');
  const citiesLimit = resolveCoverageLimit('cities_limit');

  if (statesLimit !== undefined || citiesLimit !== undefined) {
    const coverage = {
      ...baseCoverage,
      ...incomingCoverage,
    };
    if (statesLimit !== undefined) coverage.states_limit = statesLimit;
    if (citiesLimit !== undefined) coverage.cities_limit = citiesLimit;
    next.coverage = coverage;

    // Keep flat keys for backward compatibility with older vendor UIs.
    if (statesLimit !== undefined) next.states_limit = statesLimit;
    if (citiesLimit !== undefined) next.cities_limit = citiesLimit;
  }

  return normalizePlanFeatures(next, payload);
}

function isMissingVendorPlanColumnError(error, columnName) {
  const col = String(columnName || '').trim().toLowerCase();
  if (!col) return false;

  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  const mentionsColumn =
    text.includes(`'${col}'`) ||
    text.includes(`"${col}"`) ||
    text.includes(`column "${col}"`) ||
    text.includes(`column '${col}'`);
  const mentionsTable =
    text.includes(`'vendor_plans'`) ||
    text.includes(`"vendor_plans"`) ||
    text.includes('relation "vendor_plans"') ||
    text.includes("relation 'vendor_plans'");
  const missingSignal = text.includes('schema cache') || text.includes('does not exist');

  return mentionsColumn && mentionsTable && missingSignal;
}

async function insertVendorPlanWithFallback(payload) {
  const first = await db
    .from('vendor_plans')
    .insert([payload])
    .select('*')
    .maybeSingle();

  if (!first?.error || !hasOwn(payload, 'description')) {
    return first;
  }

  if (!isMissingVendorPlanColumnError(first.error, 'description')) {
    return first;
  }

  const retryPayload = { ...payload };
  delete retryPayload.description;

  const retry = await db
    .from('vendor_plans')
    .insert([retryPayload])
    .select('*')
    .maybeSingle();

  if (!retry?.error && retry?.data) {
    retry.data.description = String(payload.description || '');
  }
  return retry;
}

async function updateVendorPlanWithFallback(planId, updates) {
  const first = await db
    .from('vendor_plans')
    .update(updates)
    .eq('id', planId)
    .select('*')
    .maybeSingle();

  if (!first?.error || !hasOwn(updates, 'description')) {
    return first;
  }

  if (!isMissingVendorPlanColumnError(first.error, 'description')) {
    return first;
  }

  const retryUpdates = { ...updates };
  delete retryUpdates.description;

  if (Object.keys(retryUpdates).length === 0) {
    return {
      data: null,
      error: {
        message:
          'Plan description is not supported by current DB schema. Apply latest migration to enable it.',
      },
    };
  }

  const retry = await db
    .from('vendor_plans')
    .update(retryUpdates)
    .eq('id', planId)
    .select('*')
    .maybeSingle();

  if (!retry?.error && retry?.data) {
    retry.data.description = String(updates.description || '');
  }
  return retry;
}

async function syncActivePlanQuota(planId, limits) {
  if (!planId) return;

  const { data: subscriptions, error: subError } = await db
    .from('vendor_plan_subscriptions')
    .select('vendor_id')
    .eq('plan_id', planId)
    .eq('status', 'ACTIVE');

  if (subError) {
    throw new Error(subError.message);
  }

  const vendorIds = Array.from(
    new Set(
      (subscriptions || [])
        .map((row) => row?.vendor_id)
        .filter(Boolean)
    )
  );

  if (vendorIds.length === 0) return;

  const { error: quotaError } = await db
    .from('vendor_lead_quota')
    .update({
      plan_id: planId,
      daily_limit: toNonNegativeInteger(limits?.daily_limit, 0),
      weekly_limit: toNonNegativeInteger(limits?.weekly_limit, 0),
      yearly_limit: toNonNegativeInteger(limits?.yearly_limit, 0),
      updated_at: nowIso(),
    })
    .in('vendor_id', vendorIds);

  if (quotaError) {
    throw new Error(quotaError.message);
  }
}

async function ensureSystemConfigRow(superadminId) {
  const key = 'maintenance_mode';
  const rows = await mysqlQuery(
    `SELECT *
       FROM system_config
      WHERE config_key = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [key]
  );

  if (rows[0]) return rows[0];

  await mysqlQuery(
    `INSERT INTO system_config
      (id, config_key, maintenance_mode, maintenance_message, allow_vendor_registration,
       commission_rate, max_upload_size_mb, public_notice_enabled, public_notice_message,
       public_notice_variant, updated_at, updated_by)
     VALUES
      (UUID(), ?, 0, '', 1, 5, 10, 0, '', 'info', NOW(), ?)`,
    [key, superadminId || null]
  );

  const insertedRows = await mysqlQuery(
    `SELECT *
       FROM system_config
      WHERE config_key = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [key]
  );

  return insertedRows[0] || {
    config_key: key,
    maintenance_mode: false,
    maintenance_message: '',
    allow_vendor_registration: true,
    commission_rate: 5,
    max_upload_size_mb: 10,
    public_notice_enabled: false,
    public_notice_message: '',
    public_notice_variant: 'info',
    updated_at: nowIso(),
    updated_by: superadminId || null,
  };
}

async function deleteVendorCascade(vendorId) {
  const { data: vendor, error: vendorError } = await db
    .from('vendors')
    .select('id, user_id, company_name, email, vendor_id')
    .eq('id', vendorId)
    .maybeSingle();

  if (vendorError) throw new Error(vendorError.message);
  if (!vendor) {
    const err = new Error('Vendor not found');
    err.statusCode = 404;
    throw err;
  }

  const vendorUserId = vendor.user_id || null;

  // Products and product images
  const { data: products } = await db
    .from('products')
    .select('id')
    .eq('vendor_id', vendorId);
  const productIds = (products || []).map((p) => p.id).filter(Boolean);
  if (productIds.length > 0) {
    await db.from('product_images').delete().in('product_id', productIds);
  }
  await db.from('products').delete().eq('vendor_id', vendorId);

  // Ticket messages -> support tickets
  const { data: tickets } = await db
    .from('support_tickets')
    .select('id')
    .eq('vendor_id', vendorId);
  const ticketIds = (tickets || []).map((t) => t.id).filter(Boolean);
  if (ticketIds.length > 0) {
    await db.from('ticket_messages').delete().in('ticket_id', ticketIds);
  }
  await db.from('support_tickets').delete().eq('vendor_id', vendorId);

  // Leads referencing vendor must be detached to avoid FK errors.
  await db
    .from('leads')
    .update({ vendor_id: null, status: 'AVAILABLE' })
    .eq('vendor_id', vendorId);

  // Direct vendor_id references
  const tablesToDeleteByVendor = [
    'favorites',
    'lead_contacts',
    'lead_purchases',
    'vendor_additional_leads',
    'vendor_bank_details',
    'vendor_contact_persons',
    'vendor_coupon_usages',
    'vendor_documents',
    'vendor_lead_quota',
    'vendor_messages',
    'vendor_otp_codes',
    'vendor_payments',
    'vendor_plan_slots',
    'vendor_plan_subscriptions',
    'vendor_plan_coupons',
    'vendor_preferences',
    'proposals',
  ];

  for (const table of tablesToDeleteByVendor) {
    // eslint-disable-next-line no-await-in-loop
    await db.from(table).delete().eq('vendor_id', vendorId);
  }

  // Finally delete vendor row.
  const { error: deleteVendorError } = await db.from('vendors').delete().eq('id', vendorId);
  if (deleteVendorError) {
    throw new Error(deleteVendorError.message);
  }

  // Best-effort delete of the auth user tied to this vendor.
  if (vendorUserId) {
    try {
      await db.from('users').delete().eq('id', vendorUserId);
    } catch (error) {
      logger.warn('[SuperAdmin] Failed to delete vendor public user:', error?.message || error);
    }
  }

  return vendor;
}

async function loadVendorLeadStats(vendorIds = []) {
  const ids = Array.from(new Set((vendorIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
  const emptyStats = () => ({
    direct_total: 0,
    direct_opened: 0,
    direct_unopened: 0,
    purchased_total: 0,
    purchased_opened: 0,
    purchased_unopened: 0,
    total_leads: 0,
    total_opened: 0,
    total_unopened: 0,
  });

  const statsByVendor = new Map(ids.map((id) => [id, emptyStats()]));
  if (!ids.length) return statsByVendor;

  const placeholders = ids.map(() => '?').join(',');

  const [directRows, purchaseRows] = await Promise.all([
    mysqlQuery(
      `SELECT vendor_id,
              COUNT(*) AS direct_total,
              SUM(
                CASE
                  WHEN UPPER(COALESCE(status, '')) NOT IN ('', 'NEW', 'OPEN', 'AVAILABLE')
                  THEN 1 ELSE 0
                END
              ) AS direct_opened
         FROM leads
        WHERE vendor_id IN (${placeholders})
        GROUP BY vendor_id`,
      ids
    ).catch((error) => {
      logger.warn('[SuperAdmin] Direct lead stats failed:', error?.message || error);
      return [];
    }),
    mysqlQuery(
      `SELECT vendor_id,
              COUNT(*) AS purchased_total,
              SUM(
                CASE
                  WHEN UPPER(COALESCE(lead_status, '')) NOT IN ('', 'NEW', 'ACTIVE', 'UNREAD')
                  THEN 1 ELSE 0
                END
              ) AS purchased_opened
         FROM lead_purchases
        WHERE vendor_id IN (${placeholders})
        GROUP BY vendor_id`,
      ids
    ).catch((error) => {
      logger.warn('[SuperAdmin] Purchased lead stats failed:', error?.message || error);
      return [];
    }),
  ]);

  (directRows || []).forEach((row) => {
    const vendorId = String(row?.vendor_id || '').trim();
    if (!vendorId || !statsByVendor.has(vendorId)) return;
    const stats = statsByVendor.get(vendorId);
    stats.direct_total = Number(row?.direct_total || 0);
    stats.direct_opened = Number(row?.direct_opened || 0);
    stats.direct_unopened = Math.max(0, stats.direct_total - stats.direct_opened);
  });

  (purchaseRows || []).forEach((row) => {
    const vendorId = String(row?.vendor_id || '').trim();
    if (!vendorId || !statsByVendor.has(vendorId)) return;
    const stats = statsByVendor.get(vendorId);
    stats.purchased_total = Number(row?.purchased_total || 0);
    stats.purchased_opened = Number(row?.purchased_opened || 0);
    stats.purchased_unopened = Math.max(0, stats.purchased_total - stats.purchased_opened);
  });

  statsByVendor.forEach((stats) => {
    stats.total_leads = stats.direct_total + stats.purchased_total;
    stats.total_opened = stats.direct_opened + stats.purchased_opened;
    stats.total_unopened = stats.direct_unopened + stats.purchased_unopened;
  });

  return statsByVendor;
}

// -----------------------
// Auth
// -----------------------
router.post('/login', loginSuperAdmin);

router.get('/me', requireSuperAdmin, async (req, res) => {
  return res.json({
    success: true,
    superadmin: {
      id: req.superadmin.id,
      email: req.superadmin.email,
      role: normalizeRole(req.superadmin.role || 'SUPERADMIN'),
      last_login: req.superadmin.last_login || null,
      is_active: req.superadmin.is_active !== false,
    },
  });
});

router.put('/password', requireSuperAdmin, changeSuperAdminPassword);

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.post('/impersonation/open', async (req, res) => {
  try {
    const session = await resolveSuperAdminSessionToken(
      req.body?.superadmin_token || req.body?.token
    );
    req.superadmin = session.superadmin;
    req.actor = session.actor;

    const result = await createImpersonationSession(req, res);
    return res.redirect(303, result.next);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    const message = escapeHtml(error?.message || 'Could not open assisted dashboard access');
    return res.status(statusCode).send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Assisted access failed</title></head><body><h1>Assisted access failed</h1><p>${message}</p><p><a href="/admin/superadmin/dashboard">Back to Super Admin</a></p></body></html>`
    );
  }
});

// All routes below require superadmin.
router.use(requireSuperAdmin);

function getTargetDisplayName(targetType, row = {}) {
  if (targetType === 'VENDOR') {
    return compactText(row.company_name) || compactText(row.owner_name) || compactText(row.email) || 'Vendor';
  }
  return compactText(row.company_name) || compactText(row.full_name) || compactText(row.email) || 'Buyer';
}

function getTargetTable(targetType) {
  return targetType === 'BUYER' ? 'buyers' : 'vendors';
}

function getTargetSelect(targetType) {
  if (targetType === 'BUYER') {
    return 'id, user_id, full_name, email, phone, company_name, state, city, is_active, created_at, updated_at';
  }

  return 'id, user_id, vendor_id, company_name, owner_name, email, phone, state, city, is_active, status, account_status, is_suspended, created_at, updated_at';
}

function getTargetDashboardPath(targetType) {
  return targetType === 'BUYER' ? '/buyer/dashboard' : '/vendor/dashboard';
}

function summarizeImpersonationTarget(targetType, row = {}) {
  const inactive = row.is_active === false || row.is_active === 0 || String(row.is_active).toLowerCase() === 'false';
  const suspended =
    String(row.account_status || row.status || '').toUpperCase() === 'SUSPENDED' ||
    String(row.is_suspended || '').toLowerCase() === 'true';

  return {
    id: row.id,
    user_id: row.user_id || null,
    target_type: targetType,
    external_id: targetType === 'VENDOR' ? row.vendor_id || null : null,
    name: getTargetDisplayName(targetType, row),
    email: row.email || null,
    phone: row.phone || null,
    company_name: row.company_name || null,
    owner_name: row.owner_name || row.full_name || null,
    city: row.city || null,
    state: row.state || null,
    is_active: !inactive && !suspended,
    status_label: suspended ? 'SUSPENDED' : inactive ? 'INACTIVE' : 'ACTIVE',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadImpersonationTarget(targetType, targetId) {
  const table = getTargetTable(targetType);
  const select = getTargetSelect(targetType);
  const target = compactText(targetId);

  if (!target) {
    const error = new Error('target_id is required');
    error.statusCode = 400;
    throw error;
  }

  let query = db.from(table).select(select);
  if (targetType === 'VENDOR') {
    query = query.or(`id.eq.${target},vendor_id.eq.${target},user_id.eq.${target}`);
  } else {
    query = query.or(`id.eq.${target},user_id.eq.${target}`);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message);
    err.statusCode = 500;
    throw err;
  }

  if (!data?.id) {
    const err = new Error(`${targetType === 'BUYER' ? 'Buyer' : 'Vendor'} not found`);
    err.statusCode = 404;
    throw err;
  }

  return data;
}

async function ensureTargetSessionUser(targetType, targetRow) {
  const email = normalizeEmail(targetRow?.email || '');
  let user = null;

  if (targetRow?.user_id) {
    user = await getPublicUserById(targetRow.user_id);
  }

  if (!user && email) {
    user = await getPublicUserByEmail(email);
  }

  if (user && INTERNAL_PUBLIC_ROLES.has(normalizeRole(user?.role))) {
    const err = new Error('Target email is linked to an internal staff account. Link the correct portal user before assisted access.');
    err.statusCode = 409;
    throw err;
  }

  if (!user && !email) {
    const err = new Error('Target account has no login identity or email');
    err.statusCode = 400;
    throw err;
  }

  if (!user) {
    user = await upsertPublicUser({
      email,
      full_name: getTargetDisplayName(targetType, targetRow),
      role: targetType,
      phone: targetRow?.phone || null,
    });
  }

  if (!user?.id) {
    const err = new Error('Unable to resolve target login identity');
    err.statusCode = 500;
    throw err;
  }

  if (targetRow.user_id !== user.id) {
    const { error } = await db
      .from(getTargetTable(targetType))
      .update({ user_id: user.id, updated_at: nowIso() })
      .eq('id', targetRow.id);

    if (error) {
      const err = new Error(error.message);
      err.statusCode = 500;
      throw err;
    }

    targetRow.user_id = user.id;
  }

  return user;
}

function buildSuperadminActor(req) {
  return {
    id: req.superadmin?.id || req.actor?.id || null,
    type: 'SUPERADMIN',
    role: normalizeRole(req.superadmin?.role || req.actor?.role || 'SUPERADMIN'),
    email: req.superadmin?.email || req.actor?.email || null,
  };
}

async function createImpersonationSession(req, res) {
  const targetType = normalizeImpersonationTarget(req.body?.target_type || req.body?.type);
  if (!targetType) {
    const err = new Error('Invalid target_type. Use VENDOR or BUYER.');
    err.statusCode = 400;
    throw err;
  }

  const target = await loadImpersonationTarget(
    targetType,
    req.body?.target_id || req.body?.targetId || req.body?.id
  );
  const user = await ensureTargetSessionUser(targetType, target);
  const actor = buildSuperadminActor(req);

  const token = signAuthToken({
    sub: user.id,
    email: user.email || target.email || null,
    role: targetType,
    type: 'IMPERSONATION',
    impersonated_by: actor.id,
    impersonated_by_role: actor.role,
    impersonated_by_email: actor.email,
    impersonation_target_type: targetType,
    impersonation_target_id: target.id,
  });

  const csrfToken = createCsrfToken();
  setAuthCookies(res, token, csrfToken);

  await writeAuditLog({
    req,
    actor,
    action: 'SUPERADMIN_IMPERSONATION_STARTED',
    entityType: getTargetTable(targetType),
    entityId: target.id,
    details: {
      target_type: targetType,
      target_name: getTargetDisplayName(targetType, target),
      target_email: target.email || null,
      target_user_id: user.id,
      dashboard_path: getTargetDashboardPath(targetType),
    },
  });

  return {
    success: true,
    target_type: targetType,
    target: summarizeImpersonationTarget(targetType, target),
    user: {
      id: user.id,
      email: user.email || target.email || null,
      role: targetType,
    },
    impersonation: {
      active: true,
      by_user_id: actor.id,
      by_email: actor.email,
      by_role: actor.role,
      target_type: targetType,
      target_id: target.id,
    },
    next: getTargetDashboardPath(targetType),
  };
}

router.get('/impersonation/targets', async (req, res) => {
  try {
    const targetType = normalizeImpersonationTarget(req.query?.target_type || req.query?.type || 'BUYER');
    if (!targetType) {
      return res.status(400).json({ success: false, error: 'Invalid target_type. Use VENDOR or BUYER.' });
    }

    const rawQuery = compactText(req.query?.q || req.query?.query || '').replace(/,/g, ' ');
    const limit = Math.min(Math.max(Number(req.query?.limit || 20), 1), 50);
    const table = getTargetTable(targetType);
    let query = db
      .from(table)
      .select(getTargetSelect(targetType))
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (rawQuery) {
      const like = `%${rawQuery}%`;
      const filters = targetType === 'BUYER'
        ? [
            `id.ilike.${like}`,
            `full_name.ilike.${like}`,
            `email.ilike.${like}`,
            `phone.ilike.${like}`,
            `company_name.ilike.${like}`,
            `city.ilike.${like}`,
            `state.ilike.${like}`,
          ]
        : [
            `id.ilike.${like}`,
            `vendor_id.ilike.${like}`,
            `company_name.ilike.${like}`,
            `owner_name.ilike.${like}`,
            `email.ilike.${like}`,
            `phone.ilike.${like}`,
            `city.ilike.${like}`,
            `state.ilike.${like}`,
          ];
      query = query.or(filters.join(','));
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      target_type: targetType,
      query: rawQuery,
      targets: (data || []).map((row) => summarizeImpersonationTarget(targetType, row)),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to load assisted-access targets',
    });
  }
});

router.post('/impersonation/start', async (req, res) => {
  try {
    return res.json(await createImpersonationSession(req, res));
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to start assisted dashboard access',
    });
  }
});

router.post('/impersonation/stop', async (req, res) => {
  try {
    const actor = buildSuperadminActor(req);
    clearAuthCookies(res);
    await writeAuditLog({
      req,
      actor,
      action: 'SUPERADMIN_IMPERSONATION_STOPPED',
      entityType: 'auth_sessions',
      details: { stopped_by: actor.email || actor.id || null },
    });
    return res.json({ success: true });
  } catch (error) {
    clearAuthCookies(res);
    return res.json({ success: true });
  }
});

router.get('/search360/vendors', async (req, res) => {
  try {
    const actor = buildSearch360ActorFromSuperadmin(req);
    const result = await searchVendors360(actor, {
      query: req.query?.q || req.query?.query || '',
      stateId: req.query?.stateId || req.query?.state_id || '',
      limit: req.query?.limit,
      offset: req.query?.offset,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to load Search 360',
    });
  }
});

router.post('/search360/escalations', async (req, res) => {
  try {
    const actor = buildSearch360ActorFromSuperadmin(req);
    const result = await createSearch360Escalation(actor, req.body || {}, req);
    return res.status(201).json(result);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to create Search 360 escalation',
    });
  }
});

router.patch('/search360/cases/:caseId/status', async (req, res) => {
  try {
    const actor = buildSearch360ActorFromSuperadmin(req);
    const result = await updateSearch360CaseStatus(actor, req.params.caseId, req.body || {}, req);
    return res.json(result);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to update Search 360 case',
    });
  }
});

// -----------------------
// Employees
// -----------------------
router.get('/states', async (req, res) => {
  try {
    const stateCatalog = await loadStateCatalog();
    return res.json({
      success: true,
      states: stateCatalog.states.map((state) => ({
        id: state.id,
        name: state.name,
        slug: state.slug,
        region_code: state.region_code,
        region_name: state.region_name,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/employees', async (req, res) => {
  try {
    const { data, error } = await db
      .from('employees')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const employees = await hydrateEmployeesWithStateScope(data || []);

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'EMPLOYEES_VIEWED',
      entityType: 'employees',
      details: { count: data?.length || 0 },
    });

    return res.json({ success: true, employees });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/employees', async (req, res) => {
  try {
    const fullName = String(req.body?.full_name || '').trim();
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '').trim();
    const role = normalizeRole(req.body?.role || 'ADMIN');
    const phone = String(req.body?.phone || '').trim() || null;
    const department = String(req.body?.department || '').trim() || 'Administration';
    const status = normalizeRole(req.body?.status || 'ACTIVE') || 'ACTIVE';
    const stateCatalog = await loadStateCatalog();
    const rawScope = Array.isArray(req.body?.state_scope_ids) ? req.body.state_scope_ids : req.body?.states_scope;
    const { stateIds: stateScopeIds, stateNames: statesScope } =
      role === 'ADMIN'
        ? normalizeRequestedStateScope(rawScope, stateCatalog)
        : { stateIds: [], stateNames: [] };

    if (!fullName || !email || !password) {
      return res
        .status(400)
        .json({ success: false, error: 'full_name, email and password are required' });
    }

    if (!EMPLOYEE_ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        error: `Invalid role. Allowed roles: ${EMPLOYEE_ALLOWED_ROLES.join(', ')}`,
      });
    }

    const password_hash = await hashPassword(password);
    const publicUser = await upsertPublicUser({
      email,
      full_name: fullName,
      role,
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });

    const userId = publicUser.id;

    const empPayload = {
      user_id: userId,
      full_name: fullName,
      email,
      phone,
      role,
      department,
      status,
      states_scope: statesScope,
      created_at: nowIso(),
    };

    const { data: employee, error: empError } = await db
      .from('employees')
      .insert([empPayload])
      .select('*')
      .maybeSingle();

    if (empError) {
        try {
          await db.from('users').delete().eq('id', userId);
        } catch (error) {
          logger.warn('[SuperAdmin] Failed to rollback public user:', error?.message || error);
        }
      return res.status(500).json({ success: false, error: empError.message });
    }

    let hydratedEmployee = employee || empPayload;
    if (employee?.id) {
      await syncEmployeeStateScope(employee.id, stateScopeIds, stateCatalog);
      [hydratedEmployee] = await hydrateEmployeesWithStateScope([employee], stateCatalog);
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'EMPLOYEE_CREATED',
      entityType: 'employees',
      entityId: employee?.id || null,
      details: { email, role, department, user_id: userId, state_scope_ids: stateScopeIds, states_scope: statesScope },
    });

    if (userId) {
      await notifyUser({
        user_id: userId,
        type: 'WELCOME',
        title: 'Welcome to the Team',
        message: 'Your staff account has been created. Please log in to continue.',
        link: '/employee/login',
      });
    }

    return res.json({ success: true, employee: hydratedEmployee });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/employees/:employeeId', async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    if (!employeeId) {
      return res.status(400).json({ success: false, error: 'employeeId is required' });
    }

    const { data: employee, error: empError } = await db
      .from('employees')
      .select('id, user_id, email, full_name, role')
      .eq('id', employeeId)
      .maybeSingle();

    if (empError) {
      return res.status(500).json({ success: false, error: empError.message });
    }

    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    await db.from('employees').delete().eq('id', employeeId);

      if (employee.user_id) {
        await db.from('users').delete().eq('id', employee.user_id);
      }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'EMPLOYEE_DELETED',
      entityType: 'employees',
      entityId: employeeId,
      details: {
        user_id: employee.user_id,
        email: employee.email,
        full_name: employee.full_name,
        role: employee.role,
      },
    });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/employees/:employeeId/password', async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    const password = String(req.body?.password || '').trim();

    if (!employeeId) {
      return res.status(400).json({ success: false, error: 'employeeId is required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const { data: employee, error: empError } = await db
      .from('employees')
      .select('id, user_id, email, full_name, role, department, phone')
      .eq('id', employeeId)
      .maybeSingle();

    if (empError) {
      return res.status(500).json({ success: false, error: empError.message });
    }

    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    // Ensure we have a valid public user id even if employees.user_id is missing/invalid.
    let resolvedUserId = employee.user_id || null;
    let createdAuthUser = false;
    try {
      const ensured = await ensureEmployeeAuthUser(employee, password);
      resolvedUserId = ensured.userId;
      createdAuthUser = ensured.created;
    } catch (error) {
      const statusCode = error?.statusCode || 500;
      return res.status(statusCode).json({ success: false, error: error.message });
    }

    if (!resolvedUserId) {
      return res.status(404).json({ success: false, error: 'Employee user not found' });
    }

    await setPublicUserPassword(resolvedUserId, password);

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'EMPLOYEE_PASSWORD_RESET',
      entityType: 'employees',
      entityId: employeeId,
      details: {
        user_id: resolvedUserId,
        email: employee.email,
        role: employee.role,
        created_auth_user: createdAuthUser,
      },
    });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// Vendors
// -----------------------
router.get('/vendors', async (req, res) => {
  try {
    const limit = clampLimit(req.query?.limit, 500, 2000);
    const offset = Math.max(0, Math.floor(Number(req.query?.offset) || 0));
    const { data, error, count } = await db
      .from('vendors')
      .select(
        'id, vendor_id, company_name, owner_name, email, phone, kyc_status, created_at, is_active, is_verified, all_india_visibility, city, state',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const statsByVendor = await loadVendorLeadStats((data || []).map((vendor) => vendor?.id));
    const vendors = (data || []).map((vendor) => ({
      ...vendor,
      lead_stats: statsByVendor.get(vendor?.id) || {
        direct_total: 0,
        direct_opened: 0,
        direct_unopened: 0,
        purchased_total: 0,
        purchased_opened: 0,
        purchased_unopened: 0,
        total_leads: 0,
        total_opened: 0,
        total_unopened: 0,
      },
    }));

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDORS_VIEWED',
      entityType: 'vendors',
      details: { count: data?.length || 0, total: Number(count) || 0, limit, offset },
    });

    return res.json({
      success: true,
      vendors,
      total: Number(count) || 0,
      limit,
      offset,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/vendors/:vendorId/all-india-visibility', async (req, res) => {
  try {
    const vendorId = req.params.vendorId;
    if (!vendorId) {
      return res.status(400).json({ success: false, error: 'vendorId is required' });
    }

    const enabled = normalizeBooleanInput(
      hasOwn(req.body || {}, 'enabled') ? req.body.enabled : req.body?.all_india_visibility,
      false
    );

    const { data, error } = await db
      .from('vendors')
      .update({ all_india_visibility: enabled ? 1 : 0, updated_at: new Date().toISOString() })
      .eq('id', vendorId)
      .select('id, vendor_id, company_name, email, all_india_visibility, city, state')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_ALL_INDIA_VISIBILITY_UPDATED',
      entityType: 'vendors',
      entityId: vendorId,
      details: {
        enabled,
        vendor_id: data.vendor_id,
        company_name: data.company_name,
        email: data.email,
      },
    });

    return res.json({ success: true, vendor: data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/vendors/:vendorId', async (req, res) => {
  try {
    const vendorId = req.params.vendorId;
    if (!vendorId) {
      return res.status(400).json({ success: false, error: 'vendorId is required' });
    }

    let vendor;
    try {
      vendor = await deleteVendorCascade(vendorId);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_DELETED',
      entityType: 'vendors',
      entityId: vendorId,
      details: {
        vendor_id: vendor.vendor_id,
        company_name: vendor.company_name,
        email: vendor.email,
        user_id: vendor.user_id,
      },
    });

    return res.json({ success: true, vendor });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// Subscription plan catalog
// -----------------------
router.get('/plans', async (req, res) => {
  try {
    const includeInactive = req.query?.include_inactive !== 'false';
    const limit = clampLimit(req.query?.limit, 200, 1000);

    let query = db
      .from('vendor_plans')
      .select('*')
      .order('price', { ascending: true })
      .order('name', { ascending: true })
      .limit(limit);

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_PLANS_VIEWED',
      entityType: 'vendor_plans',
      details: {
        include_inactive: includeInactive,
        count: data?.length || 0,
      },
    });

    return res.json({ success: true, plans: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/plans', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const payload = {
      name,
      price: toNonNegativeNumber(req.body?.price, 0),
      daily_limit: toNonNegativeInteger(req.body?.daily_limit, 0),
      weekly_limit: toNonNegativeInteger(req.body?.weekly_limit, 0),
      yearly_limit: toNonNegativeInteger(req.body?.yearly_limit, 0),
      duration_days: toPositiveInteger(req.body?.duration_days, 365),
      is_active: normalizeBooleanInput(req.body?.is_active, true),
      features: buildPlanFeatures({}, req.body),
    };

    if (hasOwn(req.body, 'description')) {
      payload.description = String(req.body?.description || '').trim();
    }

    const { data, error } = await insertVendorPlanWithFallback(payload);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_PLAN_CREATED',
      entityType: 'vendor_plans',
      entityId: data?.id || null,
      details: {
        name: payload.name,
        price: payload.price,
        daily_limit: payload.daily_limit,
        weekly_limit: payload.weekly_limit,
        yearly_limit: payload.yearly_limit,
        duration_days: payload.duration_days,
        is_active: payload.is_active,
        currency: payload?.features?.pricing?.currency || 'INR',
        regional_price_count: Array.isArray(payload?.features?.pricing?.regional_prices)
          ? payload.features.pricing.regional_prices.length
          : 0,
        extra_lead_price: toNonNegativeNumber(payload?.features?.pricing?.extra_lead_price, 0),
      },
    });

    return res.json({ success: true, plan: data || payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/plans/:planId', async (req, res) => {
  try {
    const planId = req.params.planId;
    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId is required' });
    }

    const { data: existing, error: existingError } = await db
      .from('vendor_plans')
      .select('*')
      .eq('id', planId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ success: false, error: existingError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const updates = {};

    if (hasOwn(req.body, 'name')) updates.name = String(req.body?.name || '').trim();
    if (hasOwn(req.body, 'description')) updates.description = String(req.body?.description || '').trim();
    if (hasOwn(req.body, 'price')) updates.price = toNonNegativeNumber(req.body?.price, 0);
    if (hasOwn(req.body, 'daily_limit')) updates.daily_limit = toNonNegativeInteger(req.body?.daily_limit, 0);
    if (hasOwn(req.body, 'weekly_limit')) updates.weekly_limit = toNonNegativeInteger(req.body?.weekly_limit, 0);
    if (hasOwn(req.body, 'yearly_limit')) updates.yearly_limit = toNonNegativeInteger(req.body?.yearly_limit, 0);
    if (hasOwn(req.body, 'duration_days')) updates.duration_days = toPositiveInteger(req.body?.duration_days, 365);
    if (hasOwn(req.body, 'is_active')) updates.is_active = normalizeBooleanInput(req.body?.is_active, false);

    const hasFeatureUpdate =
      hasOwn(req.body, 'features') ||
      hasOwn(req.body, 'original_price') ||
      hasOwn(req.body, 'discount_percent') ||
      hasOwn(req.body, 'discount_label') ||
      hasOwn(req.body, 'currency') ||
      hasOwn(req.body, 'regional_prices') ||
      hasOwn(req.body, 'extra_lead_price') ||
      hasOwn(req.body, 'badge_label') ||
      hasOwn(req.body, 'badge_variant') ||
      hasOwn(req.body, 'states_limit') ||
      hasOwn(req.body, 'cities_limit') ||
      hasOwn(req.body, 'purchase_channel') ||
      hasOwn(req.body, 'public_purchase_enabled') ||
      hasOwn(req.body, 'sales_assisted') ||
      hasOwn(req.body, 'sales_cta_label') ||
      hasOwn(req.body, 'portfolio_template') ||
      hasOwn(req.body, 'portfolio_customizable') ||
      hasOwn(req.body, 'custom_url_enabled') ||
      hasOwn(req.body, 'portfolio_custom_sections') ||
      hasOwn(req.body, 'sitemap_customization') ||
      hasOwn(req.body, 'sitemap_url_boost') ||
      hasOwn(req.body, 'certificate_enabled') ||
      hasOwn(req.body, 'certificate_tier') ||
      hasOwn(req.body, 'certificate_title') ||
      hasOwn(req.body, 'certificate_label') ||
      hasOwn(req.body, 'seo_enabled') ||
      hasOwn(req.body, 'seo_url_aliases') ||
      hasOwn(req.body, 'seo_city_category_pages');

    if (hasFeatureUpdate) {
      updates.features = buildPlanFeatures(existing.features, req.body);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields provided to update' });
    }

    const { data, error } = await updateVendorPlanWithFallback(planId, updates);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    if (hasOwn(updates, 'daily_limit') || hasOwn(updates, 'weekly_limit') || hasOwn(updates, 'yearly_limit')) {
      await syncActivePlanQuota(planId, {
        daily_limit: data?.daily_limit ?? existing.daily_limit ?? 0,
        weekly_limit: data?.weekly_limit ?? existing.weekly_limit ?? 0,
        yearly_limit: data?.yearly_limit ?? existing.yearly_limit ?? 0,
      });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_PLAN_UPDATED',
      entityType: 'vendor_plans',
      entityId: planId,
      details: updates,
    });

    return res.json({ success: true, plan: data || null });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/plans/:planId', async (req, res) => {
  try {
    const planId = req.params.planId;
    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId is required' });
    }

    const { data: existing, error: existingError } = await db
      .from('vendor_plans')
      .select('*')
      .eq('id', planId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ success: false, error: existingError.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const [
      { count: activeSubscriptionCount, error: activeSubError },
      { count: subscriptionHistoryCount, error: subHistoryError },
      { count: paymentHistoryCount, error: paymentHistoryError },
    ] = await Promise.all([
      db
        .from('vendor_plan_subscriptions')
        .select('id', { head: true, count: 'exact' })
        .eq('plan_id', planId)
        .eq('status', 'ACTIVE'),
      db
        .from('vendor_plan_subscriptions')
        .select('id', { head: true, count: 'exact' })
        .eq('plan_id', planId),
      db
        .from('vendor_payments')
        .select('id', { head: true, count: 'exact' })
        .eq('plan_id', planId),
    ]);

    if (activeSubError || subHistoryError || paymentHistoryError) {
      return res.status(500).json({
        success: false,
        error:
          activeSubError?.message ||
          subHistoryError?.message ||
          paymentHistoryError?.message ||
          'Failed to validate plan dependencies',
      });
    }

    const hasDependencies =
      (activeSubscriptionCount || 0) > 0 ||
      (subscriptionHistoryCount || 0) > 0 ||
      (paymentHistoryCount || 0) > 0;

    if (hasDependencies) {
      const { data: hiddenPlan, error: hideError } = await updateVendorPlanWithFallback(planId, {
        is_active: false,
      });

      if (hideError) {
        return res.status(500).json({ success: false, error: hideError.message || 'Failed to hide plan' });
      }

      await writeAuditLog({
        req,
        actor: req.actor,
        action: 'VENDOR_PLAN_HIDDEN_INSTEAD_OF_DELETED',
        entityType: 'vendor_plans',
        entityId: planId,
        details: {
          name: existing.name || null,
          active_subscriptions: activeSubscriptionCount || 0,
          subscription_history: subscriptionHistoryCount || 0,
          payment_history: paymentHistoryCount || 0,
        },
      });

      return res.json({
        success: true,
        planId,
        plan: hiddenPlan || { ...existing, is_active: false },
        soft_deleted: true,
        message: 'Plan has active/history records, so it was hidden instead of hard deleted.',
      });
    }

    const { error: deleteError } = await db
      .from('vendor_plans')
      .delete()
      .eq('id', planId);

    if (deleteError) {
      const { data: hiddenPlan, error: hideError } = await updateVendorPlanWithFallback(planId, {
        is_active: false,
      });

      if (!hideError) {
        await writeAuditLog({
          req,
          actor: req.actor,
          action: 'VENDOR_PLAN_HIDDEN_AFTER_DELETE_FAILED',
          entityType: 'vendor_plans',
          entityId: planId,
          details: {
            name: existing.name || null,
            delete_error: deleteError.message || null,
          },
        });

        return res.json({
          success: true,
          planId,
          plan: hiddenPlan || { ...existing, is_active: false },
          soft_deleted: true,
          message: 'Plan could not be hard deleted, so it was hidden from active catalog.',
        });
      }

      return res.status(500).json({ success: false, error: deleteError.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_PLAN_DELETED',
      entityType: 'vendor_plans',
      entityId: planId,
      details: {
        name: existing.name || null,
        price: Number(existing.price || 0),
      },
    });

    return res.json({ success: true, planId });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// Finance
// -----------------------
router.get('/finance/summary', async (req, res) => {
  try {
    const { data: payments, error } = await db
      .from('vendor_payments')
      .select('amount, net_amount, payment_date');
    if (error) return res.status(500).json({ success: false, error: error.message });

    const now = new Date();
    const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    let totalGross = 0;
    let totalNet = 0;
    let last30 = 0;
    (payments || []).forEach((p) => {
      const gross = Number(p.amount || 0);
      const net = Number(p.net_amount ?? p.amount ?? 0);
      totalGross += gross;
      totalNet += net;
      if (p.payment_date && new Date(p.payment_date) >= thirtyAgo) last30 += net;
    });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'FINANCE_SUMMARY_VIEWED',
      entityType: 'vendor_payments',
      details: { totalGross, totalNet, last30 },
    });

    return res.json({
      success: true,
      data: {
        totalGross,
        totalNet,
        last30,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/finance/payments', async (req, res) => {
  try {
    const { vendor_id, plan_id, from, to, limit = 200 } = req.query;
    let query = db
      .from('vendor_payments')
      .select(
        '*, vendor:vendors(id, vendor_id, company_name, email), plan:vendor_plans(id, name, price)'
      )
      .order('payment_date', { ascending: false })
      .limit(clampLimit(limit, 200, 2000));

    if (vendor_id) query = query.eq('vendor_id', vendor_id);
    if (plan_id) query = query.eq('plan_id', plan_id);
    if (from) query = query.gte('payment_date', from);
    if (to) query = query.lte('payment_date', to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'FINANCE_PAYMENTS_VIEWED',
      entityType: 'vendor_payments',
      details: {
        filters: { vendor_id: vendor_id || null, plan_id: plan_id || null, from: from || null, to: to || null },
        count: data?.length || 0,
      },
    });

    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// System config + messages
// -----------------------
router.get('/system-config', async (req, res) => {
  try {
    const row = await ensureSystemConfigRow(req.superadmin?.id);
    return res.json({
      success: true,
      config: {
        ...row,
        maintenance_mode: normalizeBooleanInput(row?.maintenance_mode, false),
        allow_vendor_registration: normalizeBooleanInput(row?.allow_vendor_registration, true),
        public_notice_enabled: normalizeBooleanInput(row?.public_notice_enabled, false),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/system-config', async (req, res) => {
  try {
    const existing = await ensureSystemConfigRow(req.superadmin?.id);
    const body = req.body || {};

    const payload = {
      config_key: 'maintenance_mode',
      maintenance_mode: hasOwn(body, 'maintenance_mode')
        ? normalizeBooleanInput(body.maintenance_mode, false)
        : normalizeBooleanInput(existing.maintenance_mode, false),
      maintenance_message: hasOwn(body, 'maintenance_message')
        ? String(body.maintenance_message ?? '')
        : String(existing.maintenance_message ?? ''),
      allow_vendor_registration:
        hasOwn(body, 'allow_vendor_registration')
          ? normalizeBooleanInput(body.allow_vendor_registration, true)
          : normalizeBooleanInput(existing.allow_vendor_registration, true),
      commission_rate:
        body.commission_rate != null ? Number(body.commission_rate) || 0 : existing.commission_rate,
      max_upload_size_mb:
        body.max_upload_size_mb != null
          ? Number(body.max_upload_size_mb) || 0
          : existing.max_upload_size_mb,
      public_notice_enabled: hasOwn(body, 'public_notice_enabled')
        ? normalizeBooleanInput(body.public_notice_enabled, false)
        : normalizeBooleanInput(existing.public_notice_enabled, false),
      public_notice_message: hasOwn(body, 'public_notice_message')
        ? String(body.public_notice_message ?? '')
        : String(existing.public_notice_message ?? ''),
      public_notice_variant: String(body.public_notice_variant || existing.public_notice_variant || 'info'),
      updated_at: nowIso(),
      updated_by: req.superadmin?.id || null,
    };

    await mysqlQuery(
      `UPDATE system_config
          SET maintenance_mode = ?,
              maintenance_message = ?,
              allow_vendor_registration = ?,
              commission_rate = ?,
              max_upload_size_mb = ?,
              public_notice_enabled = ?,
              public_notice_message = ?,
              public_notice_variant = ?,
              updated_at = NOW(),
              updated_by = ?
        WHERE config_key = ?`,
      [
        payload.maintenance_mode ? 1 : 0,
        payload.maintenance_message,
        payload.allow_vendor_registration ? 1 : 0,
        payload.commission_rate,
        payload.max_upload_size_mb,
        payload.public_notice_enabled ? 1 : 0,
        payload.public_notice_message,
        payload.public_notice_variant,
        payload.updated_by,
        payload.config_key,
      ]
    );

    const rows = await mysqlQuery(
      `SELECT *
         FROM system_config
        WHERE config_key = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
      [payload.config_key]
    );
    const saved = rows[0] || payload;

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SYSTEM_CONFIG_UPDATED',
      entityType: 'system_config',
      entityId: saved?.id || existing?.id || null,
      details: {
        maintenance_mode: payload.maintenance_mode,
        maintenance_message: payload.maintenance_message,
        public_notice_enabled: payload.public_notice_enabled,
        public_notice_variant: payload.public_notice_variant,
      },
    });

    return res.json({
      success: true,
      config: {
        ...saved,
        maintenance_mode: normalizeBooleanInput(saved?.maintenance_mode, false),
        allow_vendor_registration: normalizeBooleanInput(saved?.allow_vendor_registration, true),
        public_notice_enabled: normalizeBooleanInput(saved?.public_notice_enabled, false),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// Page status controls
// -----------------------
router.get('/page-status', async (_req, res) => {
  try {
    const { data, error } = await db
      .from('page_status')
      .select('*')
      .order('page_name', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      pages: (data || []).map((page) => ({
        ...page,
        is_blanked: normalizeBooleanInput(page?.is_blanked, false),
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/page-status', async (req, res) => {
  try {
    const page_name = String(req.body?.page_name || '').trim();
    const page_route = String(req.body?.page_route || '').trim();
    const error_message = String(req.body?.error_message || '').trim();

    if (!page_name || !page_route) {
      return res.status(400).json({ success: false, error: 'page_name and page_route are required' });
    }

    const payload = {
      page_name,
      page_route,
      error_message,
      is_blanked: false,
      updated_at: nowIso(),
    };

    const { data, error } = await db
      .from('page_status')
      .insert([payload])
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'PAGE_STATUS_CREATED',
      entityType: 'page_status',
      entityId: data?.id || null,
      details: { page_name, page_route },
    });

    return res.json({ success: true, page: data || payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/page-status/:pageId', async (req, res) => {
  try {
    const pageId = req.params.pageId;
    if (!pageId) {
      return res.status(400).json({ success: false, error: 'pageId is required' });
    }

    const updates = {
      updated_at: nowIso(),
    };

    if (hasOwn(req.body || {}, 'is_blanked')) {
      updates.is_blanked = normalizeBooleanInput(req.body?.is_blanked, false);
    }
    if (req.body?.error_message != null) updates.error_message = String(req.body.error_message || '');
    if (req.body?.page_title != null) updates.page_title = String(req.body.page_title || '');
    if (req.body?.page_description != null) updates.page_description = String(req.body.page_description || '');

    const { data, error } = await db
      .from('page_status')
      .update(updates)
      .eq('id', pageId)
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'PAGE_STATUS_UPDATED',
      entityType: 'page_status',
      entityId: pageId,
      details: updates,
    });

    return res.json({
      success: true,
      page: data ? { ...data, is_blanked: normalizeBooleanInput(data?.is_blanked, false) } : null,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/page-status/:pageId', async (req, res) => {
  try {
    const pageId = req.params.pageId;
    if (!pageId) {
      return res.status(400).json({ success: false, error: 'pageId is required' });
    }

    const { data: existing } = await db
      .from('page_status')
      .select('id, page_name, page_route')
      .eq('id', pageId)
      .maybeSingle();

    const { error } = await db.from('page_status').delete().eq('id', pageId);
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'PAGE_STATUS_DELETED',
      entityType: 'page_status',
      entityId: pageId,
      details: existing || {},
    });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// Audit logs
// -----------------------
router.get('/audit-logs', async (req, res) => {
  try {
    const limit = clampLimit(req.query?.limit, 300, 2000);
    const hoursBack = Number(req.query?.hoursBack ?? req.query?.hours_back ?? 168);
    const actorTypeFilter = String(req.query?.actor_type || '').trim().toUpperCase();
    const entityTypeFilter = String(req.query?.entity_type || '').trim();
    const actionContains = String(req.query?.action_contains || '').trim().toUpperCase();

    const cutoff = Number.isFinite(hoursBack) && hoursBack > 0 ? new Date(Date.now() - hoursBack * 60 * 60 * 1000) : null;

    let query = db
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (cutoff) {
      query = query.gte('created_at', cutoff.toISOString());
    }
    if (entityTypeFilter) {
      query = query.eq('entity_type', entityTypeFilter);
    }
    if (actionContains) {
      query = query.ilike('action', `%${actionContains}%`);
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    let logs = data || [];

    if (actorTypeFilter) {
      logs = logs.filter((log) => String(log?.details?.actor_type || '').toUpperCase() === actorTypeFilter);
    }

    return res.json({
      success: true,
      logs: logs.map((log) => ({
        ...log,
        actor: {
          id: log?.details?.actor_id || log.user_id || null,
          type: log?.details?.actor_type || null,
          role: log?.details?.actor_role || null,
          email: log?.details?.actor_email || null,
        },
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ===========================================================
// MONITORING ROUTES — SuperAdmin sees all regions
// ===========================================================

const KYC_REVIEW_STATUSES = new Set(['PENDING', 'SUBMITTED']);
const MONITORING_BATCH_SIZE = 1000;
const UNASSIGNED_REGION = { code: 'UNASSIGNED', name: 'Unassigned', sort_order: 999 };

function normalizeText(value) {
  return String(value ?? '').trim();
}

// Monitoring queries page through large tables to avoid capped API responses.
async function fetchAllRows(buildQuery, pageSize = MONITORING_BATCH_SIZE) {
  const rows = [];

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message || 'Failed to fetch paginated rows');
    if (!Array.isArray(data) || data.length === 0) break;

    rows.push(...data);
    if (data.length < pageSize) break;
  }

  return rows;
}

async function loadStateCatalog() {
  const [{ data: states, error: statesErr }, { data: regions, error: regionsErr }] = await Promise.all([
    db
      .from('states')
      .select('id, name, slug, region_code')
      .order('name', { ascending: true }),
    db
      .from('regions')
      .select('code, name, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
  ]);

  if (statesErr) throw new Error(statesErr.message || 'Failed to load states');
  if (regionsErr) throw new Error(regionsErr.message || 'Failed to load regions');

  const regionByCode = new Map(
    [UNASSIGNED_REGION, ...(regions || [])].map((region) => {
      const code = normalizeText(region.code).toUpperCase();
      return [
        code,
        {
          code,
          name: normalizeText(region.name) || code,
          sort_order: Number(region.sort_order ?? UNASSIGNED_REGION.sort_order),
        },
      ];
    })
  );

  const catalogStates = (states || []).map((state) => {
    const regionCode = normalizeText(state.region_code).toUpperCase() || UNASSIGNED_REGION.code;
    const region = regionByCode.get(regionCode) || UNASSIGNED_REGION;
    return {
      id: String(state.id),
      name: normalizeText(state.name),
      slug: normalizeText(state.slug),
      region_code: region.code,
      region_name: region.name,
      region_sort_order: Number(region.sort_order ?? UNASSIGNED_REGION.sort_order),
    };
  });

  return {
    states: catalogStates,
    regions: Array.from(regionByCode.values()).sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name)),
    stateById: new Map(catalogStates.map((state) => [state.id, state])),
    stateByName: new Map(catalogStates.map((state) => [state.name.toLowerCase(), state])),
  };
}

function resolveStateInfo(stateId, fallbackState, stateCatalog) {
  if (stateId) {
    const state = stateCatalog.stateById.get(String(stateId));
    if (state) return state;
  }

  const fallback = normalizeText(fallbackState);
  if (fallback) {
    const state = stateCatalog.stateByName.get(fallback.toLowerCase());
    if (state) return state;
  }

  return {
    id: '',
    name: fallback || 'Unknown',
    slug: '',
    region_code: UNASSIGNED_REGION.code,
    region_name: UNASSIGNED_REGION.name,
    region_sort_order: UNASSIGNED_REGION.sort_order,
  };
}

function normalizeRequestedStateScope(rawScope, stateCatalog) {
  const values = Array.isArray(rawScope) ? rawScope : [];
  const seen = new Set();
  const invalid = [];
  const stateIds = [];
  const stateNames = [];

  values.forEach((value) => {
    const raw = normalizeText(
      typeof value === 'object' && value !== null
        ? (value.id ?? value.state_id ?? value.name ?? '')
        : value
    );
    if (!raw) return;

    const state =
      stateCatalog.stateById.get(raw) ||
      stateCatalog.stateByName.get(raw.toLowerCase()) ||
      null;

    if (!state) {
      invalid.push(raw);
      return;
    }

    if (seen.has(state.id)) return;
    seen.add(state.id);
    stateIds.push(state.id);
    stateNames.push(state.name);
  });

  if (invalid.length) {
    const err = new Error(`Invalid states: ${invalid.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  return { stateIds, stateNames };
}

async function loadEmployeeScopeRows(employeeIds = []) {
  const ids = [...new Set((employeeIds || []).map((id) => normalizeText(id)).filter(Boolean))];
  if (!ids.length) return [];

  const { data, error } = await db
    .from('employee_state_scope')
    .select('employee_id, state_id')
    .in('employee_id', ids);

  if (error) throw new Error(error.message || 'Failed to load employee state scope');
  return data || [];
}

async function hydrateEmployeesWithStateScope(employees = [], stateCatalog = null) {
  const catalog = stateCatalog || await loadStateCatalog();
  const employeeIds = employees.map((employee) => employee?.id).filter(Boolean);
  const scopeRows = await loadEmployeeScopeRows(employeeIds);
  const scopeByEmployeeId = new Map(employeeIds.map((id) => [String(id), []]));

  (scopeRows || []).forEach((row) => {
    const key = String(row.employee_id || '');
    if (!scopeByEmployeeId.has(key)) scopeByEmployeeId.set(key, []);
    scopeByEmployeeId.get(key).push(String(row.state_id || ''));
  });

  return employees.map((employee) => {
    const employeeId = String(employee?.id || '');
    let stateIds = [...new Set((scopeByEmployeeId.get(employeeId) || []).filter((id) => catalog.stateById.has(id)))];

    if (!stateIds.length && Array.isArray(employee?.states_scope) && employee.states_scope.length > 0) {
      stateIds = normalizeRequestedStateScope(employee.states_scope, catalog).stateIds;
    }

    const stateNames = stateIds
      .map((stateId) => catalog.stateById.get(stateId)?.name || '')
      .filter(Boolean);

    return {
      ...employee,
      state_scope_ids: stateIds,
      states_scope: stateNames,
    };
  });
}

async function syncEmployeeStateScope(employeeId, rawScope, stateCatalog = null) {
  const catalog = stateCatalog || await loadStateCatalog();
  const { stateIds, stateNames } = normalizeRequestedStateScope(rawScope, catalog);

  const { error: deleteError } = await db
    .from('employee_state_scope')
    .delete()
    .eq('employee_id', employeeId);

  if (deleteError) throw new Error(deleteError.message || 'Failed to clear employee state scope');

  if (stateIds.length > 0) {
    const { error: insertError } = await db
      .from('employee_state_scope')
      .insert(
        stateIds.map((stateId) => ({
          employee_id: employeeId,
          state_id: stateId,
          created_at: nowIso(),
          updated_at: nowIso(),
        }))
      );

    if (insertError) throw new Error(insertError.message || 'Failed to save employee state scope');
  }

  const { error: employeeUpdateError } = await db
    .from('employees')
    .update({ states_scope: stateNames, updated_at: nowIso() })
    .eq('id', employeeId);

  if (employeeUpdateError) throw new Error(employeeUpdateError.message || 'Failed to mirror employee state scope');

  return { stateIds, stateNames, stateCatalog: catalog };
}

// GET /monitoring/overview
// All-India + per-region: revenue, vendor count, KYC pending, open tickets, admin list
router.get('/monitoring/overview', requireSuperAdmin, async (req, res) => {
  try {
    const [
      { data: adminEmployeesRaw, error: empErr },
      stateCatalog,
      vendors,
      payments,
      tickets,
    ] = await Promise.all([
      db
        .from('employees')
        .select('id, full_name, email, role, status, states_scope, last_login, created_at')
        .eq('role', 'ADMIN')
        .order('created_at', { ascending: false }),
      loadStateCatalog(),
      fetchAllRows(() =>
        db
          .from('vendors')
          .select('id, state_id, state, kyc_status, is_active')
          .order('id', { ascending: true })
      ),
      fetchAllRows(() =>
        db
          .from('vendor_payments')
          .select('id, vendor_id, amount, net_amount, payment_date')
          .order('id', { ascending: true })
      ),
      fetchAllRows(() =>
        db
          .from('support_tickets')
          .select('id, status, vendor_id, created_at')
          .not('status', 'eq', 'RESOLVED')
          .order('id', { ascending: true })
      ),
    ]);

    if (empErr) return res.status(500).json({ success: false, error: empErr.message });
    const adminEmployees = await hydrateEmployeesWithStateScope(adminEmployeesRaw || [], stateCatalog);

    // --- All-India totals ---
    const allVendors = vendors || [];
    const allPayments = payments || [];
    const allTickets = tickets || [];
    const vendorStateById = new Map();
    const regionSortOrderByName = new Map((stateCatalog.regions || []).map((region) => [region.name, Number(region.sort_order ?? UNASSIGNED_REGION.sort_order)]));

    const totalRevenue = allPayments.reduce((s, p) => s + Number(p.net_amount ?? p.amount ?? 0), 0);
    const totalVendors = allVendors.filter((v) => v.is_active).length;
    const kycPending = allVendors.filter((v) => KYC_REVIEW_STATUSES.has(normalizeText(v.kyc_status).toUpperCase())).length;
    const openTickets = allTickets.length;

    // --- Per-state aggregation ---
    const byState = {};

    allVendors.forEach((v) => {
      const stateInfo = resolveStateInfo(v.state_id, v.state, stateCatalog);
      const state = stateInfo.name;
      vendorStateById.set(String(v.id), stateInfo);
      if (!byState[state]) {
        byState[state] = {
          state,
          region: stateInfo.region_name,
          region_sort_order: Number(stateInfo.region_sort_order ?? UNASSIGNED_REGION.sort_order),
          revenue: 0,
          vendors: 0,
          kycPending: 0,
          openTickets: 0,
        };
      }
      if (v.is_active) byState[state].vendors += 1;
      if (KYC_REVIEW_STATUSES.has(normalizeText(v.kyc_status).toUpperCase())) byState[state].kycPending += 1;
    });

    allPayments.forEach((p) => {
      const stateInfo = vendorStateById.get(String(p.vendor_id)) || resolveStateInfo('', 'Unknown', stateCatalog);
      const state = stateInfo.name;
      if (!byState[state]) {
        byState[state] = {
          state,
          region: stateInfo.region_name,
          region_sort_order: Number(stateInfo.region_sort_order ?? UNASSIGNED_REGION.sort_order),
          revenue: 0,
          vendors: 0,
          kycPending: 0,
          openTickets: 0,
        };
      }
      byState[state].revenue += Number(p.net_amount ?? p.amount ?? 0);
    });

    allTickets.forEach((t) => {
      const stateInfo = vendorStateById.get(String(t.vendor_id)) || resolveStateInfo('', 'Unknown', stateCatalog);
      const state = stateInfo.name;
      if (!byState[state]) {
        byState[state] = {
          state,
          region: stateInfo.region_name,
          region_sort_order: Number(stateInfo.region_sort_order ?? UNASSIGNED_REGION.sort_order),
          revenue: 0,
          vendors: 0,
          kycPending: 0,
          openTickets: 0,
        };
      }
      byState[state].openTickets += 1;
    });

    // --- Per-region rollup ---
    const byRegion = {};
    Object.values(byState).forEach((s) => {
      const r = s.region;
      if (!byRegion[r]) {
        byRegion[r] = {
          region: r,
          region_sort_order: Number(regionSortOrderByName.get(r) ?? s.region_sort_order ?? UNASSIGNED_REGION.sort_order),
          revenue: 0,
          vendors: 0,
          kycPending: 0,
          openTickets: 0,
          states: [],
        };
      }
      byRegion[r].revenue += s.revenue;
      byRegion[r].vendors += s.vendors;
      byRegion[r].kycPending += s.kycPending;
      byRegion[r].openTickets += s.openTickets;
      byRegion[r].states.push(s.state);
    });

    // --- Per-admin enrichment: attach region/states + stats from their states_scope ---
    const admins = (adminEmployees || []).map((emp) => {
      const scope = Array.isArray(emp.states_scope) ? emp.states_scope : [];
      const scopeLower = scope.map((s) => String(s).toLowerCase().trim());
      let empRevenue = 0, empVendors = 0, empKyc = 0, empTickets = 0;

      Object.values(byState).forEach((s) => {
        if (scopeLower.length === 0 || scopeLower.includes(s.state.toLowerCase())) {
          empRevenue += s.revenue;
          empVendors += s.vendors;
          empKyc += s.kycPending;
          empTickets += s.openTickets;
        }
      });

      return {
        id: emp.id,
        full_name: emp.full_name,
        email: emp.email,
        status: emp.status,
        states_scope: scope,
        state_scope_ids: Array.isArray(emp.state_scope_ids) ? emp.state_scope_ids : [],
        last_login: emp.last_login,
        revenue: scopeLower.length > 0 ? empRevenue : null,
        vendors: scopeLower.length > 0 ? empVendors : null,
        kycPending: scopeLower.length > 0 ? empKyc : null,
        openTickets: scopeLower.length > 0 ? empTickets : null,
      };
    });

    return res.json({
      success: true,
      data: {
        allIndia: { totalRevenue, totalVendors, kycPending, openTickets },
        byRegion: Object.values(byRegion).sort((a, b) => (a.region_sort_order - b.region_sort_order) || (b.revenue - a.revenue) || a.region.localeCompare(b.region)),
        byState: Object.values(byState).sort((a, b) => (b.revenue - a.revenue) || (b.vendors - a.vendors) || a.state.localeCompare(b.state)),
        admins,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monitoring/admin-activity
// Per-admin: actions this week from audit_logs
router.get('/monitoring/admin-activity', requireSuperAdmin, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days ?? 7), 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [logs, { data: adminsRaw, error: adminsErr }, stateCatalog] = await Promise.all([
      fetchAllRows(() =>
        db
          .from('audit_logs')
          .select('id, user_id, action, details, created_at')
          .gte('created_at', cutoff)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
      ),
      db
        .from('employees')
        .select('id, full_name, email, role, states_scope, last_login, status')
        .eq('role', 'ADMIN'),
      loadStateCatalog(),
    ]);

    if (adminsErr) return res.status(500).json({ success: false, error: adminsErr.message });
    const admins = await hydrateEmployeesWithStateScope(adminsRaw || [], stateCatalog);

    const adminMap = {};
    (admins || []).forEach((a) => {
      adminMap[a.id] = {
        ...a,
        actionsTotal: 0,
        kycApproved: 0,
        kycRejected: 0,
        vendorsTerminated: 0,
        vendorsActivated: 0,
        staffCreated: 0,
        ticketsResolved: 0,
        recentActions: [],
      };
    });

    (logs || []).forEach((log) => {
      const actorId = log.details?.actor_id || log.user_id;
      if (!actorId || !adminMap[actorId]) return;
      const entry = adminMap[actorId];
      entry.actionsTotal += 1;

      const action = String(log.action || '').toUpperCase();
      if (action.includes('KYC_APPROV')) entry.kycApproved += 1;
      else if (action.includes('KYC_REJECT')) entry.kycRejected += 1;
      else if (action.includes('VENDOR_TERM')) entry.vendorsTerminated += 1;
      else if (action.includes('VENDOR_ACTIV')) entry.vendorsActivated += 1;
      else if (action.includes('STAFF_CREAT') || action.includes('EMPLOYEE_CREAT')) entry.staffCreated += 1;
      else if (action.includes('TICKET') && action.includes('RESOLV')) entry.ticketsResolved += 1;

      if (entry.recentActions.length < 5) {
        entry.recentActions.push({ action: log.action, created_at: log.created_at });
      }
    });

    const activity = Object.values(adminMap).sort((a, b) => b.actionsTotal - a.actionsTotal);

    return res.json({ success: true, data: { days, activity } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monitoring/revenue-by-state
// Revenue + payment count per state, with this-month vs last-month comparison
router.get('/monitoring/revenue-by-state', requireSuperAdmin, async (req, res) => {
  try {
    const [stateCatalog, vendors, payments] = await Promise.all([
      loadStateCatalog(),
      fetchAllRows(() =>
        db
          .from('vendors')
          .select('id, state_id, state')
          .order('id', { ascending: true })
      ),
      fetchAllRows(() =>
        db
          .from('vendor_payments')
          .select('id, vendor_id, amount, net_amount, payment_date')
          .order('payment_date', { ascending: false })
          .order('id', { ascending: false })
      ),
    ]);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const byState = {};
    const vendorStateById = new Map((vendors || []).map((vendor) => [
      String(vendor.id),
      resolveStateInfo(vendor.state_id, vendor.state, stateCatalog),
    ]));

    (payments || []).forEach((p) => {
      const stateInfo = vendorStateById.get(String(p.vendor_id)) || resolveStateInfo('', 'Unknown', stateCatalog);
      const state = stateInfo.name;
      const region = stateInfo.region_name;
      const amt = Number(p.net_amount ?? p.amount ?? 0);
      const date = p.payment_date ? new Date(p.payment_date) : null;

      if (!byState[state]) {
        byState[state] = { state, region, totalRevenue: 0, paymentCount: 0, thisMonth: 0, lastMonth: 0 };
      }

      byState[state].totalRevenue += amt;
      byState[state].paymentCount += 1;

      if (date) {
        if (date >= thisMonthStart) byState[state].thisMonth += amt;
        else if (date >= lastMonthStart) byState[state].lastMonth += amt;
      }
    });

    const stateList = Object.values(byState)
      .sort((a, b) => (b.totalRevenue - a.totalRevenue) || (b.paymentCount - a.paymentCount) || a.state.localeCompare(b.state))
      .map((s) => ({
        ...s,
        trend: s.lastMonth > 0 ? ((s.thisMonth - s.lastMonth) / s.lastMonth) * 100 : null,
      }));

    return res.json({ success: true, data: stateList });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /employees/:id/states-scope — SuperAdmin updates an Admin's state coverage
router.put('/employees/:id/states-scope', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const rawStates = Array.isArray(req.body?.state_scope_ids) ? req.body.state_scope_ids : req.body?.states_scope;

    if (!Array.isArray(rawStates)) {
      return res.status(400).json({ success: false, error: 'state_scope_ids or states_scope must be an array' });
    }

    const { data: emp } = await db
      .from('employees')
      .select('id, role, full_name, email')
      .eq('id', id)
      .maybeSingle();

    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (emp.role !== 'ADMIN') {
      return res.status(400).json({ success: false, error: 'states_scope can only be set on ADMIN employees' });
    }

    const stateCatalog = await loadStateCatalog();
    const { stateIds, stateNames } = await syncEmployeeStateScope(id, rawStates, stateCatalog);

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'ADMIN_STATES_SCOPE_UPDATED',
      entityType: 'employees',
      entityId: id,
      details: { email: emp.email, state_scope_ids: stateIds, states_scope: stateNames },
    });

    return res.json({ success: true, state_scope_ids: stateIds, states_scope: stateNames });
  } catch (err) {
    return res.status(err?.statusCode || 500).json({ success: false, error: err.message });
  }
});

router.get('/visitor-activity', async (req, res) => {
  try {
    const data = await getWebsiteVisitorActivity({
      days: req.query?.days,
      limit: req.query?.limit,
      includeTechnical: normalizeRole(req.superadmin?.role) === 'GODMODE',
    });

    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load visitor activity' });
  }
});

router.get('/behavioral-intelligence', requireSuperAdmin, async (req, res) => {
  try {
    const data = await getBehavioralCommerceIntelligence({
      days: req.query?.days,
      limit: req.query?.limit,
      refresh: req.query?.refresh,
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to load behavioral commerce intelligence',
    });
  }
});

// ===========================================================
// GOD MODE ONLY ROUTES — Developer only, SUPERADMIN blocked
// ===========================================================

// List all superadmin accounts (GOD MODE sees everyone)
router.get('/godmode/superadmins', requireGodMode, async (req, res) => {
  try {
    const { data, error } = await db
      .from('superadmin_users')
      .select('id, email, role, is_active, last_login, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'GODMODE_SUPERADMINS_VIEWED',
      entityType: 'superadmin_users',
      details: { count: data?.length || 0 },
    });

    return res.json({ success: true, superadmins: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Create a SUPERADMIN account (ITM owner) — GOD MODE only
router.post('/godmode/superadmins', requireGodMode, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '').trim();
    const fullName = String(req.body?.full_name || '').trim();

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'email and password are required' });
    }

    // Only SUPERADMIN role can be created here (not GODMODE — there can only be 1 GOD MODE)
    const role = 'SUPERADMIN';

    const { data: existing } = await db
      .from('superadmin_users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing?.id) {
      return res.status(400).json({ success: false, error: 'A superadmin with this email already exists' });
    }

    const bcrypt = await import('bcryptjs');
    const password_hash = await bcrypt.default.hash(password, 10);

    const { data, error } = await insertSuperadminWithFallback({
      email,
      full_name: fullName || email,
      role,
      password_hash,
      is_active: true,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SUPERADMIN_CREATED',
      entityType: 'superadmin_users',
      entityId: data?.id || null,
      details: { email, role },
    });

    return res.json({ success: true, superadmin: data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Toggle active/inactive for a SUPERADMIN account — GOD MODE only
router.put('/godmode/superadmins/:id/toggle-active', requireGodMode, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data: target, error: fetchError } = await db
      .from('superadmin_users')
      .select('id, email, role, is_active')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, error: fetchError.message });
    if (!target) return res.status(404).json({ success: false, error: 'Superadmin not found' });

    // Cannot deactivate GOD MODE account via this endpoint
    if (target.role === 'GODMODE') {
      return res.status(403).json({ success: false, error: 'Cannot deactivate GOD MODE account' });
    }

    const newStatus = !target.is_active;

    const { data, error } = await db
      .from('superadmin_users')
      .update({ is_active: newStatus, updated_at: nowIso() })
      .eq('id', id)
      .select('id, email, role, is_active')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: newStatus ? 'SUPERADMIN_ACTIVATED' : 'SUPERADMIN_DEACTIVATED',
      entityType: 'superadmin_users',
      entityId: id,
      details: { email: target.email, role: target.role, is_active: newStatus },
    });

    return res.json({ success: true, superadmin: data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a SUPERADMIN account — GOD MODE only
router.delete('/godmode/superadmins/:id', requireGodMode, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data: target, error: fetchError } = await db
      .from('superadmin_users')
      .select('id, email, role')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) return res.status(500).json({ success: false, error: fetchError.message });
    if (!target) return res.status(404).json({ success: false, error: 'Superadmin not found' });

    // Cannot delete own GOD MODE account
    if (target.role === 'GODMODE') {
      return res.status(403).json({ success: false, error: 'Cannot delete GOD MODE account' });
    }

    const { error } = await db.from('superadmin_users').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SUPERADMIN_DELETED',
      entityType: 'superadmin_users',
      entityId: id,
      details: { email: target.email, role: target.role },
    });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Reset SUPERADMIN password — GOD MODE only
router.put('/godmode/superadmins/:id/password', requireGodMode, async (req, res) => {
  try {
    const id = req.params.id;
    const newPassword = String(req.body?.password || '').trim();

    if (!id) return res.status(400).json({ success: false, error: 'id is required' });
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const { data: target } = await db
      .from('superadmin_users')
      .select('id, email, role')
      .eq('id', id)
      .maybeSingle();

    if (!target) return res.status(404).json({ success: false, error: 'Superadmin not found' });
    if (target.role === 'GODMODE') {
      return res.status(403).json({ success: false, error: 'Use /password endpoint to change your own GOD MODE password' });
    }

    const bcrypt = await import('bcryptjs');
    const password_hash = await bcrypt.default.hash(newPassword, 10);

    const { error } = await db
      .from('superadmin_users')
      .update({ password_hash, updated_at: nowIso() })
      .eq('id', id);

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SUPERADMIN_PASSWORD_RESET',
      entityType: 'superadmin_users',
      entityId: id,
      details: { email: target.email },
    });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
