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
