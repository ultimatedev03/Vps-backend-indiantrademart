const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CAPTCHA_BYPASS_TOKEN = 'captcha_bypass';

const normalizeText = (value) => String(value || '').trim();

const normalizeBooleanEnv = (value) => normalizeText(value).toLowerCase();

const parseBooleanEnv = (value) => {
  const normalized = normalizeBooleanEnv(value);

  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return null;
};

const readCaptchaEnabledOverride = () =>
  [
    process.env.CAPTCHA_ENABLED,
    process.env.VITE_CAPTCHA_ENABLED,
  ].find((value) => parseBooleanEnv(value) !== null);

const isCaptchaExplicitlyDisabled = () =>
  parseBooleanEnv(readCaptchaEnabledOverride()) === false;

const readCaptchaSecret = () =>
  [
    process.env.TURNSTILE_SECRET_KEY,
    process.env.TURNSTILE_SECRET,
    process.env.CAPTCHA_SECRET_KEY,
    process.env.VITE_TURNSTILE_SECRET_KEY,
    process.env.VITE_CAPTCHA_SECRET_KEY,
    process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY,
  ]
    .map(normalizeText)
    .find(Boolean) || '';

const isProductionRuntime = () =>
  normalizeText(process.env.NODE_ENV).toLowerCase() === 'production';

const isLocalDevRuntime = () => {
  const lifecycleEvent = normalizeText(process.env.npm_lifecycle_event).toLowerCase();
  if (['dev', 'dev:all', 'dev:server', 'dev:client'].includes(lifecycleEvent)) {
    return true;
  }

  return process.execArgv.some((arg) => normalizeText(arg) === '--watch');
};

const allowDevBypass = () => {
  const explicit = normalizeText(process.env.CAPTCHA_ALLOW_DEV_BYPASS).toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  if (isLocalDevRuntime()) return true;
  return !isProductionRuntime();
};

export const getCaptchaToken = (payload = {}) =>
  [
    payload?.captcha_token,
    payload?.captchaToken,
    payload?.turnstile_token,
    payload?.turnstileToken,
  ]
    .map(normalizeText)
    .find(Boolean) || '';

export const getRemoteIpFromHeaders = (headers = {}) => {
  const forwardedFor =
    headers?.['x-forwarded-for'] ||
    headers?.['X-Forwarded-For'] ||
    headers?.['x-nf-client-connection-ip'] ||
    headers?.['X-Nf-Client-Connection-Ip'] ||
    '';

  const firstForwarded = String(forwardedFor || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean);

  return (
    firstForwarded ||
    normalizeText(headers?.['x-real-ip'] || headers?.['X-Real-Ip']) ||
    ''
  );
};

const createCaptchaError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export async function verifyCaptchaToken({ token, remoteIp = '', action = '' } = {}) {
  const normalizedToken = normalizeText(token);
  const normalizedAction = normalizeText(action);
  const secret = readCaptchaSecret();
  const devBypassAllowed = allowDevBypass();

  if (isCaptchaExplicitlyDisabled()) {
    return { success: true, skipped: true, reason: 'explicit_bypass' };
  }

  // Frontend local-dev mode emits a sentinel token when Turnstile is intentionally
  // bypassed. Accept that token only in non-production/dev-bypass contexts so
  // local login flows keep working even when a real secret is present locally.
  if (normalizedToken === CAPTCHA_BYPASS_TOKEN && devBypassAllowed) {
    return { success: true, skipped: true, reason: 'dev_bypass_token' };
  }

  if (!secret) {
    if (devBypassAllowed) {
      return { success: true, skipped: true, reason: 'dev_bypass_no_secret' };
    }

    throw createCaptchaError(
      'Captcha verification is not configured on the server. Set TURNSTILE_SECRET_KEY in the deployment environment.',
      503
    );
  }

  if (!normalizedToken) {
    throw createCaptchaError('Please complete the CAPTCHA verification to continue.');
  }

  let payload = null;

  try {
    const body = new URLSearchParams({
      secret,
      response: normalizedToken,
    });

    if (remoteIp) {
      body.set('remoteip', remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    payload = await response.json().catch(() => ({}));
  } catch (error) {
    if (devBypassAllowed) {
      return { success: true, skipped: true, reason: 'dev_bypass_network_error' };
    }

    throw createCaptchaError('Captcha verification is temporarily unavailable. Please try again.', 503);
  }

  if (!payload?.success) {
    throw createCaptchaError('Captcha verification failed. Please try again.');
  }

  if (normalizedAction && payload?.action && normalizeText(payload.action) !== normalizedAction) {
    throw createCaptchaError('Captcha verification could not be confirmed. Please retry.');
  }

  return {
    success: true,
    skipped: false,
    payload,
  };
}

export async function assertCaptchaForExpressRequest(req, { action = '' } = {}) {
  const token = getCaptchaToken(req?.body || {});
  const remoteIp = getRemoteIpFromHeaders(req?.headers || {});
  return verifyCaptchaToken({ token, remoteIp, action });
}

export async function assertCaptchaForNetlifyEvent(event, body = {}, { action = '' } = {}) {
  const token = getCaptchaToken(body || {});
  const remoteIp = getRemoteIpFromHeaders(event?.headers || {});
  return verifyCaptchaToken({ token, remoteIp, action });
}
