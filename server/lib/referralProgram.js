import { createClient } from '@supabase/supabase-js';

let cachedDefaultClient = null;

const getDefaultClient = () => {
  if (cachedDefaultClient) return cachedDefaultClient;

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase credentials');
  }

  cachedDefaultClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cachedDefaultClient;
};

export const REFERRAL_DEFAULTS = {
  is_enabled: false,
  first_paid_plan_only: true,
  allow_coupon_stack: false,
  min_plan_amount: 0,
  min_cashout_amount: 500,
  reward_hold_days: 0,
};

const CODE_ALLOWED = /[^A-Z0-9]/g;

export const normalizeReferralCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(CODE_ALLOWED, '')
    .slice(0, 20);

const alnumUpper = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(CODE_ALLOWED, '');

export const calculateOfferAmount = ({ baseAmount, type, value, cap = null }) => {
  const amount = Number(baseAmount || 0);
  const offerValue = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(offerValue) || offerValue <= 0) return 0;

  let discount = 0;
  if (String(type || '').toUpperCase() === 'PERCENT') {
    discount = (amount * offerValue) / 100;
  } else {
    discount = offerValue;
  }

  if (!Number.isFinite(discount)) return 0;
  if (Number.isFinite(Number(cap)) && Number(cap) > 0) {
    discount = Math.min(discount, Number(cap));
  }
  return Math.max(0, Math.min(discount, amount));
};

export const getReferralSettings = async (client = getDefaultClient()) => {
  const { data, error } = await client
    .from('referral_program_settings')
    .select('*')
    .eq('config_key', 'GLOBAL')
    .maybeSingle();

  if (error) {
    console.warn('[referral] settings load failed:', error.message);
    return { ...REFERRAL_DEFAULTS };
  }

  return {
    ...REFERRAL_DEFAULTS,
    ...(data || {}),
  };
};

export const getReferralPlanRule = async (planId, at = new Date(), client = getDefaultClient()) => {
  if (!planId) return null;
  const { data, error } = await client
    .from('referral_plan_rules')
    .select('*')
    .eq('plan_id', planId)
    .eq('is_enabled', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[referral] plan rule load failed:', error.message);
    return null;
  }
  if (!data) return null;

  const atTs = new Date(at).getTime();
  const fromTs = data.valid_from ? new Date(data.valid_from).getTime() : null;
  const toTs = data.valid_to ? new Date(data.valid_to).getTime() : null;
  if (Number.isFinite(fromTs) && fromTs > atTs) return null;
  if (Number.isFinite(toTs) && toTs < atTs) return null;
  return data;
};

export const ensureVendorReferralProfile = async (vendor, client = getDefaultClient()) => {
  const vendorId = String(vendor?.id || '').trim();
  if (!vendorId) return null;

  const { data: existing, error: existingErr } = await client
    .from('vendor_referral_profiles')
    .select('*')
    .eq('vendor_id', vendorId)
    .maybeSingle();

  if (!existingErr && existing?.referral_code) return existing;

  const seeds = [
    alnumUpper(vendor?.vendor_id),
    alnumUpper(vendor?.company_name).slice(0, 8),
    alnumUpper(vendor?.owner_name).slice(0, 8),
    `V${vendorId.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
  ].filter(Boolean);
  const baseSeed = seeds[0] || `V${vendorId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  for (let i = 0; i < 25; i += 1) {
    const suffix = i === 0 ? '' : `${Math.floor(Math.random() * 8999 + 1000)}`;
    const code = normalizeReferralCode(`${baseSeed}${suffix}`).slice(0, 16);
    if (!code) continue;

    const payload = {
      vendor_id: vendorId,
      referral_code: code,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await client
      .from('vendor_referral_profiles')
      .upsert(payload, { onConflict: 'vendor_id' })
      .select('*')
      .maybeSingle();

    if (!error && data?.referral_code) return data;

    const msg = String(error?.message || '').toLowerCase();
    if (!msg.includes('duplicate') && !msg.includes('unique')) {
      throw error;
    }
  }

  throw new Error('Unable to generate unique referral code');
};

export const linkReferralForVendor = async (
  { referredVendor, referralCode },
  client = getDefaultClient()
) => {
  const referredVendorId = String(referredVendor?.id || '').trim();
  const code = normalizeReferralCode(referralCode);
  if (!referredVendorId || !code) {
    throw new Error('referred_vendor and referral_code are required');
  }

  const [referredProfileRes, referrerProfileRes] = await Promise.all([
    ensureVendorReferralProfile(referredVendor, client),
    client
      .from('vendor_referral_profiles')
      .select('vendor_id, referral_code, is_active')
      .eq('referral_code', code)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  const referredProfile = referredProfileRes;
  const referrerProfile = referrerProfileRes?.data;
  if (!referrerProfile?.vendor_id) {
    throw new Error('Invalid referral code');
  }

  if (referrerProfile.vendor_id === referredVendorId) {
    throw new Error('Self referral is not allowed');
  }

  if (referredProfile?.referral_code === code) {
    throw new Error('Self referral is not allowed');
  }

  const { data: existing, error: existingErr } = await client
    .from('vendor_referrals')
    .select('*')
    .eq('referred_vendor_id', referredVendorId)
    .maybeSingle();

  if (existingErr) {
    throw new Error(existingErr.message || 'Unable to validate referral link');
  }

  if (existing?.id) {
    if (existing.referrer_vendor_id === referrerProfile.vendor_id) {
      return existing;
    }
    throw new Error('Referral code already linked for this vendor');
  }

  const { data: inserted, error: insErr } = await client
    .from('vendor_referrals')
    .insert([
      {
        referrer_vendor_id: referrerProfile.vendor_id,
        referred_vendor_id: referredVendorId,
        referral_code: code,
        status: 'PENDING',
      },
    ])
    .select('*')
    .single();

  if (insErr) throw new Error(insErr.message || 'Failed to create referral link');
  return inserted;
};

const getPendingReferralForVendor = async (
  referredVendorId,
  client = getDefaultClient()
) => {
  const { data, error } = await client
    .from('vendor_referrals')
    .select('*')
    .eq('referred_vendor_id', referredVendorId)
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message || 'Failed to load vendor referral');
  }
  return data || null;
};

const getActiveReferralForVendor = async (
  referredVendorId,
  client = getDefaultClient()
) => {
  const { data, error } = await client
    .from('vendor_referrals')
    .select('*')
    .eq('referred_vendor_id', referredVendorId)
    .in('status', ['PENDING', 'QUALIFIED', 'REWARDED'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(error.message || 'Failed to load vendor referral');
  }
  return data || null;
};

const hasPriorCompletedPayment = async (
  vendorId,
  excludePaymentId,
  client = getDefaultClient()
) => {
  let query = client
    .from('vendor_payments')
    .select('id')
    .eq('vendor_id', vendorId)
    .eq('status', 'COMPLETED')
    .limit(1);

  if (excludePaymentId) {
    query = query.neq('id', excludePaymentId);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message || 'Failed to verify prior payments');
  return Array.isArray(data) && data.length > 0;
};

const ensureWallet = async (vendorId, client = getDefaultClient()) => {
  const payload = {
    vendor_id: vendorId,
    available_balance: 0,
    pending_balance: 0,
    lifetime_earned: 0,
    lifetime_paid_out: 0,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from('vendor_referral_wallets')
    .upsert(payload, { onConflict: 'vendor_id' })
    .select('*')
    .single();
  if (error) throw new Error(error.message || 'Failed to initialize wallet');
  return data;
};

export const getReferralOfferForVendor = async (
  { vendor, plan, at = new Date() },
  client = getDefaultClient()
) => {
  const settings = await getReferralSettings(client);
  if (!settings.is_enabled) return null;
  if (!vendor?.id || !plan?.id) return null;

  if (settings.first_paid_plan_only) {
    const hasAnyCompleted = await hasPriorCompletedPayment(vendor.id, null, client);
    if (hasAnyCompleted) return null;
  }

  const activeReferral = await getActiveReferralForVendor(vendor.id, client);
  if (!activeReferral?.id) return null;

  const rule = await getReferralPlanRule(plan.id, at, client);
  if (!rule?.is_enabled) return null;

  const baseAmount = Number(plan.price || 0);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;
  if (baseAmount < Number(settings.min_plan_amount || 0)) return null;

  const discountAmount = calculateOfferAmount({
    baseAmount,
    type: rule.discount_type,
    value: rule.discount_value,
    cap: rule.discount_cap,
  });

  if (discountAmount <= 0) return null;

  return {
    offer_type: 'REFERRAL',
    offer_code: activeReferral.referral_code,
    referral_id: activeReferral.id,
    discount_amount: discountAmount,
    referral: activeReferral,
    rule,
    settings,
  };
};

export const applyReferralRewardAfterPayment = async (
  { referredVendorId, plan, paymentRow, netAmount },
  client = getDefaultClient()
) => {
  const paymentId = String(paymentRow?.id || '').trim();
  if (!referredVendorId || !paymentId || !plan?.id) return { applied: false, reason: 'missing_context' };

  const settings = await getReferralSettings(client);
  if (!settings.is_enabled) return { applied: false, reason: 'program_disabled' };

  const rewardReferral = settings.first_paid_plan_only
    ? await getPendingReferralForVendor(referredVendorId, client)
    : await getActiveReferralForVendor(referredVendorId, client);
  if (!rewardReferral?.id) return { applied: false, reason: 'no_eligible_referral' };

  if (settings.first_paid_plan_only) {
    const prior = await hasPriorCompletedPayment(referredVendorId, paymentId, client);
    if (prior) {
      await client
        .from('vendor_referrals')
        .update({
          status: 'REJECTED',
          rejection_reason: 'NOT_FIRST_PAID_PLAN',
          updated_at: new Date().toISOString(),
        })
        .eq('id', rewardReferral.id);
      return { applied: false, reason: 'not_first_paid_plan' };
    }
  }

  const baseAmount = Number(netAmount || paymentRow?.net_amount || paymentRow?.amount || 0);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    return { applied: false, reason: 'invalid_amount' };
  }
  if (baseAmount < Number(settings.min_plan_amount || 0)) {
    return { applied: false, reason: 'below_min_plan_amount' };
  }

  const rule = await getReferralPlanRule(plan.id, paymentRow?.payment_date || new Date(), client);
  if (!rule?.is_enabled) return { applied: false, reason: 'rule_missing_or_disabled' };

  const rewardAmount = calculateOfferAmount({
    baseAmount,
    type: rule.reward_type,
    value: rule.reward_value,
    cap: rule.reward_cap,
  });

  if (rewardAmount <= 0) {
    await client
      .from('vendor_referrals')
      .update({
        status: 'REJECTED',
        rejection_reason: 'ZERO_REWARD',
        updated_at: new Date().toISOString(),
      })
      .eq('id', rewardReferral.id);
    return { applied: false, reason: 'zero_reward' };
  }

  const referrerVendorId = rewardReferral.referrer_vendor_id;
  const wallet = await ensureWallet(referrerVendorId, client);
  const nextAvailable = Number(wallet.available_balance || 0) + rewardAmount;
  const nextLifetimeEarned = Number(wallet.lifetime_earned || 0) + rewardAmount;

  const { error: walletUpdErr } = await client
    .from('vendor_referral_wallets')
    .update({
      available_balance: nextAvailable,
      lifetime_earned: nextLifetimeEarned,
      updated_at: new Date().toISOString(),
    })
    .eq('vendor_id', referrerVendorId);
  if (walletUpdErr) throw new Error(walletUpdErr.message || 'Failed to update referral wallet');

  const referenceKey = `ref_reward:${paymentId}`;
  const { error: ledgerErr } = await client
    .from('vendor_referral_wallet_ledger')
    .insert([
      {
        vendor_id: referrerVendorId,
        referral_id: rewardReferral.id,
        payment_id: paymentId,
        entry_type: 'REFERRAL_REWARD_CREDIT',
        amount: rewardAmount,
        status: 'COMPLETED',
        reference_key: referenceKey,
        meta: {
          referred_vendor_id: referredVendorId,
          plan_id: plan.id,
        },
      },
    ]);

  if (ledgerErr) {
    const msg = String(ledgerErr.message || '').toLowerCase();
    if (!msg.includes('duplicate') && !msg.includes('unique')) {
      throw new Error(ledgerErr.message || 'Failed to write referral ledger');
    }
  }

  const nowIso = new Date().toISOString();
  const { error: referralUpdErr } = await client
    .from('vendor_referrals')
    .update({
      status: 'REWARDED',
      qualified_payment_id: paymentId,
      qualified_at: nowIso,
      rewarded_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', rewardReferral.id);
  if (referralUpdErr) throw new Error(referralUpdErr.message || 'Failed to update referral status');

  const { error: payUpdErr } = await client
    .from('vendor_payments')
    .update({
      referral_id: rewardReferral.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', paymentId);
  if (payUpdErr) {
    console.warn('[referral] payment referral_id update failed:', payUpdErr.message);
  }

  return {
    applied: true,
    reward_amount: rewardAmount,
    referral_id: rewardReferral.id,
    referrer_vendor_id: referrerVendorId,
  };
};

export const createReferralCashoutRequest = async (
  { vendorId, amount, bankDetailId = null, note = null },
  client = getDefaultClient()
) => {
  const requestedAmount = Number(amount || 0);
  if (!vendorId || !Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new Error('Invalid cashout request');
  }

  const settings = await getReferralSettings(client);
  if (requestedAmount < Number(settings.min_cashout_amount || 0)) {
    throw new Error(`Minimum cashout is ₹${Number(settings.min_cashout_amount || 0)}`);
  }

  const wallet = await ensureWallet(vendorId, client);
  const available = Number(wallet.available_balance || 0);
  if (available < requestedAmount) {
    throw new Error('Insufficient wallet balance');
  }

  let bank = null;
  if (bankDetailId) {
    const { data, error } = await client
      .from('vendor_bank_details')
      .select('*')
      .eq('id', bankDetailId)
      .eq('vendor_id', vendorId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Failed to load bank detail');
    bank = data;
  } else {
    const { data, error } = await client
      .from('vendor_bank_details')
      .select('*')
      .eq('vendor_id', vendorId)
      .eq('is_primary', true)
      .maybeSingle();
    if (!error && data) bank = data;
  }

  if (!bank?.id) {
    throw new Error('Primary bank account is required before cashout');
  }

  const bankSnapshot = {
    id: bank.id,
    account_holder: bank.account_holder || null,
    account_number_masked: String(bank.account_number || '').replace(/\d(?=\d{4})/g, 'X'),
    ifsc_code: bank.ifsc_code || null,
    bank_name: bank.bank_name || null,
    branch_name: bank.branch_name || null,
    is_primary: Boolean(bank.is_primary),
  };

  const nowIso = new Date().toISOString();
  const { data: requestRow, error: reqErr } = await client
    .from('vendor_referral_cashout_requests')
    .insert([
      {
        vendor_id: vendorId,
        requested_amount: requestedAmount,
        status: 'REQUESTED',
        bank_detail_id: bank.id,
        bank_snapshot: bankSnapshot,
        notes: note || null,
        created_at: nowIso,
        updated_at: nowIso,
      },
    ])
    .select('*')
    .single();
  if (reqErr) throw new Error(reqErr.message || 'Failed to create cashout request');

  const nextBalance = available - requestedAmount;
  const { error: walletErr } = await client
    .from('vendor_referral_wallets')
    .update({
      available_balance: nextBalance,
      updated_at: nowIso,
    })
    .eq('vendor_id', vendorId);
  if (walletErr) throw new Error(walletErr.message || 'Failed to reserve cashout amount');

  const referenceKey = `cashout_debit:${requestRow.id}`;
  const { error: ledgerErr } = await client.from('vendor_referral_wallet_ledger').insert([
    {
      vendor_id: vendorId,
      cashout_request_id: requestRow.id,
      entry_type: 'CASHOUT_DEBIT',
      amount: requestedAmount,
      status: 'COMPLETED',
      reference_key: referenceKey,
      meta: {
        status: 'REQUESTED',
      },
      created_at: nowIso,
    },
  ]);
  if (ledgerErr) {
    throw new Error(ledgerErr.message || 'Failed to write cashout ledger');
  }

  return requestRow;
};
