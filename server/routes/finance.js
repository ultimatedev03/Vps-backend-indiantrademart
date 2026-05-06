import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { writeAuditLog } from '../lib/audit.js';
import { requireEmployeeRoles } from '../middleware/requireEmployeeRoles.js';
import { getReferralSettings } from '../lib/referralProgram.js';

const router = express.Router();

const COUPON_EXPIRY_SYNC_ATTEMPTS = [
  { table: 'coupons', expiresColumn: 'expires_at' },
  { table: 'coupons', expiresColumn: 'expiry_at' },
  { table: 'coupons', expiresColumn: 'valid_till' },
  { table: 'coupon_codes', expiresColumn: 'expires_at' },
  { table: 'coupon_codes', expiresColumn: 'expiry_at' },
];
const COUPON_EXPIRY_SCAN_TABLES = ['coupons', 'coupon_codes'];
const ACTIVE_COUPON_STATUSES = ['ACTIVE', 'SCHEDULED'];
const INDIA_TZ_OFFSET_MINUTES = 5 * 60 + 30;
const ISO_TZ_SUFFIX_REGEX = /(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

let couponExpirySyncInFlight = null;
let couponExpirySyncLastAt = 0;

const normalizeCouponStatus = (value) => String(value || '').toUpperCase().trim();

const parseCouponExpiryInput = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (ISO_TZ_SUFFIX_REGEX.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const localMatch = raw.match(LOCAL_DATETIME_REGEX);
  if (localMatch) {
    const [, year, month, day, hours, minutes, seconds = '0'] = localMatch;
    // `datetime-local` has no timezone. Admins use IST, so convert that wall time to UTC explicitly.
    const utcMillis =
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds)
      ) -
      INDIA_TZ_OFFSET_MINUTES * 60 * 1000;
    const parsed = new Date(utcMillis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseCouponTimeToken = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return { hours: 23, minutes: 59, seconds: 59 };

  const meridiemMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)$/i);
  if (meridiemMatch) {
    let hours = Number(meridiemMatch[1]) || 0;
    const minutes = Number(meridiemMatch[2]) || 0;
    const seconds = Number(meridiemMatch[3]) || 0;
    const meridiem = String(meridiemMatch[4] || '').toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    return { hours, minutes, seconds };
  }

  const twentyFourHourMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (twentyFourHourMatch) {
    return {
      hours: Number(twentyFourHourMatch[1]) || 0,
      minutes: Number(twentyFourHourMatch[2]) || 0,
      seconds: Number(twentyFourHourMatch[3]) || 0,
    };
  }

  return { hours: 23, minutes: 59, seconds: 59 };
};

const parseCouponDateToken = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return {
      day: Number(slashMatch[1]),
      month: Number(slashMatch[2]),
      year: Number(slashMatch[3]),
    };
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
      day: parsed.getUTCDate(),
    };
  }

  return null;
};

const parseCouponExpiryAt = (coupon = {}) => {
  const directCandidates = [
    coupon?.expires_at,
    coupon?.expiry_at,
    coupon?.valid_till,
    coupon?.expires_on,
  ];

  for (const candidate of directCandidates) {
    if (!candidate) continue;
    const parsed = parseCouponExpiryInput(candidate);
    if (parsed) return parsed;
  }

  const dateToken =
    coupon?.expiry_date_only ||
    coupon?.expiry_date ||
    coupon?.valid_date ||
    coupon?.expires_date ||
    coupon?.end_date ||
    null;
  const dateParts = parseCouponDateToken(dateToken);
  if (!dateParts) return null;

  const { hours, minutes, seconds } = parseCouponTimeToken(
    coupon?.expiry_time ||
      coupon?.valid_time ||
      coupon?.expires_time ||
      coupon?.end_time ||
      ''
  );

  const utcMillis =
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hours, minutes, seconds) -
    (5 * 60 + 30) * 60 * 1000;
  return new Date(utcMillis);
};

const syncExpiredCouponsByRowScan = async () => {
  const nowTs = Date.now();

  for (const table of COUPON_EXPIRY_SCAN_TABLES) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .in('status', ACTIVE_COUPON_STATUSES)
        .limit(1000);

      if (error || !Array.isArray(data) || data.length === 0) {
        continue;
      }

      const expiredIds = data
        .filter((row) => {
          const status = normalizeCouponStatus(row?.status);
          if (!ACTIVE_COUPON_STATUSES.includes(status)) return false;
          const expiresAt = parseCouponExpiryAt(row);
          return expiresAt && expiresAt.getTime() <= nowTs;
        })
        .map((row) => row?.id)
        .filter(Boolean);

      if (expiredIds.length === 0) continue;

      await supabase.from(table).update({ status: 'EXPIRED' }).in('id', expiredIds);
    } catch {
      // Ignore schema mismatches here; another deployed table shape may match.
    }
  }
};

const syncExpiredCoupons = async () => {
  const now = Date.now();
  if (couponExpirySyncInFlight) return couponExpirySyncInFlight;
  if (now - couponExpirySyncLastAt < 30 * 1000) return null;

  couponExpirySyncInFlight = (async () => {
    for (const attempt of COUPON_EXPIRY_SYNC_ATTEMPTS) {
      try {
        const { error } = await supabase
          .from(attempt.table)
          .update({ status: 'EXPIRED' })
          .lte(attempt.expiresColumn, new Date().toISOString())
          .in('status', ACTIVE_COUPON_STATUSES);

        if (!error) {
          // Keep going so date+time split schemas also get handled.
        }
      } catch (error) {
        // Ignore schema mismatches here; next attempt may match deployed schema.
      }
    }

    await syncExpiredCouponsByRowScan();

    couponExpirySyncLastAt = Date.now();
    return true;
  })();

  try {
    return await couponExpirySyncInFlight;
  } finally {
    couponExpirySyncInFlight = null;
  }
};

router.use(async (_req, _res, next) => {
  try {
    await syncExpiredCoupons();
  } catch {
    // Status sync should never block finance APIs.
  }
  next();
});

// Finance APIs require FINANCE or ADMIN employees.
router.use(requireEmployeeRoles(['FINANCE', 'ADMIN']));

const COUPON_CODE_REGEX = /^[A-Z0-9_-]+$/;
const GLOBAL_SCOPE_TOKENS = new Set(['ANY', 'ALL', 'GLOBAL', 'NULL', 'NONE']);

const looksLikeUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );

const normalizeCouponCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_-]/g, '');

const normalizeScopeToken = (value) => String(value || '').trim();

const isGlobalScopeValue = (value) => {
  const token = normalizeScopeToken(value);
  if (!token) return true;
  return GLOBAL_SCOPE_TOKENS.has(token.toUpperCase());
};

const normalizePlanScopeId = (planScope) => {
  const token = normalizeScopeToken(planScope);
  if (isGlobalScopeValue(token)) return null;
  return token;
};

const resolveCouponStatus = (coupon = {}) => {
  const usedCount = Number(coupon?.used_count || 0);
  const maxUses = Number(coupon?.max_uses || 0);
  const expiresAt = parseCouponExpiryAt(coupon)?.getTime() ?? null;

  if (coupon?.is_active === false) return 'INACTIVE';
  if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= Date.now()) return 'EXPIRED';
  if (maxUses > 0 && usedCount >= maxUses) return 'USED_UP';
  return 'ACTIVE';
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const asUpper = (value) => String(value || '').trim().toUpperCase();

async function resolveVendorScopeId(vendorRef) {
  const ref = normalizeScopeToken(vendorRef);
  if (isGlobalScopeValue(ref)) return null;

  if (looksLikeUuid(ref)) {
    const { data: byId, error: byIdError } = await supabase
      .from('vendors')
      .select('id')
      .eq('id', ref)
      .maybeSingle();
    if (byIdError) throw new Error(byIdError.message || 'Failed to validate vendor UUID');
    if (byId?.id) return byId.id;
  }

  const { data: byPublicId, error: byPublicIdError } = await supabase
    .from('vendors')
    .select('id')
    .ilike('vendor_id', ref)
    .limit(2);
  if (byPublicIdError) throw new Error(byPublicIdError.message || 'Failed to resolve vendor');
  if ((byPublicId || []).length === 1) return byPublicId[0].id;
  if ((byPublicId || []).length > 1) {
    throw new Error('Multiple vendors matched this vendor ID. Use vendor UUID.');
  }

  const { data: byEmail, error: byEmailError } = await supabase
    .from('vendors')
    .select('id')
    .ilike('email', ref)
    .limit(2);
  if (byEmailError) throw new Error(byEmailError.message || 'Failed to resolve vendor');
  if ((byEmail || []).length === 1) return byEmail[0].id;
  if ((byEmail || []).length > 1) {
    throw new Error('Multiple vendors matched this email. Use vendor UUID.');
  }

  throw new Error('Vendor not found. Enter vendor UUID, vendor code, or vendor email.');
}

// GET /api/finance/payments
// Optional query params: vendor_id, plan_id, from, to, limit
router.get('/payments', async (req, res) => {
  try {
    const { vendor_id, plan_id, from, to, limit = 200 } = req.query;
    let query = supabase
      .from('vendor_payments')
      .select('*, vendor:vendors(id, vendor_id, company_name, email), plan:vendor_plans(id, name, price)')
      .order('payment_date', { ascending: false })
      .limit(Number(limit) || 200);

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
        filters: {
          vendor_id: vendor_id || null,
          plan_id: plan_id || null,
          from: from || null,
          to: to || null,
        },
        count: data?.length || 0,
      },
    });

    return res.json({ success: true, data: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/finance/summary
router.get('/summary', async (_req, res) => {
  try {
    const { data: payments, error } = await supabase
      .from('vendor_payments')
      .select('amount, net_amount, payment_date');
    if (error) return res.status(500).json({ success: false, error: error.message });

    const { data: leads, error: leadErr } = await supabase
      .from('lead_purchases')
      .select('amount, purchase_date, created_at');
    if (leadErr) {
      // Do not fail summary if lead_purchases is missing/blocked.
      logger.warn('[finance/summary] lead_purchases error:', leadErr.message);
    }

    const now = new Date();
    const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    let totalGross = 0;
    let totalNet = 0;
    let totalLead = 0;
    let last30 = 0;
    (payments || []).forEach((p) => {
      const gross = Number(p.amount || 0);
      const net = Number(p.net_amount ?? p.amount ?? 0);
      totalGross += gross;
      totalNet += net;
      if (p.payment_date && new Date(p.payment_date) >= thirtyAgo) last30 += net;
    });

    (leads || []).forEach((l) => {
      const amt = Number(l.amount || 0);
      totalLead += amt;
      const d = l.purchase_date || l.created_at;
      if (d && new Date(d) >= thirtyAgo) last30 += amt;
    });

    const totalRevenue = totalNet + totalLead;

    await writeAuditLog({
      req: _req,
      actor: _req.actor,
      action: 'FINANCE_SUMMARY_VIEWED',
      entityType: 'vendor_payments',
      details: { totalGross, totalNet, totalLead, totalRevenue, last30 },
    });

    return res.json({
      success: true,
      data: {
        totalGross,
        totalNet,
        totalLead,
        totalRevenue,
        last30,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Coupons ---------------------------------------------------

// GET /api/finance/coupons/pending — FINANCE sees their own pending submissions
router.get('/coupons/pending', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_plan_coupons')
      .select('*')
      .eq('approval_status', 'PENDING_APPROVAL')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/finance/coupons
router.get('/coupons', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_plan_coupons')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });

    const coupons = Array.isArray(data) ? data : [];
    const planIds = Array.from(
      new Set(coupons.map((c) => normalizePlanScopeId(c.plan_id)).filter((id) => id && looksLikeUuid(id)))
    );
    const vendorIds = Array.from(
      new Set(coupons.map((c) => normalizeScopeToken(c.vendor_id)).filter((id) => id && looksLikeUuid(id)))
    );

    let planMap = {};
    let vendorMap = {};

    if (planIds.length) {
      const { data: plans, error: planErr } = await supabase
        .from('vendor_plans')
        .select('id, name')
        .in('id', planIds);
      if (planErr) {
        logger.warn('[finance/coupons] plan lookup failed:', planErr.message);
      } else {
        planMap = (plans || []).reduce((acc, p) => {
          if (p?.id) acc[p.id] = p;
          return acc;
        }, {});
      }
    }

    if (vendorIds.length) {
      const { data: vendors, error: vendorErr } = await supabase
        .from('vendors')
        .select('id, company_name, owner_name, vendor_id')
        .in('id', vendorIds);
      if (vendorErr) {
        logger.warn('[finance/coupons] vendor lookup failed:', vendorErr.message);
      } else {
        vendorMap = (vendors || []).reduce((acc, v) => {
          if (v?.id) acc[v.id] = v;
          return acc;
        }, {});
      }
    }

    const enriched = coupons.map((c) => ({
      ...c,
      plan: c.plan_id ? planMap[c.plan_id] || null : null,
      vendor: c.vendor_id ? vendorMap[c.vendor_id] || null : null,
      effective_status: resolveCouponStatus(c),
    }));

    return res.json({ success: true, data: enriched });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/finance/coupons
router.post('/coupons', async (req, res) => {
  try {
    const {
      code,
      discount_type,
      value,
      plan_id = null,
      vendor_id = null,
      max_uses = 0,
      expires_at = null,
      is_active = true,
    } = req.body || {};

    const normalizedCode = normalizeCouponCode(code);
    const normalizedDiscountType = String(discount_type || '').trim().toUpperCase();
    const numericValue = Number(value);
    const numericMaxUses = Number(max_uses || 0);

    if (!normalizedCode || !normalizedDiscountType || value === undefined || value === null || value === '') {
      return res.status(400).json({ success: false, error: 'code, discount_type, value are required' });
    }

    if (!COUPON_CODE_REGEX.test(normalizedCode)) {
      return res.status(400).json({
        success: false,
        error: 'Coupon code must use letters, numbers, hyphen, or underscore only',
      });
    }

    if (!['PERCENT', 'FLAT'].includes(normalizedDiscountType)) {
      return res.status(400).json({ success: false, error: 'discount_type must be PERCENT or FLAT' });
    }

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return res.status(400).json({ success: false, error: 'value must be a number greater than 0' });
    }

    if (normalizedDiscountType === 'PERCENT' && numericValue > 100) {
      return res.status(400).json({ success: false, error: 'Percent coupon value cannot exceed 100' });
    }

    if (!Number.isFinite(numericMaxUses) || numericMaxUses < 0) {
      return res.status(400).json({ success: false, error: 'max_uses must be 0 or more' });
    }

    const normalizedExpiresAt = parseCouponExpiryInput(expires_at);
    if (expires_at && !normalizedExpiresAt) {
      return res.status(400).json({ success: false, error: 'expires_at must be a valid date/time' });
    }

    const resolvedVendorId = await resolveVendorScopeId(vendor_id);
    const normalizedPlanId = normalizePlanScopeId(plan_id);

    // ADMIN can activate directly; FINANCE submissions require ADMIN approval.
    const actorRole = String(req.actor?.role || '').toUpperCase();
    const isAdminActor = actorRole === 'ADMIN';
    const approvalStatus = isAdminActor ? 'APPROVED' : 'PENDING_APPROVAL';
    const couponIsActive = isAdminActor ? Boolean(is_active) : false;

    const payload = {
      code: normalizedCode,
      discount_type: normalizedDiscountType,
      value: numericValue,
      plan_id: normalizedPlanId,
      vendor_id: resolvedVendorId,
      max_uses: Math.trunc(numericMaxUses),
      expires_at: normalizedExpiresAt ? normalizedExpiresAt.toISOString() : null,
      is_active: couponIsActive,
      approval_status: approvalStatus,
      approved_by: isAdminActor ? (req.actor?.email || null) : null,
      approved_at: isAdminActor ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('vendor_plan_coupons').insert([payload]).select().single();
    if (error) {
      const normalizedMessage = String(error.message || '').toLowerCase();
      const status = error.code === '23505' ? 409 : 500;
      const friendlyMessage =
        error.code === '23505' &&
        (normalizedMessage.includes('vendor_plan_coupons_code_key') || normalizedMessage.includes('duplicate'))
          ? 'Coupon code already exists. Use a different code.'
          : error.message;
      return res.status(status).json({ success: false, error: friendlyMessage });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'COUPON_CREATED',
      entityType: 'vendor_plan_coupons',
      entityId: data?.id || null,
      details: {
        code: payload.code,
        discount_type: payload.discount_type,
        value: payload.value,
        plan_id: payload.plan_id,
        vendor_id: payload.vendor_id,
        vendor_input: vendor_id || null,
        expires_at: payload.expires_at,
        approval_status: approvalStatus,
      },
    });

    return res.json({
      success: true,
      data,
      pending_approval: !isAdminActor,
      message: isAdminActor
        ? 'Coupon created and activated.'
        : 'Coupon submitted for Admin approval.',
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/finance/coupons/:id — Update coupon fields
router.put('/coupons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data: existing, error: findErr } = await supabase
      .from('vendor_plan_coupons')
      .select('id, code')
      .eq('id', id)
      .maybeSingle();

    if (findErr) return res.status(500).json({ success: false, error: findErr.message });
    if (!existing) return res.status(404).json({ success: false, error: 'Coupon not found' });

    const updates = {};

    if (req.body?.discount_type !== undefined) {
      const dt = String(req.body.discount_type).trim().toUpperCase();
      if (!['PERCENT', 'FLAT'].includes(dt)) {
        return res.status(400).json({ success: false, error: 'discount_type must be PERCENT or FLAT' });
      }
      updates.discount_type = dt;
    }

    if (req.body?.value !== undefined) {
      const v = Number(req.body.value);
      if (!Number.isFinite(v) || v <= 0) {
        return res.status(400).json({ success: false, error: 'value must be greater than 0' });
      }
      updates.value = v;
    }

    if (req.body?.max_uses !== undefined) {
      const m = Number(req.body.max_uses);
      if (!Number.isFinite(m) || m < 0) {
        return res.status(400).json({ success: false, error: 'max_uses must be 0 or more' });
      }
      updates.max_uses = Math.trunc(m);
    }

    if (req.body?.expires_at !== undefined) {
      const parsed = parseCouponExpiryInput(req.body.expires_at);
      if (req.body.expires_at && !parsed) {
        return res.status(400).json({ success: false, error: 'expires_at must be a valid date/time' });
      }
      updates.expires_at = parsed ? parsed.toISOString() : null;
    }

    if (req.body?.is_active !== undefined) {
      updates.is_active = req.body.is_active === true || req.body.is_active === 'true';
    }

    if (req.body?.plan_id !== undefined) {
      updates.plan_id = normalizePlanScopeId(req.body.plan_id);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields provided to update' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('vendor_plan_coupons')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'COUPON_UPDATED',
      entityType: 'vendor_plan_coupons',
      entityId: id,
      details: { code: existing.code, updates },
    });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/finance/coupons/:code/deactivate
router.post('/coupons/:code/deactivate', async (req, res) => {
  try {
    const { code } = req.params;
    const { data, error } = await supabase
      .from('vendor_plan_coupons')
      .update({ is_active: false })
      .eq('code', code.toUpperCase())
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'COUPON_DEACTIVATED',
      entityType: 'vendor_plan_coupons',
      entityId: data?.id || null,
      details: { code: code.toUpperCase() },
    });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/finance/coupons/:id
router.delete('/coupons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Missing coupon id' });

    const { data, error } = await supabase
      .from('vendor_plan_coupons')
      .delete()
      .eq('id', id)
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'COUPON_DELETED',
      entityType: 'vendor_plan_coupons',
      entityId: id,
      details: { code: data?.code || null },
    });

    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Referral program ---------------------------------------------------

// GET /api/finance/referrals/settings
router.get('/referrals/settings', async (_req, res) => {
  try {
    const settings = await getReferralSettings(supabase);

    const [{ data: rules, error: rulesErr }, { data: plans, error: plansErr }] = await Promise.all([
      supabase
        .from('referral_plan_rules')
        .select('*')
        .order('updated_at', { ascending: false }),
      supabase
        .from('vendor_plans')
        .select('id, name, price, is_active')
        .order('price', { ascending: true }),
    ]);

    if (rulesErr) return res.status(500).json({ success: false, error: rulesErr.message });
    if (plansErr) return res.status(500).json({ success: false, error: plansErr.message });

    return res.json({
      success: true,
      data: {
        settings,
        rules: rules || [],
        plans: plans || [],
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load referral settings' });
  }
});

// PUT /api/finance/referrals/settings
router.put('/referrals/settings', async (req, res) => {
  try {
    const payload = req.body || {};
    const update = {
      is_enabled: Boolean(payload.is_enabled),
      first_paid_plan_only: payload.first_paid_plan_only !== false,
      allow_coupon_stack: Boolean(payload.allow_coupon_stack),
      min_plan_amount: Math.max(0, Number(payload.min_plan_amount || 0)),
      min_cashout_amount: Math.max(0, Number(payload.min_cashout_amount || 0)),
      reward_hold_days: Math.max(0, Math.trunc(Number(payload.reward_hold_days || 0))),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('referral_program_settings')
      .upsert([{ config_key: 'GLOBAL', ...update }], { onConflict: 'config_key' })
      .select('*')
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_SETTINGS_UPDATED',
      entityType: 'referral_program_settings',
      entityId: 'GLOBAL',
      details: update,
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to update settings' });
  }
});

// PUT /api/finance/referrals/plan-rules/:planId
router.put('/referrals/plan-rules/:planId', async (req, res) => {
  try {
    const planId = String(req.params.planId || '').trim();
    if (!looksLikeUuid(planId)) {
      return res.status(400).json({ success: false, error: 'Invalid plan id' });
    }

    const {
      is_enabled = true,
      discount_type = 'PERCENT',
      discount_value = 0,
      discount_cap = null,
      reward_type = 'PERCENT',
      reward_value = 0,
      reward_cap = null,
      valid_from = null,
      valid_to = null,
    } = req.body || {};

    const normalizedDiscountType = asUpper(discount_type);
    const normalizedRewardType = asUpper(reward_type);
    if (!['PERCENT', 'FLAT'].includes(normalizedDiscountType)) {
      return res.status(400).json({ success: false, error: 'discount_type must be PERCENT or FLAT' });
    }
    if (!['PERCENT', 'FLAT'].includes(normalizedRewardType)) {
      return res.status(400).json({ success: false, error: 'reward_type must be PERCENT or FLAT' });
    }

    const dValue = Number(discount_value || 0);
    const rValue = Number(reward_value || 0);
    if (!Number.isFinite(dValue) || dValue < 0) {
      return res.status(400).json({ success: false, error: 'discount_value must be >= 0' });
    }
    if (!Number.isFinite(rValue) || rValue < 0) {
      return res.status(400).json({ success: false, error: 'reward_value must be >= 0' });
    }
    if (normalizedDiscountType === 'PERCENT' && dValue > 100) {
      return res.status(400).json({ success: false, error: 'discount percent cannot exceed 100' });
    }
    if (normalizedRewardType === 'PERCENT' && rValue > 100) {
      return res.status(400).json({ success: false, error: 'reward percent cannot exceed 100' });
    }

    const payload = {
      plan_id: planId,
      is_enabled: Boolean(is_enabled),
      discount_type: normalizedDiscountType,
      discount_value: dValue,
      discount_cap: toNumberOrNull(discount_cap),
      reward_type: normalizedRewardType,
      reward_value: rValue,
      reward_cap: toNumberOrNull(reward_cap),
      valid_from: valid_from || null,
      valid_to: valid_to || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('referral_plan_rules')
      .upsert([payload], { onConflict: 'plan_id' })
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_PLAN_RULE_UPSERTED',
      entityType: 'referral_plan_rules',
      entityId: data?.id || null,
      details: payload,
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to update referral rule' });
  }
});

// GET /api/finance/referrals/cashouts
router.get('/referrals/cashouts', async (req, res) => {
  try {
    const status = asUpper(req.query.status || '');
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

    let query = supabase
      .from('vendor_referral_cashout_requests')
      .select('*, vendor:vendors(id, vendor_id, company_name, owner_name, email, phone)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load cashouts' });
  }
});

const revertCashoutAmount = async ({ requestRow, actorUserId }) => {
  const vendorId = requestRow.vendor_id;
  const amount = Number(requestRow.requested_amount || 0);
  if (!vendorId || amount <= 0) return;

  const { data: wallet, error: walletErr } = await supabase
    .from('vendor_referral_wallets')
    .select('*')
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (walletErr) throw new Error(walletErr.message || 'Failed to load wallet');

  const current = wallet || {
    vendor_id: vendorId,
    available_balance: 0,
    pending_balance: 0,
    lifetime_earned: 0,
    lifetime_paid_out: 0,
  };

  const nextAvailable = Number(current.available_balance || 0) + amount;
  const { error: upErr } = await supabase
    .from('vendor_referral_wallets')
    .upsert(
      [
        {
          vendor_id: vendorId,
          available_balance: nextAvailable,
          pending_balance: Number(current.pending_balance || 0),
          lifetime_earned: Number(current.lifetime_earned || 0),
          lifetime_paid_out: Number(current.lifetime_paid_out || 0),
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: 'vendor_id' }
    );
  if (upErr) throw new Error(upErr.message || 'Failed to update wallet balance');

  const referenceKey = `cashout_revert:${requestRow.id}`;
  const { error: ledgerErr } = await supabase.from('vendor_referral_wallet_ledger').insert([
    {
      vendor_id: vendorId,
      cashout_request_id: requestRow.id,
      entry_type: 'CASHOUT_REVERT',
      amount,
      status: 'COMPLETED',
      reference_key: referenceKey,
      meta: {
        actor_user_id: actorUserId || null,
      },
      created_at: new Date().toISOString(),
    },
  ]);

  if (ledgerErr) {
    const msg = String(ledgerErr.message || '').toLowerCase();
    if (!msg.includes('duplicate') && !msg.includes('unique')) {
      throw new Error(ledgerErr.message || 'Failed to write cashout revert ledger');
    }
  }
};

// POST /api/finance/referrals/cashouts/:id/approve
router.post('/referrals/cashouts/:id/approve', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!looksLikeUuid(id)) return res.status(400).json({ success: false, error: 'Invalid cashout id' });

    const { data: row, error: rowErr } = await supabase
      .from('vendor_referral_cashout_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (rowErr) return res.status(500).json({ success: false, error: rowErr.message });
    if (!row) return res.status(404).json({ success: false, error: 'Cashout request not found' });
    if (!['REQUESTED', 'APPROVED'].includes(asUpper(row.status))) {
      return res.status(400).json({ success: false, error: `Cannot approve cashout in status ${row.status}` });
    }

    const { data, error } = await supabase
      .from('vendor_referral_cashout_requests')
      .update({
        status: 'APPROVED',
        approved_by_user_id: req.actor?.id || null,
        approved_at: new Date().toISOString(),
        notes: normalizeScopeToken(req.body?.notes) || row.notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_CASHOUT_APPROVED',
      entityType: 'vendor_referral_cashout_requests',
      entityId: id,
      details: {
        vendor_id: row.vendor_id,
        amount: row.requested_amount,
      },
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to approve cashout' });
  }
});

// POST /api/finance/referrals/cashouts/:id/reject
router.post('/referrals/cashouts/:id/reject', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!looksLikeUuid(id)) return res.status(400).json({ success: false, error: 'Invalid cashout id' });
    const rejectionReason = normalizeScopeToken(req.body?.rejection_reason || 'Rejected by finance');

    const { data: row, error: rowErr } = await supabase
      .from('vendor_referral_cashout_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (rowErr) return res.status(500).json({ success: false, error: rowErr.message });
    if (!row) return res.status(404).json({ success: false, error: 'Cashout request not found' });
    if (!['REQUESTED', 'APPROVED'].includes(asUpper(row.status))) {
      return res.status(400).json({ success: false, error: `Cannot reject cashout in status ${row.status}` });
    }

    await revertCashoutAmount({ requestRow: row, actorUserId: req.actor?.id || null });

    const { data, error } = await supabase
      .from('vendor_referral_cashout_requests')
      .update({
        status: 'REJECTED',
        rejection_reason: rejectionReason || null,
        approved_by_user_id: req.actor?.id || null,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_CASHOUT_REJECTED',
      entityType: 'vendor_referral_cashout_requests',
      entityId: id,
      details: {
        vendor_id: row.vendor_id,
        amount: row.requested_amount,
        rejection_reason: rejectionReason,
      },
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to reject cashout' });
  }
});

// POST /api/finance/referrals/cashouts/:id/mark-paid
router.post('/referrals/cashouts/:id/mark-paid', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!looksLikeUuid(id)) return res.status(400).json({ success: false, error: 'Invalid cashout id' });

    const utr = normalizeScopeToken(req.body?.utr_number || '');
    const receiptUrl = normalizeScopeToken(req.body?.receipt_url || '');
    const notes = normalizeScopeToken(req.body?.notes || '');

    if (!utr) return res.status(400).json({ success: false, error: 'utr_number is required' });

    const { data: row, error: rowErr } = await supabase
      .from('vendor_referral_cashout_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (rowErr) return res.status(500).json({ success: false, error: rowErr.message });
    if (!row) return res.status(404).json({ success: false, error: 'Cashout request not found' });
    if (asUpper(row.status) !== 'APPROVED') {
      return res.status(400).json({ success: false, error: 'Cashout must be APPROVED before mark-paid' });
    }

    const { data: wallet, error: walletErr } = await supabase
      .from('vendor_referral_wallets')
      .select('*')
      .eq('vendor_id', row.vendor_id)
      .maybeSingle();
    if (walletErr) return res.status(500).json({ success: false, error: walletErr.message });

    const nextPaidOut = Number(wallet?.lifetime_paid_out || 0) + Number(row.requested_amount || 0);
    const { error: walletUpdateErr } = await supabase
      .from('vendor_referral_wallets')
      .upsert(
        [
          {
            vendor_id: row.vendor_id,
            available_balance: Number(wallet?.available_balance || 0),
            pending_balance: Number(wallet?.pending_balance || 0),
            lifetime_earned: Number(wallet?.lifetime_earned || 0),
            lifetime_paid_out: nextPaidOut,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: 'vendor_id' }
      );
    if (walletUpdateErr) return res.status(500).json({ success: false, error: walletUpdateErr.message });

    const { data, error } = await supabase
      .from('vendor_referral_cashout_requests')
      .update({
        status: 'PAID',
        paid_by_user_id: req.actor?.id || null,
        paid_at: new Date().toISOString(),
        utr_number: utr,
        receipt_url: receiptUrl || null,
        notes: notes || row.notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_CASHOUT_MARKED_PAID',
      entityType: 'vendor_referral_cashout_requests',
      entityId: id,
      details: {
        vendor_id: row.vendor_id,
        amount: row.requested_amount,
        utr_number: utr,
        receipt_url: receiptUrl || null,
      },
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to mark cashout paid' });
  }
});

export default router;
