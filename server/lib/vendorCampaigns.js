import { mysqlQuery } from './mysqlPool.js';

export const VENDOR_CAMPAIGN_TYPES = new Set(['ANNOUNCEMENT', 'DISCOUNT', 'COUPON']);
export const VENDOR_CAMPAIGN_TARGETS = new Set(['ALL', 'SELECTED']);
export const VENDOR_CAMPAIGN_VARIANTS = new Set(['INFO', 'SUCCESS', 'WARNING', 'PREMIUM']);
export const VENDOR_CAMPAIGN_EVENTS = new Set(['IMPRESSION', 'CLICK', 'DISMISS', 'COPY_CODE']);
export const VENDOR_CAMPAIGN_PLACEMENTS = new Set(['VENDOR_PORTAL', 'HOMEPAGE']);

let ensureTablesPromise = null;

export const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const parseJsonObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const normalizeCampaignRow = (row = {}) => ({
  ...row,
  placement: VENDOR_CAMPAIGN_PLACEMENTS.has(String(row.placement || '').trim().toUpperCase())
    ? String(row.placement).trim().toUpperCase()
    : 'VENDOR_PORTAL',
  target_vendor_ids: parseJsonArray(row.target_vendor_ids)
    .map((id) => String(id || '').trim())
    .filter(Boolean),
  is_active: Boolean(row.is_active),
  dismissible: Boolean(row.dismissible),
  priority: Number(row.priority || 0),
  max_impressions_per_vendor: Number(row.max_impressions_per_vendor || 0),
  discount_value:
    row.discount_value === null || row.discount_value === undefined
      ? null
      : Number(row.discount_value),
  max_uses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
  impressions: Number(row.impressions || 0),
  clicks: Number(row.clicks || 0),
  dismissals: Number(row.dismissals || 0),
  code_copies: Number(row.code_copies || 0),
  unique_vendors_reached: Number(row.unique_vendors_reached || 0),
});

export const getCampaignEffectiveStatus = (campaign = {}, now = new Date()) => {
  if (campaign.deleted_at) return 'DELETED';
  if (!campaign.is_active) return 'PAUSED';

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startsAtMs = campaign.starts_at ? new Date(campaign.starts_at).getTime() : null;
  const endsAtMs = campaign.ends_at ? new Date(campaign.ends_at).getTime() : null;

  if (Number.isFinite(startsAtMs) && startsAtMs > nowMs) return 'SCHEDULED';
  if (Number.isFinite(endsAtMs) && endsAtMs <= nowMs) return 'EXPIRED';
  return 'ACTIVE';
};

export const isCampaignTargetedToVendor = (campaign = {}, vendor = {}) => {
  const targetType = String(campaign.target_type || 'ALL').trim().toUpperCase();
  if (targetType === 'ALL') return true;
  if (targetType !== 'SELECTED') return false;

  const allowedIds = new Set(
    parseJsonArray(campaign.target_vendor_ids)
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!allowedIds.size) return false;

  const candidates = [vendor.id, vendor.vendor_id]
    .map((id) => String(id || '').trim().toLowerCase())
    .filter(Boolean);
  return candidates.some((candidate) => allowedIds.has(candidate));
};

export async function ensureVendorCampaignTables() {
  if (ensureTablesPromise) return ensureTablesPromise;

  ensureTablesPromise = (async () => {
    await mysqlQuery(`
      CREATE TABLE IF NOT EXISTS vendor_campaigns (
        id CHAR(36) NOT NULL,
        name VARCHAR(191) NOT NULL,
        campaign_type VARCHAR(32) NOT NULL DEFAULT 'ANNOUNCEMENT',
        placement VARCHAR(32) NOT NULL DEFAULT 'VENDOR_PORTAL',
        title VARCHAR(191) NOT NULL,
        message TEXT NOT NULL,
        style_variant VARCHAR(32) NOT NULL DEFAULT 'INFO',
        cta_label VARCHAR(80) NULL,
        cta_url VARCHAR(500) NULL,
        target_type VARCHAR(32) NOT NULL DEFAULT 'ALL',
        target_vendor_ids JSON NULL,
        coupon_id CHAR(36) NULL,
        coupon_code VARCHAR(191) NULL,
        discount_type VARCHAR(20) NULL,
        discount_value DECIMAL(16,2) NULL,
        plan_id CHAR(36) NULL,
        max_uses INT NULL,
        starts_at DATETIME NOT NULL,
        ends_at DATETIME NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        priority INT NOT NULL DEFAULT 50,
        dismissible TINYINT(1) NOT NULL DEFAULT 1,
        max_impressions_per_vendor INT NOT NULL DEFAULT 1,
        created_by CHAR(36) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_vendor_campaigns_delivery (is_active, starts_at, ends_at, priority),
        KEY idx_vendor_campaigns_coupon_id (coupon_id),
        KEY idx_vendor_campaigns_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const campaignColumns = await mysqlQuery(`
      SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'vendor_campaigns'
    `);
    const campaignColumnNames = new Set(
      campaignColumns.map((column) => String(column.COLUMN_NAME || column.column_name || '').toLowerCase())
    );
    if (!campaignColumnNames.has('placement')) {
      await mysqlQuery(`
        ALTER TABLE vendor_campaigns
        ADD COLUMN placement VARCHAR(32) NOT NULL DEFAULT 'VENDOR_PORTAL' AFTER campaign_type
      `);
    }

    const campaignIndexes = await mysqlQuery(`
      SELECT DISTINCT INDEX_NAME
        FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'vendor_campaigns'
    `);
    const campaignIndexNames = new Set(
      campaignIndexes.map((index) => String(index.INDEX_NAME || index.index_name || '').toLowerCase())
    );
    if (!campaignIndexNames.has('idx_vendor_campaigns_placement_delivery')) {
      await mysqlQuery(`
        ALTER TABLE vendor_campaigns
        ADD KEY idx_vendor_campaigns_placement_delivery
          (placement, is_active, starts_at, ends_at, priority)
      `);
    }

    await mysqlQuery(`
      CREATE TABLE IF NOT EXISTS vendor_campaign_events (
        id CHAR(36) NOT NULL,
        campaign_id CHAR(36) NOT NULL,
        vendor_id CHAR(36) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        session_key VARCHAR(100) NOT NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_vendor_campaign_event_session (campaign_id, vendor_id, event_type, session_key),
        KEY idx_vendor_campaign_events_campaign (campaign_id, created_at),
        KEY idx_vendor_campaign_events_vendor (vendor_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await mysqlQuery(`
      CREATE TABLE IF NOT EXISTS homepage_campaign_events (
        id CHAR(36) NOT NULL,
        campaign_id CHAR(36) NOT NULL,
        visitor_id VARCHAR(80) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        session_key VARCHAR(100) NOT NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_homepage_campaign_event_session
          (campaign_id, visitor_id, event_type, session_key),
        KEY idx_homepage_campaign_events_campaign (campaign_id, created_at),
        KEY idx_homepage_campaign_events_visitor (visitor_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })().catch((error) => {
    ensureTablesPromise = null;
    throw error;
  });

  return ensureTablesPromise;
}
