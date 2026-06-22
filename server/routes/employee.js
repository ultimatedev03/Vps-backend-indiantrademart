import express from 'express';
import { randomUUID } from 'crypto';
import { db } from '../lib/dbClient.js';
import { logger } from '../utils/logger.js';
import { inferCloudinaryResourceType, isCloudinaryConfigured, uploadBufferToCloudinary } from '../lib/cloudinaryUpload.js';
import { writeAuditLog } from '../lib/audit.js';
import { hashPassword, normalizeEmail, normalizeRole, upsertPublicUser } from '../lib/auth.js';
import { validateStrongPassword } from '../lib/passwordPolicy.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmployeeRoles } from '../middleware/requireEmployeeRoles.js';
import { mysqlQuery } from '../lib/mysqlPool.js';
import { cacheGetJson, cacheSetJson, isRedisConfigured } from '../lib/redisCache.js';
import {
  buildSearch360ActorFromEmployee,
  createSearch360Escalation,
  searchVendors360,
  updateSearch360CaseStatus,
} from '../lib/search360.js';
import { getPlanEntitlements, isSalesAssistedPlan, isVisibleCatalogPlan } from '../lib/vendorPlanCatalog.js';

const router = express.Router();

const SALES_ROLES = new Set(['SALES', 'ADMIN', 'SUPERADMIN']);
const MANAGER_APPROVAL_ROLES = new Set(['MANAGER', 'ADMIN', 'SUPERADMIN']);
const STAFF_MANAGE_ROLES = new Set(['ADMIN', 'HR', 'SUPERADMIN']);
const PRICING_RULE_ENTITY_TYPE = 'pricing_rule_request';
const PRICING_RULE_SUBMITTED_ACTION = 'PRICING_RULE_SUBMITTED';
const PRICING_RULE_APPROVED_ACTION = 'PRICING_RULE_APPROVED';
const PRICING_RULE_REJECTED_ACTION = 'PRICING_RULE_REJECTED';
const PRICING_RULE_ALLOWED_TYPES = new Set(['MANUAL', 'DISCOUNT', 'MARKUP', 'SURCHARGE', 'SPECIAL_RATE']);
const CATEGORY_IMAGE_BUCKET = 'avatars';
const CATEGORY_IMAGE_LEVELS = new Set(['head', 'sub', 'micro']);
const CATEGORY_TABLE_BY_LEVEL = {
  head: 'head_categories',
  sub: 'sub_categories',
  micro: 'micro_categories',
};
const CATEGORY_IMAGE_MIN_BYTES = 10 * 1024; // 10KB
const CATEGORY_IMAGE_MAX_BYTES = 800 * 1024; // 800KB
const PRODUCT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // source videos/PDFs can be larger; images are optimized client-side
const PRODUCT_IMAGE_MIN_BYTES = 10 * 1024; // images are optimized before upload
const PRODUCT_IMAGE_MAX_BYTES = 1024 * 1024; // 1MB
const DEFAULT_PRODUCT_UPLOAD_BUCKETS_BY_TYPE = {
  image: ['product-images', 'product-media', 'objects', 'avatars'],
  video: ['product-media', 'product-images', 'objects', 'avatars'],
  pdf: ['product-media', 'objects', 'avatars'],
};
const sanitizeBucketName = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
const parseBucketList = (value = '') =>
  Array.from(
    new Set(
      String(value || '')
        .split(',')
        .map((item) => sanitizeBucketName(item))
        .filter(Boolean)
    )
  );
const PRODUCT_SHARED_UPLOAD_BUCKETS = parseBucketList(
  process.env.PRODUCT_UPLOAD_BUCKETS || process.env.PRODUCT_MEDIA_BUCKETS || ''
);
const resolveProductUploadBuckets = (type = '') => {
  const normalizedType = String(type || '').trim().toLowerCase();
  const defaults = DEFAULT_PRODUCT_UPLOAD_BUCKETS_BY_TYPE[normalizedType] || [];
  const envSpecific = parseBucketList(process.env[`PRODUCT_${normalizedType.toUpperCase()}_BUCKETS`] || '');
  return Array.from(new Set([...envSpecific, ...PRODUCT_SHARED_UPLOAD_BUCKETS, ...defaults]));
};

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const safeNum = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const pctChange = (current, prev) => {
  const c = safeNum(current);
  const p = safeNum(prev);
  if (p <= 0) return null;
  return Math.round(((c - p) / p) * 100);
};

const fmtINR = (amount) => {
  const n = safeNum(amount);
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `Rs ${Math.round(n).toLocaleString('en-IN')}`;
  }
};

const parseDataUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('data:')) {
    const match = raw.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    return { mime: match[1], base64: match[2] };
  }
  return { mime: null, base64: raw };
};

const sanitizeSlug = (value = '') =>
  String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'category';

const sanitizeFilename = (value = '') =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 120) || 'image';

const isBucketMissingError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('bucket not found') || (msg.includes('bucket') && msg.includes('not found'));
};
const isBucketAlreadyExistsError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('already exists') || (msg.includes('duplicate') && msg.includes('bucket'));
};
const ensurePublicBucket = async (bucketName) => {
  const bucket = sanitizeBucketName(bucketName);
  if (!bucket) return new Error('Invalid bucket name');
  const { error } = await db.storage.createBucket(bucket, { public: true });
  if (error && !isBucketAlreadyExistsError(error)) return error;
  return null;
};

const normalizeProductUploadType = (value = '') => {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'image' || t === 'video' || t === 'pdf') return t;
  return null;
};

const inferProductUploadTypeFromMime = (mime = '') => {
  const m = String(mime || '').trim().toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  return null;
};

const buildProductUploadPath = ({ type, originalName, contentType }) => {
  const safeName = sanitizeFilename(originalName || '');
  const extFromMime = MIME_EXT[contentType] || '';
  const hasExt = safeName.includes('.');
  const base = hasExt ? safeName.replace(/\.[^/.]+$/, '') : safeName;
  const ext = hasExt ? safeName.split('.').pop() : (extFromMime || 'bin');
  const finalName = `${base || type || 'upload'}.${ext}`;
  return `product-media/${type}s/${Date.now()}-${randomUUID()}-${finalName}`;
};

const hasSalesAccess = (authRole, employeeRole) => {
  const a = normalizeRole(authRole || '');
  const e = normalizeRole(employeeRole || '');
  return SALES_ROLES.has(a) || SALES_ROLES.has(e);
};

const hasStaffManagementAccess = (authRole, employeeRole) => {
  const a = normalizeRole(authRole || '');
  const e = normalizeRole(employeeRole || '');
  return STAFF_MANAGE_ROLES.has(a) || STAFF_MANAGE_ROLES.has(e);
};

const hasManagerApprovalAccess = (authRole, employeeRole) => {
  const a = normalizeRole(authRole || '');
  const e = normalizeRole(employeeRole || '');
  return MANAGER_APPROVAL_ROLES.has(a) || MANAGER_APPROVAL_ROLES.has(e);
};

const isMissingColumnError = (error, columnName = '') => {
  const normalizedColumn = String(columnName || '').trim().toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return Boolean(
    normalizedColumn &&
      message.includes(normalizedColumn) &&
      (message.includes('column') || message.includes('schema cache'))
  );
};

const normalizePricingRuleType = (value = '') => {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
  return PRICING_RULE_ALLOWED_TYPES.has(normalized) ? normalized : '';
};

const buildPricingRuleRecord = (entityId, details = {}, createdAt = '') => {
  const numericValue = Number(details?.value);
  return {
    id: String(entityId || '').trim(),
    rule_name: String(details?.rule_name || details?.name || '').trim() || 'Untitled Rule',
    type: normalizePricingRuleType(details?.type) || String(details?.type || '').trim().toUpperCase() || '-',
    value: Number.isFinite(numericValue) ? numericValue : details?.value ?? null,
    status: String(details?.status || 'PENDING_APPROVAL').trim().toUpperCase() || 'PENDING_APPROVAL',
    requested_by_name: String(details?.requested_by_name || '').trim() || null,
    requested_by_email: String(details?.requested_by_email || '').trim() || null,
    requested_by_role: normalizeRole(details?.requested_by_role || 'SALES') || 'SALES',
    requester_user_id: String(details?.requester_user_id || '').trim() || null,
    submitted_at: String(details?.submitted_at || '').trim() || createdAt || new Date().toISOString(),
    created_at: String(details?.created_at || '').trim() || createdAt || new Date().toISOString(),
    manager_remarks: String(details?.manager_remarks || details?.remarks || '').trim() || null,
    business_reason: String(details?.business_reason || details?.reason || '').trim() || null,
    target_segment: String(details?.target_segment || details?.scope || '').trim() || null,
    decided_at: String(details?.decided_at || '').trim() || null,
    decided_by_name: String(details?.decided_by_name || '').trim() || null,
    decided_by_email: String(details?.decided_by_email || '').trim() || null,
    decided_by_role: normalizeRole(details?.decided_by_role || '') || null,
    source: 'pricing_rule_request',
  };
};

const applyPricingRuleAuditEvent = (currentRule, auditRow) => {
  const createdAt = String(auditRow?.created_at || '').trim() || new Date().toISOString();
  const details =
    auditRow?.details && typeof auditRow.details === 'object' && !Array.isArray(auditRow.details)
      ? auditRow.details
      : {};
  const nextRule = {
    ...(currentRule || buildPricingRuleRecord(auditRow?.entity_id, details, createdAt)),
    ...buildPricingRuleRecord(auditRow?.entity_id, details, createdAt),
  };

  if (!nextRule.created_at) nextRule.created_at = createdAt;
  if (!nextRule.submitted_at) nextRule.submitted_at = createdAt;

  if (auditRow?.action === PRICING_RULE_SUBMITTED_ACTION) {
    nextRule.status = 'PENDING_APPROVAL';
    nextRule.submitted_at = nextRule.submitted_at || createdAt;
  }

  if (auditRow?.action === PRICING_RULE_APPROVED_ACTION) {
    nextRule.status = 'APPROVED';
    nextRule.decided_at = createdAt;
  }

  if (auditRow?.action === PRICING_RULE_REJECTED_ACTION) {
    nextRule.status = 'REJECTED';
    nextRule.decided_at = createdAt;
  }

  return nextRule;
};

const hydratePricingRuleRequests = (auditRows = []) => {
  const byId = new Map();
  const rows = Array.isArray(auditRows) ? [...auditRows] : [];
  rows.sort((left, right) => new Date(left?.created_at || 0).getTime() - new Date(right?.created_at || 0).getTime());

  rows.forEach((row) => {
    const entityId = String(row?.entity_id || '').trim();
    if (!entityId) return;
    const existing = byId.get(entityId) || null;
    byId.set(entityId, applyPricingRuleAuditEvent(existing, row));
  });

  return Array.from(byId.values()).sort(
    (left, right) =>
      new Date(right?.submitted_at || right?.created_at || 0).getTime() -
      new Date(left?.submitted_at || left?.created_at || 0).getTime()
  );
};

const roleToDepartment = (role) => {
  switch (normalizeRole(role)) {
    case 'ADMIN':
      return 'Administration';
    case 'HR':
      return 'Human Resources';
    case 'FINANCE':
      return 'Finance';
    case 'SUPPORT':
      return 'Support';
    case 'SALES':
      return 'Sales';
    case 'MANAGER':
      return 'Territory';
    case 'VP':
      return 'Leadership';
    case 'DATA_ENTRY':
    case 'DATAENTRY':
      return 'Operations';
    default:
      return '';
  }
};

const PRIVILEGED_STAFF_ROLES = new Set(['ADMIN', 'HR', 'FINANCE', 'SUPERADMIN']);
const SEARCH360_EMPLOYEE_ROLES = ['SUPPORT', 'DATA_ENTRY', 'SALES', 'MANAGER', 'VP', 'ADMIN'];

// Roles each level is allowed to CREATE:
// ADMIN → HR, FINANCE only
// HR → SALES, SUPPORT, DATA_ENTRY, MANAGER, VP only
const ADMIN_CREATABLE_ROLES = new Set(['HR', 'FINANCE']);
const HR_CREATABLE_ROLES = new Set(['SALES', 'SUPPORT', 'DATA_ENTRY', 'MANAGER', 'VP']);

const canHrManageRole = (managerRole, targetRole) =>
  normalizeRole(managerRole) !== 'HR' || !PRIVILEGED_STAFF_ROLES.has(normalizeRole(targetRole));

const canManagerCreateRole = (managerRole, targetRole) => {
  const mgr = normalizeRole(managerRole);
  const tgt = normalizeRole(targetRole);
  if (mgr === 'ADMIN') return ADMIN_CREATABLE_ROLES.has(tgt);
  if (mgr === 'HR') return HR_CREATABLE_ROLES.has(tgt);
  return false;
};

const syncEmployeePublicUser = async (employee) => {
  const email = normalizeEmail(employee?.email || '');
  if (!email) return null;

  return upsertPublicUser({
    id: employee?.user_id || undefined,
    email,
    full_name: String(employee?.full_name || '').trim(),
    role: normalizeRole(employee?.role || 'DATA_ENTRY') || 'DATA_ENTRY',
    phone: String(employee?.phone || '').trim() || null,
    allowPasswordUpdate: false,
  });
};

async function resolveEmployeeProfile(authUser) {
  const userId = String(authUser?.id || '').trim();
  const email = String(authUser?.email || '').trim().toLowerCase();

  let employee = null;
  const { data: byId } = await db
    .from('employees')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (byId) employee = byId;

  if (!employee && email) {
    const { data: byEmail } = await db
      .from('employees')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    if (byEmail) employee = byEmail;
  }

  if (employee?.id && userId && employee.user_id !== userId) {
    await db
      .from('employees')
      .update({ user_id: userId })
      .eq('id', employee.id);
    employee.user_id = userId;
  }

  return employee || null;
}

function buildAuthEmployeeFallback(authUser) {
  const role = normalizeRole(authUser?.role || '');
  if (!['ADMIN', 'SUPERADMIN', 'HR', 'FINANCE', 'SUPPORT', 'SALES', 'DATA_ENTRY', 'MANAGER', 'VP'].includes(role)) {
    return null;
  }

  return {
    id: String(authUser?.id || '').trim(),
    user_id: String(authUser?.id || '').trim() || null,
    email: String(authUser?.email || '').trim() || null,
    full_name: String(authUser?.email || '').trim() || 'Internal User',
    role,
    status: 'ACTIVE',
    department: roleToDepartment(role) || null,
    states_scope: [],
    fallback_profile: true,
  };
}

async function resolveStaffManager(req, res) {
  const employee = (await resolveEmployeeProfile(req.user)) || buildAuthEmployeeFallback(req.user);
  if (!employee) {
    res.status(404).json({ success: false, error: 'Employee profile not found' });
    return null;
  }

  if (!hasStaffManagementAccess(req.user?.role, employee?.role)) {
    res.status(403).json({ success: false, error: 'Staff management access required' });
    return null;
  }

  return employee;
}

router.get('/search360/vendors', requireEmployeeRoles(SEARCH360_EMPLOYEE_ROLES), async (req, res) => {
  try {
    const actor = buildSearch360ActorFromEmployee(req);
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

router.post('/search360/escalations', requireEmployeeRoles(SEARCH360_EMPLOYEE_ROLES), async (req, res) => {
  try {
    const actor = buildSearch360ActorFromEmployee(req);
    const result = await createSearch360Escalation(actor, req.body || {}, req);
    return res.status(201).json(result);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to create Search 360 escalation',
    });
  }
});

router.patch('/search360/cases/:caseId/status', requireEmployeeRoles(SEARCH360_EMPLOYEE_ROLES), async (req, res) => {
  try {
    const actor = buildSearch360ActorFromEmployee(req);
    const result = await updateSearch360CaseStatus(actor, req.params.caseId, req.body || {}, req);
    return res.json(result);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      success: false,
      error: error?.message || 'Failed to update Search 360 case',
    });
  }
});

router.get('/staff', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveStaffManager(req, res);
    if (!employee) return;

    const { data, error } = await db
      .from('employees')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch staff' });
    }

    return res.json({ success: true, employees: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch staff' });
  }
});

router.post('/staff', requireAuth(), async (req, res) => {
  try {
    const manager = await resolveStaffManager(req, res);
    if (!manager) return;

    const full_name = String(req.body?.full_name || '').trim();
    const email = normalizeEmail(req.body?.email || '');
    const password = String(req.body?.password || '').trim();
    const role = normalizeRole(req.body?.role || 'DATA_ENTRY') || 'DATA_ENTRY';
    const phone = String(req.body?.phone || '').trim() || null;
    const department = String(req.body?.department || '').trim() || roleToDepartment(role) || null;

    if (!full_name || !email || !password) {
      return res.status(400).json({ success: false, error: 'full_name, email and password are required' });
    }

    // Enforce role creation hierarchy:
    // ADMIN → can only create HR, FINANCE
    // HR   → can only create SALES, SUPPORT, DATA_ENTRY, MANAGER, VP
    if (!canManagerCreateRole(manager?.role, role)) {
      const managerRole = normalizeRole(manager?.role);
      const allowed = managerRole === 'ADMIN'
        ? [...ADMIN_CREATABLE_ROLES].join(', ')
        : [...HR_CREATABLE_ROLES].join(', ');
      return res.status(403).json({
        success: false,
        error: `${managerRole} can only create: ${allowed}`,
      });
    }

    const passwordValidation = validateStrongPassword(password);
    if (!passwordValidation.ok) {
      return res.status(400).json({ success: false, error: passwordValidation.error });
    }

    const password_hash = await hashPassword(password);
    const publicUser = await upsertPublicUser({
      email,
      full_name,
      role,
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });

    const employeePayload = {
      user_id: publicUser.id,
      full_name,
      email,
      phone,
      role,
      department,
      status: 'ACTIVE',
      updated_at: new Date().toISOString(),
    };

    const { data: existingByUserId, error: existingByUserIdError } = await db
      .from('employees')
      .select('*')
      .eq('user_id', publicUser.id)
      .maybeSingle();

    if (existingByUserIdError) {
      return res.status(500).json({ success: false, error: existingByUserIdError.message });
    }

    let existingEmployee = existingByUserId || null;

    if (!existingEmployee) {
      const { data: existingByEmail, error: existingByEmailError } = await db
        .from('employees')
        .select('*')
        .ilike('email', email)
        .limit(1)
        .maybeSingle();

      if (existingByEmailError) {
        return res.status(500).json({ success: false, error: existingByEmailError.message });
      }

      existingEmployee = existingByEmail || null;
    }

    let employeeRow = null;
    if (existingEmployee?.id) {
      const { data: updatedEmployee, error: updateEmployeeError } = await db
        .from('employees')
        .update(employeePayload)
        .eq('id', existingEmployee.id)
        .select('*')
        .maybeSingle();

      if (updateEmployeeError) {
        return res.status(500).json({ success: false, error: updateEmployeeError.message });
      }

      employeeRow = updatedEmployee || { ...existingEmployee, ...employeePayload };
    } else {
      const { data: insertedEmployee, error: insertEmployeeError } = await db
        .from('employees')
        .insert([
          {
            ...employeePayload,
            created_at: new Date().toISOString(),
          },
        ])
        .select('*')
        .maybeSingle();

      if (insertEmployeeError) {
        return res.status(500).json({ success: false, error: insertEmployeeError.message });
      }

      employeeRow = insertedEmployee || null;
    }

    return res.json({
      success: true,
      employee: employeeRow,
      reused_existing: Boolean(existingEmployee?.id),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to create employee' });
  }
});

router.patch('/staff/:employeeId', requireAuth(), async (req, res) => {
  try {
    const manager = await resolveStaffManager(req, res);
    if (!manager) return;

    const { employeeId } = req.params;
    const { data: employeeRow, error: employeeError } = await db
      .from('employees')
      .select('*')
      .eq('id', employeeId)
      .maybeSingle();

    if (employeeError) {
      return res.status(500).json({ success: false, error: employeeError.message || 'Failed to fetch employee' });
    }

    if (!employeeRow?.id) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }

    const nextRole = req.body?.role === undefined ? undefined : normalizeRole(req.body?.role || '');
    const nextStatus = req.body?.status === undefined ? undefined : String(req.body?.status || '').trim().toUpperCase();
    const nextName = req.body?.full_name === undefined ? undefined : String(req.body?.full_name || '').trim();
    const nextEmail = req.body?.email === undefined ? undefined : normalizeEmail(req.body?.email || '');
    const nextPhone = req.body?.phone === undefined ? undefined : String(req.body?.phone || '').trim() || null;
    const nextDepartment =
      req.body?.department === undefined
        ? undefined
        : String(req.body?.department || '').trim() || null;

    if (req.body?.role !== undefined && !nextRole) {
      return res.status(400).json({ success: false, error: 'Valid role is required' });
    }

    if (req.body?.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(nextStatus)) {
      return res.status(400).json({ success: false, error: 'Status must be ACTIVE or INACTIVE' });
    }

    if (req.body?.full_name !== undefined && !nextName) {
      return res.status(400).json({ success: false, error: 'full_name cannot be empty' });
    }

    if (req.body?.email !== undefined && !nextEmail) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    const currentRole = normalizeRole(employeeRow?.role || 'DATA_ENTRY');
    const targetRole = nextRole || currentRole;

    if (!canHrManageRole(manager?.role, currentRole) || !canHrManageRole(manager?.role, targetRole)) {
      return res.status(403).json({ success: false, error: 'HR portal cannot manage privileged staff roles' });
    }

    const isSelfUpdate =
      String(employeeRow?.user_id || '').trim() === String(req.user?.id || '').trim() ||
      normalizeEmail(employeeRow?.email || '') === normalizeEmail(req.user?.email || '');

    if (isSelfUpdate && nextStatus && nextStatus !== 'ACTIVE') {
      return res.status(400).json({ success: false, error: 'You cannot deactivate your own account' });
    }

    const updates = {
      updated_at: new Date().toISOString(),
    };

    if (nextName !== undefined && nextName !== String(employeeRow?.full_name || '').trim()) {
      updates.full_name = nextName;
    }

    if (nextEmail !== undefined && nextEmail !== normalizeEmail(employeeRow?.email || '')) {
      updates.email = nextEmail;
    }

    if (nextPhone !== undefined && nextPhone !== (String(employeeRow?.phone || '').trim() || null)) {
      updates.phone = nextPhone;
    }

    if (nextRole !== undefined && nextRole !== currentRole) {
      updates.role = nextRole;
      if (nextDepartment === undefined && !employeeRow?.department) {
        updates.department = roleToDepartment(nextRole) || null;
      }
    }

    if (nextDepartment !== undefined && nextDepartment !== (employeeRow?.department || null)) {
      updates.department = nextDepartment;
    }

    if (nextStatus !== undefined && nextStatus !== String(employeeRow?.status || 'ACTIVE').trim().toUpperCase()) {
      updates.status = nextStatus;
    }

    if (Object.keys(updates).length === 1) {
      return res.json({ success: true, employee: employeeRow });
    }

    const draftEmployee = { ...employeeRow, ...updates };
    const publicUser = await syncEmployeePublicUser(draftEmployee);
    if (publicUser?.id && publicUser.id !== employeeRow?.user_id) {
      updates.user_id = publicUser.id;
    }

    const { data: updatedEmployee, error: updateError } = await db
      .from('employees')
      .update(updates)
      .eq('id', employeeId)
      .select('*')
      .maybeSingle();

    if (updateError) {
      return res.status(500).json({ success: false, error: updateError.message || 'Failed to update employee' });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'STAFF_UPDATE',
      entityType: 'employees',
      entityId: employeeId,
      details: {
        before: {
          role: currentRole,
          status: employeeRow?.status || 'ACTIVE',
          department: employeeRow?.department || null,
        },
        after: {
          role: updatedEmployee?.role || currentRole,
          status: updatedEmployee?.status || employeeRow?.status || 'ACTIVE',
          department: updatedEmployee?.department || updates.department || employeeRow?.department || null,
        },
      },
    });

    return res.json({ success: true, employee: updatedEmployee || { ...employeeRow, ...updates } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update employee' });
  }
});

async function sumRevenueByPeriod({ startIso, endIso, endInclusive = true }) {
  let byPurchaseDate = db
    .from('lead_purchases')
    .select('amount, purchase_date');

  byPurchaseDate = byPurchaseDate.gte('purchase_date', startIso);
  byPurchaseDate = endInclusive
    ? byPurchaseDate.lte('purchase_date', endIso)
    : byPurchaseDate.lt('purchase_date', endIso);

  let { data, error } = await byPurchaseDate;

  // Legacy schema fallback: purchase_date column may not exist.
  const errText = String(error?.message || '').toLowerCase();
  if (error && (error?.code === '42703' || errText.includes('purchase_date'))) {
    let byCreatedAt = db
      .from('lead_purchases')
      .select('amount, created_at')
      .gte('created_at', startIso);
    byCreatedAt = endInclusive
      ? byCreatedAt.lte('created_at', endIso)
      : byCreatedAt.lt('created_at', endIso);

    ({ data, error } = await byCreatedAt);
  }

  if (error) throw new Error(error.message || 'Failed to load revenue');

  return safeNum((data || []).reduce((sum, row) => sum + safeNum(row?.amount), 0));
}

const normalizeTextValue = (value = '', max = 500) => {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : '';
};

const normalizeSalesCode = (value = '') =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32);

const getSalesUserId = (employee, authUser = {}) =>
  String(employee?.user_id || authUser?.id || employee?.id || '').trim() || null;

const getFrontendBaseUrl = (req) => {
  const configured = normalizeTextValue(
    process.env.FRONTEND_URL ||
      process.env.PUBLIC_SITE_URL ||
      process.env.APP_PUBLIC_URL ||
      process.env.WEBSITE_URL ||
      '',
    300
  ).replace(/\/+$/, '');
  if (configured) return configured;

  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost:3000')
    .replace(/:(3001|3100|5000)$/, ':3000');
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return `${proto}://${host}`;
};

const buildSalesPlanLink = (req, { planId, salesCode, vendorId = '' }) => {
  const params = new URLSearchParams();
  if (planId) params.set('plan', planId);
  if (salesCode) params.set('sales_code', salesCode);
  if (vendorId) params.set('vendor_id', vendorId);
  return `${getFrontendBaseUrl(req)}/vendor/services${params.toString() ? `?${params.toString()}` : ''}`;
};

const encodeCursor = (row = {}) => {
  const createdAt = row?.created_at || row?.date || null;
  const id = row?.id || null;
  if (!createdAt || !id) return null;
  return Buffer.from(JSON.stringify({ created_at: createdAt, id }), 'utf8').toString('base64url');
};

const decodeCursor = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed?.created_at || !parsed?.id) return null;
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    return null;
  }
};

const salesDashboardCacheKey = (actor = {}) =>
  `sales-dashboard:v2:${actor.employee?.role || 'role'}:${actor.salesUserId || actor.employee?.id || 'all'}`;

async function readDashboardSnapshot(metricScope, scopeId, metricKey) {
  try {
    const rows = await mysqlQuery(
      `SELECT payload, computed_at, expires_at
         FROM dashboard_metric_snapshots
        WHERE metric_scope = ?
          AND scope_id = ?
          AND metric_key = ?
          AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())
        LIMIT 1`,
      [metricScope, scopeId, metricKey]
    );
    const row = rows?.[0];
    if (!row?.payload) return null;
    return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  } catch {
    return null;
  }
}

async function writeDashboardSnapshot(metricScope, scopeId, metricKey, payload, ttlSeconds = 180) {
  try {
    await mysqlQuery(
      `INSERT INTO dashboard_metric_snapshots
        (id, metric_scope, scope_id, metric_key, payload, computed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE
        payload = VALUES(payload),
        computed_at = VALUES(computed_at),
        expires_at = VALUES(expires_at)`,
      [randomUUID(), metricScope, scopeId, metricKey, JSON.stringify(payload || {}), ttlSeconds]
    );
  } catch {
    // Snapshot table is an optimization; live route must keep working without it.
  }
}

const buildSalesCodeCandidate = (employee, authUser = {}, salt = '') => {
  const namePart =
    normalizeSalesCode(employee?.full_name || employee?.email || authUser?.email || 'SALE').slice(0, 6) || 'SALE';
  const idPart = normalizeSalesCode(employee?.user_id || authUser?.id || employee?.id || randomUUID()).slice(0, 6);
  const saltPart = normalizeSalesCode(salt).slice(0, 4);
  return normalizeSalesCode(`ITM${namePart}${idPart}${saltPart}`).slice(0, 24);
};

async function ensureSalesCode(employee, authUser = {}) {
  const existing = normalizeSalesCode(employee?.sales_code || '');
  if (existing) return existing;
  if (!employee?.id) return buildSalesCodeCandidate(employee, authUser);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = buildSalesCodeCandidate(employee, authUser, attempt ? randomUUID().slice(0, 6) : '');
    const { data: conflict } = await db
      .from('employees')
      .select('id')
      .eq('sales_code', candidate)
      .maybeSingle();
    if (conflict?.id && conflict.id !== employee.id) continue;

    const { data, error } = await db
      .from('employees')
      .update({ sales_code: candidate, updated_at: new Date().toISOString() })
      .eq('id', employee.id)
      .select('*')
      .maybeSingle();

    if (!error) {
      if (data) Object.assign(employee, data);
      employee.sales_code = candidate;
      return candidate;
    }
  }

  return buildSalesCodeCandidate(employee, authUser, randomUUID().slice(0, 8));
}

async function resolveSalesActor(req, res) {
  const employee = (await resolveEmployeeProfile(req.user)) || buildAuthEmployeeFallback(req.user);
  if (!employee) {
    res.status(404).json({ success: false, error: 'Employee profile not found' });
    return null;
  }
  if (!hasSalesAccess(req.user?.role, employee?.role)) {
    res.status(403).json({ success: false, error: 'Sales access required' });
    return null;
  }
  const salesCode = await ensureSalesCode(employee, req.user);
  return {
    employee,
    salesCode,
    salesUserId: getSalesUserId(employee, req.user),
  };
}

async function resolveSalesEmployeeByCode(code = '') {
  const salesCode = normalizeSalesCode(code);
  if (!salesCode) return null;

  const { data, error } = await db
    .from('employees')
    .select('id, user_id, full_name, email, role, status, sales_code')
    .eq('sales_code', salesCode)
    .maybeSingle();
  if (error || !data?.id) return null;

  const role = normalizeRole(data.role || '');
  const status = String(data.status || 'ACTIVE').trim().toUpperCase();
  if (!['SALES', 'MANAGER', 'VP', 'ADMIN', 'SUPERADMIN'].includes(role) || status !== 'ACTIVE') return null;

  return data;
}

async function getActiveSubscriptionMap(vendorIds = []) {
  const ids = Array.from(new Set((vendorIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return new Map();

  const { data, error } = await db
    .from('vendor_plan_subscriptions')
    .select('id, vendor_id, plan_id, status, start_date, end_date, sales_code, sales_user_id, created_at')
    .in('vendor_id', ids)
    .eq('status', 'ACTIVE')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message || 'Failed to fetch active subscriptions');

  const now = Date.now();
  const byVendor = new Map();
  (data || []).forEach((row) => {
    const vendorId = String(row?.vendor_id || '').trim();
    if (!vendorId || byVendor.has(vendorId)) return;
    const endMs = row?.end_date ? new Date(row.end_date).getTime() : null;
    if (endMs && Number.isFinite(endMs) && endMs < now) return;
    byVendor.set(vendorId, row);
  });
  return byVendor;
}

async function hydrateVendors(rows = [], vendorIdField = 'vendor_id') {
  const vendorIds = Array.from(
    new Set((rows || []).map((row) => String(row?.[vendorIdField] || row?.vendor_id || '').trim()).filter(Boolean))
  );
  if (!vendorIds.length) return rows || [];

  const { data, error } = await db
    .from('vendors')
    .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, kyc_status, is_active, created_at')
    .in('id', vendorIds);
  if (error) throw new Error(error.message || 'Failed to hydrate vendors');
  const vendorById = new Map((data || []).map((vendor) => [vendor.id, vendor]));
  return (rows || []).map((row) => ({ ...row, vendor: vendorById.get(row?.[vendorIdField] || row?.vendor_id) || null }));
}

async function hydratePlans(rows = [], planIdField = 'plan_id') {
  const planIds = Array.from(
    new Set((rows || []).map((row) => String(row?.[planIdField] || row?.plan_id || '').trim()).filter(Boolean))
  );
  if (!planIds.length) return rows || [];

  const { data, error } = await db
    .from('vendor_plans')
    .select('id, name, price, duration_days, is_active')
    .in('id', planIds);
  if (error) throw new Error(error.message || 'Failed to hydrate plans');
  const planById = new Map((data || []).map((plan) => [plan.id, plan]));
  return (rows || []).map((row) => ({ ...row, plan: planById.get(row?.[planIdField] || row?.plan_id) || null }));
}

const isMissingWebsiteVisitorEventsTable = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('website_visitor_events') &&
    (message.includes("doesn't exist") || message.includes('does not exist') || message.includes('unknown table'))
  );
};

async function countWebsiteVisitorEvents(startIso, endIso) {
  const { count, error } = await db
    .from('website_visitor_events')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', startIso)
    .lte('created_at', endIso);

  if (error && isMissingWebsiteVisitorEventsTable(error)) return 0;
  if (error) throw new Error(error.message || 'Failed to count visitor activity');
  return safeNum(count);
}

async function getRecentWebsiteVisitorEvents(limit = 12) {
  const { data, error } = await db
    .from('website_visitor_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error && isMissingWebsiteVisitorEventsTable(error)) return [];
  if (error) throw new Error(error.message || 'Failed to fetch visitor activity');
  return data || [];
}

router.get('/me', requireAuth(), async (req, res) => {
  try {
    const authUser = req.user;
    const employee = (await resolveEmployeeProfile(authUser)) || buildAuthEmployeeFallback(authUser);

    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }

    return res.json({
      success: true,
      employee: {
        ...employee,
        user_id: authUser.id || employee.user_id || null,
        role: normalizeRole(employee.role || 'UNKNOWN'),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to resolve employee profile' });
  }
});

// PUT /api/employee/me — update own employee profile
router.put('/me', requireAuth(), async (req, res) => {
  try {
    const authUser = req.user;
    const employee = await resolveEmployeeProfile(authUser);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }

    const ALLOWED_UPDATES = new Set([
      'full_name', 'phone', 'bio', 'avatar_url', 'address',
      'city', 'state', 'state_id', 'city_id',
    ]);

    const updates = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (ALLOWED_UPDATES.has(key)) {
        updates[key] = value !== undefined ? value : null;
      }
    }

    if (!Object.keys(updates).length) {
      return res.json({ success: true, employee });
    }

    updates.updated_at = new Date().toISOString();

    const { data: updated, error } = await db
      .from('employees')
      .update(updates)
      .eq('id', employee.id)
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, employee: updated || { ...employee, ...updates } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update employee profile' });
  }
});

router.post('/category-image-upload', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }

    const level = String(req.body?.level || '').trim().toLowerCase();
    if (!CATEGORY_IMAGE_LEVELS.has(level)) {
      return res.status(400).json({ success: false, error: 'Invalid category level' });
    }

    const slug = sanitizeSlug(req.body?.slug || 'category');
    const dataUrl = String(req.body?.data_url || req.body?.dataUrl || '').trim();
    const originalName = sanitizeFilename(req.body?.file_name || req.body?.fileName || '');
    const explicitType = String(req.body?.content_type || req.body?.contentType || '').trim();

    if (!dataUrl) {
      return res.status(400).json({ success: false, error: 'data_url is required' });
    }

    const parsed = parseDataUrl(dataUrl);
    if (!parsed?.base64) {
      return res.status(400).json({ success: false, error: 'Invalid base64 payload' });
    }

    const contentType = explicitType || parsed.mime || 'application/octet-stream';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ success: false, error: 'Only image uploads are allowed' });
    }

    const buffer = Buffer.from(parsed.base64, 'base64');
    if (!buffer?.length) {
      return res.status(400).json({ success: false, error: 'Empty upload payload' });
    }
    if (buffer.length < CATEGORY_IMAGE_MIN_BYTES) {
      return res.status(400).json({
        success: false,
        error: `Image must be at least ${Math.round(CATEGORY_IMAGE_MIN_BYTES / 1024)}KB`,
      });
    }
    if (buffer.length > CATEGORY_IMAGE_MAX_BYTES) {
      return res.status(413).json({
        success: false,
        error: `Image must be at most ${Math.round(CATEGORY_IMAGE_MAX_BYTES / 1024)}KB`,
      });
    }

    const extFromMime = MIME_EXT[contentType] || 'png';
    const hasExt = originalName.includes('.');
    const ext = hasExt ? originalName.split('.').pop() : extFromMime;
    const objectPath = `category-images/${level}/${slug}-${Date.now()}-${randomUUID()}.${ext}`;

    if (isCloudinaryConfigured()) {
      const uploaded = await uploadBufferToCloudinary({
        buffer,
        contentType,
        folder: `category-images/${level}`,
        publicId: objectPath,
        fileName: objectPath.split('/').pop(),
        tags: ['category-image', level],
      });

      return res.json({
        success: true,
        bucket: uploaded.bucket,
        path: uploaded.path,
        publicUrl: uploaded.publicUrl,
        storage: uploaded.storageProvider,
      });
    }

    const { error: uploadError } = await db.storage
      .from(CATEGORY_IMAGE_BUCKET)
      .upload(objectPath, buffer, {
        contentType,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message || 'Upload failed' });
    }

    const { data } = db.storage.from(CATEGORY_IMAGE_BUCKET).getPublicUrl(objectPath);
    return res.json({
      success: true,
      bucket: CATEGORY_IMAGE_BUCKET,
      path: objectPath,
      publicUrl: data?.publicUrl || null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to upload category image' });
  }
});

router.post('/product-media-upload', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }

    const requestedType = normalizeProductUploadType(req.body?.type || '');
    const dataUrl = String(req.body?.data_url || req.body?.dataUrl || '').trim();
    const originalName = sanitizeFilename(req.body?.file_name || req.body?.fileName || '');
    const explicitType = String(req.body?.content_type || req.body?.contentType || '').trim();

    if (!dataUrl) {
      return res.status(400).json({ success: false, error: 'data_url is required' });
    }

    const parsed = parseDataUrl(dataUrl);
    if (!parsed?.base64) {
      return res.status(400).json({ success: false, error: 'Invalid base64 payload' });
    }

    const contentType = explicitType || parsed.mime || 'application/octet-stream';
    const inferredType = inferProductUploadTypeFromMime(contentType);
    const finalType = requestedType || inferredType;

    const buckets = resolveProductUploadBuckets(finalType);
    if (!finalType || !buckets.length) {
      return res.status(400).json({ success: false, error: 'Unsupported upload type' });
    }
    if (!inferredType || inferredType !== finalType) {
      return res.status(400).json({ success: false, error: 'File type does not match upload type' });
    }

    const buffer = Buffer.from(parsed.base64, 'base64');
    if (!buffer?.length) {
      return res.status(400).json({ success: false, error: 'Empty upload payload' });
    }
    if (buffer.length > PRODUCT_UPLOAD_MAX_BYTES) {
      return res.status(413).json({ success: false, error: 'File too large (max 50MB)' });
    }
    if (finalType === 'image') {
      if (buffer.length < PRODUCT_IMAGE_MIN_BYTES) {
        return res.status(400).json({ success: false, error: 'Image too small (minimum 10KB)' });
      }
      if (buffer.length > PRODUCT_IMAGE_MAX_BYTES) {
        return res.status(413).json({ success: false, error: 'Image too large (maximum 1MB)' });
      }
    }

    const objectPath = buildProductUploadPath({
      type: finalType,
      originalName,
      contentType,
    });

    if (isCloudinaryConfigured()) {
      const uploaded = await uploadBufferToCloudinary({
        buffer,
        contentType,
        folder: `product-media/${finalType}`,
        publicId: objectPath,
        fileName: objectPath.split('/').pop(),
        resourceType: inferCloudinaryResourceType(contentType),
        tags: ['employee-product-media', finalType],
      });

      return res.json({
        success: true,
        bucket: uploaded.bucket,
        path: uploaded.path,
        publicUrl: uploaded.publicUrl,
        storage: uploaded.storageProvider,
      });
    }

    let uploadedBucket = null;
    let lastUploadError = null;
    const uploadOptions = {
      contentType,
      upsert: true,
    };

    for (const bucket of buckets) {
      let { error: uploadError } = await db.storage
        .from(bucket)
        .upload(objectPath, buffer, uploadOptions);
      const bucketMissingOnInitialTry = !!uploadError && isBucketMissingError(uploadError);

      if (bucketMissingOnInitialTry) {
        const bucketCreateError = await ensurePublicBucket(bucket);
        if (!bucketCreateError) {
          const retryUpload = await db.storage.from(bucket).upload(objectPath, buffer, uploadOptions);
          uploadError = retryUpload.error || null;
        } else {
          uploadError = bucketCreateError;
        }
      }

      if (!uploadError) {
        uploadedBucket = bucket;
        break;
      }

      lastUploadError = uploadError;
      if (!bucketMissingOnInitialTry && !isBucketMissingError(uploadError)) {
        break;
      }
    }

    if (!uploadedBucket) {
      const errorMessage = isBucketMissingError(lastUploadError)
        ? `Upload storage bucket not found. Checked: ${buckets.join(', ')}`
        : lastUploadError?.message || 'Upload failed';
      return res.status(500).json({ success: false, error: errorMessage });
    }

    const { data } = db.storage.from(uploadedBucket).getPublicUrl(objectPath);
    return res.json({
      success: true,
      bucket: uploadedBucket,
      path: objectPath,
      publicUrl: data?.publicUrl || null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to upload media' });
  }
});

router.post('/category-update', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }

    const level = String(req.body?.level || '').trim().toLowerCase();
    const table = CATEGORY_TABLE_BY_LEVEL[level];
    if (!table) {
      return res.status(400).json({ success: false, error: 'Invalid category level' });
    }

    const id = String(req.body?.id || '').trim();
    if (!id) {
      return res.status(400).json({ success: false, error: 'Category id is required' });
    }

    const incomingPayload = req.body?.payload;
    if (!incomingPayload || typeof incomingPayload !== 'object') {
      return res.status(400).json({ success: false, error: 'payload object is required' });
    }

    const allowedKeysByLevel = {
      head: ['name', 'slug', 'description', 'image_url', 'image', 'is_active'],
      sub: ['name', 'slug', 'description', 'image_url', 'image', 'is_active'],
      micro: ['name', 'slug', 'image_url', 'image', 'images', 'image_urls', 'is_active'],
    };
    const allowed = new Set(allowedKeysByLevel[level] || []);
    const payload = {};
    Object.keys(incomingPayload).forEach((key) => {
      if (allowed.has(key)) payload[key] = incomingPayload[key];
    });

    if (!Object.keys(payload).length) {
      return res.status(400).json({ success: false, error: 'No allowed fields provided in payload' });
    }

    const { data, error } = await db
      .from(table)
      .update(payload)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to update category' });
    }
    if (!data?.id) {
      return res.status(404).json({ success: false, error: 'Category not found or not updated' });
    }

    return res.json({ success: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update category' });
  }
});

router.get('/sales/stats', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }

    if (!hasSalesAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const now = new Date();
    const endIso = now.toISOString();

    const start7 = startOfDay(now);
    start7.setDate(start7.getDate() - 6);

    const prevStart7 = startOfDay(start7);
    prevStart7.setDate(prevStart7.getDate() - 7);

    const prevEnd7 = new Date(start7);
    const conversions = ['CONVERTED', 'CLOSED'];

    const [
      totalLeadsRes,
      totalConvertedRes,
      newLeads7Res,
      newLeadsPrev7Res,
      converted7Res,
      convertedPrev7Res,
    ] = await Promise.all([
      db.from('leads').select('*', { count: 'exact', head: true }),
      db.from('leads').select('*', { count: 'exact', head: true }).in('status', conversions),
      db
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', start7.toISOString())
        .lte('created_at', endIso),
      db
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', prevStart7.toISOString())
        .lt('created_at', prevEnd7.toISOString()),
      db
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .in('status', conversions)
        .gte('created_at', start7.toISOString())
        .lte('created_at', endIso),
      db
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .in('status', conversions)
        .gte('created_at', prevStart7.toISOString())
        .lt('created_at', prevEnd7.toISOString()),
    ]);

    const countErrors = [
      totalLeadsRes?.error,
      totalConvertedRes?.error,
      newLeads7Res?.error,
      newLeadsPrev7Res?.error,
      converted7Res?.error,
      convertedPrev7Res?.error,
    ].filter(Boolean);

    if (countErrors.length) {
      throw new Error(countErrors[0]?.message || 'Failed to load sales stats');
    }

    const revenue7d = await sumRevenueByPeriod({
      startIso: start7.toISOString(),
      endIso: endIso,
      endInclusive: true,
    });

    const revenuePrev7d = await sumRevenueByPeriod({
      startIso: prevStart7.toISOString(),
      endIso: prevEnd7.toISOString(),
      endInclusive: false,
    });

    const totalLeads = safeNum(totalLeadsRes?.count);
    const totalConverted = safeNum(totalConvertedRes?.count);
    const newLeads7d = safeNum(newLeads7Res?.count);
    const newLeadsPrev7d = safeNum(newLeadsPrev7Res?.count);
    const converted7d = safeNum(converted7Res?.count);
    const convertedPrev7d = safeNum(convertedPrev7Res?.count);

    const conversionRate = totalLeads ? Math.round((totalConverted / totalLeads) * 100) : 0;

    return res.json({
      success: true,
      stats: {
        totalLeads,
        conversionRate,
        newLeads7d,
        newLeadsPrev7d,
        converted7d,
        convertedPrev7d,
        revenue7d,
        revenuePrev7d,
        newLeadsTrendPct: pctChange(newLeads7d, newLeadsPrev7d),
        convertedTrendPct: pctChange(converted7d, convertedPrev7d),
        revenueTrendPct: pctChange(revenue7d, revenuePrev7d),
        revenue7dFmt: fmtINR(revenue7d),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load sales stats' });
  }
});

router.get('/sales/leads', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasSalesAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const limitRaw = Number(req.query?.limit || 80);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 80;
    const cursor = decodeCursor(req.query?.cursor);
    const status = normalizeTextValue(req.query?.status || '', 80).toUpperCase();
    const search = normalizeTextValue(req.query?.search || '', 160);
    const fetchLimit = limit + 1;

    const where = ['1 = 1'];
    const params = [];

    if (cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.created_at, cursor.created_at, cursor.id);
    }

    if (status && status !== 'ALL') {
      where.push('UPPER(COALESCE(status, "")) = ?');
      params.push(status);
    }

    if (search) {
      const like = `%${search}%`;
      where.push(`(
        LOWER(COALESCE(title, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(product_name, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(category, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(description, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(message, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(buyer_name, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(buyer_email, "")) LIKE LOWER(?)
        OR LOWER(COALESCE(buyer_phone, "")) LIKE LOWER(?)
      )`);
      params.push(like, like, like, like, like, like, like, like);
    }

    const rows = await mysqlQuery(
      `SELECT *
         FROM leads
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ${fetchLimit}`,
      params
    );

    const leads = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore ? encodeCursor(leads[leads.length - 1]) : null;

    return res.json({
      success: true,
      leads,
      pageInfo: {
        hasMore,
        nextCursor,
        limit,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch leads' });
  }
});

router.patch('/sales/leads/:leadId', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasSalesAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'leadId is required' });
    }

    const payload = {};
    if (req.body?.status !== undefined) {
      const nextStatus = String(req.body.status || '').trim().toUpperCase();
      if (!nextStatus) {
        return res.status(400).json({ success: false, error: 'status cannot be empty' });
      }
      payload.status = nextStatus;
    }

    ['budget', 'price'].forEach((field) => {
      if (req.body?.[field] === undefined) return;
      const numericValue = Number(req.body[field]);
      if (!Number.isFinite(numericValue) || numericValue < 0) {
        throw new Error(`${field} must be a non-negative number`);
      }
      payload[field] = numericValue;
    });

    if (req.body?.vendor_id !== undefined) {
      payload.vendor_id = String(req.body.vendor_id || '').trim() || null;
    }

    if (req.body?.sales_note !== undefined) {
      payload.sales_note = String(req.body.sales_note || '').trim() || null;
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ success: false, error: 'No valid fields provided for update' });
    }

    payload.updated_at = new Date().toISOString();

    let { data, error } = await db
      .from('leads')
      .update(payload)
      .eq('id', leadId)
      .select('*')
      .maybeSingle();

    if (error && payload.sales_note !== undefined && isMissingColumnError(error, 'sales_note')) {
      const retryPayload = { ...payload };
      delete retryPayload.sales_note;

      ({ data, error } = await db
        .from('leads')
        .update(retryPayload)
        .eq('id', leadId)
        .select('*')
        .maybeSingle());
    }

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to update lead' });
    }

    return res.json({ success: true, lead: data || null });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update lead' });
  }
});

router.patch('/sales/leads/:leadId/status', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasSalesAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const leadId = String(req.params?.leadId || '').trim();
    const nextStatus = String(req.body?.status || '').trim().toUpperCase();
    if (!leadId || !nextStatus) {
      return res.status(400).json({ success: false, error: 'leadId and status are required' });
    }

    const { data, error } = await db
      .from('leads')
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq('id', leadId)
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to update lead status' });
    }

    return res.json({ success: true, lead: data || null });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update lead status' });
  }
});

router.get('/sales/profile', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    return res.json({
      success: true,
      profile: {
        id: actor.employee.id,
        user_id: actor.salesUserId,
        full_name: actor.employee.full_name,
        email: actor.employee.email,
        role: actor.employee.role,
        sales_code: actor.salesCode,
        plan_link_base: buildSalesPlanLink(req, { salesCode: actor.salesCode }),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load sales profile' });
  }
});

router.get('/sales/plans', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const { data, error } = await db
      .from('vendor_plans')
      .select('id, name, description, price, duration_days, daily_limit, weekly_limit, yearly_limit, features, is_active')
      .eq('is_active', true)
      .order('price', { ascending: true });

    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch plans' });

    const plans = (data || [])
      .filter(isVisibleCatalogPlan)
      .map((plan) => ({
        ...plan,
        sales_link: buildSalesPlanLink(req, { planId: plan.id, salesCode: actor.salesCode }),
      }));
    return res.json({ success: true, plans });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch plans' });
  }
});

router.get('/sales/no-plan-vendors', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const limitRaw = Number(req.query?.limit || 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50;
    const search = normalizeTextValue(req.query?.search || '', 120).toLowerCase();
    const region = normalizeTextValue(req.query?.region || '', 120).toLowerCase();

    const fetchLimit = Math.min(Math.max(limit * 8, 200), 800);
    const { data: vendors, error } = await db
      .from('vendors')
      .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, kyc_status, profile_completion, is_active, created_at, updated_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);

    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch vendors' });

    const vendorRows = Array.isArray(vendors) ? vendors : [];
    const activeByVendor = await getActiveSubscriptionMap(vendorRows.map((vendor) => vendor.id));

    let rows = vendorRows
      .filter((vendor) => !activeByVendor.has(String(vendor.id || '').trim()))
      .filter((vendor) => {
        const haystack = [
          vendor.company_name,
          vendor.owner_name,
          vendor.email,
          vendor.phone,
          vendor.vendor_id,
          vendor.city,
          vendor.state,
          vendor.pincode,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const regionText = [vendor.city, vendor.state, vendor.pincode].filter(Boolean).join(' ').toLowerCase();
        if (search && !haystack.includes(search)) return false;
        if (region && !regionText.includes(region)) return false;
        return true;
      })
      .slice(0, limit);

    const vendorIds = rows.map((vendor) => vendor.id).filter(Boolean);
    let latestByVendor = new Map();
    if (vendorIds.length) {
      const { data: engagements, error: engagementError } = await db
        .from('sales_vendor_engagements')
        .select('id, vendor_id, lead_id, sales_user_id, plan_id, sales_code, plan_share_url, channel, engagement_type, status, notes, next_follow_up_at, created_at')
        .in('vendor_id', vendorIds)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (engagementError) {
        return res.status(500).json({ success: false, error: engagementError.message || 'Failed to fetch vendor engagement history' });
      }
      (engagements || []).forEach((row) => {
        if (!row?.vendor_id || latestByVendor.has(row.vendor_id)) return;
        latestByVendor.set(row.vendor_id, row);
      });
    }

    rows = rows.map((vendor) => ({
      ...vendor,
      active_plan: null,
      latest_engagement: latestByVendor.get(vendor.id) || null,
      last_contact_at: latestByVendor.get(vendor.id)?.created_at || null,
      next_follow_up_at: latestByVendor.get(vendor.id)?.next_follow_up_at || null,
    }));

    return res.json({
      success: true,
      vendors: rows,
      meta: {
        total_scanned: vendorRows.length,
        returned: rows.length,
        limit,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch vendors without plans' });
  }
});

router.get('/sales/reminders', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const limitRaw = Number(req.query?.limit || 80);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 80;
    const status = normalizeRole(req.query?.status || '');
    const dueOnly = String(req.query?.due || '').toLowerCase() === 'true';

    let query = db
      .from('sales_vendor_engagements')
      .select('id, vendor_id, lead_id, sales_user_id, manager_user_id, vp_user_id, division_id, plan_id, sales_code, plan_share_url, channel, engagement_type, status, notes, next_follow_up_at, created_at, updated_at')
      .not('next_follow_up_at', 'is', null)
      .order('next_follow_up_at', { ascending: true })
      .limit(limit);

    if (actor.employee.role === 'SALES') query = query.eq('sales_user_id', actor.salesUserId);
    if (status) query = query.eq('status', status);
    else query = query.in('status', ['OPEN', 'PENDING', 'SENT', 'IN_PROGRESS']);
    if (dueOnly) query = query.lte('next_follow_up_at', new Date().toISOString());

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch reminders' });

    let reminders = await hydrateVendors(data || []);
    reminders = await hydratePlans(reminders);

    return res.json({ success: true, reminders });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch reminders' });
  }
});

router.post('/sales/reminders', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const vendorId = normalizeTextValue(req.body?.vendor_id || '', 80);
    const leadId = normalizeTextValue(req.body?.lead_id || '', 80);
    const notes = normalizeTextValue(req.body?.notes || '', 2000);
    const nextFollowUpAt = normalizeTextValue(req.body?.next_follow_up_at || '', 80);
    const status = normalizeRole(req.body?.status || 'OPEN') || 'OPEN';
    const channel = normalizeRole(req.body?.channel || 'CALL') || 'CALL';

    if (!vendorId && !leadId) {
      return res.status(400).json({ success: false, error: 'vendor_id or lead_id is required' });
    }
    if (!nextFollowUpAt || Number.isNaN(new Date(nextFollowUpAt).getTime())) {
      return res.status(400).json({ success: false, error: 'Valid next_follow_up_at is required' });
    }

    if (vendorId) {
      const { data: vendor, error: vendorError } = await db
        .from('vendors')
        .select('id')
        .eq('id', vendorId)
        .maybeSingle();
      if (vendorError) return res.status(500).json({ success: false, error: vendorError.message || 'Failed to validate vendor' });
      if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    if (leadId) {
      await db
        .from('leads')
        .update({
          assigned_to: actor.employee.id,
          assigned_sales_user_id: actor.salesUserId,
          next_follow_up_at: new Date(nextFollowUpAt).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId);
    }

    const payload = {
      vendor_id: vendorId || null,
      lead_id: leadId || null,
      sales_user_id: actor.salesUserId,
      engagement_type: 'FOLLOW_UP',
      channel,
      status,
      notes: notes || null,
      next_follow_up_at: new Date(nextFollowUpAt).toISOString(),
      sales_code: actor.salesCode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await db
      .from('sales_vendor_engagements')
      .insert([payload])
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to create reminder' });

    await writeAuditLog({
      req,
      actor: req.actor || { email: actor.employee.email, role: actor.employee.role },
      action: 'SALES_FOLLOW_UP_REMINDER_CREATED',
      entityType: 'sales_vendor_engagements',
      entityId: data?.id || null,
      details: { vendor_id: vendorId || null, lead_id: leadId || null, next_follow_up_at: nextFollowUpAt },
    });

    return res.status(201).json({ success: true, reminder: data || payload });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to create reminder' });
  }
});

router.patch('/sales/reminders/:id/status', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const id = normalizeTextValue(req.params?.id || '', 80);
    const status = normalizeRole(req.body?.status || '');
    if (!id || !status) return res.status(400).json({ success: false, error: 'id and status are required' });

    let query = db.from('sales_vendor_engagements').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (actor.employee.role === 'SALES') query = query.eq('sales_user_id', actor.salesUserId);

    const { data, error } = await query.select('*').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to update reminder' });
    if (!data?.id) return res.status(404).json({ success: false, error: 'Reminder not found' });

    return res.json({ success: true, reminder: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update reminder' });
  }
});

router.post('/sales/plan-shares', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const vendorId = normalizeTextValue(req.body?.vendor_id || '', 80);
    const planId = normalizeTextValue(req.body?.plan_id || '', 80);
    const leadId = normalizeTextValue(req.body?.lead_id || '', 80);
    const channel = normalizeRole(req.body?.channel || 'WHATSAPP') || 'WHATSAPP';
    const notes = normalizeTextValue(req.body?.notes || '', 2000);
    const nextFollowUpAt = normalizeTextValue(req.body?.next_follow_up_at || '', 80);

    if (!vendorId || !planId) {
      return res.status(400).json({ success: false, error: 'vendor_id and plan_id are required' });
    }

    const [{ data: vendor, error: vendorError }, { data: plan, error: planError }] = await Promise.all([
      db.from('vendors').select('id, vendor_id, company_name, email, phone').eq('id', vendorId).maybeSingle(),
      db.from('vendor_plans').select('id, name, price, duration_days, is_active').eq('id', planId).maybeSingle(),
    ]);

    if (vendorError) return res.status(500).json({ success: false, error: vendorError.message || 'Failed to validate vendor' });
    if (planError) return res.status(500).json({ success: false, error: planError.message || 'Failed to validate plan' });
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor not found' });
    if (!plan?.id || plan.is_active === false) return res.status(404).json({ success: false, error: 'Active plan not found' });

    const planShareUrl = buildSalesPlanLink(req, {
      planId,
      salesCode: actor.salesCode,
      vendorId,
    });

    const payload = {
      vendor_id: vendorId,
      lead_id: leadId || null,
      sales_user_id: actor.salesUserId,
      plan_id: planId,
      sales_code: actor.salesCode,
      plan_share_url: planShareUrl,
      channel,
      engagement_type: 'PLAN_SHARED',
      status: 'SENT',
      notes: notes || `Shared ${plan.name} plan with ${vendor.company_name || vendor.vendor_id || 'vendor'}`,
      next_follow_up_at: nextFollowUpAt && !Number.isNaN(new Date(nextFollowUpAt).getTime())
        ? new Date(nextFollowUpAt).toISOString()
        : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await db
      .from('sales_vendor_engagements')
      .insert([payload])
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to save plan share' });

    await writeAuditLog({
      req,
      actor: req.actor || { email: actor.employee.email, role: actor.employee.role },
      action: 'SALES_PLAN_SHARED',
      entityType: 'sales_vendor_engagements',
      entityId: data?.id || null,
      details: { vendor_id: vendorId, plan_id: planId, sales_code: actor.salesCode, channel },
    });

    return res.status(201).json({
      success: true,
      share: {
        ...(data || payload),
        vendor,
        plan,
      },
      link: planShareUrl,
      sales_code: actor.salesCode,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to share plan' });
  }
});

router.post('/sales/activate-plan', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const vendorId = normalizeTextValue(req.body?.vendor_id || '', 80);
    const planId = normalizeTextValue(req.body?.plan_id || '', 80);
    const notes = normalizeTextValue(req.body?.notes || '', 2000);
    const amountRaw = Number(req.body?.amount ?? req.body?.net_amount ?? 0);
    const amount = Number.isFinite(amountRaw) && amountRaw >= 0 ? amountRaw : 0;

    if (!vendorId || !planId) {
      return res.status(400).json({ success: false, error: 'vendor_id and plan_id are required' });
    }

    const [{ data: vendor, error: vendorError }, { data: plan, error: planError }] = await Promise.all([
      db.from('vendors').select('id, vendor_id, company_name, email, phone').eq('id', vendorId).maybeSingle(),
      db.from('vendor_plans').select('*').eq('id', planId).maybeSingle(),
    ]);

    if (vendorError) return res.status(500).json({ success: false, error: vendorError.message || 'Failed to validate vendor' });
    if (planError) return res.status(500).json({ success: false, error: planError.message || 'Failed to validate plan' });
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor not found' });
    if (!plan?.id || plan.is_active === false) return res.status(404).json({ success: false, error: 'Active plan not found' });

    const entitlements = getPlanEntitlements(plan);
    const durationDays = Math.max(1, Number(req.body?.duration_days || plan.duration_days || 365));
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

    await db
      .from('vendor_plan_subscriptions')
      .update({ status: 'INACTIVE' })
      .eq('vendor_id', vendorId)
      .eq('status', 'ACTIVE');

    const { data: subscription, error: subscriptionError } = await db
      .from('vendor_plan_subscriptions')
      .insert([{
        vendor_id: vendorId,
        plan_id: planId,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        status: 'ACTIVE',
        plan_duration_days: durationDays,
        sales_code: actor.salesCode,
        sales_user_id: actor.salesUserId,
        auto_renewal_enabled: false,
        renewal_notification_sent: false,
      }])
      .select('*')
      .maybeSingle();

    if (subscriptionError) {
      return res.status(500).json({ success: false, error: subscriptionError.message || 'Failed to activate plan' });
    }

    const quotaPayload = {
      vendor_id: vendorId,
      plan_id: planId,
      daily_used: 0,
      daily_limit: Math.max(0, Number(plan?.daily_limit || 0)),
      weekly_used: 0,
      weekly_limit: Math.max(0, Number(plan?.weekly_limit || 0)),
      yearly_used: 0,
      yearly_limit: Math.max(0, Number(plan?.yearly_limit || 0)),
      last_reset_date: startDate.toISOString(),
      updated_at: startDate.toISOString(),
    };

    const { data: existingQuota } = await db
      .from('vendor_lead_quota')
      .select('id')
      .eq('vendor_id', vendorId)
      .maybeSingle();

    if (existingQuota?.id) {
      await db.from('vendor_lead_quota').update(quotaPayload).eq('vendor_id', vendorId);
    } else {
      await db.from('vendor_lead_quota').insert([quotaPayload]);
    }

    let payment = null;
    if (amount > 0) {
      const { data: paymentRow, error: paymentError } = await db
        .from('vendor_payments')
        .insert([{
          vendor_id: vendorId,
          plan_id: planId,
          subscription_id: subscription?.id || null,
          amount,
          net_amount: amount,
          discount_amount: 0,
          description: `${plan.name} sales-assisted activation`,
          status: 'COMPLETED',
          payment_method: 'OFFLINE_SALES',
          transaction_id: `SALES-${Date.now()}-${randomUUID().slice(0, 8)}`,
          payment_date: startDate.toISOString(),
          sales_code: actor.salesCode,
          sales_user_id: actor.salesUserId,
        }])
        .select('*')
        .maybeSingle();
      if (paymentError) {
        logger.warn('[sales] Offline payment record failed:', paymentError?.message || paymentError);
      } else {
        payment = paymentRow || null;
      }
    }

    await writeAuditLog({
      req,
      actor: req.actor || { email: actor.employee.email, role: actor.employee.role },
      action: isSalesAssistedPlan(plan) ? 'SALES_ASSISTED_PLAN_ACTIVATED' : 'SALES_PLAN_ACTIVATED',
      entityType: 'vendor_plan_subscriptions',
      entityId: subscription?.id || null,
      details: {
        vendor_id: vendorId,
        plan_id: planId,
        sales_code: actor.salesCode,
        amount,
        notes: notes || null,
        entitlements,
      },
    });

    return res.status(201).json({
      success: true,
      subscription,
      payment,
      vendor,
      plan: {
        ...plan,
        entitlements,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to activate sales plan' });
  }
});

router.get('/sales/attributions', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const limitRaw = Number(req.query?.limit || 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50;

    let query = db
      .from('vendor_payments')
      .select('id, vendor_id, plan_id, subscription_id, amount, discount_amount, net_amount, status, payment_method, transaction_id, payment_date, coupon_code, offer_type, offer_code, referral_id, sales_code, sales_user_id, sales_engagement_id')
      .order('payment_date', { ascending: false })
      .limit(limit);

    if (actor.employee.role === 'SALES') {
      query = query.or(`sales_user_id.eq.${actor.salesUserId},sales_code.eq.${actor.salesCode}`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch attribution records' });

    let payments = await hydrateVendors(data || []);
    payments = await hydratePlans(payments);
    const totalRevenue = payments.reduce((sum, row) => sum + safeNum(row?.net_amount ?? row?.amount), 0);

    return res.json({
      success: true,
      payments,
      summary: {
        count: payments.length,
        total_revenue: totalRevenue,
        total_revenue_fmt: fmtINR(totalRevenue),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch attribution records' });
  }
});

router.get('/sales/dashboard', requireAuth(), async (req, res) => {
  try {
    const actor = await resolveSalesActor(req, res);
    if (!actor) return;

    const cacheKey = salesDashboardCacheKey(actor);
    const snapshotScope = 'sales_dashboard';
    const snapshotScopeId = actor.employee.role === 'SALES'
      ? String(actor.salesUserId || actor.employee.id || 'sales')
      : String(actor.employee.role || 'all');

    if (isRedisConfigured()) {
      const cached = await cacheGetJson(cacheKey).catch(() => null);
      if (cached?.dashboard) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
    }

    const snapshot = await readDashboardSnapshot(snapshotScope, snapshotScopeId, 'overview');
    if (snapshot?.dashboard) {
      if (isRedisConfigured()) {
        cacheSetJson(cacheKey, snapshot, 60).catch(() => {});
      }
      res.setHeader('X-Cache', 'STALE-SNAPSHOT');
      return res.json(snapshot);
    }

    const now = new Date();
    const start7 = startOfDay(now);
    start7.setDate(start7.getDate() - 6);
    const startIso = start7.toISOString();
    const endIso = now.toISOString();

    const [
      leadsRes,
      visitorLeadsRes,
      planSharesRes,
      dueRemindersRes,
      noPlanVendorsResult,
      remindersResult,
      attributionsResult,
    ] = await Promise.all([
      db.from('leads').select('*', { count: 'exact', head: true }).gte('created_at', startIso).lte('created_at', endIso),
      db.from('leads').select('*', { count: 'exact', head: true }).not('visitor_id', 'is', null),
      db
        .from('sales_vendor_engagements')
        .select('*', { count: 'exact', head: true })
        .eq('engagement_type', 'PLAN_SHARED')
        .gte('created_at', startIso)
        .lte('created_at', endIso),
      db
        .from('sales_vendor_engagements')
        .select('*', { count: 'exact', head: true })
        .not('next_follow_up_at', 'is', null)
        .in('status', ['OPEN', 'PENDING', 'SENT', 'IN_PROGRESS'])
        .lte('next_follow_up_at', endIso),
      (async () => {
        const { data: vendors, error } = await db
          .from('vendors')
          .select('id, vendor_id, company_name, owner_name, email, phone, city, state, pincode, kyc_status, profile_completion, is_active, created_at, updated_at')
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .limit(180);
        if (error) throw error;
        const activeMap = await getActiveSubscriptionMap((vendors || []).map((vendor) => vendor.id));
        return (vendors || []).filter((vendor) => !activeMap.has(String(vendor.id || '').trim())).slice(0, 12);
      })(),
      (async () => {
        let query = db
          .from('sales_vendor_engagements')
          .select('id, vendor_id, lead_id, sales_user_id, plan_id, sales_code, plan_share_url, channel, engagement_type, status, notes, next_follow_up_at, created_at')
          .not('next_follow_up_at', 'is', null)
          .in('status', ['OPEN', 'PENDING', 'SENT', 'IN_PROGRESS'])
          .order('next_follow_up_at', { ascending: true })
          .limit(8);
        if (actor.employee.role === 'SALES') query = query.eq('sales_user_id', actor.salesUserId);
        const { data, error } = await query;
        if (error) throw error;
        let rows = await hydrateVendors(data || []);
        rows = await hydratePlans(rows);
        return rows;
      })(),
      (async () => {
        let query = db
          .from('vendor_payments')
          .select('id, vendor_id, plan_id, amount, net_amount, status, payment_date, sales_code, sales_user_id')
          .order('payment_date', { ascending: false })
          .limit(8);
        if (actor.employee.role === 'SALES') {
          query = query.or(`sales_user_id.eq.${actor.salesUserId},sales_code.eq.${actor.salesCode}`);
        }
        const { data, error } = await query;
        if (error) throw error;
        let rows = await hydrateVendors(data || []);
        rows = await hydratePlans(rows);
        return rows;
      })(),
    ]);

    const countError = [leadsRes.error, visitorLeadsRes.error, planSharesRes.error, dueRemindersRes.error].find(Boolean);
    if (countError) throw countError;

    const revenue7d = (attributionsResult || [])
      .filter((row) => {
        const paymentDate = row?.payment_date ? new Date(row.payment_date).getTime() : 0;
        return paymentDate && paymentDate >= start7.getTime() && paymentDate <= now.getTime();
      })
      .reduce((sum, row) => sum + safeNum(row?.net_amount ?? row?.amount), 0);

    const response = {
      success: true,
      dashboard: {
        profile: {
          full_name: actor.employee.full_name,
          email: actor.employee.email,
          role: actor.employee.role,
          sales_code: actor.salesCode,
          plan_link_base: buildSalesPlanLink(req, { salesCode: actor.salesCode }),
        },
        stats: {
          new_leads_7d: safeNum(leadsRes.count),
          visitor_leads: safeNum(visitorLeadsRes.count),
          plan_shares_7d: safeNum(planSharesRes.count),
          due_reminders: safeNum(dueRemindersRes.count),
          no_plan_vendors_sample: Array.isArray(noPlanVendorsResult) ? noPlanVendorsResult.length : 0,
          attributed_revenue_7d: revenue7d,
          attributed_revenue_7d_fmt: fmtINR(revenue7d),
        },
        no_plan_vendors: noPlanVendorsResult || [],
        reminders: remindersResult || [],
        attributed_payments: attributionsResult || [],
      },
    };

    writeDashboardSnapshot(snapshotScope, snapshotScopeId, 'overview', response, 180);
    if (isRedisConfigured()) {
      cacheSetJson(cacheKey, response, 60).catch(() => {});
    }
    res.setHeader('X-Cache', 'MISS');
    return res.json(response);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load sales dashboard' });
  }
});

router.get('/sales/pricing-rules', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasSalesAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const [
      { data: vendorPlans, error: vendorPlanError },
      { data: auditRows, error: auditError },
    ] = await Promise.all([
      db
        .from('vendor_plans')
        .select('*')
        .order('created_at', { ascending: false }),
      db
        .from('audit_logs')
        .select('action, entity_type, entity_id, details, created_at')
        .eq('entity_type', PRICING_RULE_ENTITY_TYPE)
        .order('created_at', { ascending: false }),
    ]);

    const vendorPlanErrorText = String(vendorPlanError?.message || '').toLowerCase();
    if (vendorPlanError && !(vendorPlanError?.code === '42P01' || vendorPlanErrorText.includes('vendor_plans'))) {
      return res.status(500).json({ success: false, error: vendorPlanError.message || 'Failed to load pricing rules' });
    }

    if (auditError) {
      return res.status(500).json({ success: false, error: auditError.message || 'Failed to load pricing rules' });
    }

    const employeeUserId = String(employee?.user_id || req.user?.id || '').trim();
    const employeeEmail = String(employee?.email || req.user?.email || '').trim().toLowerCase();
    const requestedRules = hydratePricingRuleRequests(auditRows).filter((rule) => {
      const requesterUserId = String(rule?.requester_user_id || '').trim();
      const requesterEmail = String(rule?.requested_by_email || '').trim().toLowerCase();
      return (
        (employeeUserId && requesterUserId === employeeUserId) ||
        (employeeEmail && requesterEmail === employeeEmail)
      );
    });

    const rules = [...requestedRules, ...(vendorPlans || [])].sort(
      (left, right) =>
        new Date(right?.submitted_at || right?.created_at || 0).getTime() -
        new Date(left?.submitted_at || left?.created_at || 0).getTime()
    );

    return res.json({ success: true, rules });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load pricing rules' });
  }
});

router.post('/sales/pricing-rules', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasSalesAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const ruleName = String(req.body?.name || req.body?.rule_name || '').trim();
    const ruleType = normalizePricingRuleType(req.body?.type);
    const ruleValue = Number(req.body?.value);
    const businessReason = String(req.body?.business_reason || req.body?.reason || '').trim();
    const targetSegment = String(req.body?.target_segment || req.body?.scope || '').trim();

    if (!ruleName) {
      return res.status(400).json({ success: false, error: 'Rule name is required' });
    }
    if (!ruleType) {
      return res.status(400).json({ success: false, error: 'A valid rule type is required' });
    }
    if (!Number.isFinite(ruleValue) || ruleValue < 0) {
      return res.status(400).json({ success: false, error: 'Rule value must be a non-negative number' });
    }

    const ruleId = randomUUID();
    const submittedAt = new Date().toISOString();
    const rule = buildPricingRuleRecord(
      ruleId,
      {
        rule_name: ruleName,
        type: ruleType,
        value: ruleValue,
        status: 'PENDING_APPROVAL',
        requested_by_name: String(employee?.full_name || '').trim() || String(employee?.email || '').trim() || 'Sales',
        requested_by_email: String(employee?.email || '').trim() || null,
        requested_by_role: normalizeRole(employee?.role || req.user?.role || 'SALES') || 'SALES',
        requester_user_id: String(employee?.user_id || req.user?.id || '').trim() || null,
        business_reason: businessReason || null,
        target_segment: targetSegment || null,
        submitted_at: submittedAt,
        created_at: submittedAt,
      },
      submittedAt
    );

    await writeAuditLog({
      req,
      actor: req.actor,
      action: PRICING_RULE_SUBMITTED_ACTION,
      entityType: PRICING_RULE_ENTITY_TYPE,
      entityId: ruleId,
      details: rule,
    });

    return res.status(201).json({ success: true, rule });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to create pricing rule' });
  }
});

router.get('/manager/pricing-approvals', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasManagerApprovalAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Manager access required' });
    }

    const { data, error } = await db
      .from('audit_logs')
      .select('action, entity_type, entity_id, details, created_at')
      .eq('entity_type', PRICING_RULE_ENTITY_TYPE)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to load pricing approvals' });
    }

    const rules = hydratePricingRuleRequests(data).filter((rule) => rule.status === 'PENDING_APPROVAL');
    return res.json({ success: true, rules });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load pricing approvals' });
  }
});

router.post('/manager/pricing-approvals/:ruleId/decision', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) {
      return res.status(404).json({ success: false, error: 'Employee profile not found' });
    }
    if (!hasManagerApprovalAccess(req.user?.role, employee?.role)) {
      return res.status(403).json({ success: false, error: 'Manager access required' });
    }

    const ruleId = String(req.params?.ruleId || '').trim();
    const decision = String(req.body?.decision || '').trim().toUpperCase();
    const remarks = String(req.body?.remarks || '').trim() || null;

    if (!ruleId) {
      return res.status(400).json({ success: false, error: 'ruleId is required' });
    }
    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'decision must be APPROVE or REJECT' });
    }

    const { data, error } = await db
      .from('audit_logs')
      .select('action, entity_type, entity_id, details, created_at')
      .eq('entity_type', PRICING_RULE_ENTITY_TYPE)
      .eq('entity_id', ruleId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to load pricing rule request' });
    }

    const currentRule = hydratePricingRuleRequests(data)[0];
    if (!currentRule) {
      return res.status(404).json({ success: false, error: 'Pricing rule request not found' });
    }
    if (currentRule.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({ success: false, error: 'Pricing rule request has already been processed' });
    }

    const decidedAt = new Date().toISOString();
    const updatedRule = {
      ...currentRule,
      status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      manager_remarks: remarks,
      decided_at: decidedAt,
      decided_by_name: String(employee?.full_name || '').trim() || String(employee?.email || '').trim() || 'Manager',
      decided_by_email: String(employee?.email || '').trim() || null,
      decided_by_role: normalizeRole(employee?.role || req.user?.role || 'MANAGER') || 'MANAGER',
    };

    await writeAuditLog({
      req,
      actor: req.actor,
      action: decision === 'APPROVE' ? PRICING_RULE_APPROVED_ACTION : PRICING_RULE_REJECTED_ACTION,
      entityType: PRICING_RULE_ENTITY_TYPE,
      entityId: ruleId,
      details: updatedRule,
    });

    return res.json({ success: true, rule: updatedRule });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to update pricing approval' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION EXTENSION REQUEST ESCALATION
// Chain: SALES creates → MANAGER forwards → VP forwards → ADMIN resolves
// ─────────────────────────────────────────────────────────────────────────────

const SUB_EXT_SALES_ROLES    = new Set(['SALES', 'ADMIN', 'SUPERADMIN']);
const SUB_EXT_MANAGER_ROLES  = new Set(['MANAGER', 'ADMIN', 'SUPERADMIN']);
const SUB_EXT_VP_ROLES       = new Set(['VP', 'ADMIN', 'SUPERADMIN']);

// SALES: Search vendors (for subscription request form auto-fill)
router.get('/sales/vendors', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    if (!SUB_EXT_SALES_ROLES.has(normalizeRole(employee?.role || req.user?.role || ''))) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const q = String(req.query?.q || '').trim();
    const searchTerm = q.replace(/,/g, ' ').trim();

    let query = db
      .from('vendors')
      .select('id, vendor_id, company_name, owner_name, state, city, email, phone, is_active, kyc_status, status')
      .order('company_name', { ascending: true })
      .limit(50);

    if (searchTerm) {
      const like = `%${searchTerm}%`;
      query = query.or(
        [
          `vendor_id.ilike.${like}`,
          `company_name.ilike.${like}`,
          `owner_name.ilike.${like}`,
          `email.ilike.${like}`,
          `phone.ilike.${like}`,
          `city.ilike.${like}`,
          `state.ilike.${like}`,
        ].join(',')
      );
    } else {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, vendors: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to search vendors' });
  }
});

// SALES: Create a new subscription extension request
router.post('/subscription-requests', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    const role = normalizeRole(employee?.role || req.user?.role || '');
    if (!SUB_EXT_SALES_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'Only SALES staff can create extension requests' });
    }

    const vendor_id     = String(req.body?.vendor_id || '').trim();
    const vendor_name   = String(req.body?.vendor_name || '').trim();
    const vendor_state  = String(req.body?.vendor_state || '').trim();
    const reason        = String(req.body?.reason || '').trim();
    const extension_days = parseInt(req.body?.extension_days, 10);

    if (!vendor_id)     return res.status(400).json({ success: false, error: 'vendor_id is required' });
    if (!vendor_name)   return res.status(400).json({ success: false, error: 'vendor_name is required' });
    if (!reason)        return res.status(400).json({ success: false, error: 'reason is required' });
    if (!Number.isFinite(extension_days) || extension_days < 1 || extension_days > 365) {
      return res.status(400).json({ success: false, error: 'extension_days must be between 1 and 365' });
    }

    const { data: inserted, error } = await db
      .from('subscription_extension_requests')
      .insert({
        vendor_id,
        vendor_name,
        vendor_state,
        reason,
        extension_days,
        current_level: 'SALES',
        status: 'OPEN',
        sales_note: String(req.body?.sales_note || '').trim() || null,
        created_by_email: String(employee.email || '').trim(),
      })
      .select()
      .single();

    if (error) throw error;

    await writeAuditLog({
      req,
      actor: req.actor || { email: employee.email, role: employee.role },
      action: 'SUB_EXT_REQUEST_CREATED',
      entityType: 'subscription_extension_request',
      entityId: inserted.id,
      details: { vendor_id, vendor_name, extension_days, reason },
    });

    return res.status(201).json({ success: true, request: inserted });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to create extension request' });
  }
});

// SALES: List own requests
router.get('/subscription-requests', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    const role = normalizeRole(employee?.role || req.user?.role || '');
    if (!SUB_EXT_SALES_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'Sales access required' });
    }

    const { data, error } = await db
      .from('subscription_extension_requests')
      .select('*')
      .eq('created_by_email', String(employee.email || '').trim())
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, requests: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to list extension requests' });
  }
});

// MANAGER: List requests at SALES level (needs manager review)
router.get('/subscription-requests/manager', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    const role = normalizeRole(employee?.role || req.user?.role || '');
    if (!SUB_EXT_MANAGER_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'Manager access required' });
    }

    const { data, error } = await db
      .from('subscription_extension_requests')
      .select('*')
      .in('status', ['OPEN', 'FORWARDED'])
      .eq('current_level', 'SALES')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, requests: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to list manager requests' });
  }
});

// MANAGER: Forward request to VP
router.post('/subscription-requests/:id/manager-forward', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    const role = normalizeRole(employee?.role || req.user?.role || '');
    if (!SUB_EXT_MANAGER_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'Manager access required' });
    }

    const { id } = req.params;
    const manager_note = String(req.body?.manager_note || '').trim();

    const { data: existing, error: fetchErr } = await db
      .from('subscription_extension_requests')
      .select('id, status, current_level')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Request not found' });
    if (existing.current_level !== 'SALES') {
      return res.status(409).json({ success: false, error: 'Request is not at SALES level' });
    }
    if (!['OPEN', 'FORWARDED'].includes(existing.status)) {
      return res.status(409).json({ success: false, error: 'Request is already resolved or rejected' });
    }

    const { data: updated, error: updateErr } = await db
      .from('subscription_extension_requests')
      .update({
        current_level: 'MANAGER',
        status: 'FORWARDED',
        manager_note: manager_note || null,
        forwarded_by_manager: String(employee.email || '').trim(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await writeAuditLog({
      req,
      actor: req.actor || { email: employee.email, role: employee.role },
      action: 'SUB_EXT_FORWARDED_TO_VP',
      entityType: 'subscription_extension_request',
      entityId: id,
      details: { manager_note },
    });

    return res.json({ success: true, request: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to forward request' });
  }
});

// VP: List requests at MANAGER level (needs VP review)
router.get('/subscription-requests/vp', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    const role = normalizeRole(employee?.role || req.user?.role || '');
    if (!SUB_EXT_VP_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'VP access required' });
    }

    const { data, error } = await db
      .from('subscription_extension_requests')
      .select('*')
      .eq('status', 'FORWARDED')
      .eq('current_level', 'MANAGER')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, requests: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to list VP requests' });
  }
});

// VP: Forward request to ADMIN
router.post('/subscription-requests/:id/vp-forward', requireAuth(), async (req, res) => {
  try {
    const employee = await resolveEmployeeProfile(req.user);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });
    const role = normalizeRole(employee?.role || req.user?.role || '');
    if (!SUB_EXT_VP_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'VP access required' });
    }

    const { id } = req.params;
    const vp_note = String(req.body?.vp_note || '').trim();

    const { data: existing, error: fetchErr } = await db
      .from('subscription_extension_requests')
      .select('id, status, current_level')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Request not found' });
    if (existing.current_level !== 'MANAGER') {
      return res.status(409).json({ success: false, error: 'Request is not at MANAGER level' });
    }
    if (existing.status !== 'FORWARDED') {
      return res.status(409).json({ success: false, error: 'Request is already resolved or rejected' });
    }

    const { data: updated, error: updateErr } = await db
      .from('subscription_extension_requests')
      .update({
        current_level: 'VP',
        status: 'FORWARDED',
        vp_note: vp_note || null,
        forwarded_by_vp: String(employee.email || '').trim(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await writeAuditLog({
      req,
      actor: req.actor || { email: employee.email, role: employee.role },
      action: 'SUB_EXT_FORWARDED_TO_ADMIN',
      entityType: 'subscription_extension_request',
      entityId: id,
      details: { vp_note },
    });

    return res.json({ success: true, request: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to forward request to admin' });
  }
});

// ✅ GET /api/employee/dashboard/stats — employee's own dashboard stats
router.get('/dashboard/stats', requireAuth(), async (req, res) => {
  try {
    const authUser = req.user;
    const employee = await resolveEmployeeProfile(authUser);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });

    const employeeId = employee.id;
    const userId = authUser?.id;

    const [vendorsRes, ticketsRes, leadsRes] = await Promise.allSettled([
      db.from('vendors').select('*', { count: 'exact', head: true }).or(`assigned_to.eq.${employeeId}${userId ? `,created_by.eq.${userId}` : ''}`),
      db.from('support_tickets').select('*', { count: 'exact', head: true }).eq('assigned_to', employeeId),
      db.from('leads').select('*', { count: 'exact', head: true }).eq('assigned_to', employeeId),
    ]);

    return res.json({
      success: true,
      stats: {
        vendorsAssigned: vendorsRes.status === 'fulfilled' ? vendorsRes.value?.count || 0 : 0,
        ticketsAssigned: ticketsRes.status === 'fulfilled' ? ticketsRes.value?.count || 0 : 0,
        leadsAssigned: leadsRes.status === 'fulfilled' ? leadsRes.value?.count || 0 : 0,
        role: employee.role,
        department: employee.department,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ GET /api/employee/requirements — list requirements/leads assigned to employee
router.get('/requirements', requireAuth(), async (req, res) => {
  try {
    const authUser = req.user;
    const employee = await resolveEmployeeProfile(authUser);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });

    const { status, search, limit = 50, page = 1 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = db
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status && status !== 'ALL') query = query.eq('status', status.toUpperCase());
    if (search) query = query.ilike('title', `%${search}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, requirements: data || [], leads: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ PATCH /api/employee/requirements/:id/status — update requirement status
router.patch('/requirements/:id/status', requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ success: false, error: 'status is required' });

    const { data, error } = await db
      .from('leads')
      .update({ status: String(status).toUpperCase(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, requirement: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ GET /api/employee/suggestions — AI/system suggestions
router.get('/suggestions', requireAuth(), async (req, res) => {
  try {
    const authUser = req.user;
    const employee = await resolveEmployeeProfile(authUser);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });

    // Return suggestions from the suggestions table or empty array if not set up
    const { data, error } = await db
      .from('employee_suggestions')
      .select('*')
      .eq('employee_id', employee.id)
      .order('created_at', { ascending: false })
      .limit(20);

    // Gracefully handle if table doesn't exist
    if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
      return res.json({ success: true, suggestions: [] });
    }
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, suggestions: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ POST /api/employee/sales/leads — create a sales lead record
router.post('/sales/leads', requireAuth(), async (req, res) => {
  try {
    const authUser = req.user;
    const employee = await resolveEmployeeProfile(authUser);
    if (!employee) return res.status(404).json({ success: false, error: 'Employee profile not found' });

    const allowed = new Set(['SALES', 'MANAGER', 'VP', 'ADMIN', 'SUPERADMIN']);
    if (!allowed.has(String(employee.role || '').toUpperCase())) {
      return res.status(403).json({ success: false, error: 'Insufficient role' });
    }

    const payload = req.body || {};
    const { data, error } = await db
      .from('leads')
      .insert([{
        title: payload.title || payload.product_name || 'Sales Lead',
        product_name: payload.product_name || payload.title || null,
        buyer_name: payload.buyer_name || null,
        buyer_email: payload.buyer_email || null,
        buyer_phone: payload.buyer_phone || null,
        company_name: payload.company_name || null,
        description: payload.description || null,
        category: payload.category || null,
        budget: payload.budget || null,
        location: payload.location || null,
        status: payload.status || 'AVAILABLE',
        source: 'SALES',
        assigned_to: employee.id,
        created_at: new Date().toISOString(),
      }])
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, lead: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
