import { mysqlQuery } from './mysqlPool.js';

const LEVELS = new Set(['head', 'sub', 'micro']);
const DAY_RANGES = new Set([0, 7, 30, 90, 180, 365]);

const LEVEL_CONFIG = {
  head: {
    assignmentColumn: 'head_id',
    catalogSql: `
      SELECT
        hc.id AS category_id,
        hc.name AS category_name,
        hc.slug AS category_slug,
        hc.name AS category_path,
        hc.id AS head_category_id,
        hc.name AS head_category_name,
        NULL AS sub_category_id,
        NULL AS sub_category_name
      FROM head_categories hc
      WHERE hc.is_active = 1
    `,
  },
  sub: {
    assignmentColumn: 'sub_id',
    catalogSql: `
      SELECT
        sc.id AS category_id,
        sc.name AS category_name,
        sc.slug AS category_slug,
        CONCAT_WS(' > ', hc.name, sc.name) AS category_path,
        hc.id AS head_category_id,
        hc.name AS head_category_name,
        sc.id AS sub_category_id,
        sc.name AS sub_category_name
      FROM sub_categories sc
      INNER JOIN head_categories hc ON hc.id = sc.head_category_id AND hc.is_active = 1
      WHERE sc.is_active = 1
    `,
  },
  micro: {
    assignmentColumn: 'micro_id',
    catalogSql: `
      SELECT
        mc.id AS category_id,
        mc.name AS category_name,
        mc.slug AS category_slug,
        CONCAT_WS(' > ', hc.name, sc.name, mc.name) AS category_path,
        hc.id AS head_category_id,
        hc.name AS head_category_name,
        sc.id AS sub_category_id,
        sc.name AS sub_category_name
      FROM micro_categories mc
      INNER JOIN sub_categories sc ON sc.id = mc.sub_category_id AND sc.is_active = 1
      INNER JOIN head_categories hc ON hc.id = sc.head_category_id AND hc.is_active = 1
      WHERE mc.is_active = 1
    `,
  },
};

export function normalizeCategoryAnalyticsLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  return LEVELS.has(level) ? level : 'head';
}

export function normalizeCategoryAnalyticsDays(value) {
  const days = Number(value);
  return DAY_RANGES.has(days) ? days : 90;
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 2000;
  return Math.min(5000, Math.floor(limit));
}

function normalizeDetailLimit(value, fallback = 100) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(200, Math.floor(limit));
}

function normalizeCategoryId(value) {
  const categoryId = String(value || '').trim();
  if (!categoryId || categoryId.length > 64) {
    const error = new Error('A valid categoryId is required');
    error.statusCode = 400;
    throw error;
  }
  return categoryId;
}

const splitProductSamples = (value) => String(value || '')
  .split(' || ')
  .map((item) => item.trim())
  .filter(Boolean)
  .slice(0, 5);

function buildSharedCtes({ cutoff, catalogSql }) {
  const proposalDateFilter = cutoff ? 'AND p.created_at >= ?' : '';
  const leadDateFilter = cutoff ? 'AND l.created_at >= ?' : '';
  const params = cutoff ? [cutoff, cutoff] : [];

  return {
    params,
    sql: `
      WITH
      unique_micro_slugs AS (
        SELECT slug, MIN(id) AS id
        FROM micro_categories
        WHERE is_active = 1 AND slug IS NOT NULL AND slug <> ''
        GROUP BY slug
        HAVING COUNT(*) = 1
      ),
      product_assignments AS (
        SELECT
          p.vendor_id,
          p.id AS product_id,
          COALESCE(mc.id, mc_slug.id) AS micro_id,
          COALESCE(sc_from_micro.id, sc_direct.id) AS sub_id,
          COALESCE(sc_from_micro.head_category_id, sc_direct.head_category_id, hc_direct.id) AS head_id,
          'PRODUCT' AS source_type
        FROM products p
        INNER JOIN vendors v ON v.id = p.vendor_id AND v.is_active = 1
        LEFT JOIN micro_categories mc ON mc.id = p.micro_category_id
        LEFT JOIN unique_micro_slugs ums
          ON mc.id IS NULL AND ums.slug = p.category_slug
        LEFT JOIN micro_categories mc_slug ON mc_slug.id = ums.id
        LEFT JOIN sub_categories sc_from_micro
          ON sc_from_micro.id = COALESCE(mc.sub_category_id, mc_slug.sub_category_id)
        LEFT JOIN sub_categories sc_direct ON sc_direct.id = p.sub_category_id
        LEFT JOIN head_categories hc_direct ON hc_direct.id = p.head_category_id
        WHERE UPPER(COALESCE(p.status, '')) IN ('ACTIVE', 'APPROVED', 'PUBLISHED', 'LIVE')
      ),
      product_extra_assignments AS (
        SELECT
          p.vendor_id,
          p.id AS product_id,
          mc.id AS micro_id,
          sc.id AS sub_id,
          sc.head_category_id AS head_id,
          'PRODUCT' AS source_type
        FROM products p
        INNER JOIN vendors v ON v.id = p.vendor_id AND v.is_active = 1
        INNER JOIN JSON_TABLE(
          COALESCE(p.extra_micro_categories, JSON_ARRAY()),
          '$[*]' COLUMNS (
            category_id VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PATH '$'
          )
        ) extra_category
        INNER JOIN micro_categories mc ON mc.id = extra_category.category_id
        INNER JOIN sub_categories sc ON sc.id = mc.sub_category_id
        WHERE UPPER(COALESCE(p.status, '')) IN ('ACTIVE', 'APPROVED', 'PUBLISHED', 'LIVE')
      ),
      preference_assignments AS (
        SELECT
          vp.vendor_id,
          NULL AS product_id,
          mc.id AS micro_id,
          COALESCE(sc_from_micro.id, sc_direct.id) AS sub_id,
          COALESCE(sc_from_micro.head_category_id, sc_direct.head_category_id, hc_direct.id) AS head_id,
          'PREFERENCE' AS source_type
        FROM vendor_preferences vp
        INNER JOIN vendors v ON v.id = vp.vendor_id AND v.is_active = 1
        INNER JOIN JSON_TABLE(
          COALESCE(vp.preferred_micro_categories, JSON_ARRAY()),
          '$[*]' COLUMNS (
            category_id VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PATH '$'
          )
        ) preferred_category
        LEFT JOIN micro_categories mc ON mc.id = preferred_category.category_id
        LEFT JOIN sub_categories sc_from_micro ON sc_from_micro.id = mc.sub_category_id
        LEFT JOIN sub_categories sc_direct ON sc_direct.id = preferred_category.category_id
        LEFT JOIN head_categories hc_direct ON hc_direct.id = preferred_category.category_id
        WHERE COALESCE(mc.id, sc_direct.id, hc_direct.id) IS NOT NULL
      ),
      supply_assignments AS (
        SELECT * FROM product_assignments
        UNION ALL
        SELECT * FROM product_extra_assignments
        UNION ALL
        SELECT * FROM preference_assignments
      ),
      canonical_demand AS (
        SELECT
          CONCAT('proposal:', p.id) AS demand_id,
          CASE
            WHEN p.buyer_id IS NOT NULL THEN CONCAT('buyer:', p.buyer_id)
            WHEN NULLIF(LOWER(TRIM(p.buyer_email)), '') IS NOT NULL
              THEN CONCAT('email:', LOWER(TRIM(p.buyer_email)))
            ELSE NULL
          END AS buyer_key,
          p.micro_category_id,
          p.sub_category_id,
          p.head_category_id,
          p.category_slug,
          p.created_at
        FROM proposals p
        WHERE UPPER(COALESCE(p.status, '')) NOT IN ('CANCELLED', 'DELETED', 'SPAM')
          ${proposalDateFilter}

        UNION ALL

        SELECT
          CONCAT('lead:', l.id) AS demand_id,
          CASE
            WHEN COALESCE(l.buyer_id, l.buyer_user_id) IS NOT NULL
              THEN CONCAT('buyer:', COALESCE(l.buyer_id, l.buyer_user_id))
            WHEN NULLIF(LOWER(TRIM(l.buyer_email)), '') IS NOT NULL
              THEN CONCAT('email:', LOWER(TRIM(l.buyer_email)))
            ELSE NULL
          END AS buyer_key,
          l.micro_category_id,
          l.sub_category_id,
          l.head_category_id,
          l.category_slug,
          l.created_at
        FROM leads l
        WHERE l.proposal_id IS NULL
          AND UPPER(COALESCE(l.status, '')) NOT IN ('CANCELLED', 'DELETED', 'SPAM')
          ${leadDateFilter}
      ),
      demand_assignments AS (
        SELECT
          d.demand_id,
          d.buyer_key,
          d.created_at,
          COALESCE(mc.id, mc_slug.id) AS micro_id,
          COALESCE(sc_from_micro.id, sc_direct.id) AS sub_id,
          COALESCE(sc_from_micro.head_category_id, sc_direct.head_category_id, hc_direct.id) AS head_id
        FROM canonical_demand d
        LEFT JOIN micro_categories mc ON mc.id = d.micro_category_id
        LEFT JOIN unique_micro_slugs ums
          ON mc.id IS NULL AND ums.slug = d.category_slug
        LEFT JOIN micro_categories mc_slug ON mc_slug.id = ums.id
        LEFT JOIN sub_categories sc_from_micro
          ON sc_from_micro.id = COALESCE(mc.sub_category_id, mc_slug.sub_category_id)
        LEFT JOIN sub_categories sc_direct ON sc_direct.id = d.sub_category_id
        LEFT JOIN head_categories hc_direct ON hc_direct.id = d.head_category_id
      ),
      category_catalog AS (
        ${catalogSql}
      )
    `,
  };
}

function addOpportunityMetrics(row) {
  const vendorCount = Number(row.vendor_count || 0);
  const requirementCount = Number(row.requirement_count || 0);
  const buyerCount = Number(row.buyer_count || 0);
  const demandPerVendor = vendorCount > 0
    ? Number((requirementCount / vendorCount).toFixed(2))
    : requirementCount > 0
      ? null
      : 0;

  let matchStatus = 'SUPPLY_ONLY';
  if (requirementCount > 0 && vendorCount === 0) matchStatus = 'NO_SUPPLY';
  else if (requirementCount > 0 && demandPerVendor >= 2) matchStatus = 'HIGH_DEMAND';
  else if (requirementCount > 0 && demandPerVendor >= 0.5) matchStatus = 'BALANCED';
  else if (requirementCount > 0) matchStatus = 'SUPPLY_HEAVY';

  const opportunityScore = requirementCount > 0
    ? Number(((vendorCount === 0 ? requirementCount * 10 : demandPerVendor * 10) + buyerCount).toFixed(2))
    : 0;

  return {
    ...row,
    vendor_count: vendorCount,
    listed_vendor_count: Number(row.listed_vendor_count || 0),
    preference_vendor_count: Number(row.preference_vendor_count || 0),
    active_product_count: Number(row.active_product_count || 0),
    requirement_count: requirementCount,
    buyer_count: buyerCount,
    net_supply_gap: requirementCount - vendorCount,
    demand_per_vendor: demandPerVendor,
    match_status: matchStatus,
    opportunity_score: opportunityScore,
  };
}

export async function getCategoryDemandAnalytics({ level, days, limit } = {}) {
  const normalizedLevel = normalizeCategoryAnalyticsLevel(level);
  const normalizedDays = normalizeCategoryAnalyticsDays(days);
  const normalizedLimit = normalizeLimit(limit);
  const config = LEVEL_CONFIG[normalizedLevel];
  const cutoff = normalizedDays > 0
    ? new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000)
    : null;
  const shared = buildSharedCtes({ cutoff, catalogSql: config.catalogSql });
  const assignmentColumn = config.assignmentColumn;

  const rowsSql = `
    ${shared.sql},
    supply_aggregate AS (
      SELECT
        ${assignmentColumn} AS category_id,
        COUNT(DISTINCT vendor_id) AS vendor_count,
        COUNT(DISTINCT CASE WHEN source_type = 'PRODUCT' THEN vendor_id END) AS listed_vendor_count,
        COUNT(DISTINCT CASE WHEN source_type = 'PREFERENCE' THEN vendor_id END) AS preference_vendor_count,
        COUNT(DISTINCT product_id) AS active_product_count
      FROM supply_assignments
      WHERE ${assignmentColumn} IS NOT NULL
      GROUP BY ${assignmentColumn}
    ),
    demand_aggregate AS (
      SELECT
        ${assignmentColumn} AS category_id,
        COUNT(DISTINCT demand_id) AS requirement_count,
        COUNT(DISTINCT buyer_key) AS buyer_count,
        MAX(created_at) AS latest_requirement_at
      FROM demand_assignments
      WHERE ${assignmentColumn} IS NOT NULL
      GROUP BY ${assignmentColumn}
    )
    SELECT
      catalog.*,
      COALESCE(supply.vendor_count, 0) AS vendor_count,
      COALESCE(supply.listed_vendor_count, 0) AS listed_vendor_count,
      COALESCE(supply.preference_vendor_count, 0) AS preference_vendor_count,
      COALESCE(supply.active_product_count, 0) AS active_product_count,
      COALESCE(demand.requirement_count, 0) AS requirement_count,
      COALESCE(demand.buyer_count, 0) AS buyer_count,
      demand.latest_requirement_at,
      COUNT(*) OVER() AS total_rows
    FROM category_catalog catalog
    LEFT JOIN supply_aggregate supply ON supply.category_id = catalog.category_id
    LEFT JOIN demand_aggregate demand ON demand.category_id = catalog.category_id
    WHERE supply.category_id IS NOT NULL OR demand.category_id IS NOT NULL
    ORDER BY
      COALESCE(demand.requirement_count, 0) DESC,
      COALESCE(supply.vendor_count, 0) DESC,
      catalog.category_name ASC
    LIMIT ?
  `;

  const vendorSummarySql = `
    ${shared.sql}
    SELECT
      (SELECT COUNT(*) FROM vendors WHERE is_active = 1) AS active_vendors,
      COUNT(DISTINCT CASE WHEN ${assignmentColumn} IS NOT NULL THEN vendor_id END) AS categorized_vendors
    FROM supply_assignments
  `;

  const demandSummarySql = `
    ${shared.sql}
    SELECT
      COUNT(DISTINCT demand_id) AS total_requirements,
      COUNT(DISTINCT buyer_key) AS total_buyers,
      COUNT(DISTINCT CASE WHEN ${assignmentColumn} IS NOT NULL THEN demand_id END) AS categorized_requirements,
      COUNT(DISTINCT CASE WHEN ${assignmentColumn} IS NOT NULL THEN buyer_key END) AS categorized_buyers,
      COUNT(DISTINCT CASE WHEN buyer_key IS NULL THEN demand_id END) AS anonymous_requirements,
      MAX(created_at) AS latest_requirement_at
    FROM demand_assignments
  `;

  const [rawRows, vendorSummaryRows, demandSummaryRows] = await Promise.all([
    mysqlQuery(rowsSql, [...shared.params, normalizedLimit]),
    mysqlQuery(vendorSummarySql, shared.params),
    mysqlQuery(demandSummarySql, shared.params),
  ]);

  const rows = (rawRows || []).map(({ total_rows: _totalRows, ...row }) => addOpportunityMetrics(row));
  const totalRows = Number(rawRows?.[0]?.total_rows || rows.length);
  const vendorSummary = vendorSummaryRows?.[0] || {};
  const demandSummary = demandSummaryRows?.[0] || {};
  const activeVendors = Number(vendorSummary.active_vendors || 0);
  const categorizedVendors = Number(vendorSummary.categorized_vendors || 0);
  const totalRequirements = Number(demandSummary.total_requirements || 0);
  const categorizedRequirements = Number(demandSummary.categorized_requirements || 0);
  const matchedRequirements = rows.reduce(
    (total, row) => total + (row.vendor_count > 0 ? row.requirement_count : 0),
    0
  );

  return {
    level: normalizedLevel,
    days: normalizedDays,
    generated_at: new Date().toISOString(),
    rows,
    summary: {
      active_vendors: activeVendors,
      categorized_vendors: categorizedVendors,
      uncategorized_vendors: Math.max(0, activeVendors - categorizedVendors),
      total_buyers: Number(demandSummary.total_buyers || 0),
      categorized_buyers: Number(demandSummary.categorized_buyers || 0),
      total_requirements: totalRequirements,
      categorized_requirements: categorizedRequirements,
      uncategorized_requirements: Math.max(0, totalRequirements - categorizedRequirements),
      anonymous_requirements: Number(demandSummary.anonymous_requirements || 0),
      matched_requirements: matchedRequirements,
      demand_coverage_percent: categorizedRequirements > 0
        ? Number(((matchedRequirements / categorizedRequirements) * 100).toFixed(1))
        : 0,
      opportunity_categories: rows.filter((row) => ['NO_SUPPLY', 'HIGH_DEMAND'].includes(row.match_status)).length,
      active_categories: totalRows,
      latest_requirement_at: demandSummary.latest_requirement_at || null,
    },
    pagination: {
      returned: rows.length,
      total: totalRows,
      limit: normalizedLimit,
      truncated: rows.length < totalRows,
    },
    methodology: {
      supply: 'Distinct active vendors with active product listings or saved category preferences.',
      demand: 'Buyer proposals plus standalone leads; proposal-mirrored lead rows are excluded.',
    },
  };
}

export async function getCategoryDemandDetails({
  level,
  days,
  categoryId,
  vendorLimit,
  demandLimit,
} = {}) {
  const normalizedLevel = normalizeCategoryAnalyticsLevel(level);
  const normalizedDays = normalizeCategoryAnalyticsDays(days);
  const normalizedCategoryId = normalizeCategoryId(categoryId);
  const normalizedVendorLimit = normalizeDetailLimit(vendorLimit, 100);
  const normalizedDemandLimit = normalizeDetailLimit(demandLimit, 100);
  const config = LEVEL_CONFIG[normalizedLevel];
  const assignmentColumn = config.assignmentColumn;
  const cutoff = normalizedDays > 0
    ? new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000)
    : null;
  const shared = buildSharedCtes({ cutoff, catalogSql: config.catalogSql });

  const categoryRows = await mysqlQuery(
    `SELECT *
       FROM (${config.catalogSql}) category_catalog
      WHERE category_id = ?
      LIMIT 1`,
    [normalizedCategoryId]
  );
  const category = categoryRows?.[0];
  if (!category) {
    const error = new Error('Category not found');
    error.statusCode = 404;
    throw error;
  }

  const vendorSql = `
    ${shared.sql},
    vendor_membership AS (
      SELECT
        sa.vendor_id,
        COUNT(DISTINCT sa.product_id) AS active_product_count,
        MAX(sa.source_type = 'PRODUCT') AS has_listing,
        MAX(sa.source_type = 'PREFERENCE') AS has_preference,
        MAX(CASE WHEN sa.source_type = 'PRODUCT' THEN p.updated_at END) AS latest_product_at,
        GROUP_CONCAT(
          DISTINCT CASE WHEN sa.source_type = 'PRODUCT' THEN NULLIF(TRIM(p.name), '') END
          ORDER BY p.updated_at DESC
          SEPARATOR ' || '
        ) AS product_samples
      FROM supply_assignments sa
      LEFT JOIN products p ON p.id = sa.product_id
      WHERE sa.${assignmentColumn} = ?
      GROUP BY sa.vendor_id
    )
    SELECT
      v.id,
      v.vendor_id AS display_vendor_id,
      v.slug,
      v.company_name,
      v.owner_name,
      v.email,
      v.phone,
      COALESCE(NULLIF(v.city, ''), city_ref.name) AS city,
      COALESCE(NULLIF(v.state, ''), state_ref.name) AS state,
      v.pincode,
      v.kyc_status,
      v.kyc_completed,
      v.is_verified,
      v.verification_badge,
      v.profile_completion,
      v.primary_business_type,
      v.status,
      v.account_status,
      v.created_at,
      vm.active_product_count,
      vm.has_listing,
      vm.has_preference,
      vm.latest_product_at,
      vm.product_samples,
      COUNT(*) OVER() AS detail_total
    FROM vendor_membership vm
    INNER JOIN vendors v ON v.id = vm.vendor_id AND v.is_active = 1
    LEFT JOIN cities city_ref ON city_ref.id = v.city_id
    LEFT JOIN states state_ref ON state_ref.id = v.state_id
    ORDER BY
      vm.has_listing DESC,
      vm.active_product_count DESC,
      v.is_verified DESC,
      v.updated_at DESC
    LIMIT ?
  `;

  const demandSql = `
    ${shared.sql}
    SELECT
      da.demand_id,
      CASE WHEN p.id IS NOT NULL THEN 'PROPOSAL' ELSE 'LEAD' END AS source_type,
      COALESCE(p.id, l.id) AS source_id,
      da.buyer_key,
      COALESCE(proposal_buyer.id, lead_buyer.id, lead_user_buyer.id, p.buyer_id, l.buyer_id) AS buyer_id,
      COALESCE(proposal_buyer.full_name, lead_buyer.full_name, lead_user_buyer.full_name, l.buyer_name) AS buyer_name,
      COALESCE(NULLIF(p.buyer_email, ''), proposal_buyer.email, NULLIF(l.buyer_email, ''), lead_buyer.email, lead_user_buyer.email) AS buyer_email,
      COALESCE(proposal_buyer.phone, NULLIF(l.buyer_phone, ''), lead_buyer.phone, lead_user_buyer.phone) AS buyer_phone,
      COALESCE(proposal_buyer.company_name, NULLIF(l.company_name, ''), lead_buyer.company_name, lead_user_buyer.company_name) AS company_name,
      COALESCE(NULLIF(p.title, ''), NULLIF(l.title, '')) AS title,
      COALESCE(NULLIF(p.product_name, ''), NULLIF(l.product_name, ''), NULLIF(l.product_interest, '')) AS product_name,
      COALESCE(NULLIF(p.quantity, ''), NULLIF(l.quantity, '')) AS quantity,
      COALESCE(CAST(p.budget AS CHAR), NULLIF(l.budget, '')) AS budget,
      COALESCE(NULLIF(p.status, ''), NULLIF(l.status, '')) AS status,
      COALESCE(NULLIF(p.location, ''), NULLIF(l.location, '')) AS location,
      COALESCE(NULLIF(l.city, ''), proposal_buyer.city, lead_buyer.city, lead_user_buyer.city) AS city,
      COALESCE(NULLIF(l.state, ''), proposal_buyer.state, lead_buyer.state, lead_user_buyer.state) AS state,
      COALESCE(NULLIF(p.description, ''), NULLIF(l.description, ''), NULLIF(l.message, '')) AS description,
      p.required_by_date,
      da.created_at,
      CASE
        WHEN COALESCE(p.micro_category_id, l.micro_category_id) IS NOT NULL THEN 'MICRO_ID'
        WHEN COALESCE(p.sub_category_id, l.sub_category_id) IS NOT NULL THEN 'SUB_ID'
        WHEN COALESCE(p.head_category_id, l.head_category_id) IS NOT NULL THEN 'HEAD_ID'
        WHEN COALESCE(NULLIF(p.category_slug, ''), NULLIF(l.category_slug, '')) IS NOT NULL THEN 'UNIQUE_SLUG'
        ELSE 'UNMAPPED'
      END AS category_mapping_source,
      COUNT(*) OVER() AS detail_total
    FROM demand_assignments da
    LEFT JOIN proposals p ON da.demand_id = CONCAT('proposal:', p.id)
    LEFT JOIN leads l ON da.demand_id = CONCAT('lead:', l.id)
    LEFT JOIN buyers proposal_buyer ON proposal_buyer.id = p.buyer_id
    LEFT JOIN buyers lead_buyer ON lead_buyer.id = l.buyer_id
    LEFT JOIN buyers lead_user_buyer ON lead_user_buyer.user_id = l.buyer_user_id
    WHERE da.${assignmentColumn} = ?
    ORDER BY da.created_at DESC
    LIMIT ?
  `;

  const mirroredSql = `
    ${shared.sql}
    SELECT COUNT(DISTINCT l.id) AS mirrored_leads_excluded
    FROM demand_assignments da
    INNER JOIN proposals p ON da.demand_id = CONCAT('proposal:', p.id)
    INNER JOIN leads l ON l.proposal_id = p.id
    WHERE da.${assignmentColumn} = ?
  `;

  const [rawVendors, rawDemand, mirroredRows] = await Promise.all([
    mysqlQuery(vendorSql, [...shared.params, normalizedCategoryId, normalizedVendorLimit]),
    mysqlQuery(demandSql, [...shared.params, normalizedCategoryId, normalizedDemandLimit]),
    mysqlQuery(mirroredSql, [...shared.params, normalizedCategoryId]),
  ]);

  const vendorTotal = Number(rawVendors?.[0]?.detail_total || 0);
  const requirementTotal = Number(rawDemand?.[0]?.detail_total || 0);
  const vendors = (rawVendors || []).map(({ detail_total: _detailTotal, product_samples: productSamples, ...row }) => ({
    ...row,
    active_product_count: Number(row.active_product_count || 0),
    has_listing: Boolean(row.has_listing),
    has_preference: Boolean(row.has_preference),
    product_samples: splitProductSamples(productSamples),
    membership_source: row.has_listing && row.has_preference
      ? 'LISTING_AND_PREFERENCE'
      : row.has_listing
        ? 'LISTING'
        : 'PREFERENCE',
  }));
  const requirements = (rawDemand || []).map(({ detail_total: _detailTotal, ...row }) => ({
    ...row,
    has_buyer_identity: Boolean(row.buyer_id || row.buyer_key),
    has_buyer_contact: Boolean(row.buyer_email || row.buyer_phone),
  }));

  const activityCutoffSql = cutoff ? 'AND e.created_at >= ?' : '';
  const activityCutoffParams = cutoff ? [cutoff] : [];
  const categorySearchText = String(category.category_name || '').trim();
  const categorySlug = String(category.category_slug || '').trim();
  const entityPathMatch = categorySlug ? `%${categorySlug}%` : `%${normalizedCategoryId}%`;
  const activityPredicate = `(
    LOWER(COALESCE(e.category, '')) = LOWER(?)
    OR e.entity_id = ?
    OR e.entity_id LIKE ?
    OR MATCH(e.search_query, e.category, e.entity_name) AGAINST (? IN NATURAL LANGUAGE MODE)
  )`;
  const activityParams = [
    ...activityCutoffParams,
    categorySearchText,
    normalizedCategoryId,
    entityPathMatch,
    categorySearchText,
  ];
  const activitySummarySql = `
    SELECT
      COUNT(*) AS total_events,
      COUNT(DISTINCT COALESCE(e.visitor_id, e.visitor_session_id)) AS unique_visitors,
      SUM(e.event_type = 'SEARCH') AS searches,
      SUM(e.event_type = 'PRODUCT_VIEW') AS product_views,
      SUM(e.event_type = 'VENDOR_VIEW') AS vendor_views,
      SUM(e.event_type = 'CATEGORY_VIEW') AS category_views,
      MAX(e.created_at) AS latest_activity_at
    FROM website_visitor_events e
    WHERE e.event_type IN ('SEARCH', 'PRODUCT_VIEW', 'VENDOR_VIEW', 'CATEGORY_VIEW')
      ${activityCutoffSql}
      AND ${activityPredicate}
  `;
  const topSearchesSql = `
    SELECT
      e.search_query,
      COUNT(*) AS event_count,
      COUNT(DISTINCT COALESCE(e.visitor_id, e.visitor_session_id)) AS unique_visitors,
      MAX(e.created_at) AS latest_at
    FROM website_visitor_events e
    WHERE e.event_type = 'SEARCH'
      AND e.search_query IS NOT NULL
      AND e.search_query <> ''
      ${activityCutoffSql}
      AND ${activityPredicate}
    GROUP BY e.search_query
    ORDER BY event_count DESC, latest_at DESC
    LIMIT 10
  `;

  const [activitySummaryRows, topSearchRows] = await Promise.all([
    mysqlQuery(activitySummarySql, activityParams).catch(() => []),
    mysqlQuery(topSearchesSql, activityParams).catch(() => []),
  ]);
  const activitySummary = activitySummaryRows?.[0] || {};
  const preferenceOnly = vendors.filter((vendor) => vendor.has_preference && !vendor.has_listing).length;
  const listingOnly = vendors.filter((vendor) => vendor.has_listing && !vendor.has_preference).length;
  const bothSources = vendors.filter((vendor) => vendor.has_listing && vendor.has_preference).length;
  const missingBuyerContact = requirements.filter((requirement) => !requirement.has_buyer_contact).length;
  const anonymousRequirements = requirements.filter((requirement) => !requirement.has_buyer_identity).length;

  return {
    level: normalizedLevel,
    days: normalizedDays,
    generated_at: new Date().toISOString(),
    category,
    totals: {
      vendors: vendorTotal,
      requirements: requirementTotal,
      returned_vendors: vendors.length,
      returned_requirements: requirements.length,
    },
    reconciliation: {
      has_supply_and_demand: vendorTotal > 0 && requirementTotal > 0,
      mirrored_leads_excluded: Number(mirroredRows?.[0]?.mirrored_leads_excluded || 0),
      preference_only_vendors: preferenceOnly,
      listing_only_vendors: listingOnly,
      listing_and_preference_vendors: bothSources,
      requirements_without_contact: missingBuyerContact,
      anonymous_requirements: anonymousRequirements,
    },
    vendors,
    requirements,
    activity: {
      total_events: Number(activitySummary.total_events || 0),
      unique_visitors: Number(activitySummary.unique_visitors || 0),
      searches: Number(activitySummary.searches || 0),
      product_views: Number(activitySummary.product_views || 0),
      vendor_views: Number(activitySummary.vendor_views || 0),
      category_views: Number(activitySummary.category_views || 0),
      latest_activity_at: activitySummary.latest_activity_at || null,
      top_searches: (topSearchRows || []).map((row) => ({
        ...row,
        event_count: Number(row.event_count || 0),
        unique_visitors: Number(row.unique_visitors || 0),
      })),
    },
    methodology: {
      supply: 'Distinct active vendors with an active listing or saved category preference.',
      demand: 'Non-cancelled buyer proposals plus standalone leads. Proposal-mirrored leads are excluded.',
      activity: 'Public search, category, product, and vendor events associated with this category.',
    },
  };
}
