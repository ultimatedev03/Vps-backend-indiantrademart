import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { writeAuditLog } from '../lib/audit.js';
import {
  createReferralCashoutRequest,
  ensureVendorReferralProfile,
  getReferralSettings,
  linkReferralForVendor,
  normalizeReferralCode,
} from '../lib/referralProgram.js';

const router = express.Router();

const normalizeText = (value) => String(value || '').trim();
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

async function resolveVendorForAuthUser(user = {}) {
  const userId = normalizeText(user?.id);
  const email = normalizeEmail(user?.email);

  if (userId) {
    const { data: byUserId, error: byUserErr } = await supabase
      .from('vendors')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (!byUserErr && byUserId) return byUserId;
  }

  if (email) {
    const { data: byEmail, error: byEmailErr } = await supabase
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

router.use(requireAuth({ roles: ['VENDOR'] }));

// GET /api/referrals/me
router.get('/me', async (req, res) => {
  try {
    const vendor = await resolveVendorForAuthUser(req.user);
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const [profile, walletRes, settings, referredRowsRes, earnedRowsRes, linkedReferralRes] = await Promise.all([
      ensureVendorReferralProfile(vendor, supabase),
      supabase
        .from('vendor_referral_wallets')
        .select('*')
        .eq('vendor_id', vendor.id)
        .maybeSingle(),
      getReferralSettings(supabase),
      supabase
        .from('vendor_referrals')
        .select('id, status, created_at, qualified_at, rewarded_at, referred_vendor_id')
        .eq('referrer_vendor_id', vendor.id)
        .order('created_at', { ascending: false })
        .limit(25),
      supabase
        .from('vendor_referral_wallet_ledger')
        .select('id, entry_type, amount, status, created_at, referral_id, payment_id')
        .eq('vendor_id', vendor.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('vendor_referrals')
        .select('id, status, created_at, qualified_at, rewarded_at, rejection_reason, referral_code, referrer_vendor_id')
        .eq('referred_vendor_id', vendor.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    if (walletRes.error) throw walletRes.error;
    if (referredRowsRes.error) throw referredRowsRes.error;
    if (earnedRowsRes.error) throw earnedRowsRes.error;
    if (linkedReferralRes.error) throw linkedReferralRes.error;

    const rawReferrals = Array.isArray(referredRowsRes.data) ? referredRowsRes.data : [];
    const referredVendorIds = Array.from(
      new Set(rawReferrals.map((row) => String(row?.referred_vendor_id || '').trim()).filter(Boolean))
    );

    let vendorMap = {};
    if (referredVendorIds.length > 0) {
      const { data: vendors, error: vendorsErr } = await supabase
        .from('vendors')
        .select('id, company_name, vendor_id, email')
        .in('id', referredVendorIds);

      if (vendorsErr) throw vendorsErr;

      vendorMap = (vendors || []).reduce((acc, row) => {
        if (row?.id) acc[row.id] = row;
        return acc;
      }, {});
    }

    const referrals = rawReferrals.map((row) => ({
      ...row,
      referred_vendor: row?.referred_vendor_id ? vendorMap[row.referred_vendor_id] || null : null,
    }));

    let linkedReferral = linkedReferralRes.data || null;
    if (linkedReferral?.referrer_vendor_id) {
      const { data: referrerVendor, error: referrerErr } = await supabase
        .from('vendors')
        .select('id, company_name, vendor_id, email')
        .eq('id', linkedReferral.referrer_vendor_id)
        .maybeSingle();
      if (referrerErr) throw referrerErr;
      linkedReferral = {
        ...linkedReferral,
        referrer_vendor: referrerVendor || null,
      };
    }

    const wallet = walletRes.data || {
      vendor_id: vendor.id,
      available_balance: 0,
      pending_balance: 0,
      lifetime_earned: 0,
      lifetime_paid_out: 0,
      updated_at: new Date().toISOString(),
    };

    return res.json({
      success: true,
      data: {
        referral_profile: profile,
        wallet,
        settings: {
          is_enabled: Boolean(settings?.is_enabled),
          min_cashout_amount: Number(settings?.min_cashout_amount || 0),
        },
        linked_referral: linkedReferral,
        referrals,
        ledger: earnedRowsRes.data || [],
      },
    });
  } catch (error) {
    logger.error('[referrals/me] error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to load referral profile' });
  }
});

// POST /api/referrals/link
// Link a referred vendor with a referrer code (typically after registration).
router.post('/link', async (req, res) => {
  try {
    const referralCode = normalizeReferralCode(req.body?.referral_code);
    if (!referralCode) {
      return res.status(400).json({ success: false, error: 'referral_code is required' });
    }

    const vendor = await resolveVendorForAuthUser(req.user);
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const linked = await linkReferralForVendor(
      {
        referredVendor: vendor,
        referralCode,
      },
      supabase
    );

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_LINKED',
      entityType: 'vendor_referrals',
      entityId: linked?.id || null,
      details: {
        referred_vendor_id: vendor.id,
        referral_code: referralCode,
      },
    });

    return res.json({ success: true, data: linked });
  } catch (error) {
    const msg = String(error?.message || 'Failed to link referral');
    const lower = msg.toLowerCase();
    const isClientError =
      lower.includes('invalid referral') ||
      lower.includes('self referral') ||
      lower.includes('already linked') ||
      lower.includes('required');
    const status = isClientError ? 400 : 500;
    return res.status(status).json({ success: false, error: msg });
  }
});

// GET /api/referrals/cashouts
router.get('/cashouts', async (req, res) => {
  try {
    const vendor = await resolveVendorForAuthUser(req.user);
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { data, error } = await supabase
      .from('vendor_referral_cashout_requests')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load cashouts' });
  }
});

// POST /api/referrals/cashout
router.post('/cashout', async (req, res) => {
  try {
    const vendor = await resolveVendorForAuthUser(req.user);
    if (!vendor?.id) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const amount = Number(req.body?.amount || 0);
    const bankDetailId = normalizeText(req.body?.bank_detail_id || '');
    const note = normalizeText(req.body?.note || '');

    const requestRow = await createReferralCashoutRequest(
      {
        vendorId: vendor.id,
        amount,
        bankDetailId: bankDetailId || null,
        note: note || null,
      },
      supabase
    );

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'REFERRAL_CASHOUT_REQUESTED',
      entityType: 'vendor_referral_cashout_requests',
      entityId: requestRow?.id || null,
      details: {
        amount,
        bank_detail_id: bankDetailId || null,
      },
    });

    return res.json({ success: true, data: requestRow });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message || 'Failed to create cashout request' });
  }
});

export default router;
