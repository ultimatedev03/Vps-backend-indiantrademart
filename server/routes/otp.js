import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { assertCaptchaForExpressRequest } from '../lib/captcha.js';
import { getAuthCookieNames, getCookie, normalizeEmail as normalizeAuthEmail, verifyAuthToken } from '../lib/auth.js';
import { cacheDelete, cacheGetJson, cacheSetJson, isRedisConfigured } from '../lib/redisCache.js';
import { sendOtpEmail as sendOtpMail } from '../lib/emailService.js';

const router = express.Router();
const OTP_TTL_SECONDS = 120;
const IS_PRODUCTION = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const OTP_REDIS_KEY_PREFIX = 'auth_otp:';

const sanitizeEnvValue = (value) => {
  if (typeof value !== 'string') return '';
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith('\'') && cleaned.endsWith('\''))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
};

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = sanitizeEnvValue(process.env[key]);
    if (value) return value;
  }
  return '';
};

const parseBoolean = (value, fallback = false) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const isValidEmail = (email) => !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const OTP_DEV_FALLBACK_ENABLED = parseBoolean(readEnv('OTP_DEV_FALLBACK'), !IS_PRODUCTION);

const parseBearerToken = (req) => {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.replace('Bearer ', '').trim();
};

const getOptionalAuthUser = (req) => {
  try {
    const { AUTH_COOKIE_NAME } = getAuthCookieNames();
    const token = parseBearerToken(req) || getCookie(req, AUTH_COOKIE_NAME);
    if (!token) return null;
    const decoded = verifyAuthToken(token);
    if (!decoded?.sub) return null;
    return {
      id: decoded.sub,
      email: normalizeAuthEmail(decoded.email || ''),
    };
  } catch {
    return null;
  }
};

const shouldBypassCaptcha = (req, email) => {
  const authUser = getOptionalAuthUser(req);
  return !!authUser?.email && authUser.email === normalizeEmail(email);
};

function generateOtp() {
  let otp = '';
  for (let i = 0; i < 6; i += 1) {
    otp += Math.floor(Math.random() * 10);
  }
  return otp;
}

async function sendOtpEmail(email, otp) {
  try {
    await sendOtpMail(email, otp);
  } catch (error) {
    logger.error('[OTP] send failed', {
      code: error?.code,
      responseCode: error?.responseCode || error?.statusCode,
      message: error?.message,
    });
    throw error;
  }
}

const deliverOtpEmail = async (email, otp) => {
  try {
    await sendOtpEmail(email, otp);
    return { delivered: true, usedFallback: false };
  } catch (error) {
    if (!OTP_DEV_FALLBACK_ENABLED) throw error;

    logger.warn('[OTP] Email delivery failed. Using local dev fallback.', {
      email,
      reason: error?.message || 'Unknown email delivery error',
    });
    logger.log(`[OTP][DEV_FALLBACK] ${email} -> ${otp}`);

    return {
      delivered: false,
      usedFallback: true,
      reason: error?.message || 'Email delivery failed',
    };
  }
};

const getRemainingSeconds = (expiresAt) => {
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return OTP_TTL_SECONDS;
  const remainingMs = expiresAtMs - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
};

const getOtpCacheKey = (email) => `${OTP_REDIS_KEY_PREFIX}${normalizeEmail(email)}`;

const buildSuccessResponse = ({ otp, expiresAt, delivery, message }) => {
  const payload = {
    success: true,
    message,
    expiresIn: getRemainingSeconds(expiresAt),
    expiresAt,
  };

  if (delivery?.usedFallback) {
    payload.delivery = 'dev_fallback';
    if (!IS_PRODUCTION) {
      payload.debug_otp = otp;
      payload.debug_reason = delivery.reason || null;
    }
  }

  return payload;
};

const upsertOtpForEmail = async (email) => {
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

  if (isRedisConfigured()) {
    try {
      await cacheSetJson(
        getOtpCacheKey(email),
        {
          email,
          otp_code: otp,
          expires_at: expiresAt,
        },
        OTP_TTL_SECONDS
      );
      await supabase
        .from('auth_otps')
        .delete()
        .eq('email', email)
        .eq('used', false);
      return { otp, expiresAt, store: 'redis' };
    } catch (error) {
      logger.warn('[OTP] Redis write failed. Falling back to Supabase OTP store.', {
        reason: error?.message || 'Unknown Redis error',
      });
    }
  }

  await supabase
    .from('auth_otps')
    .delete()
    .eq('email', email)
    .eq('used', false);

  const { error: dbError } = await supabase
    .from('auth_otps')
    .insert([
      {
        email,
        otp_code: otp,
        expires_at: expiresAt,
        used: false,
      },
    ]);

  if (dbError) {
    logger.error('[OTP] Upsert failed:', dbError);
    throw new Error('Failed to generate OTP');
  }

  return { otp, expiresAt, store: 'supabase' };
};

const verifyOtpFromRedis = async (email, otpCode) => {
  if (!isRedisConfigured()) return null;

  try {
    const record = await cacheGetJson(getOtpCacheKey(email));
    if (!record) return { matched: false };

    const expiresAtMs = new Date(record.expires_at || record.expiresAt || '').getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      await cacheDelete(getOtpCacheKey(email)).catch(() => null);
      return { matched: false };
    }

    const expected = String(record.otp_code || record.otp || '').trim();
    if (!expected || expected !== otpCode) return { matched: false };

    await cacheDelete(getOtpCacheKey(email));
    return { matched: true };
  } catch (error) {
    logger.warn('[OTP] Redis verify failed. Falling back to Supabase OTP store.', {
      reason: error?.message || 'Unknown Redis error',
    });
    return null;
  }
};

// POST /api/otp/request - Request OTP
router.post('/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!shouldBypassCaptcha(req, email)) {
      await assertCaptchaForExpressRequest(req, { action: 'otp_request' });
    }

    const { otp, expiresAt } = await upsertOtpForEmail(email);
    const delivery = await deliverOtpEmail(email, otp);

    return res.json(buildSuccessResponse({
      otp,
      expiresAt,
      delivery,
      message: delivery.usedFallback
        ? 'OTP generated (dev fallback mode)'
        : 'OTP sent successfully to your email',
    }));
  } catch (error) {
    logger.error('OTP request error:', error);
    return res.status(error?.statusCode || 500).json({ error: error.message || 'Failed to send OTP' });
  }
});

// POST /api/otp/verify - Verify OTP
router.post('/verify', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const otpCode = String(req.body?.otp_code || '').trim();

    if (!email || !otpCode) {
      return res.status(400).json({ error: 'Email and OTP code are required' });
    }

    const redisVerification = await verifyOtpFromRedis(email, otpCode);
    if (redisVerification?.matched) {
      return res.json({
        success: true,
        message: 'OTP verified successfully',
        email,
      });
    }
    if (redisVerification && !redisVerification.matched) {
      return res.status(401).json({ error: 'Invalid or expired OTP code' });
    }

    const { data, error } = await supabase
      .from('auth_otps')
      .select('*')
      .eq('email', email)
      .eq('otp_code', otpCode)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('Database error:', error);
      return res.status(500).json({ error: 'Verification failed' });
    }
    if (!data) {
      return res.status(401).json({ error: 'Invalid or expired OTP code' });
    }

    await supabase
      .from('auth_otps')
      .update({ used: true })
      .eq('id', data.id);

    return res.json({
      success: true,
      message: 'OTP verified successfully',
      email,
    });
  } catch (error) {
    logger.error('OTP verification error:', error);
    return res.status(500).json({ error: error.message || 'Verification failed' });
  }
});

// POST /api/otp/resend - Resend OTP
router.post('/resend', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!shouldBypassCaptcha(req, email)) {
      await assertCaptchaForExpressRequest(req, { action: 'otp_resend' });
    }

    const { otp, expiresAt } = await upsertOtpForEmail(email);
    const delivery = await deliverOtpEmail(email, otp);

    return res.json(buildSuccessResponse({
      otp,
      expiresAt,
      delivery,
      message: delivery.usedFallback
        ? 'New OTP generated (dev fallback mode)'
        : 'New OTP sent to your email',
    }));
  } catch (error) {
    logger.error('Resend OTP error:', error);
    return res.status(error?.statusCode || 500).json({ error: error.message || 'Failed to resend OTP' });
  }
});

export default router;
