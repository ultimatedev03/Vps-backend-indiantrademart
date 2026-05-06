import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
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
  'CONVERTED',
  'UNMASK_REQUEST',
]);

const normalizeText = (value = '') => String(value || '').trim();
const normalizeUpper = (value = '') => normalizeRole(value || '');
const unique = (arr = []) => Array.from(new Set((arr || []).map((v) => String(v || '').trim()).filter(Boolean)));
const nowIso = () => new Date().toISOString();

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

  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .or([userId ? `user_id.eq.${userId}` : null, email ? `email.eq.${email}` : null].filter(Boolean).join(','))
    .maybeSingle();

  if (error) throw new Error(error.message || 'Failed to resolve employee');
  if (!data) return null;

  if (!data.user_id && userId) {
    await supabase.from('employees').update({ user_id: userId }).eq('id', data.id);
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
  const actorUserId = String(req.user?.id || employee?.user_id || '').trim() || null;
  return { role, actorUserId, employee };
}

async function getScopedDivisionIds(role, actorUserId) {
  if (isVpOrAdmin(role)) return null;

  if (role === 'MANAGER') {
    const { data, error } = await supabase
      .from('vp_manager_division_allocations')
      .select('division_id')
      .eq('manager_user_id', actorUserId)
      .eq('allocation_status', 'ACTIVE');
    if (error) throw new Error(error.message || 'Failed to fetch manager division scope');
    return unique((data || []).map((d) => d.division_id));
  }

  if (role === 'SALES') {
    const { data, error } = await supabase
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

  let query = supabase
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
  const { data, error } = await supabase
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

    let query = supabase
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
  const { data, error } = await supabase
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
    const { error: relErr } = await supabase
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
    const { data: existing, error: findErr } = await supabase
      .from('vp_manager_division_allocations')
      .select('id')
      .eq('manager_user_id', managerUserId)
      .eq('division_id', divisionId)
      .eq('allocation_status', 'ACTIVE')
      .maybeSingle();
    if (findErr) throw new Error(findErr.message || 'Failed to fetch VP allocation');

    if (existing?.id) {
      const { error: updErr } = await supabase
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

    const { error: insErr } = await supabase.from('vp_manager_division_allocations').insert([
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

    let query = supabase
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
      const { count, error } = await supabase
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
  const { data, error } = await supabase
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
    const { error: relErr } = await supabase
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
  const { error } = await supabase
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

    const { data: existing, error: findErr } = await supabase
      .from('manager_sales_division_allocations')
      .select('id')
      .eq('manager_user_id', managerUserId)
      .eq('sales_user_id', salesUserId)
      .eq('division_id', divisionId)
      .eq('allocation_status', 'ACTIVE')
      .maybeSingle();
    if (findErr) throw new Error(findErr.message || 'Failed to fetch sales allocation');

    if (existing?.id) {
      const { error: updErr } = await supabase
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

    const { error: insErr } = await supabase.from('manager_sales_division_allocations').insert([
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

    let query = supabase
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
      const { count, error } = await supabase
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
      const { data, error } = await supabase
        .from('vendor_division_map')
        .select('vendor_id, division_id')
        .in('division_id', divisionIds);
      if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch vendor mappings' });

      const mappedVendorIds = unique((data || []).map((x) => x.vendor_id));
      (data || []).forEach((x) => divisionByVendorId.set(x.vendor_id, x.division_id));

      if (mappedVendorIds.length) {
        const { data: vendors, error: vendorErr } = await supabase
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
      const { data: vendors, error } = await supabase
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

  const { data: mapped, error: mapErr } = await supabase
    .from('vendor_division_map')
    .select('division_id')
    .eq('vendor_id', vendorId)
    .maybeSingle();
  if (mapErr) throw new Error(mapErr.message || 'Failed to resolve vendor division map');
  if (mapped?.division_id) return mapped.division_id;

  const { data: vendor, error: vendorErr } = await supabase
    .from('vendors')
    .select('city_id')
    .eq('id', vendorId)
    .maybeSingle();
  if (vendorErr) throw new Error(vendorErr.message || 'Failed to resolve vendor city');
  if (!vendor?.city_id) return null;

  const { data: division, error: divisionErr } = await supabase
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

  let scoped = supabase
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

  const { data: fallbackVp, error: fallbackErr } = await supabase
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
    const { data: scopedManager, error: scopedErr } = await supabase
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
    const { data: fallbackManager, error: fallbackErr } = await supabase
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

    if (!vendorId) return res.status(400).json({ success: false, error: 'vendor_id is required' });
    if (!ENGAGEMENT_TYPES.has(engagementType)) {
      return res.status(400).json({ success: false, error: `Invalid engagement_type. Allowed: ${[...ENGAGEMENT_TYPES].join(', ')}` });
    }

    const { data: vendor, error: vendorErr } = await supabase
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
      sales_user_id: actor.actorUserId,
      manager_user_id: managerUserId,
      vp_user_id: vpUserId,
      division_id: divisionId,
      engagement_type: engagementType,
      status: status || 'OPEN',
      notes: notes || null,
      next_follow_up_at: nextFollowUpAt || null,
      is_contact_unmasked: req.body?.is_contact_unmasked === true && isManagerOrAbove(actor.role),
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    const { data, error } = await supabase
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
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    const vendorId = normalizeText(req.query?.vendor_id);
    const status = normalizeUpper(req.query?.status || '');

    let query = supabase
      .from('sales_vendor_engagements')
      .select('id, vendor_id, sales_user_id, manager_user_id, vp_user_id, division_id, engagement_type, status, notes, next_follow_up_at, is_contact_unmasked, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (actor.role === 'SALES') query = query.eq('sales_user_id', actor.actorUserId);
    if (actor.role === 'MANAGER') query = query.eq('manager_user_id', actor.actorUserId);
    if (vendorId) query = query.eq('vendor_id', vendorId);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch engagements' });

    const engagements = data || [];
    const vendorIds = unique(engagements.map((x) => x.vendor_id).filter(Boolean));
    const divisionIds = unique(engagements.map((x) => x.division_id).filter(Boolean));

    let vendorById = new Map();
    if (vendorIds.length) {
      const { data: vendors, error: vendorErr } = await supabase
        .from('vendors')
        .select('id, vendor_id, company_name, city, state, pincode')
        .in('id', vendorIds);
      if (vendorErr) return res.status(500).json({ success: false, error: vendorErr.message || 'Failed to fetch engagement vendors' });
      vendorById = new Map((vendors || []).map((v) => [v.id, v]));
    }

    let divisionById = new Map();
    if (divisionIds.length) {
      const { data: divisions, error: divisionErr } = await supabase
        .from('geo_divisions')
        .select('id, name, city_id, state_id, pincode_count, city:cities(name), state:states(name)')
        .in('id', divisionIds);
      if (divisionErr) return res.status(500).json({ success: false, error: divisionErr.message || 'Failed to fetch engagement divisions' });
      divisionById = new Map((divisions || []).map((d) => [d.id, d]));
    }

    const hydrated = engagements.map((row) => ({
      ...row,
      vendor: vendorById.get(row.vendor_id) || null,
      division: divisionById.get(row.division_id) || null,
    }));

    return res.json({ success: true, engagements: hydrated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch engagements' });
  }
});

export default router;
