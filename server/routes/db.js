import express from 'express';
import { optionalAuth } from '../middleware/requireAuth.js';
import { db } from '../lib/dbClient.js';

const router = express.Router();

const ALLOWED_TABLES = new Set([
  'admin_users',
  'audit_logs',
  'auth_otps',
  'buyer_notifications',
  'buyer_support_tickets',
  'buyers',
  'categories',
  'chat_blocks',
  'chatbot_history',
  'cities',
  'contact_submissions',
  'employee_state_scope',
  'employee_suggestions',
  'employees',
  'favorites',
  'geo_division_pincodes',
  'geo_divisions',
  'geo_postal_raw',
  'head_categories',
  'kyc_documents',
  'kyc_remarks',
  'lead_contacts',
  'lead_purchases',
  'lead_status_history',
  'leads',
  'manager_sales_division_allocations',
  'marketplace_available_leads',
  'micro_categories',
  'micro_category_meta',
  'notifications',
  'page_status',
  'plan_tiers',
  'platform_feedback',
  'product_images',
  'product_ratings',
  'product_videos',
  'products',
  'proposal_messages',
  'proposals',
  'public_vendor_plan_badges',
  'quotation_emails',
  'quotation_unregistered',
  'quotes',
  'referral_plan_rules',
  'referral_program_settings',
  'regions',
  'requirements',
  'role_permissions',
  'sales_vendor_engagements',
  'states',
  'sub_categories',
  'subscription_extension_requests',
  'suggestions',
  'superadmin_users',
  'support_tickets',
  'system_config',
  'ticket_messages',
  'users',
  'vendor_additional_leads',
  'vendor_bank_details',
  'vendor_contact_persons',
  'vendor_coupon_usages',
  'vendor_division_map',
  'vendor_documents',
  'vendor_lead_quota',
  'vendor_messages',
  'vendor_otp_codes',
  'vendor_payments',
  'vendor_plan_coupons',
  'vendor_plan_slots',
  'vendor_plan_subscriptions',
  'vendor_plans',
  'vendor_preferences',
  'vendor_referral_cashout_requests',
  'vendor_referral_profiles',
  'vendor_referral_wallet_ledger',
  'vendor_referral_wallets',
  'vendor_referrals',
  'vendor_reviews',
  'vendor_services',
  'vendor_subscriptions',
  'vendors',
  'view_category_hierarchy',
  'vp_manager_division_allocations',
]);

const PUBLIC_WRITE_TABLES = new Set([
  'contact_submissions',
  'quotes',
  'requirements',
  'chatbot_history',
]);

const normalizeTable = (table) => String(table || '').trim().replace(/^public\./, '');

const isReadOnlyOperation = (operation) => String(operation || 'select').toLowerCase() === 'select';

router.post('/query', optionalAuth(), async (req, res) => {
  try {
    const input = req.body || {};
    const table = normalizeTable(input.table);
    const operation = String(input.operation || 'select').toLowerCase();

    if (!ALLOWED_TABLES.has(table)) {
      return res.status(400).json({ success: false, error: 'Table is not allowed' });
    }

    if (!isReadOnlyOperation(operation) && !req.user && !PUBLIC_WRITE_TABLES.has(table)) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const result = await db.runSerializedQuery({
      ...input,
      table,
      operation,
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error.message, code: result.error.code });
    }

    return res.json({
      success: true,
      data: result.data,
      count: result.count ?? null,
    });
  } catch (error) {
    console.error('[db] query failed:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Database query failed' });
  }
});

export default router;
