import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { notifyUser } from '../lib/notify.js';
import { writeAuditLog } from '../lib/audit.js';
import {
  getPublicUserByEmail,
  hashPassword,
  normalizeEmail,
  setPublicUserPassword,
  upsertPublicUser,
} from '../lib/auth.js';
import {
  loginSuperAdmin,
  requireSuperAdmin,
  requireGodMode,
  changeSuperAdminPassword,
} from '../lib/superadminAuth.js';

const router = express.Router();

// SUPERADMIN (ITM Owner) can only create ADMIN role employees.
// ADMIN creates HR/FINANCE. HR creates SALES/SUPPORT/DATA_ENTRY/MANAGER/VP.
const EMPLOYEE_ALLOWED_ROLES = ['ADMIN'];

const normalizeRole = (role) => String(role || '').trim().toUpperCase();

const nowIso = () => new Date().toISOString();

async function findPublicUserByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;

  const { data, error } = await supabase
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
    const { data, error } = await supabase
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

  await supabase
    .from('employees')
    .update({ user_id: userId })
    .eq('id', employee.id);

  return { userId, created };
}

async function insertSuperadminWithFallback(payload) {
  const first = await supabase
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

  return supabase
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

  return next;
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
  const first = await supabase
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

  const retry = await supabase
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
  const first = await supabase
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

  const retry = await supabase
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

  const { data: subscriptions, error: subError } = await supabase
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

  const { error: quotaError } = await supabase
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
  const { data, error } = await supabase
    .from('system_config')
    .select('*')
    .eq('config_key', key)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data) return data;

  const payload = {
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

  const { data: inserted, error: insertError } = await supabase
    .from('system_config')
    .upsert(payload, { onConflict: 'config_key' })
    .select('*')
    .maybeSingle();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return inserted || payload;
}

async function deleteVendorCascade(vendorId) {
  const { data: vendor, error: vendorError } = await supabase
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
  const { data: products } = await supabase
    .from('products')
    .select('id')
    .eq('vendor_id', vendorId);
  const productIds = (products || []).map((p) => p.id).filter(Boolean);
  if (productIds.length > 0) {
    await supabase.from('product_images').delete().in('product_id', productIds);
  }
  await supabase.from('products').delete().eq('vendor_id', vendorId);

  // Ticket messages -> support tickets
  const { data: tickets } = await supabase
    .from('support_tickets')
    .select('id')
    .eq('vendor_id', vendorId);
  const ticketIds = (tickets || []).map((t) => t.id).filter(Boolean);
  if (ticketIds.length > 0) {
    await supabase.from('ticket_messages').delete().in('ticket_id', ticketIds);
  }
  await supabase.from('support_tickets').delete().eq('vendor_id', vendorId);

  // Leads referencing vendor must be detached to avoid FK errors.
  await supabase
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
    await supabase.from(table).delete().eq('vendor_id', vendorId);
  }

  // Finally delete vendor row.
  const { error: deleteVendorError } = await supabase.from('vendors').delete().eq('id', vendorId);
  if (deleteVendorError) {
    throw new Error(deleteVendorError.message);
  }

  // Best-effort delete of the auth user tied to this vendor.
  if (vendorUserId) {
    try {
      await supabase.from('users').delete().eq('id', vendorUserId);
    } catch (error) {
      logger.warn('[SuperAdmin] Failed to delete vendor public user:', error?.message || error);
    }
  }

  return vendor;
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

// All routes below require superadmin.
router.use(requireSuperAdmin);

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
    const { data, error } = await supabase
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

    const { data: employee, error: empError } = await supabase
      .from('employees')
      .insert([empPayload])
      .select('*')
      .maybeSingle();

    if (empError) {
        try {
          await supabase.from('users').delete().eq('id', userId);
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

    const { data: employee, error: empError } = await supabase
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

    await supabase.from('employees').delete().eq('id', employeeId);

      if (employee.user_id) {
        await supabase.from('users').delete().eq('id', employee.user_id);
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

    const { data: employee, error: empError } = await supabase
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
    const { data, error, count } = await supabase
      .from('vendors')
      .select(
        'id, vendor_id, company_name, owner_name, email, phone, kyc_status, created_at, is_active, is_verified, city, state',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDORS_VIEWED',
      entityType: 'vendors',
      details: { count: data?.length || 0, total: Number(count) || 0, limit, offset },
    });

    return res.json({
      success: true,
      vendors: data || [],
      total: Number(count) || 0,
      limit,
      offset,
    });
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

    let query = supabase
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
      is_active: req.body?.is_active !== false,
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

    const { data: existing, error: existingError } = await supabase
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
    if (hasOwn(req.body, 'is_active')) updates.is_active = req.body?.is_active === true;

    const hasFeatureUpdate =
      hasOwn(req.body, 'features') ||
      hasOwn(req.body, 'original_price') ||
      hasOwn(req.body, 'discount_percent') ||
      hasOwn(req.body, 'discount_label') ||
      hasOwn(req.body, 'extra_lead_price') ||
      hasOwn(req.body, 'badge_label') ||
      hasOwn(req.body, 'badge_variant') ||
      hasOwn(req.body, 'states_limit') ||
      hasOwn(req.body, 'cities_limit');

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

    const { data: existing, error: existingError } = await supabase
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
      supabase
        .from('vendor_plan_subscriptions')
        .select('id', { head: true, count: 'exact' })
        .eq('plan_id', planId)
        .eq('status', 'ACTIVE'),
      supabase
        .from('vendor_plan_subscriptions')
        .select('id', { head: true, count: 'exact' })
        .eq('plan_id', planId),
      supabase
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

    if ((activeSubscriptionCount || 0) > 0) {
      return res.status(400).json({
        success: false,
        error: 'Plan has active vendor subscriptions. Disable it instead of deleting.',
      });
    }

    if ((subscriptionHistoryCount || 0) > 0 || (paymentHistoryCount || 0) > 0) {
      return res.status(400).json({
        success: false,
        error: 'Plan has subscription/payment history. Keep it inactive instead of deleting.',
      });
    }

    const { error: deleteError } = await supabase
      .from('vendor_plans')
      .delete()
      .eq('id', planId);

    if (deleteError) {
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
    const { data: payments, error } = await supabase
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
    let query = supabase
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
    return res.json({ success: true, config: row });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/system-config', async (req, res) => {
  try {
    const existing = await ensureSystemConfigRow(req.superadmin?.id);

    const payload = {
      config_key: 'maintenance_mode',
      maintenance_mode: req.body?.maintenance_mode === true,
      maintenance_message: String(req.body?.maintenance_message || ''),
      allow_vendor_registration:
        typeof req.body?.allow_vendor_registration === 'boolean'
          ? req.body.allow_vendor_registration
          : existing.allow_vendor_registration ?? true,
      commission_rate:
        req.body?.commission_rate != null ? Number(req.body.commission_rate) || 0 : existing.commission_rate,
      max_upload_size_mb:
        req.body?.max_upload_size_mb != null
          ? Number(req.body.max_upload_size_mb) || 0
          : existing.max_upload_size_mb,
      public_notice_enabled: req.body?.public_notice_enabled === true,
      public_notice_message: String(req.body?.public_notice_message || ''),
      public_notice_variant: String(req.body?.public_notice_variant || existing.public_notice_variant || 'info'),
      updated_at: nowIso(),
      updated_by: req.superadmin?.id || null,
    };

    const { data, error } = await supabase
      .from('system_config')
      .upsert(payload, { onConflict: 'config_key' })
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SYSTEM_CONFIG_UPDATED',
      entityType: 'system_config',
      entityId: existing?.id || null,
      details: {
        maintenance_mode: payload.maintenance_mode,
        maintenance_message: payload.maintenance_message,
        public_notice_enabled: payload.public_notice_enabled,
        public_notice_variant: payload.public_notice_variant,
      },
    });

    return res.json({ success: true, config: data || payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------
// Page status controls
// -----------------------
router.get('/page-status', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('page_status')
      .select('*')
      .order('page_name', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, pages: data || [] });
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

    const { data, error } = await supabase
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

    if (typeof req.body?.is_blanked === 'boolean') updates.is_blanked = req.body.is_blanked;
    if (req.body?.error_message != null) updates.error_message = String(req.body.error_message || '');
    if (req.body?.page_title != null) updates.page_title = String(req.body.page_title || '');
    if (req.body?.page_description != null) updates.page_description = String(req.body.page_description || '');

    const { data, error } = await supabase
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

    return res.json({ success: true, page: data || null });
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

    const { data: existing } = await supabase
      .from('page_status')
      .select('id, page_name, page_route')
      .eq('id', pageId)
      .maybeSingle();

    const { error } = await supabase.from('page_status').delete().eq('id', pageId);
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

    let query = supabase
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

// Supabase REST responses are capped per request, so monitoring queries must page through large tables.
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
    supabase
      .from('states')
      .select('id, name, slug, region_code')
      .order('name', { ascending: true }),
    supabase
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

  const { data, error } = await supabase
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

  const { error: deleteError } = await supabase
    .from('employee_state_scope')
    .delete()
    .eq('employee_id', employeeId);

  if (deleteError) throw new Error(deleteError.message || 'Failed to clear employee state scope');

  if (stateIds.length > 0) {
    const { error: insertError } = await supabase
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

  const { error: employeeUpdateError } = await supabase
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
      supabase
        .from('employees')
        .select('id, full_name, email, role, status, states_scope, last_login, created_at')
        .eq('role', 'ADMIN')
        .order('created_at', { ascending: false }),
      loadStateCatalog(),
      fetchAllRows(() =>
        supabase
          .from('vendors')
          .select('id, state_id, state, kyc_status, is_active')
          .order('id', { ascending: true })
      ),
      fetchAllRows(() =>
        supabase
          .from('vendor_payments')
          .select('id, vendor_id, amount, net_amount, payment_date')
          .order('id', { ascending: true })
      ),
      fetchAllRows(() =>
        supabase
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
        supabase
          .from('audit_logs')
          .select('id, user_id, action, details, created_at')
          .gte('created_at', cutoff)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
      ),
      supabase
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
        supabase
          .from('vendors')
          .select('id, state_id, state')
          .order('id', { ascending: true })
      ),
      fetchAllRows(() =>
        supabase
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

    const { data: emp } = await supabase
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

// ===========================================================
// GOD MODE ONLY ROUTES — Developer only, SUPERADMIN blocked
// ===========================================================

// List all superadmin accounts (GOD MODE sees everyone)
router.get('/godmode/superadmins', requireGodMode, async (req, res) => {
  try {
    const { data, error } = await supabase
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

    const { data: existing } = await supabase
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

    const { data: target, error: fetchError } = await supabase
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

    const { data, error } = await supabase
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

    const { data: target, error: fetchError } = await supabase
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

    const { error } = await supabase.from('superadmin_users').delete().eq('id', id);
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

    const { data: target } = await supabase
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

    const { error } = await supabase
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
