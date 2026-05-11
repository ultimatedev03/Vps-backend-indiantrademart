const normalizeText = (value) => String(value || '').trim();

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

  return (
    String(forwardedFor || '')
      .split(',')
      .map((part) => part.trim())
      .find(Boolean) ||
    normalizeText(headers?.['x-real-ip'] || headers?.['X-Real-Ip']) ||
    ''
  );
};

export async function verifyCaptchaToken() {
  return { success: true, skipped: true, reason: 'captcha_removed' };
}

export async function assertCaptchaForExpressRequest() {
  return verifyCaptchaToken();
}

export async function assertCaptchaForNetlifyEvent() {
  return verifyCaptchaToken();
}
