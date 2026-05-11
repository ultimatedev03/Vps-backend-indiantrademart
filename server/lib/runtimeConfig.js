import dotenv from 'dotenv';
import { resolve } from 'path';

/**
 * Central runtime / environment configuration for the backend.
 *
 * All env-derived settings that affect server bootstrap, deployment behavior,
 * or shared defaults belong here instead of being scattered across files.
 */

// Load env files in priority order (first hit wins for each key).
// Check monorepo root, backend/, backend/server/, and parent dir (compat).
const cwd = process.cwd();
const envCandidates = [
  resolve(cwd, '.env.local'),
  resolve(cwd, '.env'),
  resolve(cwd, 'backend', '.env.local'),
  resolve(cwd, 'backend', '.env'),
  resolve(cwd, 'backend', 'server', '.env.local'),
  resolve(cwd, 'backend', 'server', '.env'),
  // Frontend vars sometimes used as fallbacks (VITE_* for URLs)
  resolve(cwd, 'frontend', '.env.local'),
  resolve(cwd, 'frontend', '.env'),
  resolve(cwd, '..', '.env.local'),
  resolve(cwd, '..', '.env'),
];

for (const envPath of envCandidates) {
  dotenv.config({ path: envPath });
}

const parseNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function createRuntimeConfig(overrides = {}) {
  const isProd = (overrides.nodeEnv || process.env.NODE_ENV) === 'production';

  return {
    // Server
    port: parseNumber(overrides.port || process.env.PORT, 3001),
    nodeEnv: overrides.nodeEnv || process.env.NODE_ENV || 'development',
    isProd,

    // Body parsing
    jsonBodyLimit: overrides.jsonBodyLimit || process.env.JSON_BODY_LIMIT || '10mb',

    // Rate limiting
    apiRateWindowMs: parseNumber(process.env.API_RATE_WINDOW_MS, 60 * 1000),
    apiRateMax: parseNumber(process.env.API_RATE_MAX, isProd ? 60 : 300),
    authRateWindowMs: parseNumber(process.env.AUTH_RATE_WINDOW_MS, 60 * 1000),
    authRateMax: parseNumber(process.env.AUTH_RATE_MAX, isProd ? 60 : 200),
    otpRateWindowMs: parseNumber(process.env.OTP_RATE_WINDOW_MS, 15 * 60 * 1000),
    otpRateMax: parseNumber(process.env.OTP_RATE_MAX, isProd ? 20 : 100),
    disableApiRateLimit: process.env.DISABLE_API_RATE_LIMIT === 'true',

    // Auth
    authCookieName: process.env.AUTH_COOKIE_NAME || 'itm_access',
    authCsrfCookie: process.env.AUTH_CSRF_COOKIE || 'itm_csrf',
    authCookieDomain: process.env.AUTH_COOKIE_DOMAIN || undefined,
    authTokenTtl: process.env.AUTH_TOKEN_TTL || '7d',
    authCookieMaxAgeDays: parseNumber(process.env.AUTH_COOKIE_MAX_AGE_DAYS, 7),

    // External integrations
    gmailEmail: process.env.GMAIL_EMAIL,
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

    // Debug
    debugSubdomain: process.env.DEBUG_SUBDOMAIN === 'true',

    // Dev
    devAdminEmail: process.env.DEV_ADMIN_EMAIL,
    devAdminPassword: process.env.DEV_ADMIN_PASSWORD,
  };
}

// Default singleton for convenience
const runtimeConfig = createRuntimeConfig();

export default runtimeConfig;
