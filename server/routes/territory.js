import express from 'express';
import { db } from '../lib/dbClient.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { normalizeRole } from '../lib/auth.js';
import { writeAuditLog } from '../lib/audit.js';

const router = express.Router();

const VP_ROLES = new Set(['VP', 'ADMIN', 'SUPERADMIN']);
const MANAGER_ROLES = new Set(['MANAGER', 'VP', 'ADMIN', 'SUPERADMIN']);
const SALES_ROLES = new Set(['SALES', 'MANAGER', 'VP', 'ADMIN', 'SUPERADMIN']);
const ENGAGEMENT_TYPES = new Set([
  'CALL',
  'WHATSAPP',
  'VISIT',
  'DEMO',
  'FOLLOW_UP',
  'PLAN_PITCH',
  'PLAN_SHARED',
  'CONVERTED',
  'UNMASK_REQUEST',
]);

const normalizeText = (value = '') => String(value || '').trim();
const normalizeUpper = (value = '') => normalizeRole(value || '');
const unique = (arr = []) => Array.from(new Set((arr || []).map((v) => String(v || '').trim()).filter(Boolean)));
const nowIso = () => new Date().toISOString();
const isTruthyQuery = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const OPEN_ENGAGEMENT_STATUSES = new Set(['OPEN', 'PENDING', 'SENT', 'IN_PROGRESS']);
const getActorIdentityIds = (actor = {}, authUser = {}) =>
  unique([actor?.actorUserId, actor?.employee?.user_id, authUser?.id, actor?.employee?.id].filter(Boolean));

const isVpOrAdmin = (role) => VP_ROLES.has(normalizeUpper(role));
const isManagerOrAbove = (role) => MANAGER_ROLES.has(normalizeUpper(role));
const isSalesOrAbove = (role) => SALES_ROLES.has(normalizeUpper(role));

const maskPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 4) return `${digits[0] || ''}${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-1)}`;
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
};

const maskEmail = (email) => {
  const value = String(email || '').trim();
  if (!value || !value.includes('@')) return '';
  const [local, domain] = value.split('@');
  if (!domain) return '';
  const maskedLocal =
    local.length <= 2
      ? `${local[0] || ''}*`
      : `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}`;
  return `${maskedLocal}@${domain}`;
};

function maskVendorRecord(vendor, allowUnmasked = false) {
  if (!vendor) return null;
  return {
    id: vendor.id,
    vendor_id: vendor.vendor_id,
    company_name: vendor.company_name,
    owner_name: vendor.owner_name,
    phone: allowUnmasked ? vendor.phone || null : maskPhone(vendor.phone),
    email: allowUnmasked ? vendor.email || null : maskEmail(vendor.email),
    city: vendor.city,
    state: vendor.state,
    pincode: vendor.pincode || null,
    city_id: vendor.city_id,
    state_id: vendor.state_id,
    kyc_status: vendor.kyc_status,
    is_active: vendor.is_active !== false,
    contact_masked: !allowUnmasked,
  };
}

async function resolveEmployeeProfile(authUser = {}) {
  const userId = String(authUser?.id || '').trim();
  const email = String(authUser?.email || '').trim().toLowerCase();
  if (!userId && !email) return null;

  const { data, error } = await db
    .from('employees')
    .select('*')
    .or([userId ? `user_id.eq.${userId}` : null, email ? `email.eq.${email}` : null].filter(Boolean).join(','))
    .maybeSingle();

  if (error) throw new Error(error.message || 'Failed to resolve employee');
  if (!data) return null;

  if (!data.user_id && userId) {
    await db.from('employees').update({ user_id: userId }).eq('id', data.id);
    data.user_id = userId;
  }

  return data;
}

async function ensureActor(req, res, { allowSuperadminWithoutEmployee = true } = {}) {
  const actorRole = normalizeUpper(req.user?.role || '');
  const employee = await resolveEmployeeProfile(req.user);
  if (!employee && !(allowSuperadminWithoutEmployee && actorRole === 'SUPERADMIN')) {
    res.status(404).json({ success: false, error: 'Employee profile not found' });
    return null;
  }

  if (employee?.status && normalizeUpper(employee.status) !== 'ACTIVE') {
    res.status(403).json({ success: false, error: 'Employee account is not active' });
    return null;
  }

  const role = normalizeUpper(employee?.role || actorRole);
  const actorUserId = String(employee?.user_id || req.user?.id || employee?.id || '').trim() || null;
  return { role, actorUserId, employee };
}

async function getScopedDivisionIds(role, actorUserId) {
  if (isVpOrAdmin(role)) return null;

  if (role === 'MANAGER') {
    const { data, error } = await db
      .from('vp_manager_division_allocations')
      .select('division_id')
      .eq('manager_user_id', actorUserId)
      .eq('allocation_status', 'ACTIVE');
    if (error) throw new Error(error.message || 'Failed to fetch manager division scope');
    return unique((data || []).map((d) => d.division_id));
  }

  if (role === 'SALES') {
    const { data, error } = await db
      .from('manager_sales_division_allocations')
      .select('division_id')
      .eq('sales_user_id', actorUserId)
      .eq('allocation_status', 'ACTIVE');
    if (error) throw new Error(error.message || 'Failed to fetch sales division scope');
    return unique((data || []).map((d) => d.division_id));
  }

  return [];
}

async function getDivisionsByScope(scopedDivisionIds, reqQuery = {}) {
  const includePincodes = reqQuery?.include_pincodes === 'true';
  const selectClause = includePincodes
    ? 'id, division_key, name, slug, state_id, city_id, district_name, subdistrict_name, pincode_count, is_active, state:states(name), city:cities(name), division_pincodes:geo_division_pincodes(pincode)'
    : 'id, division_key, name, slug, state_id, city_id, district_name, subdistrict_name, pincode_count, is_active, state:states(name), city:cities(name)';

  let query = db
    .from('geo_divisions')
    .select(selectClause)
    .eq('is_active', true)
    .order('name', { ascending: true });

  const stateId = normalizeText(reqQuery?.state_id);
  const cityId = normalizeText(reqQuery?.city_id);
  const divisionId = normalizeText(reqQuery?.division_id);

  if (stateId) query = query.eq('state_id', stateId);
  if (cityId) query = query.eq('city_id', cityId);
  if (divisionId) query = query.eq('id', divisionId);

  if (Array.isArray(scopedDivisionIds)) {
    if (!scopedDivisionIds.length) return [];
    query = query.in('id', scopedDivisionIds);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message || 'Failed to fetch divisions');
  return data || [];
}

async function validateEmployeeRole(userId, expectedRole) {
  const { data, error } = await db
    .from('employees')
    .select('id, user_id, role, status')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to validate employee');
  if (!data?.id) return { ok: false, reason: 'Employee not found' };
  if (normalizeUpper(data.status || 'ACTIVE') !== 'ACTIVE') return { ok: false, reason: 'Employee is not active' };
  if (normalizeUpper(data.role) !== normalizeUpper(expectedRole)) return { ok: false, reason: `Employee role must be ${normalizeUpper(expectedRole)}` };
  return { ok: true };
}

router.get('/divisions', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isSalesOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Territory access requires SALES, MANAGER, VP or ADMIN role' });
    }

    const scope = await getScopedDivisionIds(actor.role, actor.actorUserId);
    const divisions = await getDivisionsByScope(scope, req.query);
    return res.json({ success: true, divisions });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch divisions' });
  }
});

router.get('/employees', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isManagerOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Manager-level access required' });
    }

    const requestedRole = normalizeUpper(req.query?.role || '');
    const roleFilter = requestedRole && ['MANAGER', 'SALES', 'VP'].includes(requestedRole)
      ? [requestedRole]
      : ['MANAGER', 'SALES', 'VP'];

    let query = db
      .from('employees')
      .select('id, user_id, full_name, email, role, department, status, created_at')
      .in('role', roleFilter)
      .order('full_name', { ascending: true });

    if (actor.role === 'MANAGER') {
      query = query.in('role', ['SALES']);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch employees' });

    const employees = (data || []).filter((emp) => normalizeUpper(emp.status || 'ACTIVE') === 'ACTIVE');
    return res.json({ success: true, employees });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch employees' });
  }
});

async function releaseVpManagerAllocations(managerUserId, keepDivisionIds = []) {
  const keep = new Set(keepDivisionIds);
  const { data, error } = await db
    .from('vp_manager_division_allocations')
    .select('id, division_id')
    .eq('manager_user_id', managerUserId)
    .eq('allocation_status', 'ACTIVE');
  if (error) throw new Error(error.message || 'Failed to fetch current VP allocations');

  const toRelease = (data || [])
    .filter((row) => !keep.has(String(row.division_id || '').trim()))
    .map((row) => row.id)
    .filter(Boolean);

  if (toRelease.length) {
    const { error: relErr } = await db
      .from('vp_manager_division_allocations')
      .update({
        allocation_status: 'RELEASED',
        released_at: nowIso(),
        updated_at: nowIso(),
      })
      .in('id', toRelease);
    if (relErr) throw new Error(relErr.message || 'Failed to release VP allocations');
  }

  return toRelease.length;
}

async function upsertVpManagerAllocations(vpUserId, managerUserId, divisionIds = [], notes = '') {
  let inserted = 0;
  let updated = 0;

  for (const divisionId of divisionIds) {
    const { data: existing, error: findErr } = await db
      .from('vp_manager_division_allocations')
      .select('id')
      .eq('manager_user_id', managerUserId)
      .eq('division_id', divisionId)
      .eq('allocation_status', 'ACTIVE')
      .maybeSingle();
    if (findErr) throw new Error(findErr.message || 'Failed to fetch VP allocation');

    if (existing?.id) {
      const { error: updErr } = await db
        .from('vp_manager_division_allocations')
        .update({
          vp_user_id: vpUserId,
          notes: notes || null,
          updated_at: nowIso(),
        })
        .eq('id', existing.id);
      if (updErr) throw new Error(updErr.message || 'Failed to update VP allocation');
      updated += 1;
      continue;
    }

    const { error: insErr } = await db.from('vp_manager_division_allocations').insert([
      {
        vp_user_id: vpUserId,
        manager_user_id: managerUserId,
        division_id: divisionId,
        allocation_status: 'ACTIVE',
        notes: notes || null,
        allocated_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ]);
    if (insErr) throw new Error(insErr.message || 'Failed to insert VP allocation');
    inserted += 1;
  }

  return { inserted, updated };
}

router.get('/allocations/vp-manager', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isManagerOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Manager-level access required' });
    }

    let managerUserId = normalizeText(req.query?.manager_user_id);
    if (actor.role === 'MANAGER') managerUserId = actor.actorUserId;

    let query = db
      .from('vp_manager_division_allocations')
      .select('id, vp_user_id, manager_user_id, division_id, allocation_status, notes, allocated_at, released_at, updated_at, division:geo_divisions(id, name, city_id, state_id)')
      .order('allocated_at', { ascending: false });

    if (managerUserId) query = query.eq('manager_user_id', managerUserId);
    if (req.query?.active !== 'false') query = query.eq('allocation_status', 'ACTIVE');

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch VP allocations' });
    return res.json({ success: true, allocations: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch VP allocations' });
  }
});

router.post('/allocations/vp-manager', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isVpOrAdmin(actor.role)) {
      return res.status(403).json({ success: false, error: 'VP/Admin access required' });
    }

    const managerUserId = normalizeText(req.body?.manager_user_id);
    const divisionIds = unique(req.body?.division_ids || []);
    const mode = normalizeUpper(req.body?.mode || 'REPLACE');
    const notes = normalizeText(req.body?.notes || '');

    if (!managerUserId) return res.status(400).json({ success: false, error: 'manager_user_id is required' });
    if (!['REPLACE', 'APPEND'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be REPLACE or APPEND' });
    }

    const managerCheck = await validateEmployeeRole(managerUserId, 'MANAGER');
    if (!managerCheck.ok) return res.status(400).json({ success: false, error: managerCheck.reason });

    if (divisionIds.length) {
      const { count, error } = await db
        .from('geo_divisions')
        .select('id', { count: 'exact', head: true })
        .in('id', divisionIds)
        .eq('is_active', true);
      if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to validate divisions' });
      if ((count || 0) !== divisionIds.length) {
        return res.status(400).json({ success: false, error: 'One or more division_ids are invalid or inactive' });
      }
    }

    const released = mode === 'REPLACE' ? await releaseVpManagerAllocations(managerUserId, divisionIds) : 0;
    const upserted = await upsertVpManagerAllocations(actor.actorUserId, managerUserId, divisionIds, notes);

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VP_MANAGER_DIVISION_ALLOCATED',
      entityType: 'vp_manager_division_allocations',
      details: {
        manager_user_id: managerUserId,
        division_ids: divisionIds,
        mode,
        released,
        inserted: upserted.inserted,
        updated: upserted.updated,
      },
    });

    return res.json({
      success: true,
      summary: {
        released,
        inserted: upserted.inserted,
        updated: upserted.updated,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to save VP allocations' });
  }
});

async function releaseManagerSalesAllocations(managerUserId, salesUserId, keepDivisionIds = []) {
  const keep = new Set(keepDivisionIds);
  const { data, error } = await db
    .from('manager_sales_division_allocations')
    .select('id, division_id')
    .eq('manager_user_id', managerUserId)
    .eq('sales_user_id', salesUserId)
    .eq('allocation_status', 'ACTIVE');
  if (error) throw new Error(error.message || 'Failed to fetch current sales allocations');

  const toRelease = (data || [])
    .filter((row) => !keep.has(String(row.division_id || '').trim()))
    .map((row) => row.id)
    .filter(Boolean);

  if (toRelease.length) {
    const { error: relErr } = await db
      .from('manager_sales_division_allocations')
      .update({
        allocation_status: 'RELEASED',
        released_at: nowIso(),
        updated_at: nowIso(),
      })
      .in('id', toRelease);
    if (relErr) throw new Error(relErr.message || 'Failed to release sales allocations');
  }

  return toRelease.length;
}

async function rebalanceDivision(managerUserId, salesUserId, divisionId) {
  const { error } = await db
    .from('manager_sales_division_allocations')
    .update({
      allocation_status: 'RELEASED',
      released_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq('manager_user_id', managerUserId)
    .eq('division_id', divisionId)
    .eq('allocation_status', 'ACTIVE')
    .neq('sales_user_id', salesUserId);

  if (error) throw new Error(error.message || 'Failed to rebalance previous sales allocation');
}

async function upsertManagerSalesAllocations(managerUserId, salesUserId, divisionIds = [], notes = '') {
  let inserted = 0;
  let updated = 0;

  for (const divisionId of divisionIds) {
    await rebalanceDivision(managerUserId, salesUserId, divisionId);

    const { data: existing, error: findErr } = await db
      .from('manager_sales_division_allocations')
      .select('id')
      .eq('manager_user_id', managerUserId)
      .eq('sales_user_id', salesUserId)
      .eq('division_id', divisionId)
      .eq('allocation_status', 'ACTIVE')
      .maybeSingle();
    if (findErr) throw new Error(findErr.message || 'Failed to fetch sales allocation');

    if (existing?.id) {
      const { error: updErr } = await db
        .from('manager_sales_division_allocations')
        .update({
          notes: notes || null,
          updated_at: nowIso(),
        })
        .eq('id', existing.id);
      if (updErr) throw new Error(updErr.message || 'Failed to update sales allocation');
      updated += 1;
      continue;
    }

    const { error: insErr } = await db.from('manager_sales_division_allocations').insert([
      {
        manager_user_id: managerUserId,
        sales_user_id: salesUserId,
        division_id: divisionId,
        allocation_status: 'ACTIVE',
        notes: notes || null,
        allocated_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ]);
    if (insErr) throw new Error(insErr.message || 'Failed to insert sales allocation');
    inserted += 1;
  }

  return { inserted, updated };
}

router.get('/allocations/manager-sales', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isManagerOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Manager-level access required' });
    }

    let managerUserId = normalizeText(req.query?.manager_user_id);
    if (actor.role === 'MANAGER') managerUserId = actor.actorUserId;

    let query = db
      .from('manager_sales_division_allocations')
      .select('id, manager_user_id, sales_user_id, division_id, allocation_status, notes, allocated_at, released_at, updated_at, division:geo_divisions(id, name, city_id, state_id)')
      .order('allocated_at', { ascending: false });

    if (managerUserId) query = query.eq('manager_user_id', managerUserId);
    const salesUserId = normalizeText(req.query?.sales_user_id);
    if (salesUserId) query = query.eq('sales_user_id', salesUserId);
    if (req.query?.active !== 'false') query = query.eq('allocation_status', 'ACTIVE');

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch manager allocations' });
    return res.json({ success: true, allocations: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch manager allocations' });
  }
});

router.post('/allocations/manager-sales', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isManagerOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Manager-level access required' });
    }

    const salesUserId = normalizeText(req.body?.sales_user_id);
    const divisionIds = unique(req.body?.division_ids || []);
    const mode = normalizeUpper(req.body?.mode || 'REPLACE');
    const notes = normalizeText(req.body?.notes || '');

    if (!salesUserId) return res.status(400).json({ success: false, error: 'sales_user_id is required' });
    if (!['REPLACE', 'APPEND'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be REPLACE or APPEND' });
    }

    let managerUserId = normalizeText(req.body?.manager_user_id);
    if (actor.role === 'MANAGER') managerUserId = actor.actorUserId;
    if (!managerUserId) return res.status(400).json({ success: false, error: 'manager_user_id is required' });
    if (actor.role === 'MANAGER' && managerUserId !== actor.actorUserId) {
      return res.status(403).json({ success: false, error: 'Manager can allocate only under own account' });
    }

    const managerCheck = await validateEmployeeRole(managerUserId, 'MANAGER');
    if (!managerCheck.ok) return res.status(400).json({ success: false, error: managerCheck.reason });

    const salesCheck = await validateEmployeeRole(salesUserId, 'SALES');
    if (!salesCheck.ok) return res.status(400).json({ success: false, error: salesCheck.reason });

    if (divisionIds.length) {
      const { count, error } = await db
        .from('geo_divisions')
        .select('id', { count: 'exact', head: true })
        .in('id', divisionIds)
        .eq('is_active', true);
      if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to validate divisions' });
      if ((count || 0) !== divisionIds.length) {
        return res.status(400).json({ success: false, error: 'One or more division_ids are invalid or inactive' });
      }
    }

    if (actor.role === 'MANAGER') {
      const managerScope = await getScopedDivisionIds('MANAGER', actor.actorUserId);
      const scopeSet = new Set(managerScope || []);
      const invalid = divisionIds.filter((id) => !scopeSet.has(id));
      if (invalid.length) {
        return res.status(403).json({
          success: false,
          error: 'Manager cannot assign divisions outside own scope',
          invalid_division_ids: invalid,
        });
      }
    }

    const released = mode === 'REPLACE'
      ? await releaseManagerSalesAllocations(managerUserId, salesUserId, divisionIds)
      : 0;
    const upserted = await upsertManagerSalesAllocations(managerUserId, salesUserId, divisionIds, notes);

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'MANAGER_SALES_DIVISION_ALLOCATED',
      entityType: 'manager_sales_division_allocations',
      details: {
        manager_user_id: managerUserId,
        sales_user_id: salesUserId,
        division_ids: divisionIds,
        mode,
        released,
        inserted: upserted.inserted,
        updated: upserted.updated,
      },
    });

    return res.json({
      success: true,
      summary: {
        released,
        inserted: upserted.inserted,
        updated: upserted.updated,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to save manager allocations' });
  }
});

router.get('/sales/vendors', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isSalesOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const includeUnmasked = req.query?.include_unmasked === 'true' && isManagerOrAbove(actor.role);
    const scope = await getScopedDivisionIds(actor.role, actor.actorUserId);
    const divisions = await getDivisionsByScope(scope, req.query);
    const divisionById = new Map((divisions || []).map((d) => [d.id, d]));
    const divisionIds = unique((divisions || []).map((d) => d.id));
    const cityIds = unique((divisions || []).map((d) => d.city_id).filter(Boolean));

    let vendorRows = [];
    const seenVendorIds = new Set();
    const divisionByVendorId = new Map();
    if (divisionIds.length) {
      const { data, error } = await db
        .from('vendor_division_map')
        .select('vendor_id, division_id')
        .in('division_id', divisionIds);
      if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch vendor mappings' });

      const mappedVendorIds = unique((data || []).map((x) => x.vendor_id));
      (data || []).forEach((x) => divisionByVendorId.set(x.vendor_id, x.division_id));

      if (mappedVendorIds.length) {
        const { data: vendors, error: vendorErr } = await db
          .from('vendors')
          .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, city_id, state_id, kyc_status, is_active')
          .in('id', mappedVendorIds)
          .eq('is_active', true)
          .order('updated_at', { ascending: false });
        if (vendorErr) return res.status(500).json({ success: false, error: vendorErr.message || 'Failed to fetch mapped vendors' });
        vendorRows = (vendors || []).map((vendor) => {
          const mappedDivisionId = divisionByVendorId.get(vendor.id) || null;
          const mappedDivision = mappedDivisionId ? divisionById.get(mappedDivisionId) || null : null;
          seenVendorIds.add(vendor.id);
          return {
            ...maskVendorRecord(vendor, includeUnmasked),
            division_id: mappedDivisionId,
            division_name: mappedDivision?.name || null,
            division_city: mappedDivision?.city?.name || null,
            division_state: mappedDivision?.state?.name || null,
            division_pincode_count: Number(mappedDivision?.pincode_count || 0),
          };
        });
      }
    }

    if (cityIds.length) {
      const { data: vendors, error } = await db
        .from('vendors')
        .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, city_id, state_id, kyc_status, is_active')
        .in('city_id', cityIds)
        .eq('is_active', true)
        .order('updated_at', { ascending: false });
      if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch city vendors' });

      (vendors || []).forEach((vendor) => {
        if (seenVendorIds.has(vendor.id)) return;
        const cityDivisionRows = divisions.filter((d) => String(d.city_id || '') === String(vendor.city_id || ''));
        const cityDivision = cityDivisionRows.length === 1 ? cityDivisionRows[0] : null;

        vendorRows.push({
          ...maskVendorRecord(vendor, includeUnmasked),
          division_id: cityDivision?.id || null,
          division_name: cityDivision?.name || null,
          division_city: cityDivision?.city?.name || null,
          division_state: cityDivision?.state?.name || null,
          division_pincode_count: Number(cityDivision?.pincode_count || 0),
        });
      });
    }

    const search = normalizeText(req.query?.search || '').toLowerCase();
    const filtered = search
      ? vendorRows.filter((v) =>
          [v.company_name, v.owner_name, v.vendor_id, v.city, v.state]
            .filter(Boolean)
            .some((x) => String(x).toLowerCase().includes(search))
        )
      : vendorRows;

    const limitRaw = Number(req.query?.limit || 200);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;

    return res.json({
      success: true,
      vendors: filtered.slice(0, limit),
      meta: {
        total: filtered.length,
        contact_masked: !includeUnmasked,
        divisions_in_scope: divisionIds.length,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch sales vendors' });
  }
});

async function resolveDivisionFromVendor(vendorId, preferredDivisionId = '') {
  const requestedDivisionId = normalizeText(preferredDivisionId);
  if (requestedDivisionId) return requestedDivisionId;

  const { data: mapped, error: mapErr } = await db
    .from('vendor_division_map')
    .select('division_id')
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (mapErr) throw new Error(mapErr.message || 'Failed to resolve vendor division map');
  if (mapped?.division_id) return mapped.division_id;

  const { data: vendor, error: vendorErr } = await db
    .from('vendors')
    .select('city_id')
    .eq('id', vendorId)
    .maybeSingle();
  if (vendorErr) throw new Error(vendorErr.message || 'Failed to resolve vendor city');
  if (!vendor?.city_id) return null;

  const { data: division, error: divisionErr } = await db
    .from('geo_divisions')
    .select('id')
    .eq('city_id', vendor.city_id)
    .eq('is_active', true)
    .order('pincode_count', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (divisionErr) throw new Error(divisionErr.message || 'Failed to resolve division by city');
  return division?.id || null;
}

async function resolveVpUserForManager(managerUserId, divisionId = null) {
  if (!managerUserId) return null;

  let scoped = db
    .from('vp_manager_division_allocations')
    .select('vp_user_id')
    .eq('manager_user_id', managerUserId)
    .eq('allocation_status', 'ACTIVE')
    .order('allocated_at', { ascending: false })
    .limit(1);

  if (divisionId) scoped = scoped.eq('division_id', divisionId);

  const { data: scopedVp, error: scopedErr } = await scoped.maybeSingle();
  if (scopedErr) throw new Error(scopedErr.message || 'Failed to resolve VP for manager');
  if (scopedVp?.vp_user_id) return scopedVp.vp_user_id;

  if (!divisionId) return null;

  const { data: fallbackVp, error: fallbackErr } = await db
    .from('vp_manager_division_allocations')
    .select('vp_user_id')
    .eq('manager_user_id', managerUserId)
    .eq('allocation_status', 'ACTIVE')
    .order('allocated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallbackErr) throw new Error(fallbackErr.message || 'Failed to resolve fallback VP for manager');
  return fallbackVp?.vp_user_id || null;
}

async function resolveSalesHierarchyForVendor(salesUserId, vendorId, preferredDivisionId = '') {
  let divisionId = await resolveDivisionFromVendor(vendorId, preferredDivisionId);
  let managerUserId = null;

  if (divisionId) {
    const { data: scopedManager, error: scopedErr } = await db
      .from('manager_sales_division_allocations')
      .select('manager_user_id')
      .eq('sales_user_id', salesUserId)
      .eq('division_id', divisionId)
      .eq('allocation_status', 'ACTIVE')
      .order('allocated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (scopedErr) throw new Error(scopedErr.message || 'Failed to resolve scoped manager allocation');
    if (scopedManager?.manager_user_id) managerUserId = scopedManager.manager_user_id;
  }

  if (!managerUserId) {
    const { data: fallbackManager, error: fallbackErr } = await db
      .from('manager_sales_division_allocations')
      .select('manager_user_id, division_id')
      .eq('sales_user_id', salesUserId)
      .eq('allocation_status', 'ACTIVE')
      .order('allocated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fallbackErr) throw new Error(fallbackErr.message || 'Failed to resolve manager allocation');
    managerUserId = fallbackManager?.manager_user_id || null;
    if (!divisionId) divisionId = fallbackManager?.division_id || null;
  }

  const vpUserId = await resolveVpUserForManager(managerUserId, divisionId);
  return { divisionId: divisionId || null, managerUserId, vpUserId };
}

router.post('/sales/engagements', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isSalesOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const vendorId = normalizeText(req.body?.vendor_id);
    const engagementType = normalizeUpper(req.body?.engagement_type || 'FOLLOW_UP');
    const status = normalizeUpper(req.body?.status || 'OPEN');
    const notes = normalizeText(req.body?.notes || '');
    const nextFollowUpAt = normalizeText(req.body?.next_follow_up_at || '');
    const leadId = normalizeText(req.body?.lead_id || '');
    const planId = normalizeText(req.body?.plan_id || '');
    const salesCode = normalizeText(req.body?.sales_code || '').toUpperCase();
    const planShareUrl = normalizeText(req.body?.plan_share_url || '');
    const channel = normalizeText(req.body?.channel || '').toUpperCase();

    if (!vendorId) return res.status(400).json({ success: false, error: 'vendor_id is required' });
    if (!ENGAGEMENT_TYPES.has(engagementType)) {
      return res.status(400).json({ success: false, error: `Invalid engagement_type. Allowed: ${[...ENGAGEMENT_TYPES].join(', ')}` });
    }

    const { data: vendor, error: vendorErr } = await db
      .from('vendors')
      .select('id')
      .eq('id', vendorId)
      .maybeSingle();
    if (vendorErr) return res.status(500).json({ success: false, error: vendorErr.message || 'Failed to validate vendor' });
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor not found' });

    const requestedDivisionId = normalizeText(req.body?.division_id || '');
    let divisionId = requestedDivisionId || null;
    let managerUserId = actor.role === 'MANAGER' ? actor.actorUserId : null;
    let vpUserId = actor.role === 'VP' ? actor.actorUserId : null;

    if (actor.role === 'SALES') {
      const hierarchy = await resolveSalesHierarchyForVendor(actor.actorUserId, vendorId, requestedDivisionId);
      divisionId = hierarchy.divisionId || divisionId;
      managerUserId = hierarchy.managerUserId || null;
      vpUserId = hierarchy.vpUserId || null;
    }

    if (actor.role === 'MANAGER' && !vpUserId) {
      vpUserId = await resolveVpUserForManager(managerUserId, divisionId);
    }

    const payload = {
      vendor_id: vendorId,
      lead_id: leadId || null,
      sales_user_id: actor.actorUserId,
      manager_user_id: managerUserId,
      vp_user_id: vpUserId,
      division_id: divisionId,
      plan_id: planId || null,
      sales_code: salesCode || null,
      plan_share_url: planShareUrl || null,
      channel: channel || null,
      engagement_type: engagementType,
      status: status || 'OPEN',
      notes: notes || null,
      next_follow_up_at: nextFollowUpAt || null,
      is_contact_unmasked: req.body?.is_contact_unmasked === true && isManagerOrAbove(actor.role),
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    const { data, error } = await db
      .from('sales_vendor_engagements')
      .insert([payload])
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to save engagement' });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SALES_VENDOR_ENGAGEMENT_CREATED',
      entityType: 'sales_vendor_engagements',
      entityId: data?.id || null,
      details: {
        vendor_id: vendorId,
        lead_id: leadId || null,
        plan_id: planId || null,
        engagement_type: engagementType,
      },
    });

    return res.json({ success: true, engagement: data || payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to save engagement' });
  }
});

router.get('/sales/engagements', requireAuth(), async (req, res) => {
  try {
    const actor = await ensureActor(req, res);
    if (!actor) return;
    if (!isSalesOrAbove(actor.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const limitRaw = Number(req.query?.limit || 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 500) : 100;
    const vendorRef = normalizeText(req.query?.vendor_id);
    const status = normalizeUpper(req.query?.status || '');
    const engagementType = normalizeUpper(req.query?.engagement_type || '');
    const salesUserId = normalizeText(req.query?.sales_user_id || '');
    const managerUserId = normalizeText(req.query?.manager_user_id || '');
    const search = normalizeText(req.query?.search || '').toLowerCase();
    const dueOnly = isTruthyQuery(req.query?.due);
    const dateFrom = normalizeText(req.query?.date_from || '');
    const dateTo = normalizeText(req.query?.date_to || '');
    let engagementVendorIds = [];
    let vendorFilterMatches = [];

    if (vendorRef) {
      const vendorSearch = vendorRef.replace(/,/g, ' ').trim();
      const vendorLike = `%${vendorSearch}%`;
      const { data: vendorMatches, error: vendorMatchErr } = await db
        .from('vendors')
        .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, city_id, state_id, kyc_status, is_active')
        .or(
          [
            `id.eq.${vendorSearch}`,
            `vendor_id.ilike.${vendorLike}`,
            `company_name.ilike.${vendorLike}`,
            `owner_name.ilike.${vendorLike}`,
            `email.ilike.${vendorLike}`,
            `phone.ilike.${vendorLike}`,
          ].join(',')
        )
        .limit(50);
      if (vendorMatchErr) {
        return res.status(500).json({ success: false, error: vendorMatchErr.message || 'Failed to resolve vendor filter' });
      }
      vendorFilterMatches = vendorMatches || [];
      engagementVendorIds = unique([vendorRef, ...vendorFilterMatches.map((vendor) => vendor.id)]);
    }

    let query = db
      .from('sales_vendor_engagements')
      .select('id, vendor_id, lead_id, sales_user_id, manager_user_id, vp_user_id, division_id, plan_id, sales_code, plan_share_url, channel, engagement_type, status, notes, next_follow_up_at, is_contact_unmasked, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    const actorIdentityIds = getActorIdentityIds(actor, req.user);
    if (actor.role === 'SALES') query = query.in('sales_user_id', actorIdentityIds.length ? actorIdentityIds : [actor.actorUserId]);
    if (actor.role === 'MANAGER') query = query.in('manager_user_id', actorIdentityIds.length ? actorIdentityIds : [actor.actorUserId]);
    if (vendorRef) query = query.in('vendor_id', engagementVendorIds.length ? engagementVendorIds : [vendorRef]);
    if (status) query = query.eq('status', status);
    if (engagementType) query = query.eq('engagement_type', engagementType);
    if (salesUserId && isManagerOrAbove(actor.role)) query = query.eq('sales_user_id', salesUserId);
    if (managerUserId && isVpOrAdmin(actor.role)) query = query.eq('manager_user_id', managerUserId);
    if (dateFrom && !Number.isNaN(new Date(dateFrom).getTime())) query = query.gte('created_at', new Date(dateFrom).toISOString());
    if (dateTo && !Number.isNaN(new Date(dateTo).getTime())) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      query = query.lte('created_at', end.toISOString());
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch engagements' });

    const engagements = data || [];
    const vendorIds = unique(engagements.map((x) => x.vendor_id).filter(Boolean));
    const divisionIds = unique(engagements.map((x) => x.division_id).filter(Boolean));
    const planIds = unique(engagements.map((x) => x.plan_id).filter(Boolean));
    const employeeUserIds = unique(
      engagements.flatMap((x) => [x.sales_user_id, x.manager_user_id, x.vp_user_id]).filter(Boolean)
    );

    let vendorById = new Map();
    if (vendorIds.length) {
      const { data: vendors, error: vendorErr } = await db
        .from('vendors')
        .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, city_id, state_id, kyc_status, is_active')
        .in('id', vendorIds);
      if (vendorErr) return res.status(500).json({ success: false, error: vendorErr.message || 'Failed to fetch engagement vendors' });
      vendorById = new Map((vendors || []).map((v) => [v.id, v]));
    }

    let divisionById = new Map();
    if (divisionIds.length) {
      const { data: divisions, error: divisionErr } = await db
        .from('geo_divisions')
        .select('id, name, city_id, state_id, pincode_count, city:cities(name), state:states(name)')
        .in('id', divisionIds);
      if (divisionErr) return res.status(500).json({ success: false, error: divisionErr.message || 'Failed to fetch engagement divisions' });
      divisionById = new Map((divisions || []).map((d) => [d.id, d]));
    }

    let planById = new Map();
    if (planIds.length) {
      const { data: plans, error: planErr } = await db
        .from('vendor_plans')
        .select('id, name, price, duration_days, is_active, description, features')
        .in('id', planIds);
      if (planErr) return res.status(500).json({ success: false, error: planErr.message || 'Failed to fetch engagement plans' });
      planById = new Map((plans || []).map((p) => [p.id, p]));
    }

    let employeeByUserId = new Map();
    if (employeeUserIds.length) {
      const { data: employees, error: employeeErr } = await db
        .from('employees')
        .select('user_id, full_name, email, role, sales_code')
        .in('user_id', employeeUserIds);
      if (employeeErr) return res.status(500).json({ success: false, error: employeeErr.message || 'Failed to fetch engagement owners' });
      employeeByUserId = new Map((employees || []).map((employee) => [employee.user_id, employee]));
    }

    const allowRoleUnmask = isManagerOrAbove(actor.role);
    const now = Date.now();
    const hydrated = engagements
      .map((row) => {
        const vendor = vendorById.get(row.vendor_id) || null;
        const plan = planById.get(row.plan_id) || null;
        return {
          ...row,
          vendor: maskVendorRecord(vendor, allowRoleUnmask || row.is_contact_unmasked === true),
          division: divisionById.get(row.division_id) || null,
          plan,
          sales_user: employeeByUserId.get(row.sales_user_id) || null,
          manager_user: employeeByUserId.get(row.manager_user_id) || null,
          vp_user: employeeByUserId.get(row.vp_user_id) || null,
        };
      })
      .filter((row) => {
        const rowStatus = normalizeUpper(row?.status || '');
        const dueAt = row?.next_follow_up_at ? new Date(row.next_follow_up_at).getTime() : 0;
        if (dueOnly && (!dueAt || dueAt > now || !OPEN_ENGAGEMENT_STATUSES.has(rowStatus))) return false;
        if (!search) return true;

        const haystack = [
          row.id,
          row.vendor_id,
          row.lead_id,
          row.sales_code,
          row.channel,
          row.engagement_type,
          row.status,
          row.notes,
          row.vendor?.vendor_id,
          row.vendor?.company_name,
          row.vendor?.owner_name,
          row.vendor?.phone,
          row.vendor?.email,
          row.vendor?.city,
          row.vendor?.state,
          row.vendor?.pincode,
          row.division?.name,
          row.division?.city?.name,
          row.division?.state?.name,
          row.plan?.name,
          row.sales_user?.full_name,
          row.sales_user?.email,
          row.manager_user?.full_name,
          row.manager_user?.email,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        return haystack.includes(search);
      });

    const dueEngagements = hydrated.filter((row) => {
      const dueAt = row?.next_follow_up_at ? new Date(row.next_follow_up_at).getTime() : 0;
      return dueAt && dueAt <= now && OPEN_ENGAGEMENT_STATUSES.has(normalizeUpper(row?.status || ''));
    });

    const summary = {
      total: hydrated.length,
      open_count: hydrated.filter((row) => OPEN_ENGAGEMENT_STATUSES.has(normalizeUpper(row?.status || ''))).length,
      due_count: dueEngagements.length,
      plan_shared_count: hydrated.filter((row) => normalizeUpper(row?.engagement_type || '') === 'PLAN_SHARED').length,
      converted_count: hydrated.filter((row) => normalizeUpper(row?.engagement_type || '') === 'CONVERTED').length,
      unique_vendors: unique(hydrated.map((row) => row.vendor_id)).length,
      unique_sales_users: unique(hydrated.map((row) => row.sales_user_id)).length,
    };

    return res.json({
      success: true,
      engagements: hydrated,
      meta: {
        summary,
        vendor_matches: vendorFilterMatches.map((vendor) => maskVendorRecord(vendor, isManagerOrAbove(actor.role))),
        filters: {
          limit,
          vendor_id: vendorRef || null,
          status: status || null,
          engagement_type: engagementType || null,
          due: dueOnly,
          search: search || null,
          date_from: dateFrom || null,
          date_to: dateTo || null,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch engagements' });
  }
});

export default router;
