import express from 'express';
import { randomUUID } from 'crypto';
import { db } from '../lib/dbClient.js';
import { mysqlQuery } from '../lib/mysqlPool.js';
import { normalizeEmail } from '../lib/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  VENDOR_CAMPAIGN_EVENTS,
  ensureVendorCampaignTables,
  getCampaignEffectiveStatus,
  isCampaignTargetedToVendor,
  normalizeCampaignRow,
} from '../lib/vendorCampaigns.js';

const router = express.Router();

const text = (value, max = 500) => String(value || '').trim().slice(0, max);
const PUBLIC_VISITOR_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;

const toPublicCampaign = (campaign = {}) => ({
  id: campaign.id,
  placement: campaign.placement,
  campaign_type: campaign.campaign_type,
  title: campaign.title,
  message: campaign.message,
  style_variant: campaign.style_variant,
  cta_label: campaign.cta_label,
  cta_url: campaign.cta_url,
  coupon_code: campaign.coupon_code,
  discount_type: campaign.discount_type,
  discount_value: campaign.discount_value,
  starts_at: campaign.starts_at,
  ends_at: campaign.ends_at,
  priority: campaign.priority,
  dismissible: campaign.dismissible,
  max_impressions_per_vendor: campaign.max_impressions_per_vendor,
  effective_status: getCampaignEffectiveStatus(campaign),
});

const normalizePublicEventMetadata = (metadata = {}) => ({
  path: text(metadata?.path, 500),
  destination: text(metadata?.destination, 500),
});

async function resolveVendorForCampaigns(user = {}) {
  const userId = text(user.id, 80);
  const email = normalizeEmail(user.email || '');

  if (userId) {
    const { data, error } = await db
      .from('vendors')
      .select('id, vendor_id, user_id, company_name, owner_name, email')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.id) return data;
  }

  if (email) {
    const { data, error } = await db
      .from('vendors')
      .select('id, vendor_id, user_id, company_name, owner_name, email')
      .ilike('email', email)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.id) return data;
  }

  return null;
}

router.get('/homepage/active', async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const visitorId = text(req.query?.visitor_id, 80);
    if (!PUBLIC_VISITOR_ID_RE.test(visitorId)) {
      return res.status(400).json({ success: false, error: 'A valid homepage visitor ID is required' });
    }

    const rows = await mysqlQuery(
      `SELECT c.*
         FROM vendor_campaigns c
        WHERE c.deleted_at IS NULL
          AND c.placement = 'HOMEPAGE'
          AND c.is_active = 1
          AND c.starts_at <= UTC_TIMESTAMP()
          AND c.ends_at > UTC_TIMESTAMP()
        ORDER BY c.priority DESC, c.starts_at DESC, c.created_at DESC
        LIMIT 50`
    );
    const campaigns = rows.map(normalizeCampaignRow);
    if (!campaigns.length) {
      return res.json({ success: true, campaigns: [] });
    }

    const campaignIds = campaigns.map((campaign) => campaign.id);
    const placeholders = campaignIds.map(() => '?').join(', ');
    const impressionRows = await mysqlQuery(
      `SELECT campaign_id, COUNT(*) AS impressions
         FROM homepage_campaign_events
        WHERE visitor_id = ?
          AND event_type = 'IMPRESSION'
          AND campaign_id IN (${placeholders})
        GROUP BY campaign_id`,
      [visitorId, ...campaignIds]
    );
    const impressionsByCampaign = new Map(
      impressionRows.map((row) => [String(row.campaign_id), Number(row.impressions || 0)])
    );

    const deliverable = campaigns
      .filter((campaign) => {
        const limit = Number(campaign.max_impressions_per_vendor || 0);
        if (limit <= 0) return true;
        return (impressionsByCampaign.get(String(campaign.id)) || 0) < limit;
      })
      .slice(0, 10)
      .map(toPublicCampaign);

    return res.json({ success: true, campaigns: deliverable });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load homepage campaigns' });
  }
});

router.post('/homepage/:campaignId/events', async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const campaignId = text(req.params.campaignId, 80);
    const visitorId = text(req.body?.visitor_id, 80);
    const eventType = text(req.body?.event_type, 32).toUpperCase();
    const sessionKey = text(req.body?.session_key, 100);
    if (
      !campaignId ||
      !PUBLIC_VISITOR_ID_RE.test(visitorId) ||
      !VENDOR_CAMPAIGN_EVENTS.has(eventType) ||
      !sessionKey
    ) {
      return res.status(400).json({
        success: false,
        error: 'Campaign, visitor, event type, and session are required',
      });
    }

    const rows = await mysqlQuery(
      `SELECT *
         FROM vendor_campaigns
        WHERE id = ?
          AND placement = 'HOMEPAGE'
          AND deleted_at IS NULL
        LIMIT 1`,
      [campaignId]
    );
    const campaign = rows[0] ? normalizeCampaignRow(rows[0]) : null;
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Homepage campaign not found' });
    }
    if (getCampaignEffectiveStatus(campaign) !== 'ACTIVE') {
      return res.status(409).json({ success: false, error: 'Homepage campaign is not active' });
    }

    await mysqlQuery(
      `INSERT IGNORE INTO homepage_campaign_events
        (id, campaign_id, visitor_id, event_type, session_key, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [
        randomUUID(),
        campaign.id,
        visitorId,
        eventType,
        sessionKey,
        JSON.stringify(normalizePublicEventMetadata(req.body?.metadata)),
      ]
    );

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to record homepage campaign event' });
  }
});

router.get('/active', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const vendor = await resolveVendorForCampaigns(req.user);
    if (!vendor?.id) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    }

    const previewMode = ['1', 'true', 'yes'].includes(
      String(req.query?.preview || '').trim().toLowerCase()
    ) && Boolean(req.user?.impersonated_by);

    const rows = await mysqlQuery(
      `SELECT c.*
         FROM vendor_campaigns c
        WHERE c.deleted_at IS NULL
          AND c.placement = 'VENDOR_PORTAL'
          AND c.is_active = 1
          AND c.starts_at <= UTC_TIMESTAMP()
          AND c.ends_at > UTC_TIMESTAMP()
        ORDER BY c.priority DESC, c.starts_at DESC, c.created_at DESC
        LIMIT 50`
    );

    const targeted = rows
      .map(normalizeCampaignRow)
      .filter((campaign) => isCampaignTargetedToVendor(campaign, vendor));

    if (!targeted.length) {
      return res.json({ success: true, vendor_id: vendor.id, campaigns: [] });
    }

    const campaignIds = targeted.map((campaign) => campaign.id);
    const placeholders = campaignIds.map(() => '?').join(', ');
    const impressionRows = await mysqlQuery(
      `SELECT campaign_id, COUNT(*) AS impressions
         FROM vendor_campaign_events
        WHERE vendor_id = ?
          AND event_type = 'IMPRESSION'
          AND campaign_id IN (${placeholders})
        GROUP BY campaign_id`,
      [vendor.id, ...campaignIds]
    );
    const impressionsByCampaign = new Map(
      impressionRows.map((row) => [String(row.campaign_id), Number(row.impressions || 0)])
    );

    const campaigns = targeted
      .filter((campaign) => {
        if (previewMode) return true;
        const limit = Number(campaign.max_impressions_per_vendor || 0);
        if (limit <= 0) return true;
        return (impressionsByCampaign.get(String(campaign.id)) || 0) < limit;
      })
      .slice(0, 10)
      .map((campaign) => ({
        ...campaign,
        effective_status: getCampaignEffectiveStatus(campaign),
        impressions_for_vendor: impressionsByCampaign.get(String(campaign.id)) || 0,
        preview_mode: previewMode,
      }));

    return res.json({ success: true, vendor_id: vendor.id, preview_mode: previewMode, campaigns });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load campaigns' });
  }
});

router.post('/:campaignId/events', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    await ensureVendorCampaignTables();
    const vendor = await resolveVendorForCampaigns(req.user);
    if (!vendor?.id) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    }

    const campaignId = text(req.params.campaignId, 80);
    const eventType = text(req.body?.event_type, 32).toUpperCase();
    const sessionKey = text(req.body?.session_key, 100);
    if (!campaignId || !VENDOR_CAMPAIGN_EVENTS.has(eventType) || !sessionKey) {
      return res.status(400).json({
        success: false,
        error: 'campaignId, a valid event_type, and session_key are required',
      });
    }

    const campaigns = await mysqlQuery(
      `SELECT * FROM vendor_campaigns WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [campaignId]
    );
    const campaign = campaigns[0] ? normalizeCampaignRow(campaigns[0]) : null;
    if (
      !campaign ||
      campaign.placement !== 'VENDOR_PORTAL' ||
      !isCampaignTargetedToVendor(campaign, vendor)
    ) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    if (eventType === 'IMPRESSION' && getCampaignEffectiveStatus(campaign) !== 'ACTIVE') {
      return res.status(409).json({ success: false, error: 'Campaign is not active' });
    }

    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : {};
    await mysqlQuery(
      `INSERT IGNORE INTO vendor_campaign_events
        (id, campaign_id, vendor_id, event_type, session_key, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [
        randomUUID(),
        campaign.id,
        vendor.id,
        eventType,
        sessionKey,
        JSON.stringify(metadata),
      ]
    );

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to record event' });
  }
});

export default router;
