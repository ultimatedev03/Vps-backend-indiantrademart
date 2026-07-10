// ✅ File: server/routes/dir.js
import { logger } from '../utils/logger.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { db } from '../lib/dbClient.js';
import { cacheResponse } from '../lib/cacheMiddleware.js';
import { cacheGetJson, cacheSetJson, isRedisConfigured } from '../lib/redisCache.js';
import { optionalAuth, requireAuth } from '../middleware/requireAuth.js';
import { mysqlQuery } from '../lib/mysqlPool.js';
import {
  autocompleteOpenSearchProducts,
  isOpenSearchCatalogEnabled,
  searchOpenSearchProducts,
} from '../lib/openSearchCatalog.js';

const router = express.Router();

// Plan priority (higher = better)
const PLAN_TIERS = [
  { key: 'diamond', label: 'DIAMOND', priority: 700 },
  { key: 'gold', label: 'GOLD', priority: 600 },
  { key: 'silver', label: 'SILVER', priority: 500 },
  { key: 'booster', label: 'BOOSTER', priority: 400 },
  { key: 'certified', label: 'CERTIFIED', priority: 300 },
  { key: 'startup', label: 'STARTUP', priority: 200 },
  { key: 'trial', label: 'TRIAL', priority: 100 },
];

function normPlanName(name) {
  return String(name || '').trim().toLowerCase();
}

function planToTierKey(planName) {
  const n = normPlanName(planName);
  if (!n) return 'trial';
  if (n.includes('diamond') || n.includes('dimond')) return 'diamond';
  if (n.includes('gold')) return 'gold';
  if (n.includes('silver')) return 'silver';
  if (n.includes('booster') || n.includes('boost')) return 'booster';
  if (n.includes('certified') || n.includes('certificate')) return 'certified';
  if (n.includes('startup')) return 'startup';
  if (n.includes('trial') || n.includes('free')) return 'trial';
  return 'trial';
}

function isValidId(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return s.length > 0;
}

function clampInt(v, def, min, max) {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function safeQ(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.slice(0, 100);
}

function clampRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function safeText(v, max = 1000) {
  return String(v || '').trim().slice(0, max);
}

function normalizeSearchText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifySearch(value = '') {
  return normalizeSearchText(value).replace(/\s+/g, '-').replace(/^-|-$/g, '');
}

const GENERIC_SEARCH_TOKENS = new Set([
  'service',
  'services',
  'supplier',
  'suppliers',
  'manufacturer',
  'manufacturers',
  'company',
  'companies',
  'provider',
  'providers',
  'product',
  'products',
]);

function searchTokens(value = '', max = 8) {
  const tokens = Array.from(
    new Set(
      normalizeSearchText(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );
  const meaningful = tokens.filter((token) => !GENERIC_SEARCH_TOKENS.has(token));
  return (meaningful.length ? meaningful : tokens).slice(0, max);
}

const SEMANTIC_TOKEN_MAP = {
  phone: ['mobile', 'smartphone', 'telephone', 'cellphone'],
  mobile: ['phone', 'smartphone', 'cellphone'],
  laptop: ['notebook', 'computer', 'pc'],
  shoe: ['shoes', 'footwear', 'sneaker', 'sneakers', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots'],
  shoes: ['shoe', 'footwear', 'sneaker', 'sneakers', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots'],
  footwear: ['shoe', 'shoes', 'sneaker', 'sneakers', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots'],
  saree: ['sari', 'fabric', 'textile', 'dress'],
  consultant: ['consulting', 'service', 'advisor', 'engineer'],
  design: ['drawing', 'layout', 'planning', 'engineering'],
  machine: ['machinery', 'equipment', 'tool'],
  survey: ['surveyor', 'surveying', 'topographic', 'dgps', 'total station', 'land survey'],
  surveyor: ['survey', 'surveying', 'topographic', 'dgps', 'total station', 'land survey'],
  surveyors: ['survey', 'surveyor', 'surveying', 'topographic', 'dgps', 'total station', 'land survey'],
  surveying: ['survey', 'surveyor', 'topographic', 'dgps', 'total station', 'land survey'],
  supplier: ['vendor', 'manufacturer', 'dealer'],
  manufacturer: ['supplier', 'vendor', 'producer'],
};

function expandSemanticTokens(value = '') {
  const base = searchTokens(value, 10);
  const expanded = new Set(base);
  base.forEach((token) => {
    addSearchTokenVariants(token, expanded);
    (SEMANTIC_TOKEN_MAP[token] || []).forEach((synonym) => expanded.add(synonym));
  });
  return Array.from(expanded).slice(0, 16);
}

function addSearchTokenVariants(token = '', target = new Set()) {
  const value = String(token || '').trim();
  if (value.length < 2) return;

  target.add(value);

  if (value === 'shoes') {
    target.add('shoe');
    return;
  }

  if (value.endsWith('ies') && value.length > 4) {
    target.add(`${value.slice(0, -3)}y`);
  }
  if (value.endsWith('es') && value.length > 3) {
    target.add(value.slice(0, -2));
  }
  if (value.endsWith('s') && value.length > 3) {
    target.add(value.slice(0, -1));
  } else if (value.endsWith('e') && value.length >= 3) {
    target.add(`${value}s`);
  } else if (value.length >= 3) {
    target.add(`${value}s`);
    target.add(`${value}es`);
  }
}

function searchTokenVariants(token = '', includeSemantic = true) {
  const variants = new Set();
  addSearchTokenVariants(token, variants);
  if (includeSemantic) {
    (SEMANTIC_TOKEN_MAP[token] || []).forEach((synonym) => addSearchTokenVariants(synonym, variants));
  }
  return Array.from(variants).filter((value) => /^[a-z0-9]+$/.test(value));
}

function wholeTokenRegex(token = '') {
  const variants = searchTokenVariants(token);
  if (!variants.length) return '';
  return `(^|[^[:alnum:]])(${variants.join('|')})([^[:alnum:]]|$)`;
}

function buildBooleanFullTextQuery(value = '') {
  const groups = searchTokens(value, 8)
    .map((token) => searchTokenVariants(token)
      .map((variant) => variant.replace(/[+\-<>()~*"@]+/g, '').trim())
      .filter((variant) => variant.length >= 2)
      .slice(0, 8))
    .filter((variants) => variants.length);
  return groups.length
    ? groups.map((variants) => `+(${variants.map((variant) => `${variant}*`).join(' ')})`).join(' ')
    : '';
}

function levenshteinDistance(a = '', b = '') {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const prev = Array.from({ length: right.length + 1 }, (_, i) => i);
  const curr = new Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
  }
  return prev[right.length];
}

function fuzzySearchScore(query = '', row = {}) {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  const queryTokens = expandSemanticTokens(query);
  const fields = [row.name, row.category, row.category_path, row.category_slug, row.description, row.vendor__company_name]
    .filter(Boolean)
    .map((value) => normalizeSearchText(value));
  let best = 0;
  fields.forEach((field) => {
    if (!field) return;
    if (field === q) best = Math.max(best, 100);
    if (field.includes(q)) best = Math.max(best, 80);
    queryTokens.forEach((token) => {
      if (field.includes(token)) best = Math.max(best, 72);
    });
    field.split(' ').forEach((word) => {
      queryTokens.forEach((token) => {
        const maxLen = Math.max(word.length, token.length);
        if (maxLen < 3) return;
        const distance = levenshteinDistance(word, token);
        const score = Math.max(0, Math.round((1 - distance / maxLen) * 70));
        best = Math.max(best, score);
      });
    });
  });
  return best;
}

function fieldHasSearchToken(field = '', token = '') {
  const normalizedField = normalizeSearchText(field);
  if (!normalizedField) return false;
  return searchTokenVariants(token).some((variant) => {
    if (!variant) return false;
    return normalizedField === variant || normalizedField.startsWith(`${variant} `) || normalizedField.endsWith(` ${variant}`) || normalizedField.includes(` ${variant} `);
  });
}

const LAND_SURVEY_TOKENS = new Set(['survey', 'surveyor', 'surveyors', 'surveying', 'topographic', 'dgps']);
const SURVEY_PRIMARY_NAME_RE = /\b(land\s+survey|land\s+surveyor|survey|surveyor|surveying|topographic|topographical|dgps|total\s+station|route\s+survey|contour\s+survey|cadastral\s+survey)\b/;
const SURVEY_SUPPORTING_NAME_RE = /\b(gps|ts\s+survey|levelling|leveling|mapping|demarcation)\b/;
const NON_SURVEY_ENGINEERING_RE = /\b(geotechnical|geo\s*technical|soil\s+testing|soil|investigation|pile|plate\s+load|thermal\s+resistivity|borehole|cross\s+hole|hydro\s+geological)\b/;

function isLandSurveyIntent(query = '', tokens = searchTokens(query, 8)) {
  const normalized = normalizeSearchText(query);
  const hasSurvey = tokens.some((token) => LAND_SURVEY_TOKENS.has(token)) || /\bsurvey(or|ors|ing)?\b/.test(normalized);
  const hasLand = tokens.includes('land') || /\bland\b/.test(normalized);
  return hasSurvey && (hasLand || /\b(topographic|dgps|total\s+station|route\s+survey)\b/.test(normalized));
}

function surveyIntentBonus(query = '', row = {}) {
  const tokens = searchTokens(query, 8);
  const surveyIntent = tokens.some((token) => LAND_SURVEY_TOKENS.has(token)) || /\bsurvey(or|ors|ing)?\b/.test(normalizeSearchText(query));
  if (!surveyIntent) return 0;

  const landIntent = isLandSurveyIntent(query, tokens);
  const name = normalizeSearchText(row?.name || row?.product_name || row?.title || '');
  const category = normalizeSearchText(row?.category || row?.micro_category_name || '');
  const categoryPath = normalizeSearchText(row?.category_path || row?.category_slug || '');
  const text = `${name} ${category} ${categoryPath}`;
  let bonus = 0;

  if (/\bland\s+(survey|surveyor|surveying)\b/.test(name)) bonus += landIntent ? 760 : 520;
  if (/\b(total\s+station|topographic|topographical|dgps|route\s+survey|contour\s+survey|cadastral\s+survey)\b/.test(name)) bonus += landIntent ? 560 : 380;
  if (SURVEY_PRIMARY_NAME_RE.test(name)) bonus += landIntent ? 360 : 240;
  if (SURVEY_SUPPORTING_NAME_RE.test(name)) bonus += 120;
  if (/\b(land\s+survey|survey|surveyor|surveying)\b/.test(category)) bonus += 140;
  if (/\b(survey|surveyor|surveying|topographic|dgps|total\s+station)\b/.test(categoryPath)) bonus += 70;

  if (!SURVEY_PRIMARY_NAME_RE.test(text) && !SURVEY_SUPPORTING_NAME_RE.test(text)) bonus -= landIntent ? 240 : 120;
  if (NON_SURVEY_ENGINEERING_RE.test(name)) bonus -= landIntent ? 420 : 180;
  if (landIntent && NON_SURVEY_ENGINEERING_RE.test(name) && !SURVEY_PRIMARY_NAME_RE.test(name)) bonus -= 220;

  return bonus;
}

function surveyIntentRank(query = '', row = {}) {
  if (!isLandSurveyIntent(query)) return 0;

  const name = normalizeSearchText(row?.name || row?.product_name || row?.title || '');
  const category = normalizeSearchText(row?.category || row?.micro_category_name || '');
  const categoryPath = normalizeSearchText(row?.category_path || row?.category_slug || '');
  const text = `${name} ${category} ${categoryPath}`;

  if (/\bland\s+(survey|surveyor|surveying)\b/.test(name)) return 70;
  if (/\b(total\s+station|topographic|topographical|dgps|route\s+survey|contour\s+survey|cadastral\s+survey)\b/.test(name)) return 60;
  if (SURVEY_PRIMARY_NAME_RE.test(name)) return 52;
  if (/\b(land\s+survey|survey|surveyor|surveying|topographic|dgps|total\s+station)\b/.test(category)) return 42;
  if (/\b(land\s+survey|survey|surveyor|surveying|topographic|dgps|total\s+station)\b/.test(categoryPath)) return 36;
  if (SURVEY_SUPPORTING_NAME_RE.test(text)) return 24;
  if (NON_SURVEY_ENGINEERING_RE.test(name) && !SURVEY_PRIMARY_NAME_RE.test(name)) return 4;
  return 12;
}

function catalogIntentScore(query = '', row = {}) {
  const q = normalizeSearchText(query);
  if (!q) return 0;

  const tokens = searchTokens(query, 8);
  const name = normalizeSearchText(row?.name || row?.product_name || row?.title || '');
  const category = normalizeSearchText(row?.category || row?.micro_category_name || '');
  const categoryPath = normalizeSearchText(row?.category_path || row?.category_slug || '');
  const description = normalizeSearchText(row?.description || '');
  let score = 0;

  if (name === q) score += 500;
  if (name.includes(q)) score += 260;
  if (category.includes(q)) score += 120;

  tokens.forEach((token) => {
    if (fieldHasSearchToken(name, token)) score += 95;
    if (fieldHasSearchToken(category, token)) score += 34;
    if (fieldHasSearchToken(categoryPath, token)) score += 18;
    if (fieldHasSearchToken(description, token)) score += 8;
  });

  score += surveyIntentBonus(query, row);

  const landIntent = tokens.includes('land');
  if (landIntent && /\bland\b/.test(name)) score += 120;

  return score;
}

function rankRowsForSearchIntent(rows = [], query = '', sort = '') {
  if (!query || sort === 'price_asc' || sort === 'price_desc') return rows;
  const landSurveyIntent = isLandSurveyIntent(query);
  return [...rows].sort((a, b) => {
    if (landSurveyIntent) {
      const surveyDiff = surveyIntentRank(query, b) - surveyIntentRank(query, a);
      if (surveyDiff) return surveyDiff;
    }
    const intentDiff = catalogIntentScore(query, b) - catalogIntentScore(query, a);
    if (intentDiff) return intentDiff;
    const premiumSlotDiff = Number(b.premium_slot_rank || 0) - Number(a.premium_slot_rank || 0);
    if (premiumSlotDiff) return premiumSlotDiff;
    const scoreDiff = Number(b.__sortScore || 0) - Number(a.__sortScore || 0);
    if (scoreDiff) return scoreDiff;
    const slotAwarePlanA = Number(a.premium_slot_rank || 0) > 0 ? Number(a.vendor_plan_priority || 0) : 0;
    const slotAwarePlanB = Number(b.premium_slot_rank || 0) > 0 ? Number(b.vendor_plan_priority || 0) : 0;
    return slotAwarePlanB - slotAwarePlanA;
  });
}

function planPriorityCaseSql() {
  return `CASE
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%diamond%' OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%' THEN 700
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%gold%' THEN 600
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%silver%' THEN 500
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%boost%' THEN 400
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%certif%' THEN 300
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%startup%' THEN 200
    ELSE 100
  END`;
}

function salesAssistedSlotPlanSql() {
  return `(
    LOWER(COALESCE(vp.name, '')) LIKE '%diamond%'
    OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%'
    OR LOWER(COALESCE(vp.name, '')) LIKE '%gold%'
    OR LOWER(COALESCE(vp.name, '')) LIKE '%silver%'
  )`;
}

function preferredCategoryMatchSql() {
  return `(
    p.micro_category_id IS NOT NULL
    AND JSON_LENGTH(COALESCE(vpref.preferred_micro_categories, JSON_ARRAY())) > 0
    AND JSON_CONTAINS(COALESCE(vpref.preferred_micro_categories, JSON_ARRAY()), JSON_QUOTE(p.micro_category_id))
  )`;
}

function premiumSlotMatchSql(args = {}) {
  const location = preferredLocationGate(args);
  return {
    sql: `(
      ${salesAssistedSlotPlanSql()}
      AND ${preferredCategoryMatchSql()}
      AND ${location.sql}
    )`,
    params: location.params,
  };
}

function premiumSlotRankSql(slotMatchSql) {
  return `CASE
    WHEN ${slotMatchSql} THEN ${planPriorityCaseSql()}
    ELSE 0
  END`;
}

function premiumSlotLabelSql(slotMatchSql) {
  return `CASE
    WHEN ${slotMatchSql} AND (LOWER(COALESCE(vp.name, '')) LIKE '%diamond%' OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%') THEN 'Diamond Supplier'
    WHEN ${slotMatchSql} AND LOWER(COALESCE(vp.name, '')) LIKE '%gold%' THEN 'Gold Supplier'
    WHEN ${slotMatchSql} AND LOWER(COALESCE(vp.name, '')) LIKE '%silver%' THEN 'Silver Supplier'
    ELSE ''
  END`;
}

function preferredLocationGate({ stateId, districtId, cityId } = {}) {
  const params = [];

  if (cityId) {
    params.push(cityId, cityId, cityId);
    return {
      sql: `(
        (
          JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
          AND JSON_CONTAINS(COALESCE(vpref.preferred_cities, JSON_ARRAY()), JSON_QUOTE(?))
        )
        OR (
          JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
          AND EXISTS (
            SELECT 1
              FROM cities selected_city
             WHERE selected_city.id = ?
               AND JSON_CONTAINS(COALESCE(vpref.preferred_districts, JSON_ARRAY()), JSON_QUOTE(selected_city.district_id))
          )
        )
        OR (
          JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
          AND EXISTS (
            SELECT 1
              FROM cities selected_city
             WHERE selected_city.id = ?
               AND JSON_CONTAINS(COALESCE(vpref.preferred_states, JSON_ARRAY()), JSON_QUOTE(selected_city.state_id))
          )
        )
      )`,
      params,
    };
  }

  if (districtId) {
    params.push(districtId, districtId, districtId);
    return {
      sql: `(
        (
          JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
          AND JSON_CONTAINS(COALESCE(vpref.preferred_districts, JSON_ARRAY()), JSON_QUOTE(?))
        )
        OR (
          JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
          AND EXISTS (
            SELECT 1
              FROM JSON_TABLE(COALESCE(vpref.preferred_cities, JSON_ARRAY()), '$[*]' COLUMNS(preferred_city_id VARCHAR(64) PATH '$')) preferred_city
              JOIN cities preferred_city_row ON preferred_city_row.id = preferred_city.preferred_city_id
             WHERE preferred_city_row.district_id = ?
          )
        )
        OR (
          JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
          AND EXISTS (
            SELECT 1
              FROM districts selected_district
             WHERE selected_district.id = ?
               AND JSON_CONTAINS(COALESCE(vpref.preferred_states, JSON_ARRAY()), JSON_QUOTE(selected_district.state_id))
          )
        )
      )`,
      params,
    };
  }

  if (stateId) {
    params.push(stateId, stateId, stateId);
    return {
      sql: `(
        (
          JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
          AND JSON_CONTAINS(COALESCE(vpref.preferred_states, JSON_ARRAY()), JSON_QUOTE(?))
        )
        OR (
          JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
          AND EXISTS (
            SELECT 1
              FROM JSON_TABLE(COALESCE(vpref.preferred_districts, JSON_ARRAY()), '$[*]' COLUMNS(preferred_district_id VARCHAR(64) PATH '$')) preferred_district
              JOIN districts preferred_district_row ON preferred_district_row.id = preferred_district.preferred_district_id
             WHERE preferred_district_row.state_id = ?
          )
        )
        OR (
          JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
          AND EXISTS (
            SELECT 1
              FROM JSON_TABLE(COALESCE(vpref.preferred_cities, JSON_ARRAY()), '$[*]' COLUMNS(preferred_city_id VARCHAR(64) PATH '$')) preferred_city
              JOIN cities preferred_city_row ON preferred_city_row.id = preferred_city.preferred_city_id
             WHERE preferred_city_row.state_id = ?
          )
        )
      )`,
      params,
    };
  }

  return {
    sql: `(
      JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
      OR JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
      OR JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
    )`,
    params,
  };
}

function buildPremiumPreferenceGate(args = {}) {
  const location = preferredLocationGate(args);
  return {
    sql: `(
      NOT ${salesAssistedSlotPlanSql()}
      OR COALESCE(v.all_india_visibility, 0) = 1
      OR (
        ${preferredCategoryMatchSql()}
        AND ${location.sql}
      )
    )`,
    params: location.params,
  };
}

function buildProductRowSelect(scoreSql = '0', slotArgs = {}) {
  const slot = premiumSlotMatchSql(slotArgs);
  const slotSql = slot.sql;
  const slotParams = [
    ...slot.params,
    ...slot.params,
    ...slot.params,
    ...slot.params,
    ...slot.params,
  ];

  return {
    sql: `
    SELECT
      p.*,
      v.id AS vendor__id,
      v.company_name AS vendor__company_name,
      v.slug AS vendor__slug,
      v.city AS vendor__city,
      v.state AS vendor__state,
      v.state_id AS vendor__state_id,
      v.district_id AS vendor__district_id,
      v.city_id AS vendor__city_id,
      v.all_india_visibility AS vendor__all_india_visibility,
      v.seller_rating AS vendor__seller_rating,
      v.kyc_status AS vendor__kyc_status,
      v.verification_badge AS vendor__verification_badge,
      v.trust_score AS vendor__trust_score,
      v.gst_verified AS vendor__gst_verified,
      v.year_of_establishment AS vendor__year_of_establishment,
      v.years_in_business AS vendor__years_in_business,
      v.response_rate AS vendor__response_rate,
      COALESCE(vp.name, 'TRIAL') AS vendor_plan_name,
      ${planPriorityCaseSql()} AS vendor_plan_priority,
      CASE WHEN ${slotSql} THEN 1 ELSE 0 END AS premium_slot_matched,
      ${premiumSlotRankSql(slotSql)} AS premium_slot_rank,
      ${premiumSlotLabelSql(slotSql)} AS premium_slot_label,
      ${scoreSql} AS search_score,
      COUNT(*) OVER() AS total_count
  `,
    params: slotParams,
  };
}

function productFromMysqlRow(row = {}) {
  const vendor = {
    id: row.vendor__id || null,
    company_name: row.vendor__company_name || null,
    slug: row.vendor__slug || null,
    city: row.vendor__city || null,
    state: row.vendor__state || null,
    state_id: row.vendor__state_id || null,
    district_id: row.vendor__district_id || null,
    city_id: row.vendor__city_id || null,
    all_india_visibility: Number(row.vendor__all_india_visibility || 0) === 1,
    seller_rating: row.vendor__seller_rating || null,
    kyc_status: row.vendor__kyc_status || null,
    verification_badge: Boolean(row.vendor__verification_badge),
    trust_score: row.vendor__trust_score || null,
    gst_verified: Boolean(row.vendor__gst_verified),
    year_of_establishment: row.vendor__year_of_establishment || null,
    years_in_business: row.vendor__years_in_business || null,
    response_rate: row.vendor__response_rate || null,
    plan_name: row.vendor_plan_name || 'TRIAL',
    plan_priority: Number(row.vendor_plan_priority || 100),
    premium_slot_matched: Number(row.premium_slot_matched || 0) === 1,
    premium_slot_rank: Number(row.premium_slot_rank || 0),
    premium_slot_label: row.premium_slot_label || '',
  };

  const product = { ...row };
  Object.keys(product).forEach((key) => {
    if (key.startsWith('vendor__')) delete product[key];
  });
  delete product.total_count;

  return {
    ...product,
    vendors: vendor,
    vendorName: vendor.company_name,
    vendorId: vendor.id,
    vendorCity: vendor.city,
    vendorState: vendor.state,
    vendorRating: vendor.seller_rating || 4.5,
    vendorVerified: vendor.kyc_status === 'VERIFIED' || Boolean(vendor.verification_badge),
    vendorGstVerified: vendor.gst_verified,
    vendorYearOfEstablishment: vendor.year_of_establishment,
    vendorYearsInBusiness: vendor.years_in_business,
    vendorResponseRate: vendor.response_rate,
    vendorPlanName: row.vendor_plan_name || 'TRIAL',
    vendor_plan_name: row.vendor_plan_name || 'TRIAL',
    vendor_plan_priority: Number(row.vendor_plan_priority || 100),
    premium_slot_matched: Number(row.premium_slot_matched || 0) === 1,
    premium_slot_rank: Number(row.premium_slot_rank || 0),
    premium_slot_label: row.premium_slot_label || '',
    __sortScore: Number(row.search_score || 0),
  };
}

function buildHybridWhere({
  q,
  microId,
  microIds = [],
  subCategoryId,
  headCategoryId,
  stateId,
  districtId,
  cityId,
  useFullText = true,
  broad = false,
}) {
  const where = ['p.status = ?', 'COALESCE(v.is_active, 1) = 1'];
  const params = ['ACTIVE'];

  const scopedMicroIds = Array.isArray(microIds) ? microIds.filter(Boolean) : [];
  if (scopedMicroIds.length) {
    where.push(`p.micro_category_id IN (${scopedMicroIds.map(() => '?').join(', ')})`);
    params.push(...scopedMicroIds);
  } else if (microId) {
    where.push('p.micro_category_id = ?');
    params.push(microId);
  } else if (subCategoryId) {
    where.push('p.sub_category_id = ?');
    params.push(subCategoryId);
  } else if (headCategoryId) {
    where.push('p.head_category_id = ?');
    params.push(headCategoryId);
  }
  if (stateId) {
    where.push(`(
      COALESCE(v.all_india_visibility, 0) = 1
      OR
      (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.states'), JSON_ARRAY())) > 0
        AND JSON_CONTAINS(COALESCE(JSON_EXTRACT(p.target_locations, '$.states'), JSON_ARRAY()), JSON_QUOTE(?))
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.states'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) > 0
        AND EXISTS (
          SELECT 1
            FROM JSON_TABLE(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY()), '$[*]' COLUMNS(city_id VARCHAR(64) PATH '$')) product_city
            JOIN cities product_city_row ON product_city_row.id = product_city.city_id
           WHERE product_city_row.state_id = ?
        )
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.states'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) = 0
        AND
        JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
        AND JSON_CONTAINS(COALESCE(vpref.preferred_states, JSON_ARRAY()), JSON_QUOTE(?))
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.states'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) = 0
        AND
        JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) = 0
        AND v.state_id = ?
      )
    )`);
    params.push(stateId, stateId, stateId, stateId);
  }
  if (districtId) {
    where.push(`(
      COALESCE(v.all_india_visibility, 0) = 1
      OR
      (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.districts'), JSON_ARRAY())) > 0
        AND JSON_CONTAINS(COALESCE(JSON_EXTRACT(p.target_locations, '$.districts'), JSON_ARRAY()), JSON_QUOTE(?))
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.districts'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) > 0
        AND EXISTS (
          SELECT 1
            FROM JSON_TABLE(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY()), '$[*]' COLUMNS(city_id VARCHAR(64) PATH '$')) product_city
            JOIN cities product_city_row ON product_city_row.id = product_city.city_id
           WHERE product_city_row.district_id = ?
        )
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.districts'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
        AND JSON_CONTAINS(COALESCE(vpref.preferred_districts, JSON_ARRAY()), JSON_QUOTE(?))
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.districts'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) = 0
        AND JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) = 0
        AND (
          v.district_id = ?
          OR EXISTS (SELECT 1 FROM cities vendor_city_row WHERE vendor_city_row.id = v.city_id AND vendor_city_row.district_id = ?)
        )
      )
    )`);
    params.push(districtId, districtId, districtId, districtId, districtId);
  }
  if (cityId) {
    where.push(`(
      COALESCE(v.all_india_visibility, 0) = 1
      OR
      (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) > 0
        AND JSON_CONTAINS(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY()), JSON_QUOTE(?))
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) = 0
        AND
        JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
        AND JSON_CONTAINS(COALESCE(vpref.preferred_cities, JSON_ARRAY()), JSON_QUOTE(?))
      )
      OR (
        JSON_LENGTH(COALESCE(JSON_EXTRACT(p.target_locations, '$.cities'), JSON_ARRAY())) = 0
        AND
        JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) = 0
        AND v.city_id = ?
      )
    )`);
    params.push(cityId, cityId, cityId);
  }

  const premiumPreferenceGate = buildPremiumPreferenceGate({ stateId, districtId, cityId });
  where.push(premiumPreferenceGate.sql);
  params.push(...premiumPreferenceGate.params);

  if (q && !broad) {
    const like = `%${q}%`;
    const slug = slugifySearch(q);
    const baseTokens = searchTokens(q, 8);
    const expanded = expandSemanticTokens(q).slice(0, 12);
    const ors = [
      'LOWER(COALESCE(p.name, "")) LIKE LOWER(?)',
      'LOWER(COALESCE(p.category, "")) LIKE LOWER(?)',
      'LOWER(COALESCE(p.description, "")) LIKE LOWER(?)',
      'LOWER(COALESCE(p.category_path, "")) LIKE LOWER(?)',
      'LOWER(COALESCE(v.company_name, "")) LIKE LOWER(?)',
    ];
    params.push(like, like, like, like, like);
    if (slug) {
      ors.push('LOWER(COALESCE(p.slug, "")) LIKE LOWER(?)');
      ors.push('LOWER(COALESCE(p.category_slug, "")) LIKE LOWER(?)');
      params.push(`%${slug}%`, `%${slug}%`);
    }
    if (baseTokens.length > 1) {
      const searchableColumns = [
        'p.name',
        'p.category',
        'p.description',
        'p.category_path',
        'p.category_slug',
        'v.company_name',
      ];
      const strictTokenClauses = baseTokens.map((token) => {
        const pattern = wholeTokenRegex(token);
        params.push(...searchableColumns.map(() => pattern));
        return `(${searchableColumns
          .map((column) => `LOWER(COALESCE(${column}, "")) REGEXP ?`)
          .join(' OR ')})`;
      });
      ors.push(`(${strictTokenClauses.join(' AND ')})`);
    } else {
      expanded.forEach((token) => {
        ors.push('LOWER(COALESCE(p.name, "")) LIKE LOWER(?)');
        ors.push('LOWER(COALESCE(p.category, "")) LIKE LOWER(?)');
        ors.push('LOWER(COALESCE(p.description, "")) LIKE LOWER(?)');
        ors.push('LOWER(COALESCE(p.category_path, "")) LIKE LOWER(?)');
        ors.push('LOWER(COALESCE(p.category_slug, "")) LIKE LOWER(?)');
        params.push(`%${token}%`, `%${token}%`, `%${token}%`, `%${token}%`, `%${slugifySearch(token)}%`);
      });
    }
    if (isLandSurveyIntent(q, baseTokens)) {
      const surveyRegex = '(^|[^[:alnum:]])(land[[:space:]]+survey|land[[:space:]]+surveyor|survey|surveyor|surveying|topographic|topographical|dgps|total[[:space:]]+station|route[[:space:]]+survey|contour[[:space:]]+survey|cadastral[[:space:]]+survey)([^[:alnum:]]|$)';
      ors.push('LOWER(COALESCE(p.name, "")) REGEXP ?');
      ors.push('LOWER(COALESCE(p.category, "")) REGEXP ?');
      ors.push('LOWER(COALESCE(p.category_path, "")) REGEXP ?');
      params.push(surveyRegex, surveyRegex, surveyRegex);
    }
    const booleanQ = buildBooleanFullTextQuery(q);
    if (useFullText && booleanQ) {
      ors.push('MATCH(p.name, p.description, p.category, p.category_path, p.category_slug) AGAINST (? IN BOOLEAN MODE)');
      params.push(booleanQ);
    }
    where.push(`(${ors.join(' OR ')})`);
  }

  return { where, params };
}

function buildHybridScoreSql(q, useFullText = true) {
  if (!q) return { sql: '0', params: [] };
  const like = `%${q}%`;
  const prefix = `${q}%`;
  const params = [q, prefix, like, like, like, like];
  let sql = `(
    CASE WHEN LOWER(COALESCE(p.name, '')) = LOWER(?) THEN 130 ELSE 0 END +
    CASE WHEN LOWER(COALESCE(p.name, '')) LIKE LOWER(?) THEN 95 ELSE 0 END +
    CASE WHEN LOWER(COALESCE(p.name, '')) LIKE LOWER(?) THEN 70 ELSE 0 END +
    CASE WHEN LOWER(COALESCE(p.category, '')) LIKE LOWER(?) THEN 42 ELSE 0 END +
    CASE WHEN LOWER(COALESCE(p.description, '')) LIKE LOWER(?) THEN 22 ELSE 0 END +
    CASE WHEN LOWER(COALESCE(v.company_name, '')) LIKE LOWER(?) THEN 14 ELSE 0 END
  `;

  searchTokens(q, 8).forEach((token) => {
    const pattern = wholeTokenRegex(token);
    if (!pattern) return;
    sql += `
      + CASE WHEN LOWER(COALESCE(p.name, '')) REGEXP ? THEN 62 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(p.category, '')) REGEXP ? THEN 46 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(p.category_path, '')) REGEXP ? THEN 16 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(p.description, '')) REGEXP ? THEN 8 ELSE 0 END
    `;
    params.push(pattern, pattern, pattern, pattern);
  });

  if (isLandSurveyIntent(q)) {
    const primarySurveyRegex = '(^|[^[:alnum:]])(land[[:space:]]+survey|land[[:space:]]+surveyor|survey|surveyor|surveying|topographic|topographical|dgps|total[[:space:]]+station|route[[:space:]]+survey|contour[[:space:]]+survey|cadastral[[:space:]]+survey)([^[:alnum:]]|$)';
    const nonSurveyRegex = '(^|[^[:alnum:]])(geotechnical|geo[[:space:]]*technical|soil[[:space:]]+testing|soil|investigation|pile|plate[[:space:]]+load|thermal[[:space:]]+resistivity|borehole|cross[[:space:]]+hole|hydro[[:space:]]+geological)([^[:alnum:]]|$)';
    sql += `
      + CASE WHEN LOWER(COALESCE(p.name, '')) REGEXP '(^|[^[:alnum:]])land[[:space:]]+(survey|surveyor|surveying)([^[:alnum:]]|$)' THEN 520 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(p.name, '')) REGEXP ? THEN 360 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(p.category, '')) REGEXP ? THEN 130 ELSE 0 END
      + CASE WHEN LOWER(COALESCE(p.category_path, '')) REGEXP ? THEN 70 ELSE 0 END
      - CASE WHEN LOWER(COALESCE(p.name, '')) REGEXP ? THEN 260 ELSE 0 END
    `;
    params.push(primarySurveyRegex, primarySurveyRegex, primarySurveyRegex, nonSurveyRegex);
  }

  expandSemanticTokens(q)
    .filter((token) => token !== normalizeSearchText(q))
    .slice(0, 8)
    .forEach((token) => {
      sql += `
        + CASE WHEN LOWER(COALESCE(p.name, '')) LIKE LOWER(?) THEN 38 ELSE 0 END
        + CASE WHEN LOWER(COALESCE(p.category, '')) LIKE LOWER(?) THEN 30 ELSE 0 END
        + CASE WHEN LOWER(COALESCE(p.category_path, '')) LIKE LOWER(?) THEN 24 ELSE 0 END
        + CASE WHEN LOWER(COALESCE(p.description, '')) LIKE LOWER(?) THEN 14 ELSE 0 END
      `;
      const tokenLike = `%${token}%`;
      params.push(tokenLike, tokenLike, tokenLike, tokenLike);
    });

  const booleanQ = buildBooleanFullTextQuery(q);
  if (useFullText && booleanQ) {
    sql += ' + (MATCH(p.name, p.description, p.category, p.category_path, p.category_slug) AGAINST (? IN BOOLEAN MODE) * 18)';
    params.push(booleanQ);
  }
  sql += ')';
  return { sql, params };
}

function orderSqlForHybrid(sort = '') {
  const slotAwarePlanOrder = 'CASE WHEN premium_slot_rank > 0 THEN vendor_plan_priority ELSE 0 END DESC';
  if (sort === 'price_asc') return `p.price ASC, premium_slot_rank DESC, ${slotAwarePlanOrder}, search_score DESC, p.created_at DESC`;
  if (sort === 'price_desc') return `p.price DESC, premium_slot_rank DESC, ${slotAwarePlanOrder}, search_score DESC, p.created_at DESC`;
  return `premium_slot_rank DESC, search_score DESC, ${slotAwarePlanOrder}, p.created_at DESC, p.id DESC`;
}

async function runHybridMysqlSearch({
  q,
  microId,
  microIds,
  subCategoryId,
  headCategoryId,
  stateId,
  districtId,
  cityId,
  sort,
  limit,
  offset = 0,
  useFullText = true,
  broad = false,
  minRelevanceScore = 24,
}) {
  const { sql: scoreSql, params: scoreParams } = buildHybridScoreSql(q, useFullText && !broad);
  const { where, params: whereParams } = buildHybridWhere({
    q,
    microId,
    microIds,
    subCategoryId,
    headCategoryId,
    stateId,
    districtId,
    cityId,
    useFullText,
    broad,
  });
  const productSelect = buildProductRowSelect(scoreSql, { stateId, districtId, cityId });
  const rows = await mysqlQuery(
    `${productSelect.sql}
       FROM products p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN vendor_plan_subscriptions vps
         ON vps.id = (
           SELECT active_vps.id
             FROM vendor_plan_subscriptions active_vps
            WHERE active_vps.vendor_id = p.vendor_id
              AND active_vps.status = 'ACTIVE'
              AND (active_vps.end_date IS NULL OR active_vps.end_date > UTC_TIMESTAMP())
            ORDER BY COALESCE(active_vps.end_date, '9999-12-31 23:59:59') DESC,
                     active_vps.created_at DESC,
                     active_vps.id DESC
            LIMIT 1
         )
       LEFT JOIN vendor_plans vp ON vp.id = vps.plan_id
      LEFT JOIN vendor_preferences vpref ON vpref.vendor_id = p.vendor_id
     WHERE ${where.join(' AND ')}
      ORDER BY ${orderSqlForHybrid(sort)}
      LIMIT ${limit} OFFSET ${offset}`,
    [...productSelect.params, ...scoreParams, ...whereParams]
  );
  const mappedRows = rankRowsForSearchIntent(mergeRowsById(rows.map(productFromMysqlRow)), q, sort);
  const relevantRows = q && !broad
    ? mappedRows.filter((row) => {
        const directScore = Number(row.__sortScore || 0);
        return directScore >= minRelevanceScore;
      })
    : mappedRows;
  return {
    rows: relevantRows,
    totalCount: q && !broad
      ? relevantRows.length
      : mappedRows.length,
  };
}

async function runHybridSearchWithFallback(args) {
  const hasCoverageFilter = Boolean(args?.stateId || args?.districtId || args?.cityId);
  if (args?.q && !hasCoverageFilter && isOpenSearchCatalogEnabled()) {
    try {
      const result = await searchOpenSearchProducts(args);
      if (result.rows?.length) return result;
    } catch (error) {
      logger.warn('[dir/hybrid-search] OpenSearch unavailable, using MySQL fallback:', error?.message);
    }
  }

  try {
    return await runHybridMysqlSearch({ ...args, useFullText: true });
  } catch (error) {
    const msg = String(error?.message || '').toLowerCase();
    if (!msg.includes('fulltext') && !msg.includes('match') && !msg.includes("can't find fulltext")) {
      throw error;
    }
    logger.warn('[dir/hybrid-search] full-text unavailable, falling back to LIKE search:', error?.message);
    return runHybridMysqlSearch({ ...args, useFullText: false });
  }
}

async function fetchFuzzyCandidates({ q, microId, microIds, subCategoryId, headCategoryId, stateId, districtId, cityId, sort, limit }) {
  const broad = await runHybridMysqlSearch({
    q: '',
    microId,
    microIds,
    subCategoryId,
    headCategoryId,
    stateId,
    districtId,
    cityId,
    sort,
    limit: Math.min(Math.max(limit * 8, 80), 240),
    offset: 0,
    useFullText: false,
    broad: true,
  });
  const rows = (broad.rows || [])
    .map((row) => ({ ...row, __sortScore: Math.max(Number(row.__sortScore || 0), fuzzySearchScore(q, row)) }))
    .filter((row) => Number(row.__sortScore || 0) >= 42)
    .sort((a, b) => {
      const intentDiff = catalogIntentScore(q, b) - catalogIntentScore(q, a);
      if (intentDiff) return intentDiff;
      const scoreDiff = Number(b.__sortScore || 0) - Number(a.__sortScore || 0);
      if (scoreDiff) return scoreDiff;
      return Number(b.vendor_plan_priority || 0) - Number(a.vendor_plan_priority || 0);
    })
    .slice(0, limit);
  return { rows, totalCount: rows.length };
}

function canUseBroadCategoryScope(scope = {}) {
  return Boolean(
    scope?.microId ||
    scope?.subCategoryId ||
    (Array.isArray(scope?.microIds) && scope.microIds.length)
  );
}

function normalizeDedupePart(value = '') {
  return normalizeSearchText(value).replace(/\s+/g, '-');
}

function canonicalProductNameKey(value = '') {
  return normalizeDedupePart(value)
    .replace(/-(service|services|supplier|suppliers|manufacturer|manufacturers|product|products)$/g, '');
}

function getFirstImageDedupePart(row = {}) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value.url || value.image_url || value.src || '';
    return '';
  };
  const raw = row?.images;

  if (Array.isArray(raw)) return normalizeDedupePart(pick(raw[0]));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeDedupePart(pick(parsed[0]));
    } catch (_) {
      return normalizeDedupePart(raw);
    }
  }

  return normalizeDedupePart(row?.image || row?.image_url || '');
}

function uniqueDedupeKeys(keys = []) {
  const seen = new Set();
  return keys.filter((key) => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function productDedupeKeys(row = {}) {
  const vendorNameKey = normalizeDedupePart(
    row?.vendorName ||
      row?.vendor_name ||
      row?.vendors?.company_name ||
      row?.vendor__company_name ||
      row?.company_name
  );
  const vendorIdKey = normalizeDedupePart(
    row?.vendorId ||
      row?.vendor_id ||
      row?.vendors?.id ||
      row?.vendor__id
  );
  const vendorKeys = uniqueDedupeKeys([vendorNameKey, vendorIdKey]);
  const nameKey = canonicalProductNameKey(row?.name || row?.product_name || row?.title || row?.slug);
  const stableKey = normalizeDedupePart(row?.id || row?.slug);
  const categoryKey = normalizeDedupePart(row?.category_slug || row?.category || row?.micro_category_name);
  const priceKey = normalizeDedupePart(row?.price);
  const unitKey = normalizeDedupePart(row?.price_unit || row?.qty_unit || row?.unit);
  const imageKey = getFirstImageDedupePart(row);
  const keys = [];

  vendorKeys.forEach((vendorKey) => {
    if (nameKey) keys.push(`vendor-name:${vendorKey}:${nameKey}`);
    if (imageKey) keys.push(`vendor-image:${vendorKey}:${imageKey}`);
  });
  if (stableKey) keys.push(`product:${stableKey}`);
  if (!vendorKeys.length && nameKey) keys.push(`name:${nameKey}:${categoryKey}:${priceKey}:${unitKey}:${imageKey}`);
  if (!vendorKeys.length && imageKey) keys.push(`image:${nameKey}:${imageKey}`);
  return uniqueDedupeKeys(keys);
}

function productDedupeKey(row = {}) {
  return productDedupeKeys(row)[0] || '';
}

function isPreferredProductRow(candidate = {}, current = {}) {
  const candidateScore = Number(candidate?.__sortScore || candidate?.search_score || 0);
  const currentScore = Number(current?.__sortScore || current?.search_score || 0);
  if (candidateScore !== currentScore) return candidateScore > currentScore;

  const candidateSlot = Number(candidate?.premium_slot_rank || candidate?.vendors?.premium_slot_rank || 0);
  const currentSlot = Number(current?.premium_slot_rank || current?.vendors?.premium_slot_rank || 0);
  if (candidateSlot !== currentSlot) return candidateSlot > currentSlot;

  const candidatePlan = candidateSlot > 0 ? Number(candidate?.vendor_plan_priority || candidate?.vendors?.plan_priority || 0) : 0;
  const currentPlan = currentSlot > 0 ? Number(current?.vendor_plan_priority || current?.vendors?.plan_priority || 0) : 0;
  if (candidatePlan !== currentPlan) return candidatePlan > currentPlan;

  const candidateUpdated = new Date(candidate?.updated_at || candidate?.created_at || 0).getTime() || 0;
  const currentUpdated = new Date(current?.updated_at || current?.created_at || 0).getTime() || 0;
  return candidateUpdated > currentUpdated;
}

function mergeRowsById(...groups) {
  const keyToIndex = new Map();
  const rows = [];
  groups.flat().forEach((row) => {
    const keys = productDedupeKeys(row);
    if (!keys.length) return;

    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index) => Number.isInteger(index));

    if (Number.isInteger(existingIndex)) {
      if (isPreferredProductRow(row, rows[existingIndex])) {
        rows[existingIndex] = row;
      }
      keys.forEach((key) => keyToIndex.set(key, existingIndex));
      return;
    }

    const nextIndex = rows.length;
    rows.push(row);
    keys.forEach((key) => keyToIndex.set(key, nextIndex));
  });
  return rows;
}

async function fetchBroadCategoryRows({ fallbackScopes = [], stateId, districtId, cityId, sort, limit }) {
  const rows = [];
  for (const scope of fallbackScopes.filter(canUseBroadCategoryScope)) {
    const scoped = await runHybridMysqlSearch({
      q: '',
      ...scope,
      stateId,
      districtId,
      cityId,
      sort,
      limit,
      offset: 0,
      useFullText: false,
      broad: true,
    });
    rows.push(...(scoped.rows || []));
    if (mergeRowsById(rows).length >= limit) break;
  }
  return mergeRowsById(rows).slice(0, limit);
}

async function augmentWithBroadCategoryRows({ rows = [], q = '', fallbackScopes = [], stateId, districtId, cityId, sort, limit }) {
  if (!fallbackScopes.some(canUseBroadCategoryScope) || rows.length >= limit) {
    return rankRowsForSearchIntent(mergeRowsById(rows), q, sort).slice(0, limit);
  }
  const broadRows = await fetchBroadCategoryRows({
    fallbackScopes,
    stateId,
    districtId,
    cityId,
    sort,
    limit: Math.max(limit, limit - rows.length),
  });
  return rankRowsForSearchIntent(mergeRowsById(rows, broadRows), q, sort).slice(0, limit);
}

async function fetchPersonalizedSearchTerms(req) {
  const terms = [];
  const email = String(req.user?.email || req.query?.buyer_email || '').trim().toLowerCase();
  const userId = String(req.user?.id || '').trim();
  const visitorId = safeText(req.query?.visitor_id || req.query?.visitorId || req.headers?.['x-visitor-id'], 191);

  try {
    if (email || userId) {
      const leadWhere = [];
      const leadParams = [];
      if (email) {
        leadWhere.push('LOWER(COALESCE(buyer_email, "")) = LOWER(?)');
        leadParams.push(email);
      }
      if (userId) {
        leadWhere.push('buyer_user_id = ?');
        leadParams.push(userId);
      }
      const leads = await mysqlQuery(
        `SELECT title, product_name, product_interest, category
           FROM leads
          WHERE ${leadWhere.join(' OR ')}
          ORDER BY created_at DESC
          LIMIT 12`,
        leadParams
      );
      leads.forEach((row) => terms.push(row.title, row.product_name, row.product_interest, row.category));

      const orders = await mysqlQuery(
        `SELECT l.title, l.product_name, l.product_interest, l.category
           FROM lead_purchases lp
           JOIN leads l ON l.id = lp.lead_id
          WHERE ${leadWhere.map((item) => item.replace(/\bbuyer_email\b/g, 'l.buyer_email').replace(/\bbuyer_user_id\b/g, 'l.buyer_user_id')).join(' OR ')}
          ORDER BY COALESCE(lp.purchase_datetime, lp.purchase_date, lp.updated_at) DESC
          LIMIT 12`,
        leadParams
      ).catch(() => []);
      orders.forEach((row) => terms.push(row.title, row.product_name, row.product_interest, row.category));
    }

    if (visitorId) {
      const searches = await mysqlQuery(
        `SELECT search_query, category, entity_name
           FROM website_visitor_events
          WHERE visitor_id = ?
            AND (search_query IS NOT NULL OR category IS NOT NULL OR entity_name IS NOT NULL)
          ORDER BY created_at DESC
          LIMIT 12`,
        [visitorId]
      ).catch(() => []);
      searches.forEach((row) => terms.push(row.search_query, row.category, row.entity_name));
    }
  } catch (error) {
    logger.warn('[dir/hybrid-search] personalized terms skipped:', error?.message);
  }

  return Array.from(new Set(terms.filter(Boolean).flatMap((value) => expandSemanticTokens(value)))).slice(0, 12);
}

async function fetchRecommendedProducts({
  req,
  q,
  microId,
  microIds,
  subCategoryId,
  headCategoryId,
  stateId,
  districtId,
  cityId,
  sort,
  limit,
  fallbackScopes = [],
}) {
  const personalizedTerms = await fetchPersonalizedSearchTerms(req);
  const semanticText = [q, ...personalizedTerms].filter(Boolean).join(' ');
  const primary = semanticText
    ? await runHybridSearchWithFallback({
        q: semanticText,
        microId,
        microIds,
        subCategoryId,
        headCategoryId,
        stateId,
        districtId,
        cityId,
        sort,
        limit,
        offset: 0,
      })
    : { rows: [], totalCount: 0 };
  if (primary.rows.length) return primary.rows.slice(0, limit);

  for (const scope of fallbackScopes) {
    const scopedPrimary = semanticText
      ? await runHybridSearchWithFallback({
          q: semanticText,
          ...scope,
          stateId,
          districtId,
          cityId,
          sort,
          limit,
          offset: 0,
        })
      : { rows: [] };
    if (scopedPrimary.rows.length) return scopedPrimary.rows.slice(0, limit);
  }

  const fuzzy = q ? await fetchFuzzyCandidates({
    q,
    microId,
    microIds,
    subCategoryId,
    headCategoryId,
    stateId,
    cityId,
    districtId,
    sort,
    limit,
  }) : { rows: [] };
  if (fuzzy.rows.length) return fuzzy.rows.slice(0, limit);

  for (const scope of fallbackScopes) {
    const scopedFuzzy = q ? await fetchFuzzyCandidates({ q, ...scope, stateId, districtId, cityId, sort, limit }) : { rows: [] };
    if (scopedFuzzy.rows.length) return scopedFuzzy.rows.slice(0, limit);
  }

  const fallback = await runHybridMysqlSearch({
    q: '',
    microId,
    microIds,
    subCategoryId,
    headCategoryId,
    stateId,
    districtId,
    cityId,
    sort,
    limit,
    offset: 0,
    useFullText: false,
    broad: true,
  });
  if (fallback.rows.length) return fallback.rows.slice(0, limit);

  for (const scope of fallbackScopes) {
    const scopedFallback = await runHybridMysqlSearch({
      q: '',
      ...scope,
      stateId,
      cityId,
      sort,
      limit,
      offset: 0,
      useFullText: false,
      broad: true,
    });
    if (scopedFallback.rows.length) return scopedFallback.rows.slice(0, limit);
  }

  return fallback.rows.slice(0, limit);
}

async function recordSearchEvent(req, { q, resultCount, recommendationCount }) {
  const query = safeText(q, 191);
  if (!query) return;
  const visitorId = safeText(req.query?.visitor_id || req.query?.visitorId || req.headers?.['x-visitor-id'], 191) || null;
  const sessionId = safeText(req.query?.visitor_session_id || req.query?.visitorSessionId || req.headers?.['x-visitor-session-id'], 191) || null;
  mysqlQuery(
    `INSERT INTO website_visitor_events
      (id, visitor_id, visitor_session_id, visitor_email, event_type, page_url, page_path, search_query, metadata, created_at)
     VALUES (?, ?, ?, ?, 'SEARCH', ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      randomUUID(),
      visitorId,
      sessionId,
      req.user?.email || null,
      safeText(req.headers?.referer || '', 1000) || null,
      safeText(req.originalUrl || req.url || '', 512),
      query,
      JSON.stringify({ resultCount, recommendationCount, source: 'hybrid_search' }),
    ]
  ).catch((error) => logger.warn('[dir/hybrid-search] search event skipped:', error?.message));
}

async function resolveBuyerProfileForUser(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = String(user?.email || '').trim().toLowerCase();

  if (userId) {
    const { data } = await db
      .from('buyers')
      .select('id, full_name, company_name, email')
      .eq('user_id', userId)
      .maybeSingle();
    if (data?.id) return data;
  }

  if (email) {
    const { data, error } = await db
      .from('buyers')
      .select('id, full_name, company_name, email')
      .ilike('email', email)
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);
    if (!error && Array.isArray(data) && data[0]?.id) return data[0];
  }

  return null;
}

function summarizeRatings(rows = []) {
  const ratings = (Array.isArray(rows) ? rows : [])
    .map((row) => clampRating(row?.rating))
    .filter((rating) => rating >= 1 && rating <= 5);

  const count = ratings.length;
  if (!count) return { average: 0, count: 0 };

  const average = Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / count) * 10) / 10;
  return { average, count };
}

function toPublicRating(row = {}) {
  return {
    id: row.id,
    product_id: row.product_id,
    buyer_id: row.buyer_id,
    buyerName: safeText(row.buyer_name, 120) || 'Buyer',
    rating: clampRating(row.rating),
    feedback: safeText(row.feedback, 1000),
    created_at: row.created_at || null,
    updated_at: row.updated_at || row.created_at || null,
  };
}

let productRatingsTableReady = null;
async function ensureProductRatingsTable() {
  if (!productRatingsTableReady) {
    productRatingsTableReady = mysqlQuery(`
      CREATE TABLE IF NOT EXISTS \`product_ratings\` (
        \`id\` CHAR(36) NOT NULL,
        \`product_id\` CHAR(36) NOT NULL,
        \`buyer_id\` CHAR(36) NOT NULL,
        \`buyer_name\` TEXT NULL,
        \`rating\` TINYINT NULL,
        \`feedback\` TEXT NULL,
        \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_product_ratings_product_buyer\` (\`product_id\`, \`buyer_id\`),
        KEY \`idx_product_ratings_product_id\` (\`product_id\`),
        KEY \`idx_product_ratings_buyer_id\` (\`buyer_id\`),
        KEY \`idx_product_ratings_updated_at\` (\`updated_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch((error) => {
      productRatingsTableReady = null;
      throw error;
    });
  }

  return productRatingsTableReady;
}

async function getProductRatingState(productId, buyerId = '') {
  await ensureProductRatingsTable();

  const { data, error } = await db
    .from('product_ratings')
    .select('id, product_id, buyer_id, buyer_name, rating, feedback, created_at, updated_at')
    .eq('product_id', productId)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  const ratings = (data || []).map(toPublicRating).filter((row) => row.rating);
  const summary = summarizeRatings(ratings);
  const myRating = buyerId
    ? ratings.find((row) => String(row.buyer_id) === String(buyerId)) || null
    : null;

  return { summary, ratings, myRating };
}

function applySort(q, sort) {
  if (sort === 'price_asc') return q.order('price', { ascending: true });
  if (sort === 'price_desc') return q.order('price', { ascending: false });
  return q.order('created_at', { ascending: false });
}

async function resolveMicroCategoryContext(microSlug) {
  if (!microSlug) return null;

  const rows = await mysqlQuery(
    `SELECT mc.id AS micro_id,
            mc.name AS micro_name,
            mc.slug AS micro_slug,
            mc.sub_category_id,
            sc.name AS sub_category_name,
            sc.slug AS sub_category_slug,
            sc.head_category_id,
            hc.name AS head_category_name,
            hc.slug AS head_category_slug
       FROM micro_categories mc
       LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
       LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
      WHERE mc.slug = ?
      ORDER BY mc.updated_at DESC, mc.created_at DESC
      LIMIT 1`,
    [microSlug]
  );

  const row = rows?.[0];
  if (!row?.micro_id) return null;

  return {
    microId: row.micro_id,
    microName: row.micro_name || '',
    microSlug: row.micro_slug || microSlug,
    subCategoryId: row.sub_category_id || null,
    subCategoryName: row.sub_category_name || '',
    subCategorySlug: row.sub_category_slug || '',
    headCategoryId: row.head_category_id || null,
    headCategoryName: row.head_category_name || '',
    headCategorySlug: row.head_category_slug || '',
  };
}

async function resolveMicroId(microSlug) {
  const context = await resolveMicroCategoryContext(microSlug);
  return context?.microId || null;
}

function buildCategoryFallbackScopes(categoryContext = {}) {
  const scopes = [];
  if (categoryContext?.subCategoryId) {
    scopes.push({
      microId: null,
      subCategoryId: categoryContext.subCategoryId,
      headCategoryId: null,
    });
  }
  if (categoryContext?.headCategoryId) {
    scopes.push({
      microId: null,
      subCategoryId: null,
      headCategoryId: categoryContext.headCategoryId,
    });
  }
  return scopes;
}

function dedupeCategoryScopes(scopes = []) {
  const seen = new Set();
  return scopes.filter((scope) => {
    const key = JSON.stringify({
      microId: scope.microId || null,
      microIds: Array.isArray(scope.microIds) ? scope.microIds.filter(Boolean).sort() : [],
      subCategoryId: scope.subCategoryId || null,
      headCategoryId: scope.headCategoryId || null,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveSearchCategoryFallbackScopes(q) {
  const terms = expandSemanticTokens(q)
    .filter((token) => token.length >= 4)
    .slice(0, 10);
  if (!terms.length) return [];

  const clauses = [];
  const params = [];
  terms.forEach((term) => {
    const like = `%${term}%`;
    const slug = `%${slugifySearch(term)}%`;
    clauses.push(`
      LOWER(COALESCE(mc.name, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(mc.slug, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(sc.name, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(sc.slug, '')) LIKE LOWER(?)
    `);
    params.push(like, slug, like, slug);
  });

  const rows = await mysqlQuery(
    `SELECT mc.id AS micro_id,
            mc.name AS micro_name,
            mc.slug AS micro_slug,
            mc.sub_category_id,
            sc.name AS sub_category_name,
            sc.slug AS sub_category_slug,
            sc.head_category_id,
            hc.name AS head_category_name,
            hc.slug AS head_category_slug
       FROM micro_categories mc
       LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
       LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
      WHERE COALESCE(mc.is_active, 1) = 1
        AND (${clauses.map((clause) => `(${clause})`).join(' OR ')})
      LIMIT 60`,
    params
  );

  const scoredRows = rows
    .map((row) => {
      const text = normalizeSearchText([
        row.micro_name,
        row.micro_slug,
        row.sub_category_name,
        row.sub_category_slug,
        row.head_category_name,
      ].filter(Boolean).join(' '));
      const score = terms.reduce((sum, term) => {
        if (normalizeSearchText(row.micro_name) === term) return sum + 120;
        if (normalizeSearchText(row.micro_slug).replace(/\s+/g, '-') === slugifySearch(term)) return sum + 100;
        return sum + (text.includes(term) ? 20 : 0);
      }, 0);
      return { ...row, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  const microIds = Array.from(new Set(scoredRows.map((row) => row.micro_id).filter(Boolean))).slice(0, 30);
  const subIds = Array.from(new Set(scoredRows.map((row) => row.sub_category_id).filter(Boolean))).slice(0, 4);
  const headIds = Array.from(new Set(scoredRows.map((row) => row.head_category_id).filter(Boolean))).slice(0, 2);
  const scopes = [];
  if (microIds.length) scopes.push({ microId: null, microIds, subCategoryId: null, headCategoryId: null });
  subIds.forEach((subCategoryId) => scopes.push({ microId: null, subCategoryId, headCategoryId: null }));
  headIds.forEach((headCategoryId) => scopes.push({ microId: null, subCategoryId: null, headCategoryId }));
  return dedupeCategoryScopes(scopes);
}

async function fetchRankedProductsViaRpc({ microId, cityId, stateId, q, sort, from, limit }) {
  const { data, error } = await db.rpc('dir_ranked_products', {
    p_micro_id: microId,
    p_city_id: cityId,
    p_state_id: stateId,
    p_q: q || null,
    p_sort: sort || null,
    p_limit: limit,
    p_offset: from,
  });

  if (error) throw error;

  const rows = data || [];
  let totalCount = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;

  // If we paged past the end, probe once to recover total_count.
  if (rows.length === 0 && from > 0) {
    const { data: probeRows, error: probeErr } = await db.rpc('dir_ranked_products', {
      p_micro_id: microId,
      p_city_id: cityId,
      p_state_id: stateId,
      p_q: q || null,
      p_sort: sort || null,
      p_limit: 1,
      p_offset: 0,
    });
    if (!probeErr && probeRows?.length) {
      totalCount = Number(probeRows[0].total_count || 0);
    }
  }

  const cleanedRows = rows.map(({ total_count, ...rest }) => rest);
  return { rows: cleanedRows, totalCount };
}

async function getActivePlanMaps() {
  const nowIso = new Date().toISOString();

  const { data: subs, error } = await db
    .from('vendor_plan_subscriptions')
    .select('vendor_id, plan_id, status, end_date, start_date, plan:vendor_plans(name)')
    .eq('status', 'ACTIVE')
    .or(`end_date.is.null,end_date.gt.${nowIso}`)
    .order('start_date', { ascending: false });

  if (error) throw error;

  const planNameByVendor = {};
  const tierKeyByVendor = {};

  for (const s of subs || []) {
    const vid = s?.vendor_id;
    if (!isValidId(vid)) continue;
    if (planNameByVendor[vid]) continue;

    const planName = s?.plan?.name || '';
    planNameByVendor[vid] = planName;
    tierKeyByVendor[vid] = planToTierKey(planName);
  }

  return { planNameByVendor, tierKeyByVendor };
}

/**
 * ✅ IMPORTANT:
 * Hide suspended/terminated vendors' products.
 * Assuming vendors table has boolean column: is_active
 */
function buildBaseProductQuery({ microId, q, stateId, cityId }) {
  let query = db
    .from('products')
    .select(
      `
        *,
        vendors!inner (
          id, company_name, city, state, state_id, city_id,
          seller_rating, kyc_status, verification_badge, trust_score,
          is_active
        )
      `,
      { count: 'exact' }
    )
    .eq('status', 'ACTIVE')
    // ✅ hide products of suspended vendors
    .eq('vendors.is_active', true);

  if (microId) query = query.eq('micro_category_id', microId);
  if (q) query = query.ilike('name', `%${q}%`);
  if (stateId) query = query.eq('vendors.state_id', stateId);
  if (cityId) query = query.eq('vendors.city_id', cityId);

  return query;
}

async function countForVendorFilter({ microId, q, stateId, cityId, vendorFilter }) {
  let query = buildBaseProductQuery({ microId, q, stateId, cityId });

  if (vendorFilter?.type === 'in') {
    if (!vendorFilter.ids?.length) return 0;
    query = query.in('vendor_id', vendorFilter.ids);
  }

  if (vendorFilter?.type === 'notin') {
    if (vendorFilter.ids?.length) {
      const list = `(${vendorFilter.ids.join(',')})`;
      query = query.not('vendor_id', 'in', list);
    }
  }

  // NOTE: keep vendors embedded in the head-count query, otherwise
  // PostgREST throws: "'vendors' is not an embedded resource in this request".
  const { count, error } = await query.select('id, vendors!inner(id)', {
    count: 'exact',
    head: true,
  });
  if (error) throw error;
  return Number(count || 0);
}

async function fetchForVendorFilter({ microId, q, stateId, cityId, vendorFilter, sort, offsetInGroup, limit }) {
  let query = buildBaseProductQuery({ microId, q, stateId, cityId });

  if (vendorFilter?.type === 'in') {
    if (!vendorFilter.ids?.length) return [];
    query = query.in('vendor_id', vendorFilter.ids);
  }

  if (vendorFilter?.type === 'notin') {
    if (vendorFilter.ids?.length) {
      const list = `(${vendorFilter.ids.join(',')})`;
      query = query.not('vendor_id', 'in', list);
    }
  }

  query = applySort(query, sort);

  const from = offsetInGroup;
  const to = offsetInGroup + limit - 1;
  query = query.range(from, to);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function handleRankedProducts(req, res) {
  try {
    // NOTE: search page may send `q` OR `query` OR `term`
    const q = safeQ(req.query.q || req.query.query || req.query.term);
    const microSlug = safeQ(req.query.microSlug || req.query.micro || req.query.micro_slug);
    const sort = String(req.query.sort || '').trim();
    const page = clampInt(req.query.page, 1, 1, 5000);
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const stateId = isValidId(req.query.stateId) ? req.query.stateId : (isValidId(req.query.state_id) ? req.query.state_id : null);
    const districtId = isValidId(req.query.districtId) ? req.query.districtId : (isValidId(req.query.district_id) ? req.query.district_id : null);
    const cityId = isValidId(req.query.cityId) ? req.query.cityId : (isValidId(req.query.city_id) ? req.query.city_id : null);

    const from = (page - 1) * limit;

    const categoryContext = await resolveMicroCategoryContext(microSlug);
    const microId = categoryContext?.microId || null;
    const fallbackScopes = dedupeCategoryScopes([
      ...buildCategoryFallbackScopes(categoryContext),
      ...(q ? await resolveSearchCategoryFallbackScopes(q) : []),
    ]);

    if (q) {
      const hybrid = await runHybridSearchWithFallback({
        q,
        microId,
        stateId,
        districtId,
        cityId,
        sort,
        limit,
        offset: from,
      });

      if (hybrid.rows.length) {
        const responseRows = await augmentWithBroadCategoryRows({
          rows: hybrid.rows,
          q,
          fallbackScopes,
          stateId,
          districtId,
          cityId,
          sort,
          limit,
        });
        return res.json({
          success: true,
          data: responseRows,
          count: Math.max(hybrid.totalCount, responseRows.length),
          meta: {
            searchMode: hybrid.engine === 'opensearch'
              ? (responseRows.length > hybrid.rows.length ? 'opensearch_category_expanded' : 'opensearch_hybrid')
              : (responseRows.length > hybrid.rows.length ? 'hybrid_category_expanded' : 'hybrid'),
            searchEngine: hybrid.engine || 'mysql',
            autocomplete: true,
            fuzzy: true,
            fullText: true,
            semantic: true,
          },
        });
      }

      for (const scope of fallbackScopes) {
        const scopedHybrid = await runHybridSearchWithFallback({
          q,
          ...scope,
          stateId,
          districtId,
          cityId,
          sort,
          limit,
          offset: from,
        });

        if (scopedHybrid.rows.length) {
          const responseRows = await augmentWithBroadCategoryRows({
            rows: scopedHybrid.rows,
            q,
            fallbackScopes,
            stateId,
            districtId,
            cityId,
            sort,
            limit,
          });
          return res.json({
            success: true,
            data: responseRows,
            count: Math.max(scopedHybrid.totalCount, responseRows.length),
            recommendations: [],
            availability: {
              exactAvailable: true,
              message: '',
            },
            meta: {
              searchMode: scopedHybrid.engine === 'opensearch' ? 'opensearch_parent_category_expanded' : 'hybrid_parent_category_expanded',
              searchEngine: scopedHybrid.engine || 'mysql',
              autocomplete: true,
              fuzzy: true,
              fullText: true,
              semantic: true,
            },
          });
        }
      }

      const broadCategoryRows = await fetchBroadCategoryRows({
        fallbackScopes,
        stateId,
        districtId,
        cityId,
        sort,
        limit,
      });
      if (broadCategoryRows.length) {
        const responseRows = rankRowsForSearchIntent(mergeRowsById(broadCategoryRows), q, sort).slice(0, limit);
        return res.json({
          success: true,
          data: responseRows,
          count: responseRows.length,
          recommendations: [],
          availability: {
            exactAvailable: true,
            message: '',
          },
          meta: {
            searchMode: 'category_broad',
            autocomplete: true,
            fuzzy: true,
            fullText: true,
            semantic: true,
          },
        });
      }
    }

    if (districtId) {
      const districtScoped = await runHybridMysqlSearch({
        q: '',
        microId,
        stateId,
        districtId,
        cityId,
        sort,
        limit,
        offset: from,
        useFullText: false,
        broad: true,
      });
      return res.json({
        success: true,
        data: mergeRowsById(districtScoped.rows || []).slice(0, limit),
        count: Number(districtScoped.totalCount || 0),
        meta: { searchMode: 'district_category', searchEngine: 'mysql' },
      });
    }

    // ✅ Preferred path: slot-aware ranking via DB RPC (capacity-based seats).
    // If the migration isn't applied yet, we fall back to legacy tier buckets.
    try {
      const { rows, totalCount } = await fetchRankedProductsViaRpc({
        microId,
        cityId,
        stateId,
        q,
        sort,
        from,
        limit,
      });

      return res.json({ success: true, data: rows, count: totalCount });
    } catch (rpcErr) {
      // Continue to legacy logic below.
      logger.warn('[dir] dir_ranked_products RPC failed, using legacy ranking:', rpcErr?.message);
    }

    const { planNameByVendor, tierKeyByVendor } = await getActivePlanMaps();
    const activeVendorIds = Object.keys(tierKeyByVendor);

    const bucketIds = {};
    PLAN_TIERS.forEach((t) => (bucketIds[t.key] = []));

    for (const [vendorId, tierKey] of Object.entries(tierKeyByVendor)) {
      if (bucketIds[tierKey]) bucketIds[tierKey].push(vendorId);
    }

    let totalCount = 0;
    let remainingOffset = from;
    let remainingLimit = limit;
    const out = [];

    // 1) Subscribed buckets (diamond..trial)
    for (const tier of PLAN_TIERS) {
      const ids = bucketIds[tier.key] || [];
      if (!ids.length) continue;

      const groupCount = await countForVendorFilter({
        microId,
        q,
        stateId,
        cityId,
        vendorFilter: { type: 'in', ids },
      });

      totalCount += groupCount;
      if (groupCount <= 0) continue;

      if (remainingOffset >= groupCount) {
        remainingOffset -= groupCount;
        continue;
      }

      if (remainingLimit > 0) {
        const rows = await fetchForVendorFilter({
          microId,
          q,
          stateId,
          cityId,
          vendorFilter: { type: 'in', ids },
          sort,
          offsetInGroup: remainingOffset,
          limit: remainingLimit,
        });

        out.push(...rows);
        remainingLimit = Math.max(0, remainingLimit - rows.length);
        remainingOffset = 0;
      }

      if (remainingLimit <= 0) break;
    }

    // 2) Vendors with NO active subscription (bottom)
    if (remainingLimit > 0) {
      const excludeIds = activeVendorIds.length <= 1000 ? activeVendorIds : [];

      const groupCount = await countForVendorFilter({
        microId,
        q,
        stateId,
        cityId,
        vendorFilter: { type: 'notin', ids: excludeIds },
      });

      totalCount += groupCount;

      if (groupCount > 0) {
        if (remainingOffset >= groupCount) {
          remainingOffset -= groupCount;
        } else {
          const rows = await fetchForVendorFilter({
            microId,
            q,
            stateId,
            cityId,
            vendorFilter: { type: 'notin', ids: excludeIds },
            sort,
            offsetInGroup: remainingOffset,
            limit: remainingLimit,
          });

          out.push(...rows);
          remainingLimit = Math.max(0, remainingLimit - rows.length);
          remainingOffset = 0;
        }
      }
    }

    const finalRows = (out || []).map((p) => {
      const vid = p?.vendor_id;
      const tierKey = tierKeyByVendor[vid] || 'trial';
      const planName = planNameByVendor[vid] || 'TRIAL';
      const tierMeta = PLAN_TIERS.find((x) => x.key === tierKey) || PLAN_TIERS[PLAN_TIERS.length - 1];

      const vendors = p?.vendors ? { ...p.vendors } : null;
      if (vendors) {
        vendors.plan_name = planName;
        vendors.plan_tier = tierMeta.label;
        vendors.plan_priority = tierMeta.priority;
      }

      return {
        ...p,
        vendors,
        vendor_plan_name: planName,
        vendor_plan_tier: tierMeta.label,
        vendor_plan_priority: tierMeta.priority,
      };
    });

    const dedupedFinalRows = mergeRowsById(finalRows).slice(0, limit);
    const responseCount = dedupedFinalRows.length < finalRows.length ? dedupedFinalRows.length : totalCount;

    return res.json({ success: true, data: dedupedFinalRows, count: responseCount });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: 'DIR_PRODUCTS_FAILED',
      details: e.message,
    });
  }
}

router.get('/autocomplete', cacheResponse('dir:autocomplete', 300), async (req, res) => {
  try {
    const q = safeQ(req.query.q || req.query.query || req.query.term);
    if (q.length < 2) return res.json({ success: true, suggestions: [] });

    const expandedTerms = expandSemanticTokens(q).slice(0, 8);
    const likeTerms = expandedTerms.length ? expandedTerms : [q];
    const buildLikeOr = (columnSql) => likeTerms.map(() => `LOWER(COALESCE(${columnSql}, '')) LIKE LOWER(?)`).join(' OR ');
    const likeParams = () => likeTerms.map((term) => `%${term}%`);

    const [microRows, productRows, vendorRows, openSearchSuggestions] = await Promise.all([
      mysqlQuery(
        `SELECT mc.id, mc.name, mc.slug,
                sc.id AS sub_id, sc.name AS sub_name, sc.slug AS sub_slug,
                hc.id AS head_id, hc.name AS head_name, hc.slug AS head_slug
           FROM micro_categories mc
           LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
           LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
          WHERE COALESCE(mc.is_active, 1) = 1
            AND (${buildLikeOr('mc.name')})
          ORDER BY mc.sort_order ASC, mc.name ASC
          LIMIT 8`,
        likeParams()
      ),
      mysqlQuery(
        `SELECT p.id, p.name, p.slug, p.micro_category_id,
                mc.name AS micro_name, mc.slug AS micro_slug,
                sc.id AS sub_id, sc.slug AS sub_slug,
                hc.id AS head_id, hc.slug AS head_slug
           FROM products p
           JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN micro_categories mc ON mc.id = p.micro_category_id
           LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
           LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
          WHERE p.status = 'ACTIVE'
            AND COALESCE(v.is_active, 1) = 1
            AND ((${buildLikeOr('p.name')}) OR (${buildLikeOr('p.category')}) OR (${buildLikeOr('p.category_path')}))
          ORDER BY p.created_at DESC
          LIMIT 8`,
        [...likeParams(), ...likeParams(), ...likeParams()]
      ),
      mysqlQuery(
        `SELECT id, company_name, slug, city, state
           FROM vendors
          WHERE COALESCE(is_active, 1) = 1
            AND (${buildLikeOr('company_name')})
          ORDER BY created_at DESC
          LIMIT 4`,
        likeParams()
      ),
      autocompleteOpenSearchProducts(q, { limit: 8 }).catch((error) => {
        logger.warn('[dir/autocomplete] OpenSearch suggestions skipped:', error?.message);
        return [];
      }),
    ]);

    const suggestions = [...openSearchSuggestions];
    microRows.forEach((item) => {
      suggestions.push({
        id: item.id,
        name: item.name,
        slug: item.slug,
        path: [item.head_name, item.sub_name, item.name].filter(Boolean).join(' > '),
        head_id: item.head_id,
        sub_id: item.sub_id,
        sub_slug: item.sub_slug,
        head_slug: item.head_slug,
        type: 'micro',
      });
    });

    productRows.forEach((item) => {
      suggestions.push({
        id: item.id,
        name: item.name,
        slug: item.micro_slug || item.slug || slugifySearch(item.name),
        product_slug: item.slug,
        path: item.micro_name ? `Product in ${item.micro_name}` : 'Product',
        head_id: item.head_id,
        sub_id: item.sub_id,
        sub_slug: item.sub_slug,
        head_slug: item.head_slug,
        type: 'product',
      });
    });

    vendorRows.forEach((item) => {
      suggestions.push({
        id: item.id,
        name: item.company_name,
        slug: item.slug,
        path: [item.city, item.state].filter(Boolean).join(', ') || 'Company',
        type: 'vendor',
      });
    });

    const seen = new Set();
    const unique = suggestions.filter((item) => {
      const key = `${item.type}:${item.slug || item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ success: true, suggestions: unique.slice(0, 12) });
  } catch (error) {
    logger.warn('[dir/autocomplete] failed:', error?.message);
    res.status(500).json({ success: false, error: 'AUTOCOMPLETE_FAILED', details: error?.message });
  }
});

router.get('/hybrid-search', optionalAuth(), async (req, res) => {
  try {
    const q = safeQ(req.query.q || req.query.query || req.query.term);
    const microSlug = safeQ(req.query.microSlug || req.query.micro || req.query.micro_slug);
    const sort = String(req.query.sort || '').trim();
    const page = clampInt(req.query.page, 1, 1, 5000);
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const stateId = isValidId(req.query.stateId) ? req.query.stateId : (isValidId(req.query.state_id) ? req.query.state_id : null);
    const districtId = isValidId(req.query.districtId) ? req.query.districtId : (isValidId(req.query.district_id) ? req.query.district_id : null);
    const cityId = isValidId(req.query.cityId) ? req.query.cityId : (isValidId(req.query.city_id) ? req.query.city_id : null);
    const offset = (page - 1) * limit;
    const visitorId = safeText(req.query?.visitor_id || req.query?.visitorId || req.headers?.['x-visitor-id'], 191);
    const personalized = Boolean(req.user?.id || req.user?.email || visitorId);
    const cacheKey = `hybrid:v12:${JSON.stringify({ q, microSlug, sort, page, limit, stateId, districtId, cityId })}`;

    if (!personalized && isRedisConfigured()) {
      const cached = await cacheGetJson(cacheKey).catch(() => null);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
    }

    const categoryContext = await resolveMicroCategoryContext(microSlug);
    const microId = categoryContext?.microId || null;
    const fallbackScopes = dedupeCategoryScopes([
      ...buildCategoryFallbackScopes(categoryContext),
      ...(q ? await resolveSearchCategoryFallbackScopes(q) : []),
    ]);
    let { rows, totalCount } = await runHybridSearchWithFallback({
      q,
      microId,
      stateId,
      districtId,
      cityId,
      sort,
      limit,
      offset,
    });

    if (!rows.length && q) {
      const fuzzy = await fetchFuzzyCandidates({ q, microId, stateId, districtId, cityId, sort, limit });
      rows = fuzzy.rows;
      totalCount = fuzzy.totalCount;
    }

    rows = rankRowsForSearchIntent(mergeRowsById(rows), q, sort).slice(0, limit);
    totalCount = rows.length;
    const exactAvailable = rows.length > 0;
    let scopedRecommendations = [];
    let locationRelaxed = false;
    let locationRelaxationLevel = '';

    if (!exactAvailable && q && cityId && stateId) {
      const nearby = await runHybridSearchWithFallback({
        q,
        microId,
        stateId,
        districtId,
        cityId: null,
        sort,
        limit,
        offset: 0,
      });
      let nearbyRows = mergeRowsById(nearby.rows || []);

      if (!nearbyRows.length) {
        const nearbyFuzzy = await fetchFuzzyCandidates({
          q,
          microId,
          stateId,
          districtId,
          cityId: null,
          sort,
          limit,
        });
        nearbyRows = mergeRowsById(nearbyFuzzy.rows || []);
      }

      if (!nearbyRows.length && microId) {
        const nearbyCategory = await runHybridMysqlSearch({
          q: '',
          microId,
          stateId,
          districtId,
          cityId: null,
          sort,
          limit,
          offset: 0,
          useFullText: false,
          broad: true,
        });
        nearbyRows = mergeRowsById(nearbyCategory.rows || []);
      }

      if (nearbyRows.length) {
        scopedRecommendations = rankRowsForSearchIntent(nearbyRows, q, sort).slice(0, limit);
        locationRelaxed = true;
        locationRelaxationLevel = 'city';
      }
    }

    if (!exactAvailable && q) {
      for (const scope of scopedRecommendations.length ? [] : fallbackScopes) {
        const scoped = await runHybridSearchWithFallback({
          q,
          ...scope,
          stateId,
          districtId,
          cityId,
          sort,
          limit,
          offset: 0,
        });
        if (scoped.rows.length) {
          scopedRecommendations = rankRowsForSearchIntent(mergeRowsById(scoped.rows || []), q, sort).slice(0, limit);
          break;
        }
      }

      if (!scopedRecommendations.length) {
        for (const scope of fallbackScopes) {
          const scopedFuzzy = await fetchFuzzyCandidates({ q, ...scope, stateId, districtId, cityId, sort, limit });
          if (scopedFuzzy.rows.length) {
            scopedRecommendations = rankRowsForSearchIntent(scopedFuzzy.rows, q, sort).slice(0, limit);
            break;
          }
        }
      }
    }

    let recommendations = exactAvailable
      ? []
      : (scopedRecommendations.length
          ? scopedRecommendations
          : await fetchRecommendedProducts({
              req,
              q,
              microId,
              stateId,
              districtId,
              cityId,
              sort,
              limit,
              fallbackScopes,
            }));
    if (!exactAvailable && !recommendations.length && q && (stateId || districtId || cityId)) {
      locationRelaxed = true;
      locationRelaxationLevel = 'all';

      for (const scope of fallbackScopes) {
        const scoped = await runHybridSearchWithFallback({
          q,
          ...scope,
          stateId: null,
          districtId: null,
          cityId: null,
          sort,
          limit,
          offset: 0,
        });
        if (scoped.rows.length) {
          recommendations = rankRowsForSearchIntent(mergeRowsById(scoped.rows || []), q, sort).slice(0, limit);
          break;
        }
      }

      if (!recommendations.length) {
        recommendations = await fetchRecommendedProducts({
          req,
          q,
          microId,
          stateId: null,
          districtId: null,
          cityId: null,
          sort,
          limit,
          fallbackScopes,
        });
      }
    }

    const responseRows = rankRowsForSearchIntent(mergeRowsById(exactAvailable ? rows : recommendations), q, sort).slice(0, limit);
    const hasResults = responseRows.length > 0;
    const searchEngine = responseRows.some((row) => row?.__searchEngine === 'opensearch') ? 'opensearch' : 'mysql';
    const availabilityMessage = exactAvailable
      ? ''
      : (locationRelaxationLevel === 'city'
          ? 'This product is currently not available in the selected city. Showing relevant suppliers from nearby cities in the selected state.'
          : locationRelaxed
          ? 'This product is currently not available in the selected location. You may like these similar products from other locations.'
          : 'This product is currently not available. You may like these similar products.');
    const response = {
      success: true,
      data: responseRows,
      count: responseRows.length,
      recommendations: exactAvailable ? [] : responseRows,
      availability: {
        exactAvailable,
        hasResults,
        locationRelaxed,
        locationRelaxationLevel,
        message: availabilityMessage,
      },
      meta: {
        searchMode: searchEngine === 'opensearch' ? 'opensearch_hybrid' : 'hybrid',
        searchEngine,
        autocomplete: true,
        fuzzy: true,
        fullText: true,
        semantic: true,
        personalized: Boolean(personalized),
        locationRelaxed,
        locationRelaxationLevel,
        page,
        limit,
      },
    };

    recordSearchEvent(req, { q, resultCount: rows.length, recommendationCount: recommendations.length });

    if (!personalized && isRedisConfigured()) {
      cacheSetJson(cacheKey, response, 120).catch((error) => logger.warn('[dir/hybrid-search] cache set failed:', error?.message));
    }

    res.setHeader('X-Cache', 'MISS');
    return res.json(response);
  } catch (error) {
    logger.error('[dir/hybrid-search] failed:', error);
    return res.status(500).json({ success: false, error: 'HYBRID_SEARCH_FAILED', details: error?.message });
  }
});

// ✅ IMPORTANT: your UI search page calls /api/dir/search
router.get('/search', cacheResponse('dir:search', 120), handleRankedProducts);

// existing endpoint
router.get('/products', cacheResponse('dir:products', 120), handleRankedProducts);

// --- PUBLIC LOCATION ROUTES ---
router.get('/states', cacheResponse('dir:states', 3600), async (req, res) => {
  try {
    const { data, error } = await db.from('states').select('id, name, slug').order('name');
    if (error) throw error;
    res.json({ success: true, states: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/districts', cacheResponse('dir:districts', 3600), async (req, res) => {
  try {
    const { stateId } = req.query;
    if (!isValidId(stateId)) return res.status(400).json({ success: false, error: 'stateId required' });
    const { data, error } = await db
      .from('districts')
      .select('id, state_id, name, slug, supplier_count, is_active')
      .eq('state_id', stateId)
      .order('name');
    if (error) throw error;
    const rows = data || [];
    const activeRows = rows.filter((row) => row?.is_active === true || row?.is_active === 1 || row?.is_active === '1');
    return res.json({ success: true, districts: activeRows.length ? activeRows : rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/cities', cacheResponse('dir:cities', 3600), async (req, res) => {
  try {
    const { stateId, districtId } = req.query;
    if (!isValidId(stateId)) return res.status(400).json({ success: false, error: 'stateId required' });
    if (districtId && !isValidId(districtId)) return res.status(400).json({ success: false, error: 'invalid districtId' });
    let query = db.from('cities').select('id, name, slug, supplier_count, state_id, district_id, is_active').eq('state_id', stateId);
    if (districtId) query = query.eq('district_id', districtId);
    query = query.order('name');
    const { data, error } = await query;
    if (error && String(error.message).includes('does not exist')) {
      const fb = await db.from('cities').select('id, name, slug, supplier_count, state_id, is_active').eq('state_id', stateId).order('name');
      const fallbackRows = fb.data || [];
      const fallbackActiveRows = fallbackRows.filter((row) => row?.is_active === true || row?.is_active === 1 || row?.is_active === '1');
      return res.json({ success: true, cities: fallbackActiveRows.length ? fallbackActiveRows : fallbackRows });
    }
    if (error) throw error;
    const rows = data || [];
    const activeRows = rows.filter((row) => row?.is_active === true || row?.is_active === 1 || row?.is_active === '1');
    res.json({ success: true, cities: activeRows.length ? activeRows : rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PUBLIC CATEGORY ROUTES ---
router.get('/head-categories', cacheResponse('dir:head-categories', 1800), async (req, res) => {
  try {
    const { data, error } = await db.from('head_categories').select('id, name, slug, image_url, description').eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/sub-categories', cacheResponse('dir:sub-categories', 1800), async (req, res) => {
  try {
    const { headId } = req.query;
    if (!isValidId(headId)) return res.status(400).json({ success: false, error: 'headId required' });
    const { data, error } = await db.from('sub_categories').select('id, name, slug, image_url, description').eq('head_category_id', headId).eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/micro-categories', cacheResponse('dir:micro-categories', 1800), async (req, res) => {
  try {
    const { subId } = req.query;
    if (!isValidId(subId)) return res.status(400).json({ success: false, error: 'subId required' });
    const { data, error } = await db.from('micro_categories').select('id, name, slug, sort_order, image_url').eq('sub_category_id', subId).eq('is_active', true).order('sort_order').order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADVANCED DIRECTORY ENDPOINTS ---

router.get('/search-micro', cacheResponse('dir:search-micro', 300), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ success: true, results: [] });

    let results = [];

    const { data: microData } = await db
      .from('micro_categories')
      .select('id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug))')
      .ilike('name', `%${q}%`)
      .limit(10);

    if (microData) {
      results = microData.map(item => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        path: `${item.sub_categories?.head_categories?.name} > ${item.sub_categories?.name} > ${item.name}`,
        head_id: item.sub_categories?.head_categories?.id,
        sub_id: item.sub_categories?.id,
        sub_slug: item.sub_categories?.slug,
        head_slug: item.sub_categories?.head_categories?.slug,
        type: 'micro'
      }));
    }

    if (results.length < 6) {
      const { data: prodData } = await db
        .from('products')
        .select('id, micro_category_id, status')
        .ilike('name', `%${q}%`)
        .or('status.eq.ACTIVE,status.is.null')
        .limit(20);

      if (prodData) {
        const microIds = Array.from(new Set(prodData.map(p => p.micro_category_id).filter(Boolean)));
        if (microIds.length > 0) {
          const { data: microFromProducts } = await db
            .from('micro_categories')
            .select('id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug))')
            .in('id', microIds)
            .limit(10);

          if (microFromProducts) {
            const mapped = microFromProducts.map(item => ({
              id: item.id,
              name: item.name,
              slug: item.slug,
              path: `${item.sub_categories?.head_categories?.name} > ${item.sub_categories?.name} > ${item.name}`,
              head_id: item.sub_categories?.head_categories?.id,
              sub_id: item.sub_categories?.id,
              sub_slug: item.sub_categories?.slug,
              head_slug: item.sub_categories?.head_categories?.slug,
              type: 'micro'
            }));
            results = [...mapped, ...results];
          }
        }
      }
    }

    if (results.length < 5) {
      const { data: subData } = await db
        .from('sub_categories')
        .select('id, name, slug, head_categories(id, name, slug)')
        .ilike('name', `%${q}%`)
        .limit(10);

      if (subData) {
        const subResults = subData.map(item => ({
          id: item.id,
          name: item.name,
          slug: item.slug,
          path: `${item.head_categories?.name} > ${item.name}`,
          head_id: item.head_categories?.id,
          sub_id: item.id,
          sub_slug: item.slug,
          head_slug: item.head_categories?.slug,
          type: 'sub'
        }));
        results = [...results, ...subResults];
      }
    }

    const seen = new Set();
    const unique = [];
    for (const r of results) {
      const key = r.type + ':' + r.slug;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }
    
    res.json({ success: true, results: unique.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/products-preview', cacheResponse('dir:products-preview', 300), async (req, res) => {
  try {
    const microIdsParam = String(req.query.microIds || '');
    const ids = microIdsParam.split(',').filter(Boolean);
    if (!ids.length) return res.json({ success: true, previews: {} });
    
    const per = Math.max(1, Math.min(Number(req.query.perMicro) || 6, 12));
    const fetchLimit = Math.min(ids.length * per * 3, 600);

    const { data, error } = await db
      .from('products')
      .select('id, name, slug, price, images, micro_category_id, created_at, vendors!inner(is_active)')
      .in('micro_category_id', ids)
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);

    if (error) throw error;
    
    const map = {};
    for (const row of data || []) {
      const mid = row.micro_category_id;
      if (!mid) continue;
      if (!map[mid]) map[mid] = [];
      if (map[mid].length >= per) continue;
      map[mid].push(row);
    }
    
    res.json({ success: true, previews: map });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/micro-covers', cacheResponse('dir:micro-covers', 600), async (req, res) => {
  try {
    const microIdsParam = String(req.query.microIds || '');
    const ids = microIdsParam.split(',').filter(Boolean);
    if (!ids.length) return res.json({ success: true, covers: {} });

    // 1) First prefer explicit micro category images (if configured)
    const { data: microData, error: microErr } = await db
      .from('micro_categories')
      .select('id, image_url')
      .in('id', ids);
      
    if (microErr) throw microErr;

    const map = {};
    for (const m of microData || []) {
      const url = typeof m?.image_url === 'string' ? m.image_url.trim() : '';
      if (m?.id && url) map[m.id] = url;
    }

    const missing = ids.filter((id) => !map[id]);
    if (missing.length === 0) return res.json({ success: true, covers: map });

    const { data, error } = await db
      .from('products')
      .select('micro_category_id, images, created_at, vendors!inner(is_active)')
      .in('micro_category_id', missing)
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true)
      .order('created_at', { ascending: false });
      
    if (error) throw error;

    for (const row of data || []) {
      const mid = row.micro_category_id;
      if (!mid || map[mid]) continue;
      
      const imgs = row.images;
      let url = null;
      
      if (Array.isArray(imgs) && imgs.length > 0) {
        const first = imgs[0];
        if (typeof first === 'string') url = first;
        else if (first && typeof first === 'object') url = first.url || first.image_url || first.src || null;
      }
      
      if (typeof url === 'string' && url.trim().length > 0) map[mid] = url.trim();
    }
    
    res.json({ success: true, covers: map });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/category/:type/:slug', cacheResponse('dir:category-detail', 1800, { includeParams: true }), async (req, res) => {
  try {
    const { type, slug } = req.params;
    
    if (type === 'head') {
      let headRes = await db.from('head_categories').select('id, name, slug, description, meta_tags, keywords').eq('slug', slug).limit(1);
      if (headRes.error) headRes = await db.from('head_categories').select('id, name, slug, description').eq('slug', slug).limit(1);
      return res.json({ success: true, category: headRes.data?.[0] || null });
    }
    
    if (type === 'sub') {
      let subRes = await db.from('sub_categories').select('id, name, slug, description, meta_tags, keywords, head_category_id').eq('slug', slug).limit(1);
      if (subRes.error) subRes = await db.from('sub_categories').select('id, name, slug, description, head_category_id').eq('slug', slug).limit(1);
      return res.json({ success: true, category: subRes.data?.[0] || null });
    }
    
    if (type === 'micro') {
      const headSlug = String(req.query.headSlug || '').trim();
      const subSlug = String(req.query.subSlug || '').trim();
      const hierarchyFilters = ['mc.slug = ?', 'COALESCE(mc.is_active,1)=1'];
      const hierarchyParams = [slug];

      if (headSlug) {
        hierarchyFilters.push('hc.slug = ?');
        hierarchyParams.push(headSlug);
      }
      if (subSlug) {
        hierarchyFilters.push('sc.slug = ?');
        hierarchyParams.push(subSlug);
      }

      const rows = await mysqlQuery(
        `
          SELECT
            mc.id,
            mc.name,
            mc.slug,
            sc.id AS sub_id,
            sc.name AS sub_name,
            sc.slug AS sub_slug,
            hc.id AS head_id,
            hc.name AS head_name,
            hc.slug AS head_slug
          FROM micro_categories mc
          LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
          LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
          WHERE ${hierarchyFilters.join(' AND ')}
          ORDER BY COALESCE(mc.updated_at, mc.created_at) DESC, mc.id DESC
          LIMIT 1
        `,
        hierarchyParams
      );

      const row = rows?.[0];
      if (!row) return res.json({ success: true, category: null });

      const micro = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        sub_categories: row.sub_id ? {
          id: row.sub_id,
          name: row.sub_name,
          slug: row.sub_slug,
          head_categories: row.head_id ? {
            id: row.head_id,
            name: row.head_name,
            slug: row.head_slug,
          } : null,
        } : null,
      };
      
      let metaRes = await db.from('micro_category_meta').select('meta_tags, description, keywords').eq('micro_categories', micro.id).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (metaRes.error) metaRes = await db.from('micro_category_meta').select('meta_tags, description').eq('micro_category_id', micro.id).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      
      return res.json({ 
        success: true, 
        category: {
          ...micro,
          meta_tags: metaRes?.data?.meta_tags,
          meta_description: metaRes?.data?.description,
          meta_keywords: metaRes?.data?.keywords
        }
      });
    }

    res.status(400).json({ success: false, error: 'Invalid type' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PUBLIC_PRODUCT_DETAIL_SELECT = '*, vendors(*), micro_categories(id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug)))';

const fetchPublicProductDetail = async (column, value) =>
  db
    .from('products')
    .select(PUBLIC_PRODUCT_DETAIL_SELECT)
    .eq(column, value)
    .eq('status', 'ACTIVE')
    .eq('vendors.is_active', true)
    .limit(1)
    .maybeSingle();

router.get('/product/:slug', cacheResponse('dir:product', 300, { includeParams: true }), async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return res.status(400).json({ success: false, error: 'Slug required' });

    let { data: product, error } = await fetchPublicProductDetail('slug', slug);
    if (!error && !product) {
      const byId = await fetchPublicProductDetail('id', slug);
      product = byId.data;
      error = byId.error;
    }

    if (error || !product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    // Attempt to increment view count asynchronously without blocking
    db.from('products').update({ views: (product.views || 0) + 1 }).eq('id', product.id).then();

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PUBLIC API ROUTES ---

const isMissingColumnErr = (error, columnName) => {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('column') && msg.includes(String(columnName).toLowerCase()) && msg.includes('does not exist');
};

const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const fetchMicroCategoriesBySubIds = async (subIds) => {
  if (!Array.isArray(subIds) || subIds.length === 0) return [];
  const chunks = chunkArray(subIds, 60);
  const runChunk = async (ids) => {
    let q = db.from('micro_categories').select('id, sub_category_id, name, slug, image_url').in('sub_category_id', ids).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    let res = await q;
    if (res.error && isMissingColumnErr(res.error, 'image_url')) res = await db.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (res.error && isMissingColumnErr(res.error, 'is_active')) res = await db.from('micro_categories').select('id, sub_category_id, name, slug, image_url').in('sub_category_id', ids).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (res.error && isMissingColumnErr(res.error, 'image_url')) res = await db.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (res.error && isMissingColumnErr(res.error, 'sort_order')) {
      let q2 = db.from('micro_categories').select('id, sub_category_id, name, slug, image_url').in('sub_category_id', ids).order('name', { ascending: true });
      if (!isMissingColumnErr(res.error, 'is_active')) {
        q2 = q2.eq('is_active', true);
      }
      res = await q2;
      if (res.error && isMissingColumnErr(res.error, 'image_url')) {
        let q3 = db.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).order('name', { ascending: true });
        if (!isMissingColumnErr(res.error, 'is_active')) {
          q3 = q3.eq('is_active', true);
        }
        res = await q3;
      }
      if (res.error && isMissingColumnErr(res.error, 'is_active')) {
        res = await db.from('micro_categories').select('id, sub_category_id, name, slug, image_url').in('sub_category_id', ids).order('name', { ascending: true });
        if (res.error && isMissingColumnErr(res.error, 'image_url')) {
          res = await db.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).order('name', { ascending: true });
        }
      }
    }
    return res.data || [];
  };
  const results = [];
  // Run with limited parallelism to avoid rate limits
  for (let i = 0; i < chunks.length; i += 4) {
    const batchRes = await Promise.all(chunks.slice(i, i + 4).map(runChunk));
    batchRes.forEach((r) => results.push(...r));
  }
  return results;
};

router.get('/categories/home-showcase', cacheResponse('dir:home-showcase', 900), async (req, res) => {
  try {
    const headLimit = Number(req.query.headLimit) || 0;
    const subLimit = Number(req.query.subLimit) || 0;
    const microLimit = Number(req.query.microLimit) || 0;

    let headQuery = db.from('head_categories').select('id, name, slug, image_url, description, keywords').eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (headLimit > 0) headQuery = headQuery.limit(headLimit);
    let headRes = await headQuery;
    if (headRes.error && isMissingColumnErr(headRes.error, 'sort_order')) {
      let fallbackHeadQuery = db.from('head_categories').select('id, name, slug, image_url, description, keywords').eq('is_active', true).order('name', { ascending: true });
      if (headLimit > 0) fallbackHeadQuery = fallbackHeadQuery.limit(headLimit);
      headRes = await fallbackHeadQuery;
    }
    if (headRes.error) throw headRes.error;
    const heads = headRes.data || [];
    if (heads.length === 0) return res.json({ success: true, categories: [] });

    const headIds = heads.map((h) => h.id);
    let subRes = await db.from('sub_categories').select('id, head_category_id, name, slug, image_url, description, keywords').in('head_category_id', headIds).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (subRes.error && isMissingColumnErr(subRes.error, 'sort_order')) {
      subRes = await db.from('sub_categories').select('id, head_category_id, name, slug, image_url, description, keywords').in('head_category_id', headIds).eq('is_active', true).order('name', { ascending: true });
    }
    if (subRes.error) throw subRes.error;
    const subs = subRes.data || [];

    let limitedSubs = subs;
    if (subLimit > 0) {
      const subsByHeadRaw = subs.reduce((acc, s) => {
        if (!acc[s.head_category_id]) acc[s.head_category_id] = [];
        acc[s.head_category_id].push(s);
        return acc;
      }, {});
      limitedSubs = [];
      for (const h of heads) {
        limitedSubs.push(...(subsByHeadRaw[h.id] || []).slice(0, subLimit));
      }
    }

    const micros = await fetchMicroCategoriesBySubIds(limitedSubs.map((s) => s.id));
    const microsBySub = micros.reduce((acc, m) => {
      if (!acc[m.sub_category_id]) acc[m.sub_category_id] = [];
      if (microLimit <= 0 || acc[m.sub_category_id].length < microLimit) {
        acc[m.sub_category_id].push({ id: m.id, name: m.name, slug: m.slug, image_url: m.image_url || null });
      }
      return acc;
    }, {});

    const subsByHead = limitedSubs.reduce((acc, s) => {
      if (!acc[s.head_category_id]) acc[s.head_category_id] = [];
      acc[s.head_category_id].push({ ...s, micros: microsBySub[s.id] || [] });
      return acc;
    }, {});

    const payload = heads.map((h) => ({ ...h, subcategories: subsByHead[h.id] || [] }));
    res.json({ success: true, categories: payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/children', cacheResponse('dir:categories-children', 1800), async (req, res) => {
  try {
    const { parentId, parentType } = req.query;
    let table = parentType === 'SUB' ? 'micro_categories' : 'sub_categories';
    let foreignKey = parentType === 'SUB' ? 'sub_category_id' : 'head_category_id';

    let r = await db.from(table).select('*').eq(foreignKey, parentId).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (r.error && isMissingColumnErr(r.error, 'sort_order')) {
      r = await db.from(table).select('*').eq(foreignKey, parentId).eq('is_active', true).order('name', { ascending: true });
    }
    if (r.error) throw r.error;
    res.json({ success: true, children: r.data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/top-level', cacheResponse('dir:categories-top', 1800), async (req, res) => {
  try {
    let r = await db.from('head_categories').select('*').eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (r.error && isMissingColumnErr(r.error, 'sort_order')) {
      r = await db.from('head_categories').select('*').eq('is_active', true).order('name', { ascending: true });
    }
    if (r.error) throw r.error;
    res.json({ success: true, categories: r.data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/head-count', cacheResponse('dir:head-count', 1800), async (req, res) => {
  try {
    const { count, error } = await db.from('head_categories').select('*', { count: 'exact', head: true }).eq('is_active', true);
    if (error) throw error;
    res.json({ success: true, count: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/category/universal/:slug', cacheResponse('dir:universal', 1800, { includeParams: true }), async (req, res) => {
  try {
    const { slug } = req.params;
    const { data: h } = await db.from('head_categories').select('*').eq('slug', slug).eq('is_active', true).maybeSingle();
    if (h) return res.json({ success: true, category: { ...h, type: 'HEAD' } });
    
    const { data: s } = await db.from('sub_categories').select('*, parent:head_categories(id, name, slug)').eq('slug', slug).eq('is_active', true).maybeSingle();
    if (s) return res.json({ success: true, category: { ...s, type: 'SUB' } });
    
    const { data: m } = await db.from('micro_categories').select('*, parent:sub_categories(id, name, slug, grandparent:head_categories(id, name, slug))').eq('slug', slug).eq('is_active', true).maybeSingle();
    if (m) return res.json({ success: true, category: { ...m, type: 'MICRO' } });
    
    res.json({ success: true, category: null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendor/:vendorSlug — public vendor profile by slug
router.get('/vendor/:vendorSlug', cacheResponse('dir:vendor', 300, { includeParams: true }), async (req, res) => {
  try {
    const { vendorSlug } = req.params;
    if (!vendorSlug) return res.status(400).json({ success: false, error: 'Vendor slug required' });

    const { data: vendor, error } = await db
      .from('vendors')
      .select(`
        id, vendor_id, company_name, owner_name, email, phone,
        city, state, state_id, city_id, website, description,
        kyc_status, verification_badge, trust_score, seller_rating,
        is_active, avatar_url, banner_url, established_year,
        created_at, updated_at,
        products(id, name, slug, price, images, status, micro_category_id)
      `)
      .eq('slug', vendorSlug)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      // Retry without slug column if it doesn't exist
      if (String(error.message).includes('slug')) {
        const { data: byId, error: idErr } = await db
          .from('vendors')
          .select('id, vendor_id, company_name, owner_name, city, state, is_active, avatar_url, kyc_status, verification_badge, seller_rating')
          .eq('vendor_id', vendorSlug)
          .eq('is_active', true)
          .maybeSingle();
        if (!idErr && byId) return res.json({ success: true, vendor: byId });
      }
      throw error;
    }

    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    return res.json({ success: true, vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/categories — flat list of all categories (head level)
router.get('/categories', cacheResponse('dir:categories', 1800), async (req, res) => {
  try {
    const { data, error } = await db
      .from('head_categories')
      .select('id, name, slug, image_url, description, keywords')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/hierarchy — full 3-level category hierarchy
router.get('/hierarchy', cacheResponse('dir:hierarchy', 1800), async (req, res) => {
  try {
    const [headsRes, subsRes, microsRes] = await Promise.all([
      db.from('head_categories').select('id, name, slug, image_url, keywords').eq('is_active', true).order('name'),
      db.from('sub_categories').select('id, name, slug, head_category_id, image_url, keywords').eq('is_active', true).order('name'),
      db.from('micro_categories').select('id, name, slug, sub_category_id, image_url').eq('is_active', true).order('name'),
    ]);

    if (headsRes.error) throw headsRes.error;

    const microsBySub = (microsRes.data || []).reduce((acc, m) => {
      if (!acc[m.sub_category_id]) acc[m.sub_category_id] = [];
      acc[m.sub_category_id].push({ id: m.id, name: m.name, slug: m.slug, image_url: m.image_url || null });
      return acc;
    }, {});

    const subsByHead = (subsRes.data || []).reduce((acc, s) => {
      if (!acc[s.head_category_id]) acc[s.head_category_id] = [];
      acc[s.head_category_id].push({ id: s.id, name: s.name, slug: s.slug, image_url: s.image_url || null, keywords: s.keywords || null, micros: microsBySub[s.id] || [] });
      return acc;
    }, {});

    const hierarchy = (headsRes.data || []).map((h) => ({
      ...h,
      subcategories: subsByHead[h.id] || [],
    }));

    res.json({ success: true, hierarchy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/products/list — product listing with filters
router.get('/products/list', cacheResponse('dir:products-list', 120), async (req, res) => {
  try {
    const microId = req.query.microId || req.query.micro_id || null;
    const q = safeQ(req.query.q || req.query.search || '');
    const stateId = req.query.stateId || req.query.state_id || null;
    const cityId = req.query.cityId || req.query.city_id || null;
    const sort = req.query.sort || 'recent';
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 10000);

    let query = db
      .from('products')
      .select('*, vendors!inner(id, company_name, city, state, is_active, kyc_status, verification_badge)', { count: 'exact' })
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true);

    if (microId) query = query.eq('micro_category_id', microId);
    if (q) query = query.ilike('name', `%${q}%`);
    if (stateId) query = query.eq('vendors.state_id', stateId);
    if (cityId) query = query.eq('vendors.city_id', cityId);

    query = applySort(query, sort);
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ success: true, products: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/product/id/:productId — product by UUID/ID (not slug)
router.get('/product/id/:productId', cacheResponse('dir:product-id', 300, { includeParams: true }), async (req, res) => {
  try {
    const { productId } = req.params;
    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

    const { data: product, error } = await db
      .from('products')
      .select(PUBLIC_PRODUCT_DETAIL_SELECT)
      .eq('id', productId)
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dir/products/ratings/summary - public summary for product cards
router.post('/products/ratings/summary', async (req, res) => {
  try {
    const productIds = Array.from(
      new Set(
        (Array.isArray(req.body?.productIds) ? req.body.productIds : [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 100);

    if (!productIds.length) {
      return res.json({ success: true, summaries: {} });
    }

    await ensureProductRatingsTable();

    const { data, error } = await db
      .from('product_ratings')
      .select('product_id, rating')
      .in('product_id', productIds)
      .limit(5000);

    if (error) throw error;

    const grouped = new Map();
    (data || []).forEach((row) => {
      const key = String(row?.product_id || '').trim();
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });

    const summaries = {};
    productIds.forEach((id) => {
      summaries[id] = summarizeRatings(grouped.get(id) || []);
    });

    return res.json({ success: true, summaries });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/products/:productId/ratings - public ratings for a product
router.get('/products/:productId/ratings', optionalAuth(), async (req, res) => {
  try {
    const productId = String(req.params?.productId || '').trim();
    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

    const buyer = req.user ? await resolveBuyerProfileForUser(req.user) : null;
    const state = await getProductRatingState(productId, buyer?.id || '');

    return res.json({
      success: true,
      summary: state.summary,
      ratings: state.ratings,
      myRating: state.myRating,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dir/products/:productId/ratings - add/update buyer rating
router.post('/products/:productId/ratings', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    const productId = String(req.params?.productId || '').trim();
    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

    const rating = clampRating(req.body?.rating);
    if (!rating) {
      return res.status(400).json({ success: false, error: 'Please select a star rating' });
    }

    const buyer = await resolveBuyerProfileForUser(req.user);
    if (!buyer?.id) {
      return res.status(404).json({ success: false, error: 'Buyer profile not found' });
    }

    await ensureProductRatingsTable();

    const { data: product, error: productError } = await db
      .from('products')
      .select('id')
      .eq('id', productId)
      .maybeSingle();

    if (productError) throw productError;
    if (!product?.id) return res.status(404).json({ success: false, error: 'Product not found' });

    const nowIso = new Date().toISOString();
    const buyerName =
      safeText(req.body?.buyerName, 120) ||
      safeText(buyer.full_name, 120) ||
      safeText(buyer.company_name, 120) ||
      safeText(buyer.email, 120) ||
      'Buyer';
    const feedback = safeText(req.body?.feedback, 1000);

    const { data: existing, error: existingError } = await db
      .from('product_ratings')
      .select('id, created_at')
      .eq('product_id', productId)
      .eq('buyer_id', buyer.id)
      .maybeSingle();

    if (existingError) throw existingError;

    let entryRes;
    if (existing?.id) {
      entryRes = await db
        .from('product_ratings')
        .update({
          rating,
          feedback,
          buyer_name: buyerName,
          updated_at: nowIso,
        })
        .eq('id', existing.id)
        .select('id, product_id, buyer_id, buyer_name, rating, feedback, created_at, updated_at')
        .maybeSingle();
    } else {
      entryRes = await db
        .from('product_ratings')
        .insert([{
          product_id: productId,
          buyer_id: buyer.id,
          buyer_name: buyerName,
          rating,
          feedback,
          created_at: nowIso,
          updated_at: nowIso,
        }])
        .select('id, product_id, buyer_id, buyer_name, rating, feedback, created_at, updated_at')
        .maybeSingle();
    }

    if (entryRes.error) throw entryRes.error;

    const state = await getProductRatingState(productId, buyer.id);
    return res.json({
      success: true,
      entry: toPublicRating(entryRes.data),
      summary: state.summary,
      ratings: state.ratings,
      myRating: state.myRating,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/dir/products/:productId/ratings - remove buyer rating
router.delete('/products/:productId/ratings', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    const productId = String(req.params?.productId || '').trim();
    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

    const buyer = await resolveBuyerProfileForUser(req.user);
    if (!buyer?.id) {
      return res.status(404).json({ success: false, error: 'Buyer profile not found' });
    }

    await ensureProductRatingsTable();

    const { count, error } = await db
      .from('product_ratings')
      .delete()
      .eq('product_id', productId)
      .eq('buyer_id', buyer.id);

    if (error) throw error;

    const state = await getProductRatingState(productId, buyer.id);
    return res.json({
      success: true,
      removed: Number(count || 0) > 0,
      summary: state.summary,
      ratings: state.ratings,
      myRating: null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendors/search — search vendors by keyword
router.get('/vendors/search', cacheResponse('dir:vendors-search', 120), async (req, res) => {
  try {
    const q = safeQ(req.query.q || req.query.search || '');
    const stateId = req.query.stateId || req.query.state_id || null;
    const cityId = req.query.cityId || req.query.city_id || null;
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 10000);

    let query = db
      .from('vendors')
      .select('id, vendor_id, company_name, owner_name, city, state, state_id, city_id, avatar_url, kyc_status, verification_badge, seller_rating, trust_score', { count: 'exact' })
      .eq('is_active', true);

    if (q) query = query.ilike('company_name', `%${q}%`);
    if (stateId) query = query.eq('state_id', stateId);
    if (cityId) query = query.eq('city_id', cityId);

    query = query.order('company_name', { ascending: true }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, vendors: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendors/detail/:vendorId — vendor detail by UUID
router.get('/vendors/detail/:vendorId', cacheResponse('dir:vendor-detail', 300, { includeParams: true }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!vendorId) return res.status(400).json({ success: false, error: 'Vendor ID required' });

    const { data: vendor, error } = await db
      .from('vendors')
      .select(`
        id, vendor_id, company_name, owner_name, city, state, state_id, city_id,
        website, description, kyc_status, verification_badge, trust_score, seller_rating,
        is_active, avatar_url, banner_url, established_year, created_at,
        products(id, name, slug, price, images, status, micro_category_id)
      `)
      .eq('id', vendorId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    res.json({ success: true, vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendors/:vendorId/ratings — vendor ratings summary
router.get('/vendors/:vendorId/ratings', cacheResponse('dir:vendor-ratings', 300, { includeParams: true }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { data: vendor, error } = await db
      .from('vendors')
      .select('id, seller_rating, trust_score')
      .eq('id', vendorId)
      .maybeSingle();

    if (error) throw error;
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    // Attempt to fetch review rows if table exists
    let reviews = [];
    const reviewsRes = await db
      .from('vendor_reviews')
      .select('id, rating, comment, created_at, buyer_id')
      .eq('vendor_id', vendorId)
      .order('created_at', { ascending: false })
      .limit(20)
      .catch(() => ({ data: [], error: null }));

    reviews = reviewsRes?.data || [];

    res.json({
      success: true,
      ratings: {
        average: vendor.seller_rating || 0,
        trust_score: vendor.trust_score || 0,
        reviews,
        total_reviews: reviews.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/leads/public — public lead listings (read-only, no auth)
router.get('/leads/public', cacheResponse('dir:leads-public', 120), async (req, res) => {
  try {
    const microId = req.query.microId || req.query.micro_id || null;
    const stateId = req.query.stateId || req.query.state_id || null;
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 10000);

    let query = db
      .from('proposals')
      .select('id, buyer_name, buyer_email, product_description, quantity, budget, created_at, micro_category_id', { count: 'exact' })
      .eq('status', 'OPEN');

    if (microId) query = query.eq('micro_category_id', microId);
    if (stateId) query = query.eq('state_id', stateId);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      // Fallback: try leads table
      const leadsRes = await db
        .from('leads')
        .select('id, buyer_name, product_description, quantity, budget, created_at, micro_category_id', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      return res.json({ success: true, leads: leadsRes.data || [], total: leadsRes.count || 0 });
    }

    res.json({ success: true, leads: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dir/contact — public contact form submission
router.post('/contact', async (req, res) => {
  try {
    const { name, email, phone, message, company } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'name, email and message are required' });
    }

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
    if (!emailValid) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    const nowIso = new Date().toISOString();
    const payload = {
      name: String(name || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      phone: phone ? String(phone).trim() : null,
      message: String(message || '').trim(),
      company: company ? String(company).trim() : null,
      status: 'new',
      created_at: nowIso,
    };

    const { data, error } = await db
      .from('contact_submissions')
      .insert([payload])
      .select()
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, submission: data || payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Aliases used by employeeApiComplete.js
// GET /api/dir/categories/heads → same as /head-categories
router.get('/categories/heads', cacheResponse('dir:heads-alias', 1800), async (req, res) => {
  try {
    const { data, error } = await db
      .from('head_categories')
      .select('id, name, slug, image_url, description, keywords, is_active')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/categories/subs?head_id=... → sub-categories by head
router.get('/categories/subs', cacheResponse('dir:subs-alias', 1800), async (req, res) => {
  try {
    const headId = req.query.head_id || req.query.headId || req.query.headCategoryId;
    if (!headId) return res.status(400).json({ success: false, error: 'head_id is required' });
    const { data, error } = await db
      .from('sub_categories')
      .select('id, name, slug, head_category_id, image_url, keywords, is_active')
      .eq('head_category_id', headId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/categories/micros?sub_id=... → micro-categories by sub
router.get('/categories/micros', cacheResponse('dir:micros-alias', 1800), async (req, res) => {
  try {
    const subId = req.query.sub_id || req.query.subId || req.query.subCategoryId;
    if (!subId) return res.status(400).json({ success: false, error: 'sub_id is required' });
    const { data, error } = await db
      .from('micro_categories')
      .select('id, name, slug, sub_category_id, image_url, is_active')
      .eq('sub_category_id', subId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
