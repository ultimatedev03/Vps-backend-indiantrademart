import { createClient } from '@supabase/supabase-js';
import { setDefaultResultOrder } from 'dns';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Compute repo root relative to this file, not cwd, so it works regardless of where node is launched from.
const here = fileURLToPath(import.meta.url);
const libDir = dirname(here);                 // backend/server/lib
const serverDir = resolve(libDir, '..');      // backend/server
const backendDir = resolve(serverDir, '..');  // backend
const repoRoot = resolve(backendDir, '..');   // repo root

const envCandidates = [
  resolve(repoRoot, '.env.local'),
  resolve(repoRoot, '.env'),
  resolve(backendDir, '.env.local'),
  resolve(backendDir, '.env'),
  resolve(serverDir, '.env.local'),
  resolve(serverDir, '.env'),
  resolve(repoRoot, 'frontend', '.env.local'),
  resolve(repoRoot, 'frontend', '.env'),
];

for (const envPath of envCandidates) {
  dotenv.config({ path: envPath });
}

const nodeEnv = process.env.NODE_ENV || 'development';
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
// Prefer proper service role key; allow alternative var name; fall back to anon ONLY in non-production for local boot.
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl) {
  throw new Error('Missing Supabase URL in environment');
}

let serviceOrAnonKey = supabaseServiceKey;
let usingDevFallback = false;
if (!serviceOrAnonKey && nodeEnv !== 'production' && supabaseAnonKey) {
  serviceOrAnonKey = supabaseAnonKey;
  usingDevFallback = true;
}

if (!serviceOrAnonKey) {
  throw new Error('Missing Supabase credentials in environment: set SUPABASE_SERVICE_ROLE_KEY (required) or provide anon key for dev fallback');
}

try {
  // Networks with unstable IPv6 often cause intermittent fetch/TLS failures.
  setDefaultResultOrder('ipv4first');
} catch {
  // Ignore when not supported by current runtime.
}

const RETRYABLE_HTTP_STATUS = new Set([
  408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530,
]);

const MAX_FETCH_RETRIES = Math.max(1, Number(process.env.SUPABASE_FETCH_RETRIES || 3));
const FETCH_RETRY_DELAY_MS = Math.max(
  50,
  Number(process.env.SUPABASE_FETCH_RETRY_DELAY_MS || 250)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableNetworkError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  return (
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('tls') ||
    message.includes('ssl') ||
    message.includes('handshake')
  );
};

const resilientFetch = async (input, init) => {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!RETRYABLE_HTTP_STATUS.has(response.status) || attempt >= MAX_FETCH_RETRIES) {
        return response;
      }
      try {
        response.body?.cancel?.();
      } catch {
        // no-op
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt >= MAX_FETCH_RETRIES) {
        throw error;
      }
    }

    await sleep(FETCH_RETRY_DELAY_MS * attempt);
  }

  throw lastError || new Error('Supabase fetch failed');
};

export const supabase = createClient(supabaseUrl, serviceOrAnonKey, {
  global: {
    fetch: resilientFetch,
  },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// Optional anon client (used only for temporary auth verification during migration)
export const supabaseAnon = supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        fetch: resilientFetch,
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;

if (usingDevFallback) {
  // eslint-disable-next-line no-console
  console.warn('[supabaseClient] Using anon key as dev fallback because SUPABASE_SERVICE_ROLE_KEY is not set. Admin-only operations may fail.');
}
