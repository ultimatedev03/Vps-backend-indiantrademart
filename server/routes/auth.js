import { logger } from '../utils/logger.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { supabase, supabaseAnon } from '../lib/supabaseClient.js';
import { isCloudinaryConfigured, uploadBufferToCloudinary } from '../lib/cloudinaryUpload.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  buildAuthUserPayload,
  clearAuthCookies,
  createCsrfToken,
  getAuthCookieNames,
  getCookie,
  hashPassword,
  isBcryptHash,
  normalizeEmail,
  normalizeRole,
  resolveRoleForUser,
  setAuthCookies,
  setPublicUserPassword,
  signAuthToken,
  syncProfileUserId,
  upsertPublicUser,
  verifyAuthToken,
  verifyPassword,
  getPublicUserByEmail,
  getPublicUserById,
} from '../lib/auth.js';
import { assertCaptchaForExpressRequest } from '../lib/captcha.js';
import { sendWelcomeEmail } from '../lib/emailService.js';
import { validateStrongPassword } from '../lib/passwordPolicy.js';

const router = express.Router();

const ENABLE_SUPABASE_AUTH_MIGRATION =
  String(process.env.ENABLE_SUPABASE_AUTH_MIGRATION || 'true').toLowerCase() !== 'false';

const ENABLE_SUPABASE_AUTH_SIGNUP =
  String(process.env.ENABLE_SUPABASE_AUTH_SIGNUP || 'true').toLowerCase() !== 'false';
const BUYER_NOT_REGISTERED_MESSAGE = 'This email is not registered as buyer';
const BUYER_AVATAR_MIN_BYTES = 10 * 1024;
const BUYER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const BUYER_AVATAR_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const BUYER_AVATAR_EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const _cacheBuyerProfile = new Map();
const _nowMs = () => Date.now();
const _getCached = (m, k) => {
  const e = m.get(k);
  return e && e.exp > _nowMs() ? e.val : null;
};
const _setCached = (m, k, v, ttl) => {
  m.set(k, { val: v, exp: _nowMs() + ttl });
};

const isValidEmail = (email) => !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const INDIAN_PHONE_RE = /^[6-9]\d{9}$/;
const pickFirstDefined = (...values) => values.find((value) => value !== undefined && value !== null);
const optionalText = (value) => {
  const text = String(value || '').trim();
  return text || null;
};
const optionalId = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};
const parseDataUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('data:')) {
    const match = raw.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    return {
      mime: String(match[1] || '').trim().toLowerCase(),
      base64: String(match[2] || '').trim(),
    };
  }
  return { mime: null, base64: raw };
};
const sanitizeFilename = (name) =>
  String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 120) || 'avatar';

const createValidationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const normalizeIndianPhone = (value = '') => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length > 10) {
    digits = digits.slice(2);
  }
  if (digits.length > 10) {
    digits = digits.slice(-10);
  }
  return digits;
};

const formatRuntimeError = (error) => {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return 'Unknown error';
  if (raw.startsWith('<!DOCTYPE html') || raw.startsWith('<html')) {
    return 'Upstream SSL/network error';
  }
  return raw.replace(/\s+/g, ' ').slice(0, 320);
};

const isTransientUpstreamError = (error) => {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('ssl') ||
    text.includes('tls') ||
    text.includes('handshake') ||
    text.includes('cloudflare') ||
    text.includes('error 52')
  );
};

const parseBuyerProfileInput = (body = {}) => ({
  company_name: optionalText(pickFirstDefined(body.company_name, body.companyName)),
  state_id: optionalId(pickFirstDefined(body.state_id, body.stateId)),
  city_id: optionalId(pickFirstDefined(body.city_id, body.cityId)),
  state: optionalText(pickFirstDefined(body.state, body.state_name, body.stateName)),
  city: optionalText(pickFirstDefined(body.city, body.city_name, body.cityName)),
});

function issueSession(res, user) {
  const token = signAuthToken({
    sub: user.id,
    email: user.email,
    role: normalizeRole(user.role || 'USER'),
    type: 'USER',
  });
  const csrfToken = createCsrfToken();
  setAuthCookies(res, token, csrfToken);
  return {
    ...buildAuthUserPayload(user),
    access_token: token,
  };
}

async function ensureUserRole(user) {
  if (!user?.id) return user;
  const resolvedRole = await resolveRoleForUser({
    userId: user.id,
    email: user.email,
    fallbackRole: user.role,
  });

  if (resolvedRole && normalizeRole(user.role) !== normalizeRole(resolvedRole)) {
    return upsertPublicUser({
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: resolvedRole,
      phone: user.phone,
      password_hash: user.password_hash,
      allowPasswordUpdate: false,
    });
  }

  return user;
}

async function assertUserActive(user) {
  if (!user?.id) return { ok: false, error: 'User not found' };
  const role = normalizeRole(user.role || 'USER');

  if (role === 'VENDOR') {
    const { data: vendor } = await supabase
      .from('vendors')
      .select('is_active')
      .or(
        [
          `user_id.eq.${user.id}`,
          user.email ? `email.eq.${user.email}` : null,
        ]
          .filter(Boolean)
          .join(',')
      )
      .maybeSingle();

    if (!vendor) return { ok: false, error: 'Vendor profile not found' };
    // Suspended/terminated vendors are allowed to login.
    // UI + protected routes enforce restricted access (support/logout only).
    return { ok: true };
  }

  if (role === 'BUYER') {
    const { data: buyer } = await supabase
      .from('buyers')
      .select('is_active')
      .or(
        [
          `user_id.eq.${user.id}`,
          user.email ? `email.eq.${user.email}` : null,
        ]
          .filter(Boolean)
          .join(',')
      )
      .maybeSingle();

    // Suspended/terminated buyers are allowed to login.
    // Buyer portal route guards will restrict them to support/tickets pages.
    if (!buyer) return { ok: true };
    return { ok: true };
  }

  if (['ADMIN', 'HR', 'DATA_ENTRY', 'SUPPORT', 'SALES', 'FINANCE', 'SUPERADMIN'].includes(role)) {
    const { data: emp } = await supabase
      .from('employees')
      .select('status')
      .or(
        [
          `user_id.eq.${user.id}`,
          user.email ? `email.eq.${user.email}` : null,
        ]
          .filter(Boolean)
          .join(',')
      )
      .maybeSingle();

    const status = String(emp?.status || 'ACTIVE').toUpperCase();
    if (emp && status !== 'ACTIVE') return { ok: false, error: 'Employee account is inactive' };
  }

  return { ok: true };
}

async function verifyViaSupabase(email, password) {
  if (!supabaseAnon?.auth?.signInWithPassword) {
    return { user: null, error: 'Supabase anon client not available' };
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

  if (error || !data?.user) {
    return { user: null, error: error?.message || 'Invalid credentials' };
  }

  return { user: data.user, error: null };
}

async function upsertBuyerProfile({
  userId,
  email,
  full_name,
  phone,
  company_name,
  state_id,
  city_id,
  state,
  city,
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!userId && !normalizedEmail) return null;

  let existing = null;

  if (userId) {
    const { data } = await supabase
      .from('buyers')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (data) existing = data;
  }

  if (!existing && normalizedEmail) {
    const { data } = await supabase
      .from('buyers')
      .select('*')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (data) existing = data;
  }

  const nameValue = optionalText(full_name) || (normalizedEmail ? normalizedEmail.split('@')[0] : 'Buyer');
  const phoneValue = optionalText(phone);
  const companyNameValue = optionalText(company_name);
  const stateIdValue = optionalId(state_id);
  const cityIdValue = optionalId(city_id);
  const stateValue = optionalText(state);
  const cityValue = optionalText(city);

  if (existing) {
    const updates = {};
    const linkingLegacyBuyer = Boolean(userId && !existing.user_id);

    if (userId && existing.user_id !== userId) updates.user_id = userId;
    if (normalizedEmail && normalizeEmail(existing.email) !== normalizedEmail) updates.email = normalizedEmail;
    if (nameValue && existing.full_name !== nameValue) updates.full_name = nameValue;
    if (phoneValue && existing.phone !== phoneValue) updates.phone = phoneValue;
    if (companyNameValue && existing.company_name !== companyNameValue) updates.company_name = companyNameValue;
    if (stateIdValue && String(existing.state_id || '') !== String(stateIdValue)) updates.state_id = stateIdValue;
    if (cityIdValue && String(existing.city_id || '') !== String(cityIdValue)) updates.city_id = cityIdValue;
    if (stateValue && existing.state !== stateValue) updates.state = stateValue;
    if (cityValue && existing.city !== cityValue) updates.city = cityValue;

    // If we are linking an older buyer row to this auth user for the first time,
    // avoid false "suspended" states caused by legacy/default inactive flags.
    if (linkingLegacyBuyer) {
      const normalizedStatus = String(existing.status || '').toUpperCase();
      const hasExplicitSuspensionFlag =
        Boolean(existing.terminated_at) ||
        normalizedStatus === 'SUSPENDED' ||
        normalizedStatus === 'TERMINATED';

      if (existing.is_active === false && !hasExplicitSuspensionFlag) {
        updates.is_active = true;
      }

      if ('status' in existing && !hasExplicitSuspensionFlag) {
        if (!normalizedStatus || normalizedStatus === 'INACTIVE') {
          updates.status = 'ACTIVE';
        }
      }
    }

    if (!Object.keys(updates).length) return existing;

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('buyers')
      .update(updates)
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(error.message || 'Failed to update buyer profile');
    return data || { ...existing, ...updates };
  }

  const nowIso = new Date().toISOString();
  const payload = {
    user_id: userId || null,
    full_name: nameValue,
    email: normalizedEmail || null,
    phone: phoneValue,
    company_name: companyNameValue,
    state_id: stateIdValue,
    city_id: cityIdValue,
    state: stateValue,
    city: cityValue,
    is_active: true,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from('buyers')
    .insert([payload])
    .select('*')
    .maybeSingle();

  if (!error) return data || payload;

  // Safe retry for race conditions when profile gets created in parallel.
  if (String(error?.code || '') === '23505') {
    if (userId) {
      const { data: byUserId } = await supabase
        .from('buyers')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (byUserId) return byUserId;
    }

    if (normalizedEmail) {
      const { data: byEmail } = await supabase
        .from('buyers')
        .select('*')
        .eq('email', normalizedEmail)
        .maybeSingle();
      if (byEmail) return byEmail;
    }
  }

  throw new Error(error.message || 'Failed to create buyer profile');
}

function deriveBuyerAccountStatus(buyer) {
  if (!buyer) return 'UNKNOWN';
  if (buyer.terminated_at) return 'TERMINATED';
  if (buyer.is_active === false) return 'SUSPENDED';
  if (typeof buyer.status === 'string' && buyer.status.trim()) {
    return buyer.status.trim().toUpperCase();
  }
  return 'ACTIVE';
}

async function resolveBuyerProfileForUser(user) {
  if (!user?.id && !user?.email) return null;
  return upsertBuyerProfile({
    userId: user?.id,
    email: user?.email,
    full_name: user?.full_name,
    phone: user?.phone,
  });
}

async function findBuyerProfileForUser(user) {
  if (!user?.id && !user?.email) return null;

  const identityFilters = [
    user?.id ? `user_id.eq.${user.id}` : null,
    user?.email ? `email.eq.${normalizeEmail(user.email)}` : null,
  ]
    .filter(Boolean)
    .join(',');

  if (!identityFilters) return null;

  const { data } = await supabase
    .from('buyers')
    .select('*')
    .or(identityFilters)
    .limit(1)
    .maybeSingle();

  return data || null;
}

async function resolveBuyerAccessUser(user) {
  if (!user?.id && !user?.email) {
    return { user, buyer: null, upgraded: false };
  }

  let ensuredUser = await ensureUserRole(user);

  if (normalizeRole(ensuredUser?.role) === 'BUYER') {
    const buyer = await resolveBuyerProfileForUser(ensuredUser);
    return { user: ensuredUser, buyer, upgraded: false };
  }

  const identityFilters = [
    ensuredUser?.id ? `user_id.eq.${ensuredUser.id}` : null,
    ensuredUser?.email ? `email.eq.${normalizeEmail(ensuredUser.email)}` : null,
  ]
    .filter(Boolean)
    .join(',');

  if (!identityFilters) {
    return { user: ensuredUser, buyer: null, upgraded: false };
  }

  const { data: buyerByIdentity } = await supabase
    .from('buyers')
    .select('*')
    .or(identityFilters)
    .maybeSingle();

  if (!buyerByIdentity) {
    return { user: ensuredUser, buyer: null, upgraded: false };
  }

  ensuredUser = await upsertPublicUser({
    id: ensuredUser.id,
    email: ensuredUser.email,
    full_name: ensuredUser.full_name || buyerByIdentity.full_name,
    role: 'BUYER',
    phone: ensuredUser.phone || buyerByIdentity.phone || null,
    password_hash: ensuredUser.password_hash,
    allowPasswordUpdate: false,
  });

  const buyer = await resolveBuyerProfileForUser(ensuredUser);
  return { user: ensuredUser, buyer: buyer || buyerByIdentity, upgraded: true };
}

async function resolveVendorProfileForUser(user) {
  if (!user?.id && !user?.email) return null;
  let vendor = null;

  if (user?.id) {
    const { data } = await supabase
      .from('vendors')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    vendor = data || null;
  }

  if (!vendor && user?.email) {
    const normalizedEmail = normalizeEmail(user.email);
    const { data } = await supabase
      .from('vendors')
      .select('*')
      .ilike('email', normalizedEmail)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    vendor = data || null;
  }

  return vendor;
}

function parseBuyerProfileUpdates(body = {}) {
  const updates = {};

  const fullNameRaw = pickFirstDefined(body.full_name, body.fullName);
  if (fullNameRaw !== undefined) {
    const value = optionalText(fullNameRaw);
    if (value) updates.full_name = value;
  }

  const phoneRaw = pickFirstDefined(body.phone, body.mobile_number, body.mobileNumber);
  if (phoneRaw !== undefined) {
    const normalizedPhone = normalizeIndianPhone(phoneRaw);
    if (String(phoneRaw ?? '').trim() && !INDIAN_PHONE_RE.test(normalizedPhone)) {
      throw createValidationError('Mobile number must be a valid 10-digit Indian number.');
    }
    updates.phone = normalizedPhone || null;
  }

  const companyRaw = pickFirstDefined(body.company_name, body.companyName);
  if (companyRaw !== undefined) updates.company_name = optionalText(companyRaw);

  const companyTypeRaw = pickFirstDefined(body.company_type, body.companyType);
  if (companyTypeRaw !== undefined) updates.company_type = optionalText(companyTypeRaw);

  const industryRaw = pickFirstDefined(body.industry);
  if (industryRaw !== undefined) updates.industry = optionalText(industryRaw);

  const gstRaw = pickFirstDefined(body.gst_number, body.gstNumber);
  if (gstRaw !== undefined) updates.gst_number = optionalText(gstRaw);

  const panRaw = pickFirstDefined(body.pan_card, body.panCard);
  if (panRaw !== undefined) updates.pan_card = optionalText(panRaw);

  const addressRaw = pickFirstDefined(body.address);
  if (addressRaw !== undefined) updates.address = optionalText(addressRaw);

  const stateIdRaw = pickFirstDefined(body.state_id, body.stateId);
  if (stateIdRaw !== undefined) updates.state_id = optionalId(stateIdRaw);

  const cityIdRaw = pickFirstDefined(body.city_id, body.cityId);
  if (cityIdRaw !== undefined) updates.city_id = optionalId(cityIdRaw);

  const stateRaw = pickFirstDefined(body.state, body.state_name, body.stateName);
  if (stateRaw !== undefined) updates.state = optionalText(stateRaw);

  const cityRaw = pickFirstDefined(body.city, body.city_name, body.cityName);
  if (cityRaw !== undefined) updates.city = optionalText(cityRaw);

  const pincodeRaw = pickFirstDefined(body.pincode, body.pin_code, body.pinCode);
  if (pincodeRaw !== undefined) updates.pincode = optionalText(pincodeRaw);

  const avatarRaw = pickFirstDefined(body.avatar_url, body.avatarUrl);
  if (avatarRaw !== undefined) updates.avatar_url = optionalText(avatarRaw);

  return updates;
}

router.post('/login', async (req, res) => {
  try {
    await assertCaptchaForExpressRequest(req, { action: 'auth_login' });

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const roleHint = normalizeRole(req.body?.role || req.body?.role_hint || req.body?.roleHint || '');

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Strict buyer portal isolation:
    // buyer login requires an existing buyer identity by email
    // and must not use vendor-only identities.
    if (roleHint === 'BUYER') {
      const { data: buyerByEmail, error: buyerLookupError } = await supabase
        .from('buyers')
        .select('id')
        .ilike('email', email)
        .limit(1)
        .maybeSingle();

      if (buyerLookupError) {
        logger.error('[Auth] Buyer lookup failed during login:', buyerLookupError?.message || buyerLookupError);
        return res.status(500).json({ success: false, error: 'Login failed' });
      }

      if (!buyerByEmail?.id) {
        return res.status(403).json({ success: false, error: BUYER_NOT_REGISTERED_MESSAGE });
      }

      const { data: vendorByEmail } = await supabase
        .from('vendors')
        .select('id')
        .ilike('email', email)
        .limit(1)
        .maybeSingle();

      if (vendorByEmail?.id) {
        return res.status(403).json({ success: false, error: BUYER_NOT_REGISTERED_MESSAGE });
      }
    }

    let user = await getPublicUserByEmail(email);

    if (user?.password_hash) {
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return res.status(401).json({ success: false, error: 'Invalid credentials' });

      if (!isBcryptHash(user.password_hash)) {
        const upgraded = await hashPassword(password);
        user = await upsertPublicUser({
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          phone: user.phone,
          password_hash: upgraded,
          allowPasswordUpdate: true,
        });
      }
    } else if (ENABLE_SUPABASE_AUTH_MIGRATION) {
      const { user: authUser, error } = await verifyViaSupabase(email, password);
      if (!authUser) {
        return res.status(401).json({ success: false, error: error || 'Invalid credentials' });
      }

      const resolvedRole = await resolveRoleForUser({
        userId: authUser.id,
        email,
        fallbackRole: authUser?.user_metadata?.role,
      });

      const password_hash = await hashPassword(password);

      user = await upsertPublicUser({
        id: authUser.id,
        email,
        full_name: authUser?.user_metadata?.full_name,
        role: resolvedRole,
        phone: authUser?.user_metadata?.phone,
        password_hash,
        allowPasswordUpdate: true,
      });

      await syncProfileUserId(authUser.id, email);
    } else {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    user = await ensureUserRole(user);
    const currentRole = normalizeRole(user?.role || 'USER');
    let buyerProfile = null;

    // Vendor portal fallback: if caller hinted VENDOR and vendor identity exists,
    // align public user role to VENDOR for this session.
    if (roleHint === 'VENDOR') {
      const vendor = await resolveVendorProfileForUser(user);
      if (!vendor) {
        return res.status(403).json({ success: false, error: 'Vendor profile not found' });
      }

      user = await upsertPublicUser({
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: 'VENDOR',
        phone: user.phone || vendor.phone || null,
        password_hash: user.password_hash,
        allowPasswordUpdate: false,
      });

      if (vendor.id && (!vendor.user_id || vendor.user_id !== user.id)) {
        const { error: linkError } = await supabase
          .from('vendors')
          .update({ user_id: user.id })
          .eq('id', vendor.id);

        if (linkError) {
          logger.warn('[Auth] Vendor relink failed during login:', linkError?.message || linkError);
        }
      }
    }

    // Buyer portal strict session:
    // vendor accounts must not authenticate in buyer portal.
    // only existing buyer identities are allowed to login as BUYER.
    if (roleHint === 'BUYER') {
      const vendorForUser = await resolveVendorProfileForUser(user);
      if (currentRole === 'VENDOR' || vendorForUser?.id) {
        return res.status(403).json({ success: false, error: BUYER_NOT_REGISTERED_MESSAGE });
      }

      const existingBuyer = await findBuyerProfileForUser(user);
      if (!existingBuyer && currentRole !== 'BUYER') {
        return res.status(403).json({ success: false, error: BUYER_NOT_REGISTERED_MESSAGE });
      }

      buyerProfile = await upsertBuyerProfile({
        userId: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
      });

      user = await upsertPublicUser({
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: 'BUYER',
        phone: user.phone || buyerProfile?.phone || null,
        password_hash: user.password_hash,
        allowPasswordUpdate: false,
      });
    }

    if (!buyerProfile && normalizeRole(user?.role) === 'BUYER') {
      buyerProfile = await upsertBuyerProfile({
        userId: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
      });
    }

    const activeCheck = await assertUserActive(user);
    if (!activeCheck.ok) {
      return res.status(403).json({ success: false, error: activeCheck.error || 'Account inactive' });
    }

    const payload = issueSession(res, user);
    if (buyerProfile) {
      payload.buyer_id = buyerProfile.id || null;
      payload.is_active =
        typeof buyerProfile.is_active === 'boolean' ? buyerProfile.is_active : true;
      payload.account_status = deriveBuyerAccountStatus(buyerProfile);
      payload.suspension_reason = buyerProfile.terminated_reason || null;
    }
    return res.json({ success: true, user: payload });
  } catch (error) {
    logger.error('[Auth] Login failed:', error?.message || error);
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      error: statusCode >= 500 && !error?.statusCode ? 'Login failed' : error?.message || 'Login failed',
    });
  }
});

router.post('/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const full_name = String(req.body?.full_name || '').trim() || undefined;
    const role = normalizeRole(req.body?.role || 'USER');
    const phone = String(req.body?.phone || '').trim() || undefined;
    const noSession = req.body?.no_session === true;
    const buyerProfileInput = parseBuyerProfileInput(req.body);

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }
    const passwordValidation = validateStrongPassword(password);
    if (!passwordValidation.ok) {
      return res.status(400).json({ success: false, error: passwordValidation.error });
    }

    // ✅ If already exists in public_users -> 409
    const existing = await getPublicUserByEmail(email);
    if (existing?.id) {
      return res.status(409).json({
        success: false,
        error: 'A user with this email address has already been registered'
      });
    }

    let userId = null;

    if (ENABLE_SUPABASE_AUTH_SIGNUP && supabase?.auth?.admin?.createUser) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, role, phone },
        app_metadata: { role },
      });

      // ✅ FIX: If Supabase says already exists -> respond 409 (not 400)
      if (error || !data?.user) {
        const msg = String(error?.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
          return res.status(409).json({
            success: false,
            error: 'A user with this email address has already been registered'
          });
        }
        return res.status(400).json({ success: false, error: error?.message || 'Auth signup failed' });
      }

      userId = data.user.id;
    }

    const password_hash = await hashPassword(password);

    const user = await upsertPublicUser({
      id: userId || undefined,
      email,
      full_name,
      role,
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });

    await syncProfileUserId(user.id, email);

    let buyerProfile = null;
    if (role === 'BUYER') {
      buyerProfile = await upsertBuyerProfile({
        userId: user.id,
        email,
        full_name: full_name || user.full_name,
        phone,
        ...buyerProfileInput,
      });
    }

    sendWelcomeEmail({
      to: email,
      fullName: full_name || user.full_name,
      role,
    }).catch((error) => {
      logger.warn('[Auth] Welcome email failed:', error?.message || error);
    });

    const payload = buildAuthUserPayload(user);
    if (buyerProfile) {
      payload.buyer_id = buyerProfile.id || null;
      payload.is_active =
        typeof buyerProfile.is_active === 'boolean' ? buyerProfile.is_active : true;
      payload.account_status = deriveBuyerAccountStatus(buyerProfile);
      payload.suspension_reason = buyerProfile.terminated_reason || null;
    }

    if (noSession) {
      return res.json({ success: true, user: payload, session_skipped: true });
    }

    const sessionPayload = issueSession(res, user);
    if (buyerProfile) {
      sessionPayload.buyer_id = payload.buyer_id;
      sessionPayload.is_active = payload.is_active;
      sessionPayload.account_status = payload.account_status;
      sessionPayload.suspension_reason = payload.suspension_reason;
    }

    return res.json({ success: true, user: sessionPayload });
  } catch (error) {
    logger.error('[Auth] Register failed:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const { AUTH_COOKIE_NAME, CSRF_COOKIE_NAME } = getAuthCookieNames();
    const token = getCookie(req, AUTH_COOKIE_NAME);

    if (!token) return res.json({ user: null });

    const decoded = verifyAuthToken(token);
    if (!decoded?.sub) {
      clearAuthCookies(res);
      return res.json({ user: null });
    }

    let user = await getPublicUserById(decoded.sub);
    if (!user && decoded?.email) {
      user = await getPublicUserByEmail(decoded.email);
    }

    if (!user) return res.json({ user: null });

    user = await ensureUserRole(user);
    let buyerProfile = null;

    if (normalizeRole(user?.role) === 'BUYER') {
      try {
        buyerProfile = await resolveBuyerProfileForUser(user);
      } catch (profileError) {
        logger.error('[Auth] Buyer profile resolve failed:', profileError?.message || profileError);
      }
    }

    // Refresh CSRF cookie if missing
    const csrfExisting = getCookie(req, CSRF_COOKIE_NAME);
    if (!csrfExisting) {
      const csrfToken = createCsrfToken();
      setAuthCookies(res, token, csrfToken);
    }

    const payload = {
      ...buildAuthUserPayload(user),
      access_token: token,
    };

    if (buyerProfile) {
      payload.buyer_id = buyerProfile.id || null;
      payload.is_active =
        typeof buyerProfile.is_active === 'boolean' ? buyerProfile.is_active : true;
      payload.account_status = deriveBuyerAccountStatus(buyerProfile);
      payload.suspension_reason = buyerProfile.terminated_reason || null;
    }

    return res.json({ user: payload, buyer: buyerProfile || null });
  } catch (error) {
    const formattedError = formatRuntimeError(error);
    const isTransient = isTransientUpstreamError(error);
    if (isTransient) {
      logger.warn('[Auth] Me temporary upstream failure:', formattedError);
      return res.status(503).json({ error: 'Auth service temporarily unavailable. Please retry.' });
    }
    logger.error('[Auth] Me failed:', formattedError);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.get('/buyer/profile', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    const ck = `buyer:${String(req.user?.id || '').trim() || (req.user?.email || '').toLowerCase()}`;
    const hit = _getCached(_cacheBuyerProfile, ck);
    if (hit) return res.json(hit);

    let user = await getPublicUserById(req.user.id);
    if (!user && req.user?.email) {
      user = await getPublicUserByEmail(req.user.email);
    }
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const buyer = await resolveBuyerProfileForUser(user);

    if (!buyer) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const payload = {
      success: true,
      buyer: buyer || null,
      account_status: deriveBuyerAccountStatus(buyer),
      user: buildAuthUserPayload(user),
    };
    _setCached(_cacheBuyerProfile, ck, payload, 45000);
    return res.json(payload);
  } catch (error) {
    const formattedError = formatRuntimeError(error);
    const isTransient = isTransientUpstreamError(error);
    if (isTransient) {
      logger.warn('[Auth] Buyer profile temporary upstream failure:', formattedError);
      return res.status(503).json({
        success: false,
        error: 'Buyer profile service temporarily unavailable. Please retry.',
      });
    }
    logger.error('[Auth] Buyer profile failed:', formattedError);
    return res.status(500).json({ success: false, error: 'Failed to fetch buyer profile' });
  }
});

router.patch('/buyer/profile', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    let user = await getPublicUserById(req.user.id);
    if (!user && req.user?.email) {
      user = await getPublicUserByEmail(req.user.email);
    }
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const buyer = await resolveBuyerProfileForUser(user);

    if (!buyer) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (!buyer.id) {
      return res.status(404).json({ success: false, error: 'Buyer profile not found' });
    }

    const requestedUpdates = parseBuyerProfileUpdates(req.body);
    const updates = {};

    // Avoid unknown-column failures by updating only existing buyer columns.
    for (const [key, value] of Object.entries(requestedUpdates)) {
      if (key in buyer) updates[key] = value;
    }

    if (!Object.keys(updates).length) {
      return res.json({ success: true, buyer });
    }

    updates.updated_at = new Date().toISOString();

    const { data: updatedBuyer, error } = await supabase
      .from('buyers')
      .update(updates)
      .eq('id', buyer.id)
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to update buyer profile' });
    }

    if ((updates.full_name || updates.phone) && user) {
      user = await upsertPublicUser({
        id: user.id,
        email: user.email,
        full_name: updates.full_name || user.full_name,
        role: user.role,
        phone: updates.phone || user.phone,
        password_hash: user.password_hash,
        allowPasswordUpdate: false,
      });
    }

    const refreshedUserPayload = user ? issueSession(res, user) : null;

    return res.json({
      success: true,
      buyer: updatedBuyer || { ...buyer, ...updates },
      user: refreshedUserPayload || (user ? buildAuthUserPayload(user) : null),
    });
  } catch (error) {
    logger.error('[Auth] Buyer profile update failed:', error?.message || error);
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      error: statusCode === 500 ? 'Failed to update buyer profile' : error?.message || 'Failed to update buyer profile',
    });
  }
});

router.post('/buyer/profile/avatar', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    let user = await getPublicUserById(req.user.id);
    if (!user && req.user?.email) {
      user = await getPublicUserByEmail(req.user.email);
    }
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const buyer = await resolveBuyerProfileForUser(user);
    if (!buyer?.id) {
      return res.status(403).json({ success: false, error: 'Buyer profile not found' });
    }

    const parsed = parseDataUrl(req.body?.data_url || req.body?.dataUrl || '');
    if (!parsed?.base64) {
      return res.status(400).json({ success: false, error: 'Empty upload payload' });
    }

    const requestedType = String(req.body?.content_type || req.body?.contentType || '').trim().toLowerCase();
    const mime = parsed.mime || requestedType;
    if (!BUYER_AVATAR_ALLOWED_MIME.has(mime)) {
      return res.status(400).json({ success: false, error: 'Unsupported image type. Use JPG/PNG/WebP/GIF.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(parsed.base64, 'base64');
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid base64 payload' });
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'Empty upload payload' });
    }
    if (buffer.length < BUYER_AVATAR_MIN_BYTES) {
      return res.status(400).json({ success: false, error: 'Image too small (minimum 10KB)' });
    }
    if (buffer.length > BUYER_AVATAR_MAX_BYTES) {
      return res.status(400).json({ success: false, error: 'Image too large (max 5MB)' });
    }

    const rawName = sanitizeFilename(req.body?.file_name || req.body?.fileName || 'avatar');
    const ext = rawName.includes('.')
      ? String(rawName.split('.').pop() || '').toLowerCase()
      : (BUYER_AVATAR_EXT_BY_MIME[mime] || 'jpg');
    const baseName = rawName.includes('.') ? rawName.replace(/\.[^/.]+$/, '') : rawName;
    const fileName = `${baseName || 'avatar'}.${ext}`;
    const objectPath = `buyer-avatars/${buyer.id}/${Date.now()}-${randomUUID()}-${fileName}`;

    if (isCloudinaryConfigured()) {
      const uploaded = await uploadBufferToCloudinary({
        buffer,
        contentType: mime,
        folder: `buyer-avatars/${buyer.id}`,
        publicId: objectPath,
        fileName,
        tags: ['buyer-avatar'],
      });

      if (!uploaded?.publicUrl) {
        return res.status(500).json({ success: false, error: 'Failed to build public url' });
      }

      const { error: updateError } = await supabase
        .from('buyers')
        .update({
          avatar_url: uploaded.publicUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', buyer.id);

      if (updateError) {
        return res.status(500).json({ success: false, error: updateError.message || 'Failed to save avatar' });
      }

      return res.json({
        success: true,
        publicUrl: uploaded.publicUrl,
        storage: uploaded.storageProvider,
        path: uploaded.path,
      });
    }

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(objectPath, buffer, {
        contentType: mime,
        upsert: false,
        cacheControl: '3600',
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message || 'Upload failed' });
    }

    const { data } = supabase.storage.from('avatars').getPublicUrl(objectPath);
    const publicUrl = data?.publicUrl || null;
    if (!publicUrl) {
      return res.status(500).json({ success: false, error: 'Failed to build public url' });
    }

    const { error: updateError } = await supabase
      .from('buyers')
      .update({
        avatar_url: publicUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', buyer.id);

    if (updateError) {
      return res.status(500).json({ success: false, error: updateError.message || 'Failed to save avatar' });
    }

    return res.json({ success: true, publicUrl });
  } catch (error) {
    logger.error('[Auth] Buyer avatar upload failed:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to upload avatar' });
  }
});

router.post('/logout', async (_req, res) => {
  clearAuthCookies(res);
  return res.json({ success: true });
});

router.patch('/password', requireAuth(), async (req, res) => {
  try {
    const currentPassword = String(req.body?.current_password || '');
    const newPassword = String(req.body?.new_password || req.body?.password || '');
    const currentUserId = String(req.user?.id || '').trim();
    const currentEmail = normalizeEmail(req.user?.email || '');

    const passwordValidation = validateStrongPassword(newPassword);
    if (!passwordValidation.ok) {
      return res.status(400).json({ success: false, error: passwordValidation.error });
    }

    let user = currentUserId ? await getPublicUserById(currentUserId) : null;
    if (!user && currentEmail) {
      user = await getPublicUserByEmail(currentEmail);
    }
    if (!user && currentEmail) {
      user = await upsertPublicUser({
        id: currentUserId || undefined,
        email: currentEmail,
        role: req.user?.role || 'USER',
        allowPasswordUpdate: false,
      });
    }
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.password_hash && currentPassword) {
      const ok = await verifyPassword(currentPassword, user.password_hash);
      if (!ok) return res.status(401).json({ success: false, error: 'Invalid current password' });
    }

    const updatedUser = await setPublicUserPassword(user.id, newPassword);

    // Keep Supabase auth.users password in sync when this ID exists in auth.
    let authPasswordSynced = false;
    const authIdCandidates = Array.from(
      new Set(
        [String(updatedUser?.id || '').trim(), currentUserId]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    );

    for (const authUserId of authIdCandidates) {
      try {
        const { error } = await supabase.auth.admin.updateUserById(authUserId, { password: newPassword });
        if (!error) {
          authPasswordSynced = true;
          break;
        }
      } catch {
        // Ignore sync failures for legacy non-Supabase identities.
      }
    }

    return res.json({ success: true, auth_password_synced: authPasswordSynced });
  } catch (error) {
    logger.error('[Auth] Password update failed:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Failed to update password' });
  }
});

export default router;
