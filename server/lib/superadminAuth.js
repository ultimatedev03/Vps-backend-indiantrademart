import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { supabase } from './supabaseClient.js';
import { assertCaptchaForExpressRequest } from './captcha.js';
import { writeAuditLog } from './audit.js';

const SUPERADMIN_TOKEN_KEY = 'superadmin_token';
let warnedMissingSuperadminSecret = false;

function getJwtSecret() {
  const secret =
    process.env.SUPERADMIN_JWT_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret) {
    throw new Error('Missing SUPERADMIN_JWT_SECRET (or fallback secret) in environment');
  }

  if (!process.env.SUPERADMIN_JWT_SECRET && !warnedMissingSuperadminSecret) {
    console.warn(
      '[SuperAdminAuth] SUPERADMIN_JWT_SECRET missing. Falling back to another secret. Configure a dedicated secret.'
    );
    warnedMissingSuperadminSecret = true;
  }

  return secret;
}

function parseBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  return header.replace('Bearer ', '').trim();
}

function isBcryptHash(value) {
  return typeof value === 'string' && value.startsWith('$2');
}

async function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;

  if (isBcryptHash(storedHash)) {
    return bcrypt.compare(password, storedHash);
  }

  // Backward-compatible plain-text check.
  return String(password) === String(storedHash);
}

async function maybeUpgradePasswordHash(superadmin, password) {
  try {
    if (!superadmin?.id || !password) return;
    if (isBcryptHash(superadmin.password_hash)) return;

    const newHash = await bcrypt.hash(password, 10);
    await supabase
      .from('superadmin_users')
      .update({
        password_hash: newHash,
        updated_at: new Date().toISOString(),
      })
      .eq('id', superadmin.id);
  } catch (error) {
    console.warn('[SuperAdminAuth] Failed to upgrade password hash:', error?.message || error);
  }
}

const GODMODE_ROLE_ALIASES = new Set(['GODMODE', 'SUPERUSER', 'DEVELOPER']);

// Preserve legacy developer labels as GODMODE; everything else falls back to SUPERADMIN.
function normalizeSuperAdminRole(role) {
  const r = String(role || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (GODMODE_ROLE_ALIASES.has(r)) return 'GODMODE';
  return 'SUPERADMIN';
}

function signSuperAdminToken(superadmin) {
  const secret = getJwtSecret();
  const payload = {
    sub: superadmin.id,
    email: superadmin.email,
    role: normalizeSuperAdminRole(superadmin.role),
    type: 'SUPERADMIN',
  };

  const expiresIn = process.env.SUPERADMIN_TOKEN_TTL || '12h';
  return jwt.sign(payload, secret, { expiresIn });
}

export async function loginSuperAdmin(req, res) {
  try {
    await assertCaptchaForExpressRequest(req, { action: 'superadmin_login' });

    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const { data: superadmin, error } = await supabase
      .from('superadmin_users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    if (!superadmin || superadmin.is_active === false) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const passwordOk = await verifyPassword(password, superadmin.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    await maybeUpgradePasswordHash(superadmin, password);

    const token = signSuperAdminToken(superadmin);

    await supabase
      .from('superadmin_users')
      .update({
        last_login: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', superadmin.id);

    const actor = {
      id: superadmin.id,
      type: 'SUPERADMIN',
      role: normalizeSuperAdminRole(superadmin.role),
      email: superadmin.email,
    };

    await writeAuditLog({
      req,
      actor,
      action: 'SUPERADMIN_LOGIN',
      entityType: 'superadmin_users',
      entityId: superadmin.id,
      details: { email: superadmin.email },
    });

    return res.json({
      success: true,
      token,
      token_type: SUPERADMIN_TOKEN_KEY,
      superadmin: {
        id: superadmin.id,
        email: superadmin.email,
        role: normalizeSuperAdminRole(superadmin.role),
        is_active: superadmin.is_active !== false,
        last_login: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[SuperAdminAuth] Login failed:', error?.message || error);
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      error:
        statusCode >= 500 && !error?.statusCode
          ? 'Superadmin login failed'
          : error?.message || 'Superadmin login failed',
    });
  }
}

export function requireSuperAdmin(req, res, next) {
  const run = async () => {
    try {
      const token = parseBearerToken(req);
      if (!token) {
        return res.status(401).json({ success: false, error: 'Missing superadmin token' });
      }

      const secret = getJwtSecret();
      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch (error) {
        return res.status(401).json({ success: false, error: 'Invalid or expired superadmin token' });
      }

      const superadminId = decoded?.sub;
      if (!superadminId) {
        return res.status(401).json({ success: false, error: 'Invalid superadmin token payload' });
      }

      const { data: superadmin, error } = await supabase
        .from('superadmin_users')
        .select('*')
        .eq('id', superadminId)
        .maybeSingle();

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      if (!superadmin || superadmin.is_active === false) {
        return res.status(403).json({ success: false, error: 'Superadmin account is inactive' });
      }

      const resolvedRole = normalizeSuperAdminRole(superadmin.role);
      req.superadmin = { ...superadmin, role: resolvedRole };
      req.actor = {
        id: superadmin.id,
        type: 'SUPERADMIN',
        role: resolvedRole,
        email: superadmin.email,
      };

      return next();
    } catch (error) {
      console.error('[SuperAdminAuth] Superadmin check failed:', error?.message || error);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  };

  run();
}

// requireGodMode — GODMODE only (developer). SUPERADMIN (ITM owner) is blocked.
export function requireGodMode(req, res, next) {
  const run = async () => {
    try {
      const token = parseBearerToken(req);
      if (!token) {
        return res.status(401).json({ success: false, error: 'Missing superadmin token' });
      }

      const secret = getJwtSecret();
      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch (error) {
        return res.status(401).json({ success: false, error: 'Invalid or expired superadmin token' });
      }

      const superadminId = decoded?.sub;
      if (!superadminId) {
        return res.status(401).json({ success: false, error: 'Invalid superadmin token payload' });
      }

      const { data: superadmin, error } = await supabase
        .from('superadmin_users')
        .select('*')
        .eq('id', superadminId)
        .maybeSingle();

      if (error) {
        return res.status(500).json({ success: false, error: error.message });
      }

      if (!superadmin || superadmin.is_active === false) {
        return res.status(403).json({ success: false, error: 'Account is inactive' });
      }

      const resolvedRole = normalizeSuperAdminRole(superadmin.role);

      // Only GODMODE allowed here
      if (resolvedRole !== 'GODMODE') {
        return res.status(403).json({
          success: false,
          error: 'GOD MODE access required. This action is restricted to the platform developer.',
        });
      }

      req.superadmin = { ...superadmin, role: resolvedRole };
      req.actor = {
        id: superadmin.id,
        type: 'SUPERADMIN',
        role: resolvedRole,
        email: superadmin.email,
      };

      return next();
    } catch (error) {
      console.error('[SuperAdminAuth] GodMode check failed:', error?.message || error);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  };

  run();
}

export async function changeSuperAdminPassword(req, res) {
  try {
    const superadmin = req.superadmin;
    const currentPassword = String(req.body?.current_password || '');
    const newPassword = String(req.body?.new_password || '');

    if (!superadmin?.id) {
      return res.status(401).json({ success: false, error: 'Missing superadmin session' });
    }

    if (!newPassword || newPassword.length < 8) {
      return res
        .status(400)
        .json({ success: false, error: 'New password must be at least 8 characters' });
    }

    const passwordOk = await verifyPassword(currentPassword, superadmin.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    const { error } = await supabase
      .from('superadmin_users')
      .update({
        password_hash: newHash,
        updated_at: new Date().toISOString(),
      })
      .eq('id', superadmin.id);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'SUPERADMIN_PASSWORD_CHANGED',
      entityType: 'superadmin_users',
      entityId: superadmin.id,
      details: { email: superadmin.email },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('[SuperAdminAuth] Password change failed:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to change superadmin password' });
  }
}
