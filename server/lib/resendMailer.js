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

export const isResendConfigured = () =>
  Boolean(
    readEnv('RESEND_API_KEY') &&
      readEnv(
        'RESEND_FROM_EMAIL',
        'OTP_FROM_EMAIL',
        'WELCOME_FROM_EMAIL',
        'NO_REPLY_FROM_EMAIL',
        'SUPPORT_FROM_EMAIL',
        'BILLING_FROM_EMAIL',
        'RESEND_SUPPORT_EMAIL',
        'RESEND_BILLING_EMAIL'
      )
  );

export const sendResendEmail = async ({
  to,
  cc,
  bcc,
  subject,
  html,
  text,
  headers,
  tags,
  attachments,
  replyTo,
  fromName = 'IndianTradeMart',
  fromEmail = '',
}) => {
  const apiKey = readEnv('RESEND_API_KEY');
  const sender = fromEmail || readEnv('RESEND_FROM_EMAIL', 'OTP_FROM_EMAIL');

  if (!apiKey || !sender) {
    throw new Error('Resend is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.');
  }

  const payloadBody = {
    from: `${fromName} <${sender}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };

  if (cc) payloadBody.cc = cc;
  if (bcc) payloadBody.bcc = bcc;
  if (typeof text === 'string') payloadBody.text = text;
  if (replyTo) payloadBody.reply_to = replyTo;
  if (headers && typeof headers === 'object') payloadBody.headers = headers;
  if (Array.isArray(tags) && tags.length) payloadBody.tags = tags;
  if (Array.isArray(attachments) && attachments.length) payloadBody.attachments = attachments;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payloadBody),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Resend send failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }

  return payload;
};
