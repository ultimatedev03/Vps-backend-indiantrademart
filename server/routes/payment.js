import { logger } from '../utils/logger.js';
import express from 'express';
import crypto from 'crypto';
import { db } from '../lib/dbClient.js';
import { razorpayInstance } from '../lib/razorpayClient.js';
import { generateInvoiceNumber, generateInvoicePDF, generateInvoiceSummary } from '../lib/invoiceGenerator.js';
import { sendSubscriptionActivatedNotification } from '../lib/notificationService.js';
import { sendEmail } from '../lib/emailService.js';
import { writeAuditLog } from '../lib/audit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { consumeLeadForVendorWithCompat } from '../lib/leadConsumptionCompat.js';
import {
  applyReferralRewardAfterPayment,
  getReferralSettings,
  getReferralOfferForVendor,
  normalizeReferralCode,
} from '../lib/referralProgram.js';
import {
  getPlanBillingQuote,
  isDirectPurchasePlan,
  isMonthlyBillingEnabled,
  isVisibleCatalogPlan,
  normalizeBillingCycle,
} from '../lib/vendorPlanCatalog.js';

const router = express.Router();

const normalizeText = (value) => String(value || '').trim();

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const normalizeCouponCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_-]/g, '');

const normalizeSalesCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32);

async function resolveSalesAttribution(rawCode = '') {
  const salesCode = normalizeSalesCode(rawCode);
  if (!salesCode) return { salesCode: null, employee: null, salesUserId: null };

  const { data, error } = await db
    .from('employees')
    .select('id, user_id, full_name, email, role, status, sales_code')
    .eq('sales_code', salesCode)
    .maybeSingle();

  if (error || !data?.id) return { salesCode, employee: null, salesUserId: null };

  const role = String(data.role || '').trim().toUpperCase();
  const status = String(data.status || 'ACTIVE').trim().toUpperCase();
  if (!['SALES', 'MANAGER', 'VP', 'ADMIN', 'SUPERADMIN'].includes(role) || status !== 'ACTIVE') {
    return { salesCode, employee: null, salesUserId: null };
  }

  return {
    salesCode,
    employee: data,
    salesUserId: String(data.user_id || data.id || '').trim() || null,
  };
}

const INDIA_TZ_OFFSET_MINUTES = 5 * 60 + 30;
const ISO_TZ_SUFFIX_REGEX = /(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const parseCouponExpiryInput = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (ISO_TZ_SUFFIX_REGEX.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const localMatch = raw.match(LOCAL_DATETIME_REGEX);
  if (localMatch) {
    const [, year, month, day, hours, minutes, seconds = '0'] = localMatch;
    const utcMillis =
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds)
      ) -
      INDIA_TZ_OFFSET_MINUTES * 60 * 1000;
    const parsed = new Date(utcMillis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getCouponExpiresAtMs = (coupon = {}) => {
  if (!coupon?.expires_at) return null;
  const parsed = parseCouponExpiryInput(coupon.expires_at);
  const ts = parsed?.getTime() ?? null;
  return Number.isFinite(ts) ? ts : null;
};

const GLOBAL_SCOPE_TOKENS = new Set(['ANY', 'ALL', 'GLOBAL', 'NULL', 'NONE']);

const normalizeScope = (value) => String(value || '').trim();

const isGlobalScope = (value) => {
  const scope = normalizeScope(value);
  if (!scope) return true;
  return GLOBAL_SCOPE_TOKENS.has(scope.toUpperCase());
};

const equalsIgnoreCase = (a, b) =>
  normalizeScope(a).toLowerCase() === normalizeScope(b).toLowerCase();

const isCouponVendorApplicable = (couponVendorScope, vendor) => {
  if (isGlobalScope(couponVendorScope)) return true;
  if (!vendor) return false;

  const scope = normalizeScope(couponVendorScope);
  const candidates = [vendor.id, vendor.vendor_id, vendor.email].filter(Boolean);
  return candidates.some((candidate) => equalsIgnoreCase(scope, candidate));
};

const isCouponPlanApplicable = (couponPlanScope, plan) => {
  if (isGlobalScope(couponPlanScope)) return true;
  if (!plan) return false;

  const scope = normalizeScope(couponPlanScope);
  const candidates = [plan.id, plan.name].filter(Boolean);
  return candidates.some((candidate) => equalsIgnoreCase(scope, candidate));
};

const parseCurrencyAmount = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
};

const asObject = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
};

const getPlanExtraLeadPrice = (plan) => {
  const features = asObject(plan?.features);
  const pricing = asObject(features?.pricing);
  return parseCurrencyAmount(pricing?.extra_lead_price, 0);
};

const getPlanCurrency = (plan) => {
  const features = asObject(plan?.features);
  const pricing = asObject(features?.pricing);
  const currency = String(pricing?.currency || features?.currency || plan?.currency || 'INR')
    .trim()
    .toUpperCase();
  return currency || 'INR';
};

const resolvePlanBillingQuote = (plan, requestedBillingCycle = 'YEARLY') => {
  const billingCycle = normalizeBillingCycle(requestedBillingCycle);
  if (billingCycle === 'MONTHLY' && !isMonthlyBillingEnabled(plan)) {
    throw new Error('Monthly payment is available only for Startup, Certified and Booster plans.');
  }

  return getPlanBillingQuote(plan, billingCycle);
};

const normalizeCountryCode = (value) => {
  const code = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return code.length === 2 && code !== 'XX' ? code : '';
};

const getCountryFromLanguage = (value) => {
  const match = String(value || '').match(/[-_]([A-Za-z]{2})(?:[,;]|$)/);
  return normalizeCountryCode(match?.[1]);
};

const getRequestCountryCode = (req) => {
  const headers = req?.headers || {};
  const candidates = [
    { source: 'cf-ipcountry', value: headers['cf-ipcountry'] },
    { source: 'x-vercel-ip-country', value: headers['x-vercel-ip-country'] },
    { source: 'cloudfront-viewer-country', value: headers['cloudfront-viewer-country'] },
    { source: 'x-country-code', value: headers['x-country-code'] },
    { source: 'x-appengine-country', value: headers['x-appengine-country'] },
  ];

  for (const candidate of candidates) {
    const countryCode = normalizeCountryCode(candidate.value);
    if (countryCode) return { countryCode, source: candidate.source };
  }

  const languageCountry = getCountryFromLanguage(headers['accept-language']);
  if (languageCountry) return { countryCode: languageCountry, source: 'accept-language' };

  return { countryCode: 'IN', source: 'fallback' };
};

const resolvePaidLeadPrice = (lead, plan) => {
  const configuredPrice = getPlanExtraLeadPrice(plan);
  if (configuredPrice > 0) return configuredPrice;
  return parseCurrencyAmount(lead?.price, 0);
};

const isMissingPlanFeaturesColumn = (error) => {
  const code = String(error?.code || '').toUpperCase();
  if (code === '42703') return true;
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  return message.includes('features') && message.includes('vendor_plans');
};

const isMissingRelationError = (error, relationName) => {
  const msg = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const normalizedRelation = String(relationName || '').toLowerCase();
  if (code === '42P01') return true;
  if (!normalizedRelation) return false;
  return (
    (msg.includes('relation') && msg.includes(normalizedRelation) && msg.includes('does not exist')) ||
    (msg.includes('table') && msg.includes(normalizedRelation) && msg.includes('not found')) ||
    (msg.includes(normalizedRelation) && msg.includes('schema cache'))
  );
};

async function consumeLeadForVendor({ vendorId, leadId, mode = 'AUTO', purchasePrice = 0 }) {
  return consumeLeadForVendorWithCompat({
    db,
    vendorId,
    leadId,
    mode,
    purchasePrice,
  });
}

async function getActiveVendorSubscription(vendorId) {
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await db
    .from('vendor_plan_subscriptions')
    .select('id, vendor_id, plan_id, status, start_date, end_date')
    .eq('vendor_id', vendorId)
    .eq('status', 'ACTIVE')
    .order('end_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(error.message || 'Failed to validate subscription');
  }

  const active = (rows || []).find((row) => !row?.end_date || String(row.end_date) > nowIso);
  return active || null;
}

async function fetchVendorPlanForPricing(planId) {
  if (!planId) return null;

  const full = await db
    .from('vendor_plans')
    .select('id, name, price, features')
    .eq('id', planId)
    .maybeSingle();

  if (!full?.error) return full?.data || null;
  if (!isMissingPlanFeaturesColumn(full.error)) {
    logger.warn('Failed to fetch vendor plan pricing meta:', full.error?.message || full.error);
    return null;
  }

  const fallback = await db
    .from('vendor_plans')
    .select('id, name, price')
    .eq('id', planId)
    .maybeSingle();

  if (fallback?.error) {
    logger.warn('Failed to fetch vendor plan fallback pricing meta:', fallback.error?.message || fallback.error);
    return null;
  }
  return fallback?.data || null;
}

async function resolveVendorForAuthUser(user = {}) {
  const userId = normalizeText(user?.id);
  const email = normalizeEmail(user?.email);

  if (userId) {
    const { data: byUserId, error: byUserErr } = await db
      .from('vendors')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (!byUserErr && byUserId) return byUserId;
  }

  if (email) {
    const { data: byEmail, error: byEmailErr } = await db
      .from('vendors')
      .select('*')
      .ilike('email', email)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!byEmailErr && byEmail) return byEmail;
  }

  return null;
}

async function resolveOfferForPayment({
  couponCode = '',
  vendor = null,
  plan = null,
  baseAmount = 0,
  strictCoupon = false,
}) {
  const amount = Number(baseAmount || plan?.price || 0);
  const normalizedCode = normalizeCouponCode(couponCode);
  const hasProvidedCode = Boolean(normalizedCode);
  const fallback = {
    discountAmount: 0,
    netAmount: amount,
    coupon: null,
    offerType: null,
    offerCode: null,
    referralId: null,
    error: null,
  };

  if (!Number.isFinite(amount) || amount <= 0) {
    return fallback;
  }

  let couponFailureMessage = 'Coupon not found or inactive';

  if (hasProvidedCode) {
    const { data: cpn, error: couponErr } = await db
      .from('vendor_plan_coupons')
      .select('*')
      .ilike('code', normalizedCode)
      .eq('is_active', true)
      .maybeSingle();

    if (cpn && !couponErr) {
      const expiresAtMs = getCouponExpiresAtMs(cpn);
      if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
        couponFailureMessage = 'Coupon expired';
      } else if (cpn.max_uses && cpn.max_uses > 0 && cpn.used_count >= cpn.max_uses) {
        couponFailureMessage = 'Coupon usage limit reached';
      } else if (!isCouponVendorApplicable(cpn.vendor_id, vendor)) {
        couponFailureMessage = 'Coupon not valid for this vendor';
      } else if (!isCouponPlanApplicable(cpn.plan_id, plan)) {
        couponFailureMessage = 'Coupon not valid for this plan';
      } else {
        let discountAmount = 0;
        const discountType = String(cpn.discount_type || '').trim().toUpperCase();
        if (discountType === 'PERCENT') {
          discountAmount = (amount * Number(cpn.value)) / 100;
        } else {
          discountAmount = Number(cpn.value || 0);
        }
        if (!Number.isFinite(discountAmount)) discountAmount = 0;
        discountAmount = Math.max(0, Math.min(discountAmount, amount));

        return {
          discountAmount,
          netAmount: Math.max(0, amount - discountAmount),
          coupon: cpn,
          offerType: 'COUPON',
          offerCode: normalizedCode,
          referralId: null,
          error: null,
        };
      }
    } else if (couponErr) {
      couponFailureMessage = 'Coupon not found or inactive';
    }
  }

  try {
    const referralOffer = await getReferralOfferForVendor({
      vendor,
      plan,
      at: new Date(),
    }, db);

    const requestedReferralCode = normalizeReferralCode(normalizedCode);
    const offerCode = normalizeReferralCode(referralOffer?.offer_code || '');
    const discountAmountRaw = Number(referralOffer?.discount_amount || 0);
    const discountAmount = Number.isFinite(discountAmountRaw)
      ? Math.max(0, Math.min(discountAmountRaw, amount))
      : 0;
    const referralMatchesCode = !hasProvidedCode || (requestedReferralCode && offerCode === requestedReferralCode);

    if (offerCode && discountAmount > 0 && referralMatchesCode) {
      return {
        discountAmount,
        netAmount: Math.max(0, amount - discountAmount),
        coupon: null,
        offerType: 'REFERRAL',
        offerCode: referralOffer?.offer_code || offerCode,
        referralId: referralOffer?.referral_id || null,
        error: null,
      };
    }
  } catch (referralError) {
    logger.warn('[payment] referral offer lookup failed:', referralError?.message || referralError);
  }

  if (strictCoupon && hasProvidedCode) {
    return {
      ...fallback,
      error: couponFailureMessage,
    };
  }

  return fallback;
}

async function activateCouponCoveredSubscription({
  req,
  vendor,
  plan,
  vendor_id,
  plan_id,
  billingQuote,
  discountAmount = 0,
  netAmount = 0,
  coupon = null,
  offerType = null,
  offerCode = null,
  referralId = null,
  salesAttribution = {},
}) {
  const invoiceNumber = generateInvoiceNumber();
  const startDate = new Date();
  const endDate = new Date(startDate);
  const durationDays = billingQuote.duration_days || 365;
  endDate.setDate(endDate.getDate() + durationDays);

  await db
    .from('vendor_plan_subscriptions')
    .update({ status: 'INACTIVE' })
    .eq('vendor_id', vendor_id)
    .eq('status', 'ACTIVE');

  const { data: subscription, error: subscriptionError } = await db
    .from('vendor_plan_subscriptions')
    .insert([
      {
        vendor_id,
        plan_id,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        status: 'ACTIVE',
        plan_duration_days: durationDays,
        billing_cycle: billingQuote.billing_cycle,
        sales_code: salesAttribution.salesCode || null,
        sales_user_id: salesAttribution.salesUserId || null,
      },
    ])
    .select()
    .single();

  if (subscriptionError || !subscription?.id) {
    logger.error('Coupon subscription creation error:', subscriptionError);
    const error = new Error('Failed to activate coupon subscription');
    error.statusCode = 500;
    throw error;
  }

  const quotaPayload = {
    vendor_id,
    plan_id,
    daily_used: 0,
    daily_limit: Math.max(0, Number(plan?.daily_limit || 0)),
    weekly_used: 0,
    weekly_limit: Math.max(0, Number(plan?.weekly_limit || 0)),
    yearly_used: 0,
    yearly_limit: 0,
    last_reset_date: startDate.toISOString(),
    updated_at: startDate.toISOString(),
  };

  const { data: existingQuota } = await db
    .from('vendor_lead_quota')
    .select('id')
    .eq('vendor_id', vendor_id)
    .maybeSingle();

  if (existingQuota?.id) {
    await db
      .from('vendor_lead_quota')
      .update(quotaPayload)
      .eq('vendor_id', vendor_id);
  } else {
    await db.from('vendor_lead_quota').insert([quotaPayload]);
  }

  const transactionId = `COUPON-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const invoicePdfData = {
    invoiceNumber,
    invoiceDate: new Date(),
    dueDate: new Date(),
    vendor,
    plan,
    amount: billingQuote.amount,
    discount_amount: discountAmount,
    coupon_code: offerCode || null,
    tax: 0,
    totalAmount: netAmount,
    paymentMethod: 'Coupon',
    transactionId,
  };

  const invoicePdf = generateInvoicePDF(invoicePdfData);
  const { data: payment, error: paymentError } = await db
    .from('vendor_payments')
    .insert([
      {
        vendor_id,
        plan_id,
        subscription_id: subscription.id,
        amount: billingQuote.amount,
        discount_amount: discountAmount,
        net_amount: netAmount,
        description: `${billingQuote.label} subscription: ${plan.name}`,
        status: 'COMPLETED',
        payment_method: 'Coupon',
        transaction_id: transactionId,
        payment_date: new Date(),
        invoice_url: invoicePdf,
        billing_cycle: billingQuote.billing_cycle,
        plan_duration_days: durationDays,
        coupon_code: offerCode || null,
        offer_type: offerType,
        offer_code: offerCode || null,
        referral_id: referralId,
        sales_code: salesAttribution.salesCode || null,
        sales_user_id: salesAttribution.salesUserId || null,
      },
    ])
    .select()
    .single();

  if (paymentError) {
    logger.error('Coupon payment record error:', paymentError);
  } else if (coupon) {
    await db
      .from('vendor_plan_coupons')
      .update({ used_count: (Number(coupon.used_count || 0) || 0) + 1 })
      .eq('id', coupon.id);
    await db.from('vendor_coupon_usages').insert([
      {
        coupon_id: coupon.id,
        payment_id: payment?.id || null,
        vendor_id,
        plan_id,
        discount_amount: discountAmount,
        net_amount: netAmount,
      },
    ]);
  }

  if (!paymentError && payment && offerType === 'REFERRAL') {
    try {
      await applyReferralRewardAfterPayment(
        {
          referredVendorId: vendor_id,
          plan,
          paymentRow: payment,
          netAmount,
        },
        db
      );
    } catch (referralRewardError) {
      logger.warn('[payment] referral reward application failed:', referralRewardError?.message || referralRewardError);
    }
  }

  if (!paymentError && payment) {
    const vendorActor = {
      id: vendor.user_id || vendor_id,
      type: 'VENDOR',
      role: 'VENDOR',
      email: vendor.email || null,
    };

    await writeAuditLog({
      req,
      actor: vendorActor,
      action: 'PAYMENT_COMPLETED',
      entityType: 'vendor_payments',
      entityId: payment.id,
      details: {
        vendor_id,
        plan_id,
        subscription_id: subscription.id,
        transaction_id: transactionId,
        billing_cycle: billingQuote.billing_cycle,
        plan_duration_days: durationDays,
        amount: billingQuote.amount,
        discount_amount: discountAmount,
        net_amount: netAmount,
        coupon_code: offerCode || null,
        offer_type: offerType,
        offer_code: offerCode || null,
        referral_id: referralId || null,
      },
    });
  }

  try {
    if (vendor.email) {
      const invoiceSummary = generateInvoiceSummary(invoicePdfData);
      await sendEmail({
        to: vendor.email,
        subject: `Invoice ${invoiceNumber} - Subscription Activated`,
        html: `
          <h2>Subscription Confirmation</h2>
          <p>Dear ${vendor.company_name},</p>
          <p>Your ${billingQuote.label.toLowerCase()} subscription has been activated using coupon ${offerCode || ''}.</p>
          ${invoiceSummary}
          <p><strong>Subscription Period:</strong> ${new Date().toLocaleDateString('en-IN')} to ${endDate.toLocaleDateString('en-IN')}</p>
          <p>Thank you for choosing Indian Trade Mart!</p>
        `,
        text: `Subscription Confirmation\n\nDear ${vendor.company_name},\n\nYour ${billingQuote.label.toLowerCase()} subscription has been activated using coupon ${offerCode || ''}.\n\nSubscription Period: ${new Date().toLocaleDateString('en-IN')} to ${endDate.toLocaleDateString('en-IN')}\n\nThank you for choosing Indian Trade Mart!`,
        purpose: 'billing',
        attachments: [
          {
            filename: `${invoiceNumber}.pdf`,
            content: invoicePdf.split(',')[1],
            encoding: 'base64',
          },
        ],
      });
    }
  } catch (emailError) {
    logger.error('Coupon activation email error:', emailError);
  }

  try {
    await sendSubscriptionActivatedNotification(vendor_id, plan.name, endDate);
  } catch (notifError) {
    logger.error('Coupon activation notification error:', notifError);
  }

  return { subscription, payment: payment || null, invoiceNumber, endDate, transactionId };
}

/**
 * POST /api/payment/initiate
 * Initiate a Razorpay payment order for subscription
 */
router.post('/initiate', async (req, res) => {
  try {
    const { vendor_id, plan_id } = req.body;
    const requestedBillingCycle = normalizeBillingCycle(req.body?.billing_cycle);
    const coupon_code = normalizeCouponCode(req.body?.coupon_code);
    const salesAttribution = await resolveSalesAttribution(req.body?.sales_code || req.query?.sales_code);

    if (!vendor_id || !plan_id) {
      return res.status(400).json({ error: 'Missing vendor_id or plan_id' });
    }

    // Fetch vendor details
    const { data: vendor, error: vendorError } = await db
      .from('vendors')
      .select('*')
      .eq('id', vendor_id)
      .single();

    if (vendorError || !vendor) {
      logger.error('Vendor not found:', vendor_id, vendorError);
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // Fetch plan details
    const { data: plan, error: planError } = await db
      .from('vendor_plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (planError || !plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    if (!isDirectPurchasePlan(plan)) {
      return res.status(400).json({
        error: 'This plan is sales-assisted. Please contact the sales team to activate it.',
      });
    }

    let billingQuote;
    try {
      billingQuote = resolvePlanBillingQuote(plan, requestedBillingCycle);
    } catch (quoteError) {
      return res.status(400).json({ error: quoteError.message || 'Invalid billing cycle' });
    }

    const baseAmount = Number(billingQuote.amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
      return res.status(400).json({ error: 'Invalid plan price' });
    }

    const planCurrency = getPlanCurrency(plan);
    if (planCurrency !== 'INR') {
      return res.status(400).json({
        error: `Online checkout is currently configured for INR plans only. This plan is priced in ${planCurrency}.`,
      });
    }

    const offer = await resolveOfferForPayment({
      couponCode: coupon_code,
      vendor,
      plan,
      baseAmount,
      strictCoupon: true,
    });
    if (offer?.error) {
      return res.status(400).json({ error: offer.error });
    }

    const discountAmount = Number(offer?.discountAmount || 0);
    const netAmount = Number(offer?.netAmount ?? baseAmount);
    const offerType = offer?.offerType || null;
    const offerCode = offer?.offerCode || (coupon_code || null);
    const referralId = offer?.referralId || null;

    if (netAmount <= 0) {
      const activation = await activateCouponCoveredSubscription({
        req,
        vendor,
        plan,
        vendor_id,
        plan_id,
        billingQuote,
        discountAmount,
        netAmount: 0,
        coupon: offer?.coupon || null,
        offerType,
        offerCode,
        referralId,
        salesAttribution,
      });

      return res.json({
        success: true,
        activated: true,
        message: 'Coupon applied. Subscription activated without payment.',
        key_id: process.env.RAZORPAY_KEY_ID,
        subscription: activation.subscription,
        payment: activation.payment,
        order: {
          id: activation.transactionId,
          amount: 0,
          currency: 'INR',
          vendor_id,
          plan_id,
          plan_name: plan.name,
          billing_cycle: billingQuote.billing_cycle,
          billing_label: billingQuote.label,
          plan_duration_days: billingQuote.duration_days,
          vendor_email: vendor.email,
          net_amount: 0,
          base_amount: baseAmount,
          discount_amount: discountAmount,
          coupon_code: offerCode || null,
          offer_type: offerType,
          referral_id: referralId,
          sales_code: salesAttribution.salesCode || null,
          sales_user_id: salesAttribution.salesUserId || null,
          sales_code_valid: Boolean(salesAttribution.salesUserId),
          activated_without_payment: true,
        },
      });
    }

    // Check if Razorpay keys are configured only when there is an online amount to collect.
    if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.includes('your_razorpay')) {
      logger.error('Razorpay KEY_ID not configured');
      return res.status(500).json({ error: 'Payment gateway not configured. Please add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env.local' });
    }

    const amount = Math.max(1, Math.round(netAmount * 100)); // paise, min 1 to keep Razorpay happy

    // Create Razorpay order
    // Receipt must be max 40 characters - use hash of vendor_id + timestamp
    const shortId = `${vendor_id.substring(0, 8)}_${Math.random().toString(36).substring(2, 8)}`;
    const options = {
      amount,
      currency: 'INR',
      receipt: shortId,
      payment_capture: 1,
      notes: {
        vendor_id,
        plan_id,
        vendor_email: vendor.email,
        vendor_name: vendor.company_name,
        billing_cycle: billingQuote.billing_cycle,
        plan_duration_days: String(billingQuote.duration_days || ''),
        coupon_code: offerCode || '',
        sales_code: salesAttribution.salesCode || '',
      },
    };

    const order = await razorpayInstance.orders.create(options);

    res.json({
      success: true,
      key_id: process.env.RAZORPAY_KEY_ID,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        vendor_id,
        plan_id,
        plan_name: plan.name,
        billing_cycle: billingQuote.billing_cycle,
        billing_label: billingQuote.label,
        plan_duration_days: billingQuote.duration_days,
        vendor_email: vendor.email,
        net_amount: netAmount,
        base_amount: baseAmount,
        discount_amount: discountAmount,
        coupon_code: offerCode || null,
        offer_type: offerType,
        referral_id: referralId,
        sales_code: salesAttribution.salesCode || null,
        sales_user_id: salesAttribution.salesUserId || null,
        sales_code_valid: Boolean(salesAttribution.salesUserId),
      },
    });
  } catch (error) {
    logger.error('Payment initiation error:', error);
    res.status(500).json({ error: error.message || 'Failed to initiate payment' });
  }
});

/**
 * POST /api/payment/verify
 * Verify Razorpay payment and create subscription
 */
router.post('/verify', async (req, res) => {
  try {
    const { order_id, payment_id, signature, vendor_id, plan_id } = req.body;
    const requestedBillingCycle = normalizeBillingCycle(req.body?.billing_cycle);
    const coupon_code = normalizeCouponCode(req.body?.coupon_code);
    const salesAttribution = await resolveSalesAttribution(req.body?.sales_code || req.query?.sales_code);

    if (!order_id || !payment_id || !signature || !vendor_id || !plan_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify payment signature
    const body = order_id + '|' + payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Fetch vendor and plan
    const { data: vendor } = await db
      .from('vendors')
      .select('*')
      .eq('id', vendor_id)
      .single();

    const { data: plan } = await db
      .from('vendor_plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (!vendor || !plan) {
      return res.status(404).json({ error: 'Vendor or plan not found' });
    }

    if (!isDirectPurchasePlan(plan)) {
      return res.status(400).json({
        error: 'This plan is sales-assisted and cannot be activated through self-serve checkout.',
      });
    }

    let orderDetails = null;
    try {
      orderDetails = await razorpayInstance.orders.fetch(order_id);
    } catch (orderFetchError) {
      logger.warn('[payment] Razorpay order fetch failed:', orderFetchError?.message || orderFetchError);
    }

    const orderBillingCycle = normalizeBillingCycle(orderDetails?.notes?.billing_cycle || requestedBillingCycle);
    let billingQuote;
    try {
      billingQuote = resolvePlanBillingQuote(plan, orderBillingCycle);
    } catch (quoteError) {
      return res.status(400).json({ error: quoteError.message || 'Invalid billing cycle' });
    }

    // Coupon re-validation
    const offer = await resolveOfferForPayment({
      couponCode: coupon_code,
      vendor,
      plan,
      baseAmount: Number(billingQuote.amount || 0),
      strictCoupon: false,
    });
    const discountAmount = Number(offer?.discountAmount || 0);
    const netAmount = Number(offer?.netAmount ?? Number(billingQuote.amount || 0));
    const coupon = offer?.coupon || null;
    const offerType = offer?.offerType || null;
    const offerCode = offer?.offerCode || (coupon_code || null);
    const referralId = offer?.referralId || null;

    if (orderDetails?.amount !== undefined && orderDetails?.amount !== null) {
      const expectedAmount = Math.max(1, Math.round(netAmount * 100));
      if (Number(orderDetails.amount) !== expectedAmount) {
        logger.warn('[payment] order amount mismatch', {
          order_id,
          expectedAmount,
          receivedAmount: orderDetails.amount,
          billing_cycle: billingQuote.billing_cycle,
        });
        return res.status(400).json({ error: 'Payment amount mismatch. Please restart checkout.' });
      }
    }

    const invoiceNumber = generateInvoiceNumber();

    // Create subscription
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + (billingQuote.duration_days || 365));

    await db
      .from('vendor_plan_subscriptions')
      .update({ status: 'INACTIVE' })
      .eq('vendor_id', vendor_id)
      .eq('status', 'ACTIVE');

    const { data: subscription, error: subscriptionError } = await db
      .from('vendor_plan_subscriptions')
      .insert([
        {
          vendor_id,
          plan_id,
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
          status: 'ACTIVE',
          plan_duration_days: billingQuote.duration_days || 365,
          billing_cycle: billingQuote.billing_cycle,
          sales_code: salesAttribution.salesCode || null,
          sales_user_id: salesAttribution.salesUserId || null,
        },
      ])
      .select()
      .single();

    if (subscriptionError) {
      logger.error('Subscription creation error:', subscriptionError);
      return res.status(500).json({ error: 'Failed to create subscription' });
    }

    const quotaPayload = {
      vendor_id,
      plan_id,
      daily_used: 0,
      daily_limit: Math.max(0, Number(plan?.daily_limit || 0)),
      weekly_used: 0,
      weekly_limit: Math.max(0, Number(plan?.weekly_limit || 0)),
      yearly_used: 0,
      yearly_limit: 0,
      last_reset_date: startDate.toISOString(),
      updated_at: startDate.toISOString(),
    };

    const { data: existingQuota } = await db
      .from('vendor_lead_quota')
      .select('id')
      .eq('vendor_id', vendor_id)
      .maybeSingle();

    if (existingQuota?.id) {
      await db
        .from('vendor_lead_quota')
        .update(quotaPayload)
        .eq('vendor_id', vendor_id);
    } else {
      await db
        .from('vendor_lead_quota')
        .insert([quotaPayload]);
    }

    // Record payment
    const invoicePdfData = {
      invoiceNumber,
      invoiceDate: new Date(),
      dueDate: new Date(),
      vendor,
      plan,
      amount: billingQuote.amount,
      discount_amount: discountAmount,
      coupon_code: offerCode || null,
      tax: 0,
      totalAmount: netAmount,
      paymentMethod: 'Razorpay',
      transactionId: payment_id,
    };

    const invoicePdf = generateInvoicePDF(invoicePdfData);

    const { data: payment, error: paymentError } = await db
      .from('vendor_payments')
      .insert([
        {
          vendor_id,
          plan_id,
          subscription_id: subscription.id,
          amount: billingQuote.amount,
          discount_amount: discountAmount,
          net_amount: netAmount,
          description: `${billingQuote.label} subscription: ${plan.name}`,
          status: 'COMPLETED',
          payment_method: 'Razorpay',
          transaction_id: payment_id,
          payment_date: new Date(),
          invoice_url: invoicePdf,
          billing_cycle: billingQuote.billing_cycle,
          plan_duration_days: billingQuote.duration_days || 365,
          coupon_code: offerCode || null,
          offer_type: offerType,
          offer_code: offerCode || null,
          referral_id: referralId,
          sales_code: salesAttribution.salesCode || null,
          sales_user_id: salesAttribution.salesUserId || null,
        },
      ])
      .select()
      .single();

    if (paymentError) {
      logger.error('Payment record error:', paymentError);
    } else if (coupon) {
      await db
        .from('vendor_plan_coupons')
        .update({ used_count: (coupon.used_count || 0) + 1 })
        .eq('id', coupon.id);
      await db.from('vendor_coupon_usages').insert([
        {
          coupon_id: coupon.id,
          payment_id: payment?.id || null,
          vendor_id,
          plan_id,
          discount_amount: discountAmount,
          net_amount: netAmount,
        },
      ]);
    }

    if (!paymentError && payment && offerType === 'REFERRAL') {
      try {
        await applyReferralRewardAfterPayment(
          {
            referredVendorId: vendor_id,
            plan,
            paymentRow: payment,
            netAmount,
          },
          db
        );
      } catch (referralRewardError) {
        logger.warn(
          '[payment] referral reward application failed:',
          referralRewardError?.message || referralRewardError
        );
      }
    }

    if (!paymentError && payment) {
      if (salesAttribution.salesUserId) {
        try {
          const { data: engagement } = await db
            .from('sales_vendor_engagements')
            .insert([
              {
                vendor_id,
                sales_user_id: salesAttribution.salesUserId,
                plan_id,
                sales_code: salesAttribution.salesCode,
                engagement_type: 'CONVERTED',
                status: 'CLOSED',
                notes: `Vendor purchased ${billingQuote.label} ${plan.name} via sales code ${salesAttribution.salesCode}`,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ])
            .select('id')
            .maybeSingle();

          if (engagement?.id) {
            await db
              .from('vendor_payments')
              .update({ sales_engagement_id: engagement.id })
              .eq('id', payment.id);
          }
        } catch (salesAttributionError) {
          logger.warn('[payment] sales attribution engagement failed:', salesAttributionError?.message || salesAttributionError);
        }
      }

      const vendorActor = {
        id: vendor.user_id || vendor_id,
        type: 'VENDOR',
        role: 'VENDOR',
        email: vendor.email || null,
      };

      await writeAuditLog({
        req,
        actor: vendorActor,
        action: 'PAYMENT_COMPLETED',
        entityType: 'vendor_payments',
        entityId: payment.id,
        details: {
          vendor_id,
          plan_id,
          subscription_id: subscription.id,
          transaction_id: payment_id,
          billing_cycle: billingQuote.billing_cycle,
          plan_duration_days: billingQuote.duration_days || 365,
          amount: billingQuote.amount,
          discount_amount: discountAmount,
          net_amount: netAmount,
          coupon_code: offerCode || null,
          offer_type: offerType,
          offer_code: offerCode || null,
          referral_id: referralId || null,
        },
      });
    }

    // Send email with invoice
    try {
      if (vendor.email) {
        const invoiceSummary = generateInvoiceSummary(invoicePdfData);
        await sendEmail({
          to: vendor.email,
          subject: `Invoice ${invoiceNumber} - Subscription Purchase`,
          html: `
            <h2>Subscription Confirmation</h2>
            <p>Dear ${vendor.company_name},</p>
            <p>Your ${billingQuote.label.toLowerCase()} subscription has been successfully activated.</p>
            ${invoiceSummary}
            <p><strong>Subscription Period:</strong> ${new Date().toLocaleDateString('en-IN')} to ${endDate.toLocaleDateString('en-IN')}</p>
            <p>Thank you for choosing Indian Trade Mart!</p>
          `,
          text: `Subscription Confirmation\n\nDear ${vendor.company_name},\n\nYour ${billingQuote.label.toLowerCase()} subscription has been successfully activated.\n\nSubscription Period: ${new Date().toLocaleDateString('en-IN')} to ${endDate.toLocaleDateString('en-IN')}\n\nThank you for choosing Indian Trade Mart!`,
          purpose: 'billing',
          attachments: [
            {
              filename: `${invoiceNumber}.pdf`,
              content: invoicePdf.split(',')[1],
              encoding: 'base64',
            },
          ],
        });
      }
    } catch (emailError) {
      logger.error('Email sending error:', emailError);
    }

    try {
      await sendSubscriptionActivatedNotification(vendor_id, plan.name, endDate);
    } catch (notifError) {
      logger.error('Subscription notification error:', notifError);
    }

    res.json({
      success: true,
      message: 'Payment verified and subscription activated',
      billing_cycle: billingQuote.billing_cycle,
      subscription,
      payment,
    });
  } catch (error) {
    logger.error('Payment verification error:', error);
    res.status(500).json({ error: error.message || 'Payment verification failed' });
  }
});

/**
 * POST /api/payment/lead/initiate
 * Initiate Razorpay payment order for marketplace lead purchase.
 */
router.post('/lead/initiate', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const leadId = normalizeText(req.body?.lead_id);

    if (!leadId) {
      return res.status(400).json({ error: 'Missing lead_id' });
    }

    if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.includes('your_razorpay')) {
      return res.status(500).json({ error: 'Payment gateway not configured' });
    }

    const vendor = await resolveVendorForAuthUser(req.user);
    if (!vendor?.id) {
      return res.status(404).json({ error: 'Vendor profile not found' });
    }

    const activeSubscription = await getActiveVendorSubscription(vendor.id);
    if (!activeSubscription) {
      return res.status(403).json({ error: 'No active subscription plan' });
    }
    const activePlan = await fetchVendorPlanForPricing(activeSubscription?.plan_id);

    const { data: lead, error: leadError } = await db
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .maybeSingle();

    if (leadError) {
      return res.status(500).json({ error: leadError.message || 'Failed to fetch lead' });
    }
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const leadStatus = normalizeText(lead?.status).toUpperCase();
    if (leadStatus && !['AVAILABLE', 'PURCHASED'].includes(leadStatus)) {
      return res.status(409).json({ error: 'Lead no longer available' });
    }

    if (normalizeText(lead?.vendor_id) && normalizeText(lead?.vendor_id) !== normalizeText(vendor.id)) {
      return res.status(409).json({ error: 'This lead is not purchasable' });
    }

    const { data: existingPurchaseRows, error: existingPurchaseError } = await db
      .from('lead_purchases')
      .select('id')
      .eq('vendor_id', vendor.id)
      .eq('lead_id', leadId)
      .order('purchase_date', { ascending: false })
      .limit(1);

    if (existingPurchaseError) {
      return res.status(500).json({ error: existingPurchaseError.message || 'Failed to validate purchase' });
    }

    if (Array.isArray(existingPurchaseRows) && existingPurchaseRows.length > 0) {
      return res.status(409).json({ error: 'You already purchased this lead' });
    }

    const { count: purchaseCount, error: purchaseCountError } = await db
      .from('lead_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId);

    if (purchaseCountError) {
      return res.status(500).json({ error: purchaseCountError.message || 'Failed to validate lead capacity' });
    }
    if ((purchaseCount || 0) >= 5) {
      return res.status(409).json({ error: 'This lead has reached maximum 5 vendors limit' });
    }

    const leadPrice = resolvePaidLeadPrice(lead, activePlan);
    if (leadPrice <= 0) {
      return res.status(400).json({ error: 'Invalid lead price for online payment' });
    }

    const amountPaise = Math.max(1, Math.round(leadPrice * 100));
    const shortLeadId = String(leadId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'lead';
    const shortVendorId = String(vendor.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'vendor';
    const receipt = `ld_${shortLeadId}_${shortVendorId}_${Date.now().toString().slice(-6)}`.slice(0, 40);

    const order = await razorpayInstance.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      payment_capture: 1,
        notes: {
          lead_id: leadId,
          vendor_id: vendor.id,
          plan_id: activeSubscription?.plan_id || '',
          vendor_email: vendor.email || '',
        },
      });

    return res.json({
      success: true,
      key_id: process.env.RAZORPAY_KEY_ID,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        lead_id: leadId,
        vendor_id: vendor.id,
        vendor_email: vendor.email || '',
        lead_title: lead?.title || lead?.product_name || 'Lead Purchase',
        lead_price: leadPrice,
        lead_price_source: getPlanExtraLeadPrice(activePlan) > 0 ? 'PLAN_EXTRA_LEAD_PRICE' : 'LEAD_PRICE',
      },
    });
  } catch (error) {
    logger.error('Lead payment initiation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to initiate lead payment' });
  }
});

/**
 * POST /api/payment/lead/verify
 * Verify Razorpay payment and unlock/purchase lead.
 */
router.post('/lead/verify', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const orderId = normalizeText(req.body?.order_id);
    const paymentId = normalizeText(req.body?.payment_id);
    const signature = normalizeText(req.body?.signature);
    const leadId = normalizeText(req.body?.lead_id);

    if (!orderId || !paymentId || !signature || !leadId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const vendor = await resolveVendorForAuthUser(req.user);
    if (!vendor?.id) {
      return res.status(404).json({ error: 'Vendor profile not found' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const { data: lead, error: leadError } = await db
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .maybeSingle();

    if (leadError) {
      return res.status(500).json({ error: leadError.message || 'Failed to fetch lead' });
    }
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const leadStatus = normalizeText(lead?.status).toUpperCase();
    if (leadStatus && !['AVAILABLE', 'PURCHASED'].includes(leadStatus)) {
      return res.status(409).json({ error: 'Lead no longer available' });
    }

    let purchaseAmount = parseCurrencyAmount(lead?.price, 50);
    try {
      const activeSubscription = await getActiveVendorSubscription(vendor.id);
      const activePlan = await fetchVendorPlanForPricing(activeSubscription?.plan_id);
      purchaseAmount = resolvePaidLeadPrice(lead, activePlan);
    } catch (priceResolveError) {
      logger.warn('Failed to resolve paid lead price from plan:', priceResolveError?.message || priceResolveError);
    }
    const consumeResult = await consumeLeadForVendor({
      vendorId: vendor.id,
      leadId,
      mode: 'BUY_EXTRA',
      purchasePrice: purchaseAmount,
    });

    if (!consumeResult.success) {
      return res.status(consumeResult.statusCode).json({
        success: false,
        code: consumeResult.code,
        error: consumeResult.error,
        ...(consumeResult.payload || {}),
      });
    }

    const consumePayload = consumeResult.payload || {};
    const purchaseRow =
      consumePayload?.purchase && typeof consumePayload.purchase === 'object'
        ? consumePayload.purchase
        : null;
    const wasExistingPurchase = Boolean(consumePayload?.existing_purchase);
    const purchaseDatetime =
      purchaseRow?.purchase_datetime ||
      purchaseRow?.purchase_date ||
      consumePayload?.purchase_datetime ||
      new Date().toISOString();

    try {
      await writeAuditLog({
        req,
        actor: {
          id: vendor.user_id || vendor.id,
          type: 'VENDOR',
          role: 'VENDOR',
          email: vendor.email || null,
        },
        action: 'LEAD_PAYMENT_COMPLETED',
        entityType: 'lead_purchases',
        entityId: purchaseRow?.id || null,
        details: {
          lead_id: leadId,
          amount: purchaseAmount,
          transaction_id: paymentId,
          order_id: orderId,
        },
      });
    } catch (auditErr) {
      logger.warn('Lead purchase audit log failed:', auditErr?.message || auditErr);
    }

    try {
      if (!wasExistingPurchase && purchaseRow?.id) {
        const { error: historyError } = await db.from('lead_status_history').insert([
          {
            lead_id: leadId,
            vendor_id: vendor.id,
            lead_purchase_id: purchaseRow.id,
            status: 'ACTIVE',
            note: 'Lead purchased via paid extra',
            source: 'PURCHASE',
            created_by: req.user?.id || null,
            created_at: purchaseDatetime,
          },
        ]);
        if (historyError && !isMissingRelationError(historyError, 'lead_status_history')) {
          logger.warn('Paid lead purchase history insert failed:', historyError?.message || historyError);
        }
      }
    } catch (historyInsertError) {
      logger.warn('Paid lead purchase history insert failed:', historyInsertError?.message || historyInsertError);
    }

    return res.json({
      success: true,
      message: wasExistingPurchase ? 'Lead already purchased' : 'Payment verified and lead unlocked',
      existing_purchase: wasExistingPurchase,
      consumption_type:
        consumePayload?.consumption_type ||
        purchaseRow?.consumption_type ||
        'PAID_EXTRA',
      remaining: consumePayload?.remaining || { daily: 0, weekly: 0, yearly: 0 },
      moved_to_my_leads: true,
      purchase_datetime: purchaseDatetime,
      plan_name:
        consumePayload?.plan_name ||
        consumePayload?.subscription_plan_name ||
        purchaseRow?.subscription_plan_name ||
        null,
      subscription_plan_name:
        consumePayload?.subscription_plan_name ||
        consumePayload?.plan_name ||
        purchaseRow?.subscription_plan_name ||
        null,
      lead_status: consumePayload?.lead_status || purchaseRow?.lead_status || 'ACTIVE',
      purchase: purchaseRow,
    });
  } catch (error) {
    logger.error('Lead payment verification error:', error);
    return res.status(500).json({ error: error.message || 'Payment verification failed' });
  }
});

/**
 * GET /api/payment/history/:vendor_id
 * Get payment history for a vendor
 */
router.get('/history/:vendor_id', async (req, res) => {
  try {
    const { vendor_id } = req.params;

    if (!vendor_id) {
      return res.status(400).json({ error: 'Missing vendor_id' });
    }

    const { data: payments, error } = await db
      .from('vendor_payments')
      .select('*')
      .eq('vendor_id', vendor_id)
      .order('payment_date', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await writeAuditLog({
      req,
      actor: { id: vendor_id, type: 'VENDOR', role: 'VENDOR', email: null },
      action: 'PAYMENT_HISTORY_VIEWED',
      entityType: 'vendor_payments',
      details: { vendor_id, count: payments?.length || 0 },
    });

    res.json({ success: true, data: payments || [] });
  } catch (error) {
    logger.error('Payment history error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/payment/invoice/:payment_id
 * Download invoice PDF
 * If `refresh=true` query param is provided, regenerate the invoice using latest template/data.
 */
router.get('/invoice/:payment_id', async (req, res) => {
  try {
    const { payment_id } = req.params;
    const refresh = (req.query.refresh || '').toString().toLowerCase() === 'true';

    if (!payment_id) {
      return res.status(400).json({ error: 'Missing payment_id' });
    }

    const { data: payment, error } = await db
      .from('vendor_payments')
      .select('*')
      .eq('id', payment_id)
      .single();

    if (error || !payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // If refresh requested or invoice missing, regenerate with latest template
    if (refresh || !payment.invoice_url) {
      const [{ data: vendor }, { data: plan }] = await Promise.all([
        db.from('vendors').select('*').eq('id', payment.vendor_id).single(),
        db.from('vendor_plans').select('*').eq('id', payment.plan_id).single(),
      ]);

      const invoicePdfData = {
        invoiceNumber: payment.invoice_number || generateInvoiceNumber(),
        invoiceDate: payment.payment_date || new Date(),
        dueDate: payment.payment_date || new Date(),
        vendor,
        plan,
        amount: payment.amount,
        discount_amount: payment.discount_amount || 0,
        coupon_code: payment.coupon_code || '',
        tax: payment.tax_amount || 0,
        totalAmount: payment.net_amount || payment.amount,
        paymentMethod: payment.payment_method || 'Razorpay',
        transactionId: payment.transaction_id,
      };

      const newPdf = generateInvoicePDF(invoicePdfData);

      await db
        .from('vendor_payments')
        .update({
          invoice_url: newPdf,
          invoice_number: invoicePdfData.invoiceNumber,
        })
        .eq('id', payment_id);

      payment.invoice_url = newPdf;
    }

    await writeAuditLog({
      req,
      actor: { id: payment.vendor_id || null, type: 'VENDOR', role: 'VENDOR', email: null },
      action: refresh ? 'INVOICE_REFRESHED' : 'INVOICE_VIEWED',
      entityType: 'vendor_payments',
      entityId: payment_id,
      details: { refresh, vendor_id: payment.vendor_id },
    });

    res.json({
      success: true,
      invoice: payment.invoice_url,
    });
  } catch (error) {
    logger.error('Invoice retrieval error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/payment/invoice/by-tx/:transaction_id
 * Regenerate or fetch invoice using Razorpay transaction/payment_id
 */
router.get('/invoice/by-tx/:transaction_id', async (req, res) => {
  try {
    const { transaction_id } = req.params;
    const refresh = (req.query.refresh || '').toString().toLowerCase() === 'true';

    if (!transaction_id) {
      return res.status(400).json({ error: 'Missing transaction_id' });
    }

    const { data: payment, error } = await db
      .from('vendor_payments')
      .select('*')
      .eq('transaction_id', transaction_id)
      .maybeSingle();

    if (error || !payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (refresh || !payment.invoice_url) {
      const [{ data: vendor }, { data: plan }] = await Promise.all([
        db.from('vendors').select('*').eq('id', payment.vendor_id).single(),
        db.from('vendor_plans').select('*').eq('id', payment.plan_id).single(),
      ]);

      const invoicePdfData = {
        invoiceNumber: payment.invoice_number || generateInvoiceNumber(),
        invoiceDate: payment.payment_date || new Date(),
        dueDate: payment.payment_date || new Date(),
        vendor,
        plan,
        amount: payment.amount,
        discount_amount: payment.discount_amount || 0,
        coupon_code: payment.coupon_code || '',
        tax: payment.tax_amount || 0,
        totalAmount: payment.net_amount || payment.amount,
        paymentMethod: payment.payment_method || 'Razorpay',
        transactionId: payment.transaction_id,
      };

      const newPdf = generateInvoicePDF(invoicePdfData);

      await db
        .from('vendor_payments')
        .update({
          invoice_url: newPdf,
          invoice_number: invoicePdfData.invoiceNumber,
        })
        .eq('id', payment.id);

      payment.invoice_url = newPdf;
    }

    res.json({
      success: true,
      invoice: payment.invoice_url,
    });
  } catch (error) {
    logger.error('Invoice by transaction retrieval error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/payment/plans
 * Get all active subscription plans
 */
router.get('/plans', async (req, res) => {
  try {
    const { data: plans, error } = await db
      .from('vendor_plans')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, data: (plans || []).filter(isVisibleCatalogPlan) });
  } catch (error) {
    logger.error('Plans retrieval error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/market-context', (req, res) => {
  const { countryCode, source } = getRequestCountryCode(req);
  return res.json({
    success: true,
    data: {
      country_code: countryCode,
      source,
    },
  });
});

/**
 * GET /api/payment/referral-offers/:vendor_id
 * Preview referral discount (if any) per active plan for the vendor.
 */
router.get('/referral-offers/:vendor_id', async (req, res) => {
  try {
    const vendor_id = normalizeText(req.params?.vendor_id);
    if (!vendor_id) {
      return res.status(400).json({ error: 'Missing vendor_id' });
    }

    const [{ data: vendor, error: vendorError }, { data: plans, error: plansError }, settings] = await Promise.all([
      db.from('vendors').select('*').eq('id', vendor_id).maybeSingle(),
      db
        .from('vendor_plans')
        .select('id, name, price, is_active')
        .eq('is_active', true)
        .order('price', { ascending: true }),
      getReferralSettings(db),
    ]);

    if (vendorError || !vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    if (plansError) {
      return res.status(500).json({ error: plansError.message || 'Failed to load plans' });
    }

    const offerMap = {};
    const now = new Date();
    for (const plan of plans || []) {
      const planId = String(plan?.id || '').trim();
      if (!planId) continue;

      const baseAmountRaw = Number(plan?.price || 0);
      const baseAmount = Number.isFinite(baseAmountRaw) ? Math.max(0, baseAmountRaw) : 0;

      let discountAmount = 0;
      let offerCode = null;
      let configuredDiscountType = null;
      let configuredDiscountValue = 0;
      let configuredDiscountCap = null;
      if (baseAmount > 0 && settings?.is_enabled) {
        try {
          const referralOffer = await getReferralOfferForVendor(
            { vendor, plan, at: now },
            db
          );
          const configuredTypeRaw = String(referralOffer?.rule?.discount_type || '').toUpperCase();
          configuredDiscountType = configuredTypeRaw || null;
          const configuredValueRaw = Number(referralOffer?.rule?.discount_value || 0);
          configuredDiscountValue = Number.isFinite(configuredValueRaw)
            ? Math.max(0, configuredValueRaw)
            : 0;
          const configuredCapRaw = Number(referralOffer?.rule?.discount_cap);
          configuredDiscountCap = Number.isFinite(configuredCapRaw) && configuredCapRaw > 0
            ? configuredCapRaw
            : null;
          const rawDiscount = Number(referralOffer?.discount_amount || 0);
          discountAmount = Number.isFinite(rawDiscount)
            ? Math.max(0, Math.min(rawDiscount, baseAmount))
            : 0;
          offerCode = referralOffer?.offer_code || null;
        } catch (error) {
          logger.warn('[payment/referral-offers] offer lookup failed:', error?.message || error);
        }
      }

      const netAmount = Math.max(0, baseAmount - discountAmount);
      const effectiveDiscountPercent = baseAmount > 0
        ? Number(((discountAmount / baseAmount) * 100).toFixed(2))
        : 0;
      const displayDiscountPercent =
        configuredDiscountType === 'PERCENT' && configuredDiscountValue > 0
          ? configuredDiscountValue
          : effectiveDiscountPercent;

      offerMap[planId] = {
        plan_id: planId,
        base_amount: baseAmount,
        discount_amount: discountAmount,
        net_amount: netAmount,
        discount_percent: effectiveDiscountPercent,
        display_discount_percent: displayDiscountPercent,
        configured_discount_type: discountAmount > 0 ? configuredDiscountType : null,
        configured_discount_value: discountAmount > 0 ? configuredDiscountValue : 0,
        configured_discount_cap: discountAmount > 0 ? configuredDiscountCap : null,
        offer_type: discountAmount > 0 ? 'REFERRAL' : null,
        offer_code: discountAmount > 0 ? offerCode : null,
      };
    }

    return res.json({
      success: true,
      data: {
        settings: {
          is_enabled: Boolean(settings?.is_enabled),
          first_paid_plan_only: Boolean(settings?.first_paid_plan_only),
        },
        offers: offerMap,
      },
    });
  } catch (error) {
    logger.error('[payment/referral-offers] error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load referral offers' });
  }
});

export default router;
