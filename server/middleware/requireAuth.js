import {
  getAuthCookieNames,
  getCookie,
  normalizeRole,
  verifyAuthToken,
} from '../lib/auth.js';
import { supabase } from '../lib/supabaseClient.js';

function parseBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  return header.replace('Bearer ', '').trim();
}

function isSafeMethod(method) {
  const m = String(method || '').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function buildActor(decoded = {}, roleOverride = null) {
  const role = normalizeRole(roleOverride || decoded.role || 'USER');
  return {
    id: decoded.sub,
    email: decoded.email || null,
    role,
    type: decoded.type || 'USER',
  };
}

const INTERNAL_ROLE_SET = new Set([
  'ADMIN',
  'HR',
  'DATA_ENTRY',
  'SUPPORT',
  'SALES',
  'FINANCE',
  'SUPERADMIN',
]);
const PORTAL_ROLE_SET = new Set(['BUYER', 'VENDOR']);

const normalizeIdentityEmail = (email) => {
  const value = String(email || '').trim().toLowerCase();
  return value || null;
};

async function findFirstByIdentity({ table, select, userId, email }) {
  if (userId) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq('user_id', userId)
      .limit(1);

    if (!error && Array.isArray(data) && data[0]) return data[0];
  }

  const normalizedEmail = normalizeIdentityEmail(email);
  if (!normalizedEmail) return null;

  const { data, error } = await supabase
    .from(table)
    .select(select)
    .ilike('email', normalizedEmail)
    .limit(1);

  if (!error && Array.isArray(data) && data[0]) return data[0];
  return null;
}

async function resolveRoleForAllowed({ userId, email, allowedRoles }) {
  const allowed = (allowedRoles || []).map(normalizeRole).filter(Boolean);
  const allowedSet = new Set(allowed);

  if (allowedSet.has('VENDOR')) {
    const vendor = await findFirstByIdentity({
      table: 'vendors',
      select: 'id',
      userId,
      email,
    });
    if (vendor?.id) return 'VENDOR';
  }

  if (allowedSet.has('BUYER')) {
    const buyer = await findFirstByIdentity({
      table: 'buyers',
      select: 'id',
      userId,
      email,
    });
    if (buyer?.id) return 'BUYER';
  }

  const internalAllowed = allowed.filter((r) => INTERNAL_ROLE_SET.has(r));
  if (internalAllowed.length > 0) {
    const employee = await findFirstByIdentity({
      table: 'employees',
      select: 'role, status',
      userId,
      email,
    });

    const employeeRole = normalizeRole(employee?.role);
    const employeeStatus = normalizeRole(employee?.status || 'ACTIVE');
    if (employeeRole && employeeStatus === 'ACTIVE' && internalAllowed.includes(employeeRole)) {
      return employeeRole;
    }
  }

  return null;
}

export function requireAuth({ roles = [] } = {}) {
  const allowedRoles = (roles || []).map(normalizeRole).filter(Boolean);

  return async (req, res, next) => {
    try {
      if (String(req.method || '').toUpperCase() === 'OPTIONS') {
        return next();
      }
      const { AUTH_COOKIE_NAME, CSRF_COOKIE_NAME } = getAuthCookieNames();
      const tokenFromCookie = getCookie(req, AUTH_COOKIE_NAME);
      const tokenFromBearer = parseBearerToken(req);
      // Prefer bearer token when both cookie + bearer are present.
      // This prevents stale cross-portal cookie sessions from overriding
      // the currently authenticated Supabase session in frontend API calls.
      const token = tokenFromBearer || tokenFromCookie;
      const tokenSource = tokenFromBearer ? 'bearer' : tokenFromCookie ? 'cookie' : null;

      if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const decoded = verifyAuthToken(token);
      if (!decoded?.sub) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      // CSRF check for mutating requests
      if (!isSafeMethod(req.method) && tokenSource !== 'bearer') {
        const csrfCookie = getCookie(req, CSRF_COOKIE_NAME);
        const csrfHeader =
          req.headers['x-csrf-token'] ||
          req.headers['x-xsrf-token'] ||
          req.headers['csrf-token'];

        if (!csrfCookie || !csrfHeader || String(csrfCookie) !== String(csrfHeader)) {
          return res.status(403).json({ success: false, error: 'CSRF token mismatch' });
        }
      }

      let role = normalizeRole(decoded.role || 'USER');
      if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        const expectsBuyer = allowedRoles.includes('BUYER');
        const expectsVendor = allowedRoles.includes('VENDOR');
        const isPortalRole = PORTAL_ROLE_SET.has(role);

        // Strict portal isolation:
        // BUYER session cannot access vendor routes, and VENDOR session cannot access buyer routes.
        if (isPortalRole && ((role === 'BUYER' && expectsVendor) || (role === 'VENDOR' && expectsBuyer))) {
          return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const resolved = await resolveRoleForAllowed({
          userId: decoded.sub,
          email: decoded.email || null,
          allowedRoles,
        });

        if (resolved && allowedRoles.includes(resolved)) {
          role = resolved;
        } else {
          return res.status(403).json({ success: false, error: 'Forbidden' });
        }
      }

      req.user = buildActor(decoded, role);

      req.actor = {
        ...req.user,
      };

      return next();
    } catch (error) {
      console.error('[Auth] requireAuth failed:', error?.message || error);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  };
}

export function optionalAuth() {
  return async (req, _res, next) => {
    try {
      if (String(req.method || '').toUpperCase() === 'OPTIONS') {
        return next();
      }

      const { AUTH_COOKIE_NAME, CSRF_COOKIE_NAME } = getAuthCookieNames();
      const tokenFromCookie = getCookie(req, AUTH_COOKIE_NAME);
      const tokenFromBearer = parseBearerToken(req);
      const token = tokenFromBearer || tokenFromCookie;
      const tokenSource = tokenFromBearer ? 'bearer' : tokenFromCookie ? 'cookie' : null;

      if (!token) {
        req.user = null;
        req.actor = null;
        return next();
      }

      const decoded = verifyAuthToken(token);
      if (!decoded?.sub) {
        req.user = null;
        req.actor = null;
        return next();
      }

      if (!isSafeMethod(req.method) && tokenSource !== 'bearer') {
        const csrfCookie = getCookie(req, CSRF_COOKIE_NAME);
        const csrfHeader =
          req.headers['x-csrf-token'] ||
          req.headers['x-xsrf-token'] ||
          req.headers['csrf-token'];

        if (!csrfCookie || !csrfHeader || String(csrfCookie) !== String(csrfHeader)) {
          req.user = null;
          req.actor = null;
          return next();
        }
      }

      req.user = buildActor(decoded);
      req.actor = { ...req.user };
      return next();
    } catch {
      req.user = null;
      req.actor = null;
      return next();
    }
  };
}
