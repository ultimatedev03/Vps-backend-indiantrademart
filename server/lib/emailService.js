import nodemailer from 'nodemailer';
import { isResendConfigured, sendResendEmail } from './resendMailer.js';

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

const APP_NAME = readEnv('APP_NAME') || 'IndianTradeMart';
const DEFAULT_FRONTEND_URL =
  readEnv('FRONTEND_URL', 'VITE_FRONTEND_URL', 'VITE_SITE_URL') || 'https://indiantrademart.com';
const SMTP_CONFIG = Object.freeze({
  host: readEnv('SMTP_HOST', 'MAIL_HOST'),
  port: Number.parseInt(readEnv('SMTP_PORT', 'MAIL_PORT') || '587', 10),
  secure: parseBoolean(readEnv('SMTP_SECURE', 'MAIL_SECURE'), false),
  user: readEnv('SMTP_USER', 'SMTP_USERNAME', 'MAIL_USER', 'MAIL_USERNAME'),
  pass: readEnv('SMTP_PASS', 'SMTP_PASSWORD', 'MAIL_PASS', 'MAIL_PASSWORD'),
});
const GMAIL_CONFIG = Object.freeze({
  email: readEnv('GMAIL_EMAIL', 'GMAIL_USER', 'VITE_GMAIL_EMAIL'),
  appPassword: readEnv('GMAIL_APP_PASSWORD', 'GMAIL_PASSWORD', 'VITE_GMAIL_APP_PASSWORD').replace(
    /[\s\u200B-\u200D\uFEFF]+/g,
    ''
  ),
});

let cachedFallbackMailers = null;

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getFallbackMailers = () => {
  if (cachedFallbackMailers) return cachedFallbackMailers;

  const mailers = [];

  if (SMTP_CONFIG.host && SMTP_CONFIG.user && SMTP_CONFIG.pass) {
    mailers.push({
      provider: 'SMTP',
      defaultFromEmail: SMTP_CONFIG.user,
      transporter: nodemailer.createTransport({
        host: SMTP_CONFIG.host,
        port: Number.isNaN(SMTP_CONFIG.port) ? 587 : SMTP_CONFIG.port,
        secure: SMTP_CONFIG.secure,
        auth: {
          user: SMTP_CONFIG.user,
          pass: SMTP_CONFIG.pass,
        },
      }),
    });
  }

  if (GMAIL_CONFIG.email && GMAIL_CONFIG.appPassword) {
    mailers.push({
      provider: 'GMAIL',
      defaultFromEmail: GMAIL_CONFIG.email,
      transporter: nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: GMAIL_CONFIG.email,
          pass: GMAIL_CONFIG.appPassword,
        },
      }),
    });
  }

  cachedFallbackMailers = mailers;
  return cachedFallbackMailers;
};

const PURPOSE_SENDER_MAP = Object.freeze({
  otp: {
    fromName: readEnv('OTP_FROM_NAME', 'NO_REPLY_FROM_NAME', 'EMAIL_FROM_NAME') || APP_NAME,
    fromEmail: readEnv(
      'OTP_FROM_EMAIL',
      'NO_REPLY_FROM_EMAIL',
      'MAIL_FROM_NO_REPLY',
      'RESEND_NO_REPLY_EMAIL',
      'RESEND_FROM_EMAIL'
    ),
    replyTo: readEnv('SUPPORT_REPLY_TO', 'SUPPORT_FROM_EMAIL', 'SUPPORT_EMAIL'),
  },
  welcome: {
    fromName: readEnv('WELCOME_FROM_NAME', 'NO_REPLY_FROM_NAME', 'EMAIL_FROM_NAME') || APP_NAME,
    fromEmail: readEnv(
      'WELCOME_FROM_EMAIL',
      'NO_REPLY_FROM_EMAIL',
      'MAIL_FROM_NO_REPLY',
      'RESEND_NO_REPLY_EMAIL',
      'RESEND_FROM_EMAIL'
    ),
    replyTo: readEnv('SUPPORT_REPLY_TO', 'SUPPORT_FROM_EMAIL', 'SUPPORT_EMAIL'),
  },
  billing: {
    fromName: readEnv('BILLING_FROM_NAME', 'ACCOUNTS_FROM_NAME', 'EMAIL_FROM_NAME') || `${APP_NAME} Billing`,
    fromEmail: readEnv(
      'BILLING_FROM_EMAIL',
      'ACCOUNTS_FROM_EMAIL',
      'MAIL_FROM_BILLING',
      'RESEND_BILLING_EMAIL',
      'SUPPORT_FROM_EMAIL',
      'RESEND_FROM_EMAIL'
    ),
    replyTo: readEnv('BILLING_REPLY_TO', 'SUPPORT_REPLY_TO', 'SUPPORT_FROM_EMAIL', 'SUPPORT_EMAIL'),
  },
  notification: {
    fromName: readEnv('SUPPORT_FROM_NAME', 'EMAIL_FROM_NAME') || APP_NAME,
    fromEmail: readEnv(
      'SUPPORT_FROM_EMAIL',
      'MAIL_FROM_SUPPORT',
      'SUPPORT_EMAIL',
      'RESEND_SUPPORT_EMAIL',
      'RESEND_FROM_EMAIL',
      'MAIL_FROM'
    ),
    replyTo: readEnv('SUPPORT_REPLY_TO', 'SUPPORT_FROM_EMAIL', 'SUPPORT_EMAIL'),
  },
  quotation: {
    fromName: readEnv('SUPPORT_FROM_NAME', 'EMAIL_FROM_NAME') || APP_NAME,
    fromEmail: readEnv(
      'QUOTATION_FROM_EMAIL',
      'SUPPORT_FROM_EMAIL',
      'MAIL_FROM_SUPPORT',
      'SUPPORT_EMAIL',
      'RESEND_SUPPORT_EMAIL',
      'RESEND_FROM_EMAIL'
    ),
    replyTo: readEnv('SUPPORT_REPLY_TO', 'SUPPORT_FROM_EMAIL', 'SUPPORT_EMAIL'),
  },
  default: {
    fromName: readEnv('SUPPORT_FROM_NAME', 'EMAIL_FROM_NAME') || APP_NAME,
    fromEmail: readEnv(
      'SUPPORT_FROM_EMAIL',
      'MAIL_FROM_SUPPORT',
      'SUPPORT_EMAIL',
      'RESEND_SUPPORT_EMAIL',
      'RESEND_FROM_EMAIL',
      'MAIL_FROM'
    ),
    replyTo: readEnv('SUPPORT_REPLY_TO', 'SUPPORT_FROM_EMAIL', 'SUPPORT_EMAIL'),
  },
});

const resolveSenderProfile = (purpose = 'default', overrides = {}) => {
  const profile =
    PURPOSE_SENDER_MAP[purpose] ||
    PURPOSE_SENDER_MAP.notification ||
    PURPOSE_SENDER_MAP.default;

  return {
    fromName: overrides.fromName || profile.fromName || APP_NAME,
    fromEmail: overrides.fromEmail || profile.fromEmail || readEnv('RESEND_FROM_EMAIL', 'MAIL_FROM'),
    replyTo: overrides.replyTo || profile.replyTo || '',
  };
};

const normalizeResendAttachments = (attachments = []) =>
  (attachments || []).map((attachment) => {
    if (attachment?.path && !attachment?.content) {
      return {
        filename: attachment.filename,
        path: attachment.path,
      };
    }

    let content = attachment?.content;
    if (Buffer.isBuffer(content)) {
      content = content.toString('base64');
    }

    return {
      filename: attachment?.filename,
      content,
    };
  });

export const isEmailTransportConfigured = () =>
  isResendConfigured() || getFallbackMailers().length > 0;

export const sendEmail = async ({
  to,
  cc,
  bcc,
  subject,
  text = '',
  html = '',
  purpose = 'default',
  attachments = [],
  headers,
  tags,
  fromName,
  fromEmail,
  replyTo,
} = {}) => {
  const sender = resolveSenderProfile(purpose, { fromName, fromEmail, replyTo });
  const providers = [];

  if (isResendConfigured()) {
    providers.push({
      provider: 'RESEND',
      send: () =>
        sendResendEmail({
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          headers,
          tags,
          attachments: normalizeResendAttachments(attachments),
          fromName: sender.fromName,
          fromEmail: sender.fromEmail,
          replyTo: sender.replyTo,
        }),
    });
  }

  getFallbackMailers().forEach((mailer) => {
    providers.push({
      provider: mailer.provider,
      send: () =>
        mailer.transporter.sendMail({
          from: `${sender.fromName} <${sender.fromEmail || mailer.defaultFromEmail}>`,
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          replyTo: sender.replyTo || undefined,
          headers,
          attachments,
        }),
    });
  });

  if (!providers.length) {
    throw new Error(
      'Email service is not configured. Set RESEND_API_KEY/RESEND_FROM_EMAIL or SMTP/Gmail credentials.'
    );
  }

  const failures = [];

  for (const provider of providers) {
    try {
      await provider.send();
      return { provider: provider.provider };
    } catch (error) {
      const responseCode = Number(error?.responseCode || error?.statusCode);
      const message = String(error?.message || '').toLowerCase();
      const isAuthError =
        error?.code === 'EAUTH' ||
        responseCode === 401 ||
        responseCode === 403 ||
        responseCode === 535 ||
        message.includes('authentication') ||
        message.includes('api key');

      failures.push({
        provider: provider.provider,
        isAuthError,
        code: error?.code,
        responseCode,
      });
    }
  }

  if (failures.some((item) => item.isAuthError)) {
    throw new Error('Email service authentication failed. Please update Resend or SMTP credentials.');
  }

  throw new Error('Failed to send email');
};

export const buildOtpHtml = (otp) => `
  <html>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center;">
        <h2 style="color: #003D82;">Email Verification</h2>
        <p style="font-size: 16px; color: #333;">Your OTP verification code is:</p>
        <div style="background-color: #f0f0f0; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h1 style="color: #003D82; letter-spacing: 8px; font-size: 36px; margin: 0;">${escapeHtml(otp)}</h1>
        </div>
        <p style="color: #666; font-size: 14px;">This code will expire in 2 minutes.</p>
        <p style="color: #999; font-size: 12px; margin-top: 20px;">If you didn't request this code, please ignore this email.</p>
      </div>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
      <p style="text-align: center; color: #999; font-size: 11px;">
        &copy; ${new Date().getFullYear()} ${escapeHtml(APP_NAME)}. All rights reserved.
      </p>
    </body>
  </html>
`;

export const sendOtpEmail = async (to, otp) =>
  sendEmail({
    to,
    purpose: 'otp',
    subject: `Your OTP Code: ${otp}`,
    html: buildOtpHtml(otp),
    text: `Your OTP verification code is ${otp}. This code expires in 2 minutes.`,
  });

export const sendWelcomeEmail = async ({
  to,
  fullName = '',
  role = 'USER',
  dashboardUrl = '',
} = {}) => {
  const name = String(fullName || '').trim() || to?.split('@')?.[0] || 'there';
  const roleLabel = String(role || 'USER').trim().toLowerCase();
  const resolvedDashboardUrl = String(dashboardUrl || '').trim() || DEFAULT_FRONTEND_URL;

  return sendEmail({
    to,
    purpose: 'welcome',
    subject: `Welcome to ${APP_NAME}`,
    text: `Hi ${name}, welcome to ${APP_NAME}. Your ${roleLabel} account is ready. Start here: ${resolvedDashboardUrl}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #1f2937;">
        <h1 style="margin: 0 0 12px; color: #003D82;">Welcome to ${escapeHtml(APP_NAME)}</h1>
        <p style="margin: 0 0 12px;">Hi ${escapeHtml(name)},</p>
        <p style="margin: 0 0 12px;">
          Your ${escapeHtml(roleLabel)} account has been created successfully.
        </p>
        <p style="margin: 0 0 18px;">
          You can now sign in, complete your profile, and start using the platform.
        </p>
        <p style="margin: 0 0 18px;">
          <a href="${escapeHtml(resolvedDashboardUrl)}" style="display:inline-block;padding:12px 18px;background:#003D82;color:#fff;text-decoration:none;border-radius:8px;">
            Open ${escapeHtml(APP_NAME)}
          </a>
        </p>
        <p style="margin: 0; font-size: 13px; color: #6b7280;">
          If you need help, just reply to this email or contact our support team.
        </p>
      </div>
    `,
  });
};
