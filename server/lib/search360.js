import { db } from './dbClient.js';
import { mysqlQuery } from './mysqlPool.js';
import { notifyRole } from './notify.js';
import { writeAuditLog } from './audit.js';

const SEARCH360_ROLES = new Set([
  'SUPPORT',
  'SALES',
  'DATA_ENTRY',
  'DATAENTRY',
  'MANAGER',
  'VP',
  'ADMIN',
  'SUPERADMIN',
  'GODMODE',
]);

const SYSTEM_ROLES = new Set(['ADMIN', 'SUPERADMIN', 'GODMODE']);
const LEADERSHIP_ROLES = new Set(['MANAGER', 'VP', 'ADMIN', 'SUPERADMIN', 'GODMODE']);
const CASE_TYPES = new Set([
  'SUSPENSION_REVIEW',
  'PRODUCT_LISTING',
  'PRODUCT_REMOVAL',
  'PLAN_UPGRADE',
  'KYC_REVIEW',
  'GENERAL_SUPPORT',
]);
const CASE_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

const ESCALATION_TARGETS = {
  SUPPORT: new Set(['ADMIN', 'DATA_ENTRY', 'SALES']),
  DATA_ENTRY: new Set(['SUPPORT', 'ADMIN']),
  DATAENTRY: new Set(['SUPPORT', 'ADMIN']),
  SALES: new Set(['SUPPORT', 'ADMIN']),
  MANAGER: new Set(['SUPPORT', 'DATA_ENTRY', 'SALES', 'ADMIN']),
  VP: new Set(['SUPPORT', 'DATA_ENTRY', 'SALES', 'ADMIN']),
  ADMIN: new Set(['SUPPORT', 'DATA_ENTRY', 'SALES', 'ADMIN']),
  SUPERADMIN: new Set(['SUPPORT', 'DATA_ENTRY', 'SALES', 'ADMIN']),
  GODMODE: new Set(['SUPPORT', 'DATA_ENTRY', 'SALES', 'ADMIN']),
};

const TEAM_LABELS = {
  ADMIN: 'Admin',
  DATA_ENTRY: 'Data Entry',
  DATAENTRY: 'Data Entry',
  SALES: 'Sales',
  SUPPORT: 'Support',
};

const CASE_LABELS = {
  SUSPENSION_REVIEW: 'Suspension review',
  PRODUCT_LISTING: 'Product listing help',
  PRODUCT_REMOVAL: 'Product removal help',
  PLAN_UPGRADE: 'Plan upgrade',
  KYC_REVIEW: 'KYC review',
  GENERAL_SUPPORT: 'General support',
};

const normalizeRole = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'DATAENTRY') return 'DATA_ENTRY';
  if (raw === 'DEVELOPER') return 'GODMODE';
  return raw;
};

const compact = (value) => String(value || '').trim();

const normalizeDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const asArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
};

const placeholderList = (items = []) => items.map(() => '?').join(', ');

const normalizeCaseType = (value) => {
  const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return CASE_TYPES.has(raw) ? raw : 'GENERAL_SUPPORT';
};

const normalizePriority = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  return PRIORITIES.has(raw) ? raw : 'MEDIUM';
};

const normalizeStatus = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  return CASE_STATUSES.has(raw) ? raw : 'OPEN';
};

const isMissingTableError = (error, tableName) => {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes(String(tableName || '').toLowerCase()) && (
    message.includes("doesn't exist") ||
    message.includes('does not exist') ||
    message.includes('no such table') ||
    message.includes('unknown table')
  );
};

const optionalRows = async (fn, tableName) => {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTableError(error, tableName)) return [];
    throw error;
  }
};

const truthyDbFlag = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return value === true || value === 1 || normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const hasApprovedKyc = (value) => {
  const status = String(value || '').trim().toUpperCase();
  return status === 'APPROVED' || status === 'VERIFIED';
};

const isVendorVerified = (vendor = {}) => (
  truthyDbFlag(vendor.is_verified) ||
  truthyDbFlag(vendor.verification_badge) ||
  Boolean(vendor.verified_at) ||
  hasApprovedKyc(vendor.kyc_status)
);

const normalizeVendorStatus = (vendor = {}) => {
  const accountStatus = String(vendor.account_status || vendor.status || '').trim().toUpperCase();
  const isSuspendedText = String(vendor.is_suspended || '').trim().toLowerCase();
  const inactive = vendor.is_active === 0 || vendor.is_active === false || String(vendor.is_active).toLowerCase() === 'false';
  const verified = isVendorVerified(vendor);
  const suspended =
    accountStatus === 'SUSPENDED' ||
    accountStatus === 'TERMINATED' ||
    isSuspendedText === 'true' ||
    isSuspendedText === '1' ||
    Boolean(vendor.suspended_at || vendor.suspension_at || vendor.terminated_at);
  const rawStatusLabel = suspended ? accountStatus || 'SUSPENDED' : inactive ? 'INACTIVE' : accountStatus || 'ACTIVE';
  const statusLabel =
    !suspended && !inactive && verified && ['UNVERIFIED', 'PENDING', 'SUBMITTED'].includes(rawStatusLabel)
      ? 'ACTIVE'
      : rawStatusLabel;

  return {
    is_active: !inactive && !suspended,
    is_suspended: suspended,
    is_verified: verified,
    status_label: statusLabel,
    reason:
      vendor.suspension_reason ||
      vendor.suspension_message ||
      vendor.terminated_reason ||
      vendor.rejection_reason ||
      null,
    suspended_at: normalizeDate(vendor.suspended_at || vendor.suspension_at || vendor.terminated_at),
  };
};

export function buildSearch360ActorFromEmployee(req) {
  const employee = req.employee || {};
  const role = normalizeRole(employee.role || req.actor?.role || req.user?.role);
  return {
    id: compact(req.actor?.id || req.user?.id || employee.user_id || employee.id),
    user_id: compact(employee.user_id || req.user?.id),
    employee_id: compact(employee.id),
    email: compact(employee.email || req.actor?.email || req.user?.email),
    name: compact(employee.full_name || req.user?.email),
    role,
    states_scope: employee.states_scope,
    type: 'EMPLOYEE',
  };
}

export function buildSearch360ActorFromSuperadmin(req) {
  const role = normalizeRole(req.superadmin?.role || 'SUPERADMIN');
  return {
    id: compact(req.superadmin?.id),
    user_id: compact(req.superadmin?.id),
    employee_id: null,
    email: compact(req.superadmin?.email),
    name: compact(req.superadmin?.full_name || req.superadmin?.email),
    role,
    states_scope: [],
    type: role === 'GODMODE' ? 'GODMODE' : 'SUPERADMIN',
  };
}

export function assertSearch360Access(actor) {
  const role = normalizeRole(actor?.role);
  if (!SEARCH360_ROLES.has(role)) {
    const error = new Error('Search 360 access is not enabled for this role');
    error.statusCode = 403;
    throw error;
  }
  return role;
}

async function resolveStateScope(actor) {
  const role = normalizeRole(actor?.role);
  if (role === 'SUPERADMIN' || role === 'GODMODE') {
    return { mode: 'ALL', restricted: false, stateIds: [], stateNames: [] };
  }

  let stateIds = [];
  let stateNames = [];

  if (actor?.employee_id) {
    const rows = await optionalRows(
      () => mysqlQuery(
        `SELECT s.id, s.name
           FROM employee_state_scope ess
           JOIN states s ON s.id = ess.state_id
          WHERE ess.employee_id = ?`,
        [actor.employee_id]
      ),
      'employee_state_scope'
    );
    stateIds.push(...rows.map((row) => compact(row.id)).filter(Boolean));
    stateNames.push(...rows.map((row) => compact(row.name)).filter(Boolean));
  }

  const rawScope = asArray(actor?.states_scope)
    .map((item) => compact(item))
    .filter(Boolean);

  const rawIds = rawScope.filter((item) => /^[0-9a-f-]{20,}$/i.test(item));
  const rawNames = rawScope.filter((item) => !/^[0-9a-f-]{20,}$/i.test(item));

  if (rawIds.length) {
    const rows = await mysqlQuery(
      `SELECT id, name FROM states WHERE id IN (${placeholderList(rawIds)})`,
      rawIds
    );
    stateIds.push(...rows.map((row) => compact(row.id)).filter(Boolean));
    stateNames.push(...rows.map((row) => compact(row.name)).filter(Boolean));
  }

  if (rawNames.length) {
    const normalized = rawNames.map((item) => item.toLowerCase());
    const rows = await mysqlQuery(
      `SELECT id, name FROM states WHERE LOWER(name) IN (${placeholderList(normalized)})`,
      normalized
    );
    stateIds.push(...rows.map((row) => compact(row.id)).filter(Boolean));
    stateNames.push(...rows.map((row) => compact(row.name)).filter(Boolean));
    stateNames.push(...rawNames);
  }

  stateIds = Array.from(new Set(stateIds));
  stateNames = Array.from(new Set(stateNames));
  const restricted = stateIds.length > 0 || stateNames.length > 0;

  if (restricted) {
    return { mode: 'STATE_SCOPE', restricted: true, stateIds, stateNames };
  }

  return {
    mode: SYSTEM_ROLES.has(role) ? 'ALL' : 'UNSCOPED_ALL_FALLBACK',
    restricted: false,
    stateIds: [],
    stateNames: [],
  };
}

function applyScopeWhere(whereParts, params, scope) {
  if (!scope?.restricted) return;
  const parts = [];
  if (scope.stateIds?.length) {
    parts.push(`v.state_id IN (${placeholderList(scope.stateIds)})`);
    params.push(...scope.stateIds);
  }
  if (scope.stateNames?.length) {
    parts.push(`LOWER(COALESCE(v.state, '')) IN (${placeholderList(scope.stateNames)})`);
    params.push(...scope.stateNames.map((name) => name.toLowerCase()));
  }
  if (parts.length) whereParts.push(`(${parts.join(' OR ')})`);
}

function applySearchWhere(whereParts, params, query) {
  const raw = compact(query);
  if (!raw) return;

  const like = `%${raw.toLowerCase()}%`;
  const digits = raw.replace(/\D/g, '');
  const parts = [
    'LOWER(COALESCE(v.id, \'\')) LIKE ?',
    'LOWER(COALESCE(v.vendor_id, \'\')) LIKE ?',
    'LOWER(COALESCE(v.company_name, \'\')) LIKE ?',
    'LOWER(COALESCE(v.owner_name, \'\')) LIKE ?',
    'LOWER(COALESCE(v.email, \'\')) LIKE ?',
    'LOWER(COALESCE(v.phone, \'\')) LIKE ?',
    'LOWER(COALESCE(v.gst_number, \'\')) LIKE ?',
    'LOWER(COALESCE(v.city, \'\')) LIKE ?',
    'LOWER(COALESCE(v.state, \'\')) LIKE ?',
  ];
  params.push(like, like, like, like, like, like, like, like, like);

  if (digits.length >= 3) {
    parts.push('COALESCE(v.phone, \'\') LIKE ?');
    params.push(`%${digits}%`);
  }

  whereParts.push(`(${parts.join(' OR ')})`);
}

async function hydrateVendors(vendors) {
  const ids = vendors.map((vendor) => vendor.id).filter(Boolean);
  if (!ids.length) return vendors;
  const inClause = placeholderList(ids);

  const productCounts = await mysqlQuery(
    `SELECT vendor_id,
            COUNT(*) AS total_products,
            SUM(CASE WHEN UPPER(COALESCE(status, '')) IN ('ACTIVE', 'APPROVED', 'PUBLISHED', 'LIVE') THEN 1 ELSE 0 END) AS active_products
       FROM products
      WHERE vendor_id IN (${inClause})
      GROUP BY vendor_id`,
    ids
  );

  const recentProducts = await mysqlQuery(
    `SELECT id, vendor_id, name, status, category, price, created_at, updated_at, slug
       FROM products
      WHERE vendor_id IN (${inClause})
      ORDER BY created_at DESC
      LIMIT 250`,
    ids
  );

  const subscriptions = await mysqlQuery(
    `SELECT s.id, s.vendor_id, s.plan_id, s.status, s.start_date, s.end_date, s.created_at,
            s.plan_duration_days, s.sales_code, s.sales_user_id,
            p.name AS plan_name, p.price AS plan_price, p.duration_days AS duration_days,
            p.daily_limit, p.weekly_limit, p.yearly_limit, p.member_limit
       FROM vendor_plan_subscriptions s
       LEFT JOIN vendor_plans p ON p.id = s.plan_id
      WHERE s.vendor_id IN (${inClause})
      ORDER BY
        CASE
          WHEN UPPER(COALESCE(s.status, '')) = 'ACTIVE' THEN 0
          WHEN UPPER(COALESCE(s.status, '')) IN ('TRIAL', 'PENDING') THEN 1
          ELSE 2
        END ASC,
        COALESCE(s.end_date, s.created_at) DESC`,
    ids
  );

  const tickets = await mysqlQuery(
    `SELECT id, vendor_id, subject, status, priority, category, ticket_display_id, created_at, resolved_at
       FROM support_tickets
      WHERE vendor_id IN (${inClause})
      ORDER BY created_at DESC
      LIMIT 250`,
    ids
  );

  const cases = await optionalRows(
    () => mysqlQuery(
      `SELECT id, ticket_id, vendor_id, case_type, target_team, source_role, source_email, subject,
              note, priority, status, region_state_id, region_state, resolution_note,
              resolved_by, resolved_by_role, resolved_at, created_at, updated_at
         FROM search360_cases
        WHERE vendor_id IN (${inClause})
        ORDER BY created_at DESC
        LIMIT 250`,
      ids
    ),
    'search360_cases'
  );

  const employeeRefs = Array.from(
    new Set(
      vendors
        .flatMap((vendor) => [compact(vendor.assigned_to), compact(vendor.created_by_user_id)])
        .filter(Boolean)
    )
  );
  const employees = employeeRefs.length
    ? await mysqlQuery(
      `SELECT id, user_id, full_name, email, role, sales_code
         FROM employees
        WHERE id IN (${placeholderList(employeeRefs)})
           OR user_id IN (${placeholderList(employeeRefs)})`,
      [...employeeRefs, ...employeeRefs]
    )
    : [];

  const employeeByRef = new Map();
  employees.forEach((employee) => {
    if (employee.id) employeeByRef.set(String(employee.id), employee);
    if (employee.user_id) employeeByRef.set(String(employee.user_id), employee);
  });

  const countsByVendor = new Map(productCounts.map((row) => [row.vendor_id, row]));
  const productsByVendor = new Map();
  recentProducts.forEach((product) => {
    const rows = productsByVendor.get(product.vendor_id) || [];
    if (rows.length < 5) rows.push(product);
    productsByVendor.set(product.vendor_id, rows);
  });

  const planByVendor = new Map();
  subscriptions.forEach((sub) => {
    if (!planByVendor.has(sub.vendor_id)) planByVendor.set(sub.vendor_id, sub);
  });

  const ticketsByVendor = new Map();
  tickets.forEach((ticket) => {
    const rows = ticketsByVendor.get(ticket.vendor_id) || [];
    rows.push(ticket);
    ticketsByVendor.set(ticket.vendor_id, rows);
  });

  const casesByVendor = new Map();
  cases.forEach((item) => {
    const rows = casesByVendor.get(item.vendor_id) || [];
    rows.push(item);
    casesByVendor.set(item.vendor_id, rows);
  });

  return vendors.map((vendor) => {
    const productCount = countsByVendor.get(vendor.id) || {};
    const vendorTickets = ticketsByVendor.get(vendor.id) || [];
    const currentPlan = planByVendor.get(vendor.id) || null;
    const account = normalizeVendorStatus(vendor);

    return {
      id: vendor.id,
      profile: {
        id: vendor.id,
        vendor_id: vendor.vendor_id,
        user_id: vendor.user_id,
        company_name: vendor.company_name,
        owner_name: vendor.owner_name,
        email: vendor.email,
        phone: vendor.phone,
        secondary_email: vendor.secondary_email,
        secondary_phone: vendor.secondary_phone,
        city: vendor.city,
        state: vendor.state,
        state_id: vendor.state_id,
        city_id: vendor.city_id,
        gst_number: vendor.gst_number,
        pan_number: vendor.pan_number,
        kyc_status: vendor.kyc_status,
        profile_completion: vendor.profile_completion,
        business_description: vendor.business_description,
        primary_business_type: vendor.primary_business_type,
        slug: vendor.slug,
        created_at: normalizeDate(vendor.created_at),
        updated_at: normalizeDate(vendor.updated_at),
      },
      account,
      products: {
        total: Number(productCount.total_products || 0),
        active: Number(productCount.active_products || 0),
        recent: (productsByVendor.get(vendor.id) || []).map((product) => ({
          ...product,
          created_at: normalizeDate(product.created_at),
          updated_at: normalizeDate(product.updated_at),
        })),
      },
      plan: currentPlan
        ? {
          ...currentPlan,
          start_date: normalizeDate(currentPlan.start_date),
          end_date: normalizeDate(currentPlan.end_date),
          created_at: normalizeDate(currentPlan.created_at),
          is_active:
            String(currentPlan.status || '').toUpperCase() === 'ACTIVE' &&
            (!currentPlan.end_date || new Date(currentPlan.end_date).getTime() > Date.now()),
        }
        : null,
      support: {
        total: vendorTickets.length,
        open: vendorTickets.filter((ticket) => !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(String(ticket.status || '').toUpperCase())).length,
        recent: vendorTickets.slice(0, 5).map((ticket) => ({
          ...ticket,
          created_at: normalizeDate(ticket.created_at),
          resolved_at: normalizeDate(ticket.resolved_at),
        })),
      },
      cases: (casesByVendor.get(vendor.id) || []).slice(0, 8).map((item) => ({
        ...item,
        created_at: normalizeDate(item.created_at),
        updated_at: normalizeDate(item.updated_at),
        resolved_at: normalizeDate(item.resolved_at),
      })),
      ownership: {
        assigned_to: vendor.assigned_to,
        created_by_user_id: vendor.created_by_user_id,
        assigned_employee: employeeByRef.get(String(vendor.assigned_to || '')) || null,
        created_by_employee: employeeByRef.get(String(vendor.created_by_user_id || '')) || null,
      },
    };
  });
}

export async function searchVendors360(actor, options = {}) {
  const role = assertSearch360Access(actor);
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 50);
  const offset = Math.min(Math.max(Number(options.offset || 0), 0), 5000);
  const query = compact(options.query);
  const scope = await resolveStateScope(actor);

  const whereParts = ['1 = 1'];
  const params = [];
  applyScopeWhere(whereParts, params, scope);
  applySearchWhere(whereParts, params, query);

  if (options.stateId) {
    whereParts.push('v.state_id = ?');
    params.push(String(options.stateId));
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const rows = await mysqlQuery(
    `SELECT v.*
       FROM vendors v
      ${whereSql}
      ORDER BY COALESCE(v.updated_at, v.created_at) DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const totalRows = await mysqlQuery(
    `SELECT COUNT(*) AS total
       FROM vendors v
      ${whereSql}`,
    params
  );

  const vendors = await hydrateVendors(rows || []);

  return {
    success: true,
    actor: {
      role,
      name: actor?.name || null,
      email: actor?.email || null,
      permissions: getSearch360Permissions(actor),
    },
    scope: {
      mode: scope.mode,
      restricted: scope.restricted,
      states: scope.stateNames,
      state_ids: scope.stateIds,
    },
    query,
    total: Number(totalRows?.[0]?.total || 0),
    limit,
    offset,
    vendors,
  };
}

async function findScopedVendor(actor, vendorId) {
  const result = await searchVendors360(actor, { query: vendorId, limit: 50, offset: 0 });
  return (result.vendors || []).find((item) => {
    const profile = item.profile || {};
    return [item.id, profile.id, profile.vendor_id, profile.email, profile.phone]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === String(vendorId).toLowerCase());
  }) || null;
}

function getAllowedTargets(role) {
  const normalized = normalizeRole(role);
  return Array.from(ESCALATION_TARGETS[normalized] || []);
}

export function getSearch360Permissions(actor) {
  const role = normalizeRole(actor?.role);
  const targets = getAllowedTargets(role);
  return {
    can_view: SEARCH360_ROLES.has(role),
    can_escalate: targets.length > 0,
    can_update_cases: ['SUPPORT', 'DATA_ENTRY', 'SALES', 'MANAGER', 'VP', 'ADMIN', 'SUPERADMIN', 'GODMODE'].includes(role),
    can_activate_vendor: ['ADMIN', 'SUPERADMIN', 'GODMODE'].includes(role),
    can_view_all_regions: SYSTEM_ROLES.has(role) || LEADERSHIP_ROLES.has(role),
    allowed_targets: targets,
  };
}

function canEscalateTo(actor, targetTeam) {
  return getAllowedTargets(actor?.role).includes(normalizeRole(targetTeam));
}

function canUpdateCase(actor, searchCase) {
  const role = normalizeRole(actor?.role);
  if (['ADMIN', 'SUPERADMIN', 'GODMODE', 'MANAGER', 'VP'].includes(role)) return true;
  const target = normalizeRole(searchCase?.target_team);
  if (role === 'DATA_ENTRY' && target === 'DATA_ENTRY') return true;
  if (role === 'SALES' && target === 'SALES') return true;
  if (role === 'SUPPORT' && target === 'SUPPORT') return true;
  return false;
}

function makeCaseSubject(caseType, targetTeam, vendor) {
  const vendorName = vendor?.profile?.company_name || vendor?.profile?.vendor_id || 'Vendor';
  return `${CASE_LABELS[caseType] || 'Search 360 case'} - ${vendorName} to ${TEAM_LABELS[targetTeam] || targetTeam}`;
}

function roleNotificationLink(targetTeam, ticketId) {
  const target = normalizeRole(targetTeam);
  if (target === 'ADMIN') return '/admin/tickets';
  if (target === 'DATA_ENTRY') return '/employee/dataentry/search-360';
  if (target === 'SALES') return `/employee/sales/search-360?ticket=${encodeURIComponent(ticketId || '')}`;
  return '/employee/support/search-360';
}

export async function createSearch360Escalation(actor, body = {}, req = null) {
  const role = assertSearch360Access(actor);
  const vendorId = compact(body.vendor_id || body.vendorId);
  const targetTeam = normalizeRole(body.target_team || body.targetTeam);
  const caseType = normalizeCaseType(body.case_type || body.caseType);
  const priority = normalizePriority(body.priority);
  const note = compact(body.note || body.message || body.reason);

  if (!vendorId) {
    const error = new Error('vendor_id is required');
    error.statusCode = 400;
    throw error;
  }
  if (!canEscalateTo(actor, targetTeam)) {
    const error = new Error(`Your role cannot escalate Search 360 cases to ${TEAM_LABELS[targetTeam] || targetTeam || 'this team'}`);
    error.statusCode = 403;
    throw error;
  }
  if (!note || note.length < 8) {
    const error = new Error('Add a clear note before escalating');
    error.statusCode = 400;
    throw error;
  }

  const vendor = await findScopedVendor(actor, vendorId);
  if (!vendor) {
    const error = new Error('Vendor not found in your Search 360 scope');
    error.statusCode = 404;
    throw error;
  }

  const subject = compact(body.subject) || makeCaseSubject(caseType, targetTeam, vendor);
  const vendorName = vendor.profile?.company_name || vendor.profile?.vendor_id || 'Vendor';
  const description = [
    `Search 360 escalation from ${role}.`,
    `Target team: ${TEAM_LABELS[targetTeam] || targetTeam}.`,
    `Case type: ${CASE_LABELS[caseType] || caseType}.`,
    `Vendor: ${vendorName}.`,
    `Region: ${vendor.profile?.state || 'Unmapped'}${vendor.profile?.city ? `, ${vendor.profile.city}` : ''}.`,
    `Note: ${note}`,
  ].join('\n');

  const { data: ticket, error: ticketError } = await db
    .from('support_tickets')
    .insert([{
      vendor_id: vendor.profile?.id,
      subject,
      description,
      category: `SEARCH360_${caseType}`,
      priority,
      status: 'OPEN',
      ticket_display_id: `S360-${Date.now()}`,
      attachments: [],
      created_at: new Date().toISOString(),
    }])
    .select()
    .maybeSingle();

  if (ticketError) {
    const error = new Error(ticketError.message || 'Failed to create escalation ticket');
    error.statusCode = 500;
    throw error;
  }

  const { data: searchCase, error: caseError } = await db
    .from('search360_cases')
    .insert([{
      ticket_id: ticket?.id || null,
      vendor_id: vendor.profile?.id,
      case_type: caseType,
      target_team: targetTeam,
      source_role: role,
      source_user_id: actor?.user_id || actor?.id || null,
      source_employee_id: actor?.employee_id || null,
      source_email: actor?.email || null,
      subject,
      note,
      priority,
      status: 'OPEN',
      region_state_id: vendor.profile?.state_id || null,
      region_state: vendor.profile?.state || null,
      metadata: {
        vendor_id_display: vendor.profile?.vendor_id || null,
        vendor_email: vendor.profile?.email || null,
        vendor_phone: vendor.profile?.phone || null,
        account: vendor.account || null,
      },
      created_at: new Date().toISOString(),
    }])
    .select()
    .maybeSingle();

  if (caseError) {
    const error = new Error(caseError.message || 'Failed to create Search 360 case');
    error.statusCode = 500;
    throw error;
  }

  await db
    .from('ticket_messages')
    .insert([{
      ticket_id: ticket?.id || null,
      sender_id: actor?.user_id || actor?.id || null,
      sender_type: role,
      message: `[Search 360 -> ${TEAM_LABELS[targetTeam] || targetTeam}] ${note}`,
      created_at: new Date().toISOString(),
    }]);

  await notifyRole(targetTeam, {
    type: 'SEARCH360_ESCALATION',
    title: subject,
    message: `${TEAM_LABELS[role] || role} escalated ${vendorName}: ${note}`,
    link: roleNotificationLink(targetTeam, ticket?.id),
  });

  if (targetTeam === 'ADMIN') {
    await notifyRole('SUPERADMIN', {
      type: 'SEARCH360_ESCALATION',
      title: subject,
      message: `${role} escalated ${vendorName}: ${note}`,
      link: '/admin/tickets',
    });
  }

  if (req) {
    await writeAuditLog({
      req,
      actor: req.actor || actor,
      action: 'SEARCH360_CASE_CREATED',
      entityType: 'search360_cases',
      entityId: searchCase?.id,
      details: {
        vendor_id: vendor.profile?.id,
        target_team: targetTeam,
        case_type: caseType,
        ticket_id: ticket?.id || null,
      },
    }).catch(() => {});
  }

  return { success: true, case: searchCase, ticket };
}

export async function updateSearch360CaseStatus(actor, caseId, body = {}, req = null) {
  const role = assertSearch360Access(actor);
  const id = compact(caseId);
  const status = normalizeStatus(body.status);
  const resolutionNote = compact(body.resolution_note || body.resolutionNote || body.note);

  if (!id) {
    const error = new Error('caseId is required');
    error.statusCode = 400;
    throw error;
  }

  const { data: existing, error: findError } = await db
    .from('search360_cases')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (findError) {
    const error = new Error(findError.message || 'Failed to fetch Search 360 case');
    error.statusCode = 500;
    throw error;
  }
  if (!existing) {
    const error = new Error('Search 360 case not found');
    error.statusCode = 404;
    throw error;
  }
  if (!canUpdateCase(actor, existing)) {
    const error = new Error('Your role cannot update this Search 360 case');
    error.statusCode = 403;
    throw error;
  }

  const update = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (['RESOLVED', 'CLOSED'].includes(status)) {
    update.resolved_at = new Date().toISOString();
    update.resolved_by = actor?.user_id || actor?.id || null;
    update.resolved_by_role = role;
    update.resolution_note = resolutionNote || existing.resolution_note || null;
  }

  const { data: searchCase, error: updateError } = await db
    .from('search360_cases')
    .update(update)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (updateError) {
    const error = new Error(updateError.message || 'Failed to update Search 360 case');
    error.statusCode = 500;
    throw error;
  }

  if (existing.ticket_id) {
    await db
      .from('ticket_messages')
      .insert([{
        ticket_id: existing.ticket_id,
        sender_id: actor?.user_id || actor?.id || null,
        sender_type: role,
        message: `[Search 360 case ${status}] ${resolutionNote || `Status updated to ${status}`}`,
        created_at: new Date().toISOString(),
      }]);

    if (['RESOLVED', 'CLOSED'].includes(status)) {
      await db
        .from('support_tickets')
        .update({ status: status === 'CLOSED' ? 'CLOSED' : 'RESOLVED', resolved_at: new Date().toISOString() })
        .eq('id', existing.ticket_id);
    }
  }

  if (req) {
    await writeAuditLog({
      req,
      actor: req.actor || actor,
      action: 'SEARCH360_CASE_STATUS_UPDATED',
      entityType: 'search360_cases',
      entityId: id,
      details: { status, target_team: existing.target_team },
    }).catch(() => {});
  }

  return { success: true, case: searchCase };
}
