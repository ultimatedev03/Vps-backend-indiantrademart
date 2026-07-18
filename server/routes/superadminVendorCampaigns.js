import express from 'express';
import { randomUUID } from 'crypto';
import { mysqlQuery, withMysqlConnection } from '../lib/mysqlPool.js';
import { writeAuditLog } from '../lib/audit.js';
import {
  VENDOR_CAMPAIGN_TARGETS,
  VENDOR_CAMPAIGN_TYPES,
  VENDOR_CAMPAIGN_VARIANTS,
  ensureVendorCampaignTables,
  getCampaignEffectiveStatus,
  normalizeCampaignRow,
} from '../lib/vendorCampaigns.js';

const router = express.Router();
const COUPON_CODE_RE = /^[A-Z0-9_-]{3,40}$/;
const PROMOTION_TYPES = new Set(['DISCOUNT', 'COUPON']);

class CampaignInputError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);

const boolValue = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const intValue = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const toMysqlDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const normalizeTargetIds = (value) => {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((id) => cleanText(id, 80)).filter(Boolean))].slice(0, 5000);
};

const normalizeCtaUrl = (value) => {
  const raw = cleanText(value, 500);
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('Invalid protocol');
    return parsed.toString();
  } catch {
    throw new CampaignInputError('CTA URL must be an internal path or a valid HTTPS URL');
  }
};

function normalizeCampaignPayload(body = {}) {
  const campaignType = cleanText(body.campaign_type, 32).toUpperCase();
  const targetType = cleanText(body.target_type || 'ALL', 32).toUpperCase();
  const styleVariant = cleanText(body.style_variant || 'INFO', 32).toUpperCase();
  const title = cleanText(body.title, 191);
  const message = cleanText(body.message, 4000);
  const targetVendorIds = normalizeTargetIds(body.target_vendor_ids);
  const ctaLabel = cleanText(body.cta_label, 80) || null;
  const ctaUrl = normalizeCtaUrl(body.cta_url);
  const dismissible = boolValue(body.dismissible, true);

  if (!VENDOR_CAMPAIGN_TYPES.has(campaignType)) {
    throw new CampaignInputError('Campaign type must be Announcement, Discount, or Coupon');
  }
  if (!VENDOR_CAMPAIGN_TARGETS.has(targetType)) {
    throw new CampaignInputError('Target must be all vendors or selected vendors');
  }
  if (!VENDOR_CAMPAIGN_VARIANTS.has(styleVariant)) {
    throw new CampaignInputError('Invalid campaign style');
  }
  if (!title || !message) {
    throw new CampaignInputError('Title and message are required');
  }
  if (targetType === 'SELECTED' && !targetVendorIds.length) {
    throw new CampaignInputError('Select at least one vendor');
  }
  if (Boolean(ctaLabel) !== Boolean(ctaUrl)) {
    throw new CampaignInputError('CTA label and CTA destination must be provided together');
  }
  if (!dismissible && !ctaUrl) {
    throw new CampaignInputError('A non-dismissible campaign must include an action button');
  }

  const startsAt = new Date(body.starts_at || Date.now());
  const endsAt = new Date(body.ends_at || '');
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new CampaignInputError('A valid start and end date are required');
  }
  if (endsAt <= startsAt) {
    throw new CampaignInputError('End date must be after the start date');
  }
  if (endsAt.getTime() - startsAt.getTime() > 400 * 24 * 60 * 60 * 1000) {
    throw new CampaignInputError('Campaign duration cannot exceed 400 days');
  }
  if (endsAt.getTime() <= Date.now()) {
    throw new CampaignInputError('Campaign end date must be in the future');
  }

  const normalized = {
    name: cleanText(body.name || title, 191),
    campaign_type: campaignType,
    title,
    message,
    style_variant: styleVariant,
    cta_label: ctaLabel,
    cta_url: ctaUrl,
    target_type: targetType,
    target_vendor_ids: targetType === 'SELECTED' ? targetVendorIds : [],
    starts_at: toMysqlDate(startsAt),
    ends_at: toMysqlDate(endsAt),
    is_active: boolValue(body.is_active, true),
    priority: intValue(body.priority, 50, 0, 1000),
    dismissible,
    max_impressions_per_vendor: intValue(body.max_impressions_per_vendor, 1, 0, 100),
    coupon_code: null,
    discount_type: null,
    discount_value: null,
    plan_id: null,
    max_uses: null,
  };

  if (PROMOTION_TYPES.has(campaignType)) {
    const couponCode = cleanText(body.coupon_code, 40).toUpperCase();
    const discountType = cleanText(body.discount_type, 20).toUpperCase();
    const discountValue = Number(body.discount_value);
    const maxUses = intValue(body.max_uses, 0, 0, 10_000_000);

    if (!COUPON_CODE_RE.test(couponCode)) {
      throw new CampaignInputError('Coupon code must be 3-40 letters, numbers, hyphens, or underscores');
    }
    if (!['PERCENT', 'FLAT'].includes(discountType)) {
      throw new CampaignInputError('Discount type must be Percent or Flat');
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      throw new CampaignInputError('Discount value must be greater than zero');
    }
    if (discountType === 'PERCENT' && discountValue > 100) {
      throw new CampaignInputError('Percentage discount cannot exceed 100%');
    }

    normalized.coupon_code = couponCode;
    normalized.discount_type = discountType;
    normalized.discount_value = discountValue;
    normalized.plan_id = ['ALL', 'ANY', 'GLOBAL', ''].includes(cleanText(body.plan_id, 80).toUpperCase())
      ? null
      : cleanText(body.plan_id, 80);
    normalized.max_uses = maxUses;
  }

  return normalized;
}

async function assertTargetVendors(connection, campaign) {
  if (campaign.target_type !== 'SELECTED') return;
  const placeholders = campaign.target_vendor_ids.map(() => '?').join(', ');
  const [rows] = await connection.query(
    `SELECT id FROM vendors WHERE id IN (${placeholders})`,
    campaign.target_vendor_ids
  );
  if (rows.length !== campaign.target_vendor_ids.length) {
    throw new CampaignInputError('One or more selected vendors no longer exist');
  }
}

const couponMetadata = (campaignId, campaign) => JSON.stringify({
  source: 'SUPERADMIN_VENDOR_CAMPAIGN',
  campaign_id: campaignId,
  campaign_starts_at: campaign.starts_at,
  campaign_ends_at: campaign.ends_at,
  target_type: campaign.target_type,
  target_vendor_ids: campaign.target_vendor_ids,
});

async function assertCouponCodeAvailable(connection, code, excludeCouponId = null) {
  const params = [code];
  let sql = 'SELECT id FROM vendor_plan_coupons WHERE UPPER(code) = UPPER(?)';
  if (excludeCouponId) {
    sql += ' AND id <> ?';
    params.push(excludeCouponId);
  }
  sql += ' LIMIT 1 FOR UPDATE';
  const [rows] = await connection.query(sql, params);
  if (rows[0]) throw new CampaignInputError('Coupon code already exists. Use a different code.', 409);
}

async function upsertLinkedCoupon(connection, {
  campaignId,
  existingCouponId = null,
  campaign,
  actor,
}) {
  if (!PROMOTION_TYPES.has(campaign.campaign_type)) {
    if (existingCouponId) {
      await connection.query('UPDATE vendor_plan_coupons SET is_active = 0 WHERE id = ?', [existingCouponId]);
    }
    return null;
  }

  await assertCouponCodeAvailable(connection, campaign.coupon_code, existingCouponId);
  const couponId = existingCouponId || randomUUID();
  const vendorScope = campaign.target_type === 'SELECTED' && campaign.target_vendor_ids.length === 1
    ? campaign.target_vendor_ids[0]
    : null;
  const active = campaign.is_active ? 1 : 0;
  const metadata = couponMetadata(campaignId, campaign);

  if (existingCouponId) {
    await connection.query(
      `UPDATE vendor_plan_coupons
          SET code = ?, discount_type = ?, value = ?, plan_id = ?, vendor_id = ?, max_uses = ?,
              expires_at = ?, is_active = ?, metadata = ?, approval_status = 'APPROVED',
              approved_by = ?, approved_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [
        campaign.coupon_code,
        campaign.discount_type,
        campaign.discount_value,
        campaign.plan_id,
        vendorScope,
        campaign.max_uses,
        campaign.ends_at,
        active,
        metadata,
        cleanText(actor?.email, 191) || null,
        existingCouponId,
      ]
    );
  } else {
    await connection.query(
      `INSERT INTO vendor_plan_coupons
        (id, code, discount_type, value, plan_id, vendor_id, max_uses, used_count, expires_at,
         is_active, metadata, created_at, created_by, approval_status, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, UTC_TIMESTAMP(), ?, 'APPROVED', ?, UTC_TIMESTAMP())`,
      [
        couponId,
        campaign.coupon_code,
        campaign.discount_type,
        campaign.discount_value,
        campaign.plan_id,
        vendorScope,
        campaign.max_uses,
        campaign.ends_at,
        active,
        metadata,
        cleanText(actor?.id, 36) || null,
        cleanText(actor?.email, 191) || null,
      ]
    );
  }

  return couponId;
}

async function readCampaign(campaignId) {
  const rows = await mysqlQuery(
    `SELECT c.*, COALESCE(cp.used_count, 0) AS coupon_used_count
       FROM vendor_campaigns c
       LEFT JOIN vendor_plan_coupons cp ON cp.id = c.coupon_id
      WHERE c.id = ? AND c.deleted_at IS NULL
      LIMIT 1`,
    [campaignId]
  );
  if (!rows[0]) return null;
  const campaign = normalizeCampaignRow(rows[0]);
  return { ...campaign, effective_status: getCampaignEffectiveStatus(campaign) };
}

async function enrichTargetNames(campaigns = []) {
  const ids = [...new Set(campaigns.flatMap((campaign) => campaign.target_vendor_ids || []))];
  if (!ids.length) return campaigns;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await mysqlQuery(
    `SELECT id, company_name, owner_name, email FROM vendors WHERE id IN (${placeholders})`,
    ids
  );
  const names = new Map(rows.map((row) => [String(row.id), row.company_name || row.owner_name || row.email || 'Vendor']));
  return campaigns.map((campaign) => ({
    ...campaign,
    target_vendor_names: (campaign.target_vendor_ids || []).map((id) => names.get(String(id))).filter(Boolean),
  }));
}

router.get('/', async (_req, res) => {
  try {
    await ensureVendorCampaignTables();
    const rows = await mysqlQuery(`
      SELECT c.*, COALESCE(cp.used_count, 0) AS coupon_used_count,
             COALESCE(es.impressions, 0) AS impressions,
             COALESCE(es.clicks, 0) AS clicks,
             COALESCE(es.dismissals, 0) AS dismissals,
             COALESCE(es.code_copies, 0) AS code_copies,
             COALESCE(es.unique_vendors_reached, 0) AS unique_vendors_reached
        FROM vendor_campaigns c
        LEFT JOIN vendor_plan_coupons cp ON cp.id = c.coupon_id
        LEFT JOIN (
          SELECT campaign_id,
                 SUM(event_type = 'IMPRESSION') AS impressions,
                 SUM(event_type = 'CLICK') AS clicks,
                 SUM(event_type = 'DISMISS') AS dismissals,
                 SUM(event_type = 'COPY_CODE') AS code_copies,
                 COUNT(DISTINCT CASE WHEN event_type = 'IMPRESSION' THEN vendor_id END) AS unique_vendors_reached
            FROM vendor_campaign_events
           GROUP BY campaign_id
        ) es ON es.campaign_id = c.id
       WHERE c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT 500
    `);
    const campaigns = await enrichTargetNames(rows.map((row) => {
      const campaign = normalizeCampaignRow(row);
      return { ...campaign, effective_status: getCampaignEffectiveStatus(campaign) };
    }));

    const summary = campaigns.reduce((acc, campaign) => {
      const key = String(campaign.effective_status || '').toLowerCase();
      if (Object.hasOwn(acc, key)) acc[key] += 1;
      acc.total_reach += Number(campaign.unique_vendors_reached || 0);
      acc.total_clicks += Number(campaign.clicks || 0);
      return acc;
    }, { active: 0, scheduled: 0, paused: 0, expired: 0, total_reach: 0, total_clicks: 0 });

    return res.json({ success: true, campaigns, summary });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load campaigns' });
  }
});

router.get('/targets', async (req, res) => {
  try {
    const query = cleanText(req.query.q, 120);
    const limit = intValue(req.query.limit, 50, 1, 100);
    const like = `%${query}%`;
    const rows = query
      ? await mysqlQuery(
          `SELECT id, company_name, owner_name, email, phone, state, city, is_active, status
             FROM vendors
            WHERE company_name LIKE ? OR owner_name LIKE ? OR email LIKE ? OR phone LIKE ?
            ORDER BY company_name ASC
            LIMIT ?`,
          [like, like, like, like, limit]
        )
      : await mysqlQuery(
          `SELECT id, company_name, owner_name, email, phone, state, city, is_active, status
             FROM vendors
            ORDER BY updated_at DESC, company_name ASC
            LIMIT ?`,
          [limit]
        );
    return res.json({ success: true, vendors: rows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load vendors' });
  }
});

router.post('/', async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const campaign = normalizeCampaignPayload(req.body || {});
    const campaignId = randomUUID();
    let couponId = null;

    await withMysqlConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await assertTargetVendors(connection, campaign);
        couponId = await upsertLinkedCoupon(connection, {
          campaignId,
          campaign,
          actor: req.actor,
        });
        await connection.query(
          `INSERT INTO vendor_campaigns
            (id, name, campaign_type, title, message, style_variant, cta_label, cta_url,
             target_type, target_vendor_ids, coupon_id, coupon_code, discount_type, discount_value,
             plan_id, max_uses, starts_at, ends_at, is_active, priority, dismissible,
             max_impressions_per_vendor, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
          [
            campaignId,
            campaign.name,
            campaign.campaign_type,
            campaign.title,
            campaign.message,
            campaign.style_variant,
            campaign.cta_label,
            campaign.cta_url,
            campaign.target_type,
            JSON.stringify(campaign.target_vendor_ids),
            couponId,
            campaign.coupon_code,
            campaign.discount_type,
            campaign.discount_value,
            campaign.plan_id,
            campaign.max_uses,
            campaign.starts_at,
            campaign.ends_at,
            campaign.is_active ? 1 : 0,
            campaign.priority,
            campaign.dismissible ? 1 : 0,
            campaign.max_impressions_per_vendor,
            cleanText(req.actor?.id, 36) || null,
          ]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_CAMPAIGN_CREATED',
      entityType: 'vendor_campaigns',
      entityId: campaignId,
      details: {
        campaign_type: campaign.campaign_type,
        target_type: campaign.target_type,
        target_count: campaign.target_vendor_ids.length,
        coupon_code: campaign.coupon_code,
        starts_at: campaign.starts_at,
        ends_at: campaign.ends_at,
      },
    });

    return res.status(201).json({ success: true, campaign: await readCampaign(campaignId) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to create campaign',
    });
  }
});

router.put('/:campaignId', async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const campaignId = cleanText(req.params.campaignId, 80);
    const existing = await readCampaign(campaignId);
    if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const campaign = normalizeCampaignPayload(req.body || {});
    let couponId = existing.coupon_id || null;
    await withMysqlConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await assertTargetVendors(connection, campaign);
        couponId = await upsertLinkedCoupon(connection, {
          campaignId,
          existingCouponId: existing.coupon_id || null,
          campaign,
          actor: req.actor,
        });
        await connection.query(
          `UPDATE vendor_campaigns
              SET name = ?, campaign_type = ?, title = ?, message = ?, style_variant = ?,
                  cta_label = ?, cta_url = ?, target_type = ?, target_vendor_ids = ?,
                  coupon_id = ?, coupon_code = ?, discount_type = ?, discount_value = ?, plan_id = ?,
                  max_uses = ?, starts_at = ?, ends_at = ?, is_active = ?, priority = ?, dismissible = ?,
                  max_impressions_per_vendor = ?, updated_at = UTC_TIMESTAMP()
            WHERE id = ? AND deleted_at IS NULL`,
          [
            campaign.name,
            campaign.campaign_type,
            campaign.title,
            campaign.message,
            campaign.style_variant,
            campaign.cta_label,
            campaign.cta_url,
            campaign.target_type,
            JSON.stringify(campaign.target_vendor_ids),
            couponId,
            campaign.coupon_code,
            campaign.discount_type,
            campaign.discount_value,
            campaign.plan_id,
            campaign.max_uses,
            campaign.starts_at,
            campaign.ends_at,
            campaign.is_active ? 1 : 0,
            campaign.priority,
            campaign.dismissible ? 1 : 0,
            campaign.max_impressions_per_vendor,
            campaignId,
          ]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_CAMPAIGN_UPDATED',
      entityType: 'vendor_campaigns',
      entityId: campaignId,
      details: { campaign_type: campaign.campaign_type, target_type: campaign.target_type },
    });
    return res.json({ success: true, campaign: await readCampaign(campaignId) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to update campaign',
    });
  }
});

router.post('/:campaignId/status', async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const campaignId = cleanText(req.params.campaignId, 80);
    const existing = await readCampaign(campaignId);
    if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const isActive = boolValue(req.body?.is_active, false);
    if (isActive && new Date(existing.ends_at).getTime() <= Date.now()) {
      return res.status(409).json({ success: false, error: 'Extend the expired campaign before activating it' });
    }

    await withMysqlConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await connection.query(
          'UPDATE vendor_campaigns SET is_active = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
          [isActive ? 1 : 0, campaignId]
        );
        if (existing.coupon_id) {
          await connection.query('UPDATE vendor_plan_coupons SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, existing.coupon_id]);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: isActive ? 'VENDOR_CAMPAIGN_ACTIVATED' : 'VENDOR_CAMPAIGN_PAUSED',
      entityType: 'vendor_campaigns',
      entityId: campaignId,
      details: {},
    });
    return res.json({ success: true, campaign: await readCampaign(campaignId) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to update status' });
  }
});

router.delete('/:campaignId', async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const campaignId = cleanText(req.params.campaignId, 80);
    const existing = await readCampaign(campaignId);
    if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });

    await withMysqlConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        await connection.query(
          'UPDATE vendor_campaigns SET is_active = 0, deleted_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?',
          [campaignId]
        );
        if (existing.coupon_id) {
          await connection.query('UPDATE vendor_plan_coupons SET is_active = 0 WHERE id = ?', [existing.coupon_id]);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: 'VENDOR_CAMPAIGN_DELETED',
      entityType: 'vendor_campaigns',
      entityId: campaignId,
      details: { coupon_id: existing.coupon_id || null },
    });
    return res.json({ success: true });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Failed to delete campaign' });
  }
});

export default router;
