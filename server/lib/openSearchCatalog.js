import { logger } from '../utils/logger.js';
import { mysqlQuery } from './mysqlPool.js';

const DEFAULT_INDEX = 'itm_products_v1';
const DEFAULT_TIMEOUT_MS = 5000;

const SEMANTIC_TOKEN_MAP = {
  phone: ['mobile', 'smartphone', 'telephone', 'cellphone'],
  mobile: ['phone', 'smartphone', 'cellphone'],
  laptop: ['notebook', 'computer', 'pc'],
  computer: ['pc', 'desktop', 'laptop'],
  shoe: ['shoes', 'footwear', 'sneaker', 'sneakers', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots'],
  shoes: ['shoe', 'footwear', 'sneaker', 'sneakers', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots'],
  footwear: ['shoe', 'shoes', 'sneaker', 'sneakers', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots'],
  saree: ['sari', 'fabric', 'textile', 'dress'],
  sari: ['saree', 'fabric', 'textile', 'dress'],
  textile: ['fabric', 'cloth', 'garment', 'apparel'],
  garment: ['apparel', 'clothing', 'textile'],
  apparel: ['garment', 'clothing', 'textile'],
  consultant: ['consulting', 'service', 'advisor', 'engineer'],
  consulting: ['consultant', 'service', 'advisor'],
  design: ['drawing', 'layout', 'planning', 'engineering'],
  machine: ['machinery', 'equipment', 'tool'],
  machinery: ['machine', 'equipment', 'tool'],
  equipment: ['machine', 'machinery', 'tool'],
  survey: ['surveyor', 'surveying', 'topographic', 'dgps', 'land survey'],
  surveyor: ['survey', 'surveying', 'topographic', 'dgps', 'land survey'],
  surveying: ['survey', 'surveyor', 'topographic', 'dgps', 'land survey'],
  supplier: ['vendor', 'manufacturer', 'dealer'],
  manufacturer: ['supplier', 'vendor', 'producer'],
  dealer: ['supplier', 'vendor', 'distributor'],
  lubricant: ['oil', 'engine oil', 'grease'],
  oil: ['lubricant', 'engine oil', 'grease'],
  packaging: ['packing', 'box', 'carton'],
  solar: ['panel', 'inverter', 'renewable'],
  furniture: ['chair', 'table', 'sofa'],
};

const OPENSEARCH_SYNONYMS = [
  'phone, mobile, smartphone, cellphone, telephone',
  'laptop, notebook, computer, pc',
  'shoe, shoes, footwear, sneaker, sneakers, slipper, slippers, sandal, sandals, boot, boots',
  'saree, sari, fabric, textile',
  'textile, fabric, cloth, garment, apparel, clothing',
  'consultant, consulting, advisor, service',
  'survey, surveyor, surveying, topographic survey, land survey, dgps survey',
  'machine, machinery, equipment, tool',
  'supplier, vendor, manufacturer, dealer, distributor, producer',
  'lubricant, oil, engine oil, grease',
  'packaging, packing, box, carton',
  'solar, solar panel, panel, inverter, renewable',
  'furniture, chair, table, sofa',
];

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

function addTokenVariants(token = '', target = new Set()) {
  const value = String(token || '').trim();
  if (value.length < 2) return;

  target.add(value);
  if (value === 'shoes') {
    target.add('shoe');
    return;
  }
  if (value.endsWith('ies') && value.length > 4) target.add(`${value.slice(0, -3)}y`);
  if (value.endsWith('es') && value.length > 3) target.add(value.slice(0, -2));
  if (value.endsWith('s') && value.length > 3) {
    target.add(value.slice(0, -1));
  } else if (value.endsWith('e') && value.length >= 3) {
    target.add(`${value}s`);
  } else if (value.length >= 3) {
    target.add(`${value}s`);
    target.add(`${value}es`);
  }
}

function searchTokens(value = '', max = 14) {
  const out = new Set();
  normalizeSearchText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .forEach((token) => {
      addTokenVariants(token, out);
      (SEMANTIC_TOKEN_MAP[token] || []).forEach((synonym) => out.add(synonym));
    });
  return Array.from(out).slice(0, max);
}

function productDedupeKey(row = {}) {
  return productDedupeKeys(row)[0] || '';
}

function productDedupeKeys(row = {}) {
  const normalize = (value = '') => normalizeSearchText(value).replace(/\s+/g, '-');
  const canonicalName = (value = '') => normalize(value)
    .replace(/-(service|services|supplier|suppliers|manufacturer|manufacturers|product|products)$/g, '');
  const imageKey = (() => {
    const pick = (value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') return value.url || value.image_url || value.src || '';
      return '';
    };
    const raw = row?.images;
    if (Array.isArray(raw)) return normalize(pick(raw[0]));
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalize(pick(parsed[0]));
      } catch (_) {
        return normalize(raw);
      }
    }
    return normalize(row?.image || row?.image_url || '');
  })();
  const unique = (keys = []) => {
    const seen = new Set();
    return keys.filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const vendorNameKey = normalize(
    row?.vendorName ||
      row?.vendor_name ||
      row?.vendors?.company_name ||
      row?.company_name
  );
  const vendorIdKey = normalize(row?.vendorId || row?.vendor_id || row?.vendors?.id);
  const vendorKeys = unique([vendorNameKey, vendorIdKey]);
  const nameKey = canonicalName(row?.name || row?.product_name || row?.title || row?.slug);
  const stableKey = normalize(row?.id || row?.slug);
  const categoryKey = normalize(row?.category_slug || row?.category || row?.micro_category_name);
  const priceKey = normalize(row?.price);
  const unitKey = normalize(row?.price_unit || row?.qty_unit || row?.unit);
  const keys = [];

  vendorKeys.forEach((vendorKey) => {
    if (nameKey) keys.push(`vendor-name:${vendorKey}:${nameKey}`);
    if (imageKey) keys.push(`vendor-image:${vendorKey}:${imageKey}`);
  });
  if (stableKey) keys.push(`product:${stableKey}`);
  if (!vendorKeys.length && nameKey) keys.push(`name:${nameKey}:${categoryKey}:${priceKey}:${unitKey}:${imageKey}`);
  if (!vendorKeys.length && imageKey) keys.push(`image:${nameKey}:${imageKey}`);
  return unique(keys);
}

function searchTokenVariants(token = '') {
  const normalized = normalizeSearchText(token);
  const variants = new Set();
  if (!normalized) return [];
  if (normalized.includes(' ')) variants.add(normalized);
  else addTokenVariants(normalized, variants);
  (SEMANTIC_TOKEN_MAP[normalized] || []).forEach((synonym) => {
    const normalizedSynonym = normalizeSearchText(synonym);
    if (!normalizedSynonym) return;
    if (normalizedSynonym.includes(' ')) variants.add(normalizedSynonym);
    else addTokenVariants(normalizedSynonym, variants);
  });
  return Array.from(variants);
}

function fieldHasSearchToken(field = '', token = '') {
  const normalizedField = normalizeSearchText(field);
  if (!normalizedField) return false;
  return searchTokenVariants(token).some((variant) => {
    if (!variant) return false;
    if (variant.includes(' ')) return normalizedField.includes(variant);
    return normalizedField === variant ||
      normalizedField.startsWith(`${variant} `) ||
      normalizedField.endsWith(` ${variant}`) ||
      normalizedField.includes(` ${variant} `);
  });
}

const LAND_SURVEY_TOKENS = new Set(['survey', 'surveyor', 'surveyors', 'surveying', 'topographic', 'dgps']);
const SURVEY_PRIMARY_NAME_RE = /\b(land\s+survey|land\s+surveyor|survey|surveyor|surveying|topographic|topographical|dgps|total\s+station|route\s+survey|contour\s+survey|cadastral\s+survey)\b/;
const SURVEY_SUPPORTING_NAME_RE = /\b(gps|ts\s+survey|levelling|leveling|mapping|demarcation)\b/;
const NON_SURVEY_ENGINEERING_RE = /\b(geotechnical|geo\s*technical|soil\s+testing|soil|investigation|pile|plate\s+load|thermal\s+resistivity|borehole|cross\s+hole|hydro\s+geological)\b/;

function isLandSurveyIntent(query = '', tokens = searchTokens(query, 10)) {
  const normalized = normalizeSearchText(query);
  const hasSurvey = tokens.some((token) => LAND_SURVEY_TOKENS.has(token)) || /\bsurvey(or|ors|ing)?\b/.test(normalized);
  const hasLand = tokens.includes('land') || /\bland\b/.test(normalized);
  return hasSurvey && (hasLand || /\b(topographic|dgps|total\s+station|route\s+survey)\b/.test(normalized));
}

function surveyIntentBonus(query = '', row = {}) {
  const tokens = searchTokens(query, 10);
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

  const tokens = searchTokens(query, 10);
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

  const landIntent = tokens.includes('land') || tokens.includes('land survey');
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

function dedupeProductRows(rows = []) {
  const keyToIndex = new Map();
  const unique = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const keys = productDedupeKeys(row);
    if (!keys.length) return;
    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index) => Number.isInteger(index));

    if (Number.isInteger(existingIndex)) {
      const current = unique[existingIndex];
      const rowSlot = Number(row?.premium_slot_rank || 0);
      const currentSlot = Number(current?.premium_slot_rank || 0);
      const rowScore = Number(row?.__sortScore || 0);
      const currentScore = Number(current?.__sortScore || 0);
      if (rowSlot > currentSlot || (rowSlot === currentSlot && rowScore > currentScore)) unique[existingIndex] = row;
      keys.forEach((key) => keyToIndex.set(key, existingIndex));
      return;
    }

    const nextIndex = unique.length;
    unique.push(row);
    keys.forEach((key) => keyToIndex.set(key, nextIndex));
  });
  return unique;
}

function uniqueSearchStrings(values = [], max = 16) {
  const seen = new Set();
  const out = [];
  values
    .flat()
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 2)
    .forEach((value) => {
      const key = normalizeSearchText(value);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(value.slice(0, 80));
    });
  return out.slice(0, max);
}

function getOpenSearchUrl() {
  return String(process.env.OPENSEARCH_URL || '').replace(/\/+$/, '');
}

export function getOpenSearchIndex() {
  return String(process.env.OPENSEARCH_INDEX || DEFAULT_INDEX).trim() || DEFAULT_INDEX;
}

export function isOpenSearchCatalogEnabled() {
  const flag = String(process.env.OPENSEARCH_ENABLED || '').trim().toLowerCase();
  return Boolean(getOpenSearchUrl()) && flag !== '0' && flag !== 'false' && flag !== 'off';
}

function basicAuthHeader() {
  const username = String(process.env.OPENSEARCH_USERNAME || '').trim();
  const password = String(process.env.OPENSEARCH_PASSWORD || '');
  if (!username && !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function openSearchRequest(path, options = {}) {
  const baseUrl = getOpenSearchUrl();
  if (!baseUrl) throw new Error('OPENSEARCH_URL is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const headers = { ...(options.headers || {}) };
  const auth = basicAuthHeader();
  if (auth) headers.Authorization = auth;

  let body = options.body;
  if (body && !options.rawBody) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!res.ok) {
      const error = new Error(typeof payload === 'string' ? payload : (payload?.error?.reason || payload?.error || `OpenSearch ${res.status}`));
      error.statusCode = res.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pingOpenSearch() {
  if (!isOpenSearchCatalogEnabled()) return false;
  await openSearchRequest('/', { timeoutMs: 2500 });
  return true;
}

function productIndexBody() {
  return {
    settings: {
      index: {
        number_of_shards: 1,
        number_of_replicas: 0,
        refresh_interval: '30s',
      },
      analysis: {
        filter: {
          autocomplete_filter: {
            type: 'edge_ngram',
            min_gram: 2,
            max_gram: 20,
          },
          catalog_synonym_filter: {
            type: 'synonym_graph',
            synonyms: OPENSEARCH_SYNONYMS,
          },
        },
        analyzer: {
          autocomplete_analyzer: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding', 'autocomplete_filter'],
          },
          catalog_text_analyzer: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding'],
          },
          catalog_search_analyzer: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding', 'catalog_synonym_filter'],
          },
        },
      },
    },
    mappings: {
      dynamic: false,
      properties: {
        id: { type: 'keyword' },
        vendor_id: { type: 'keyword' },
        name: {
          type: 'text',
          analyzer: 'autocomplete_analyzer',
          search_analyzer: 'catalog_search_analyzer',
          fields: { raw: { type: 'keyword', ignore_above: 256 } },
        },
        suggest: {
          type: 'completion',
          analyzer: 'simple',
          search_analyzer: 'simple',
          preserve_separators: true,
          preserve_position_increments: true,
          max_input_length: 80,
        },
        slug: { type: 'keyword' },
        description: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        category: {
          type: 'text',
          analyzer: 'autocomplete_analyzer',
          search_analyzer: 'catalog_search_analyzer',
          fields: { raw: { type: 'keyword', ignore_above: 256 } },
        },
        category_path: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        category_slug: { type: 'keyword' },
        search_text: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        semantic_text: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        search_tokens: { type: 'keyword' },
        micro_category_id: { type: 'keyword' },
        sub_category_id: { type: 'keyword' },
        head_category_id: { type: 'keyword' },
        micro_name: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        micro_slug: { type: 'keyword' },
        sub_category_name: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        sub_category_slug: { type: 'keyword' },
        head_category_name: { type: 'text', analyzer: 'catalog_text_analyzer', search_analyzer: 'catalog_search_analyzer' },
        head_category_slug: { type: 'keyword' },
        vendor_name: {
          type: 'text',
          analyzer: 'autocomplete_analyzer',
          search_analyzer: 'catalog_search_analyzer',
          fields: { raw: { type: 'keyword', ignore_above: 256 } },
        },
        vendor_slug: { type: 'keyword' },
        vendor_city: { type: 'keyword' },
        vendor_state: { type: 'keyword' },
        vendor_state_id: { type: 'keyword' },
        vendor_city_id: { type: 'keyword' },
        vendor_all_india_visibility: { type: 'boolean' },
        vendor_active: { type: 'boolean' },
        vendor_verified: { type: 'boolean' },
        vendor_plan_name: { type: 'keyword' },
        vendor_plan_priority: { type: 'integer' },
        premium_slot_matched: { type: 'boolean' },
        premium_slot_rank: { type: 'integer' },
        premium_slot_label: { type: 'keyword' },
        price: { type: 'double' },
        price_unit: { type: 'keyword' },
        status: { type: 'keyword' },
        images: { type: 'object', enabled: false },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  };
}

export async function ensureOpenSearchProductIndex({ recreate = false } = {}) {
  if (!isOpenSearchCatalogEnabled()) return { enabled: false, created: false };
  const index = getOpenSearchIndex();
  if (recreate) {
    await openSearchRequest(`/${encodeURIComponent(index)}`, { method: 'DELETE', timeoutMs: 15000 }).catch((error) => {
      if (error.statusCode !== 404) throw error;
    });
  }

  const exists = await openSearchRequest(`/${encodeURIComponent(index)}`, { method: 'HEAD', timeoutMs: 5000 })
    .then(() => true)
    .catch((error) => {
      if (error.statusCode === 404) return false;
      throw error;
    });

  if (exists) return { enabled: true, created: false, index };
  await openSearchRequest(`/${encodeURIComponent(index)}`, {
    method: 'PUT',
    body: productIndexBody(),
    timeoutMs: 20000,
  });
  return { enabled: true, created: true, index };
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

function premiumSlotMatchSql() {
  return `(
    ${salesAssistedSlotPlanSql()}
    AND ${preferredCategoryMatchSql()}
  )`;
}

function premiumSlotRankSql() {
  return `CASE
    WHEN ${premiumSlotMatchSql()} THEN ${planPriorityCaseSql()}
    ELSE 0
  END`;
}

function premiumSlotLabelSql() {
  return `CASE
    WHEN ${premiumSlotMatchSql()} AND (LOWER(COALESCE(vp.name, '')) LIKE '%diamond%' OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%') THEN 'Diamond Supplier'
    WHEN ${premiumSlotMatchSql()} AND LOWER(COALESCE(vp.name, '')) LIKE '%gold%' THEN 'Gold Supplier'
    WHEN ${premiumSlotMatchSql()} AND LOWER(COALESCE(vp.name, '')) LIKE '%silver%' THEN 'Silver Supplier'
    ELSE ''
  END`;
}

function premiumPreferenceReadySql() {
  return `(
    NOT ${salesAssistedSlotPlanSql()}
    OR COALESCE(v.all_india_visibility, 0) = 1
    OR (
      ${preferredCategoryMatchSql()}
      AND (
        JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
        OR JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
        OR JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
      )
    )
  )`;
}

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeJson(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function activeBool(value) {
  if (value === false || value === 0) return false;
  const text = String(value ?? '').toLowerCase();
  return text !== 'false' && text !== '0';
}

function documentFromProductRow(row = {}) {
  const textParts = [
    row.name,
    row.category,
    row.category_path,
    row.description,
    row.micro_name,
    row.sub_category_name,
    row.head_category_name,
    row.vendor_name,
  ].filter(Boolean);
  const semanticTerms = textParts.flatMap((value) => searchTokens(value, 8));
  const searchText = textParts.join(' ');
  const planPriority = Number(row.vendor_plan_priority || 100);
  const suggestInputs = uniqueSearchStrings([
    row.name,
    row.category,
    row.micro_name,
    row.sub_category_name,
    row.head_category_name,
    row.vendor_name,
    searchTokens(row.name, 8),
    searchTokens(row.category, 8),
  ]);

  return {
    id: row.id,
    vendor_id: row.vendor_id || null,
    name: row.name || '',
    slug: row.slug || null,
    description: row.description || '',
    category: row.category || '',
    category_path: row.category_path || '',
    category_slug: row.category_slug || null,
    suggest: {
      input: suggestInputs,
      weight: Math.max(1, Math.min(planPriority, 1000)),
    },
    search_text: searchText,
    semantic_text: Array.from(new Set([...semanticTerms, ...searchTokens(searchText, 24)])).join(' '),
    search_tokens: Array.from(new Set([...semanticTerms, ...searchTokens(searchText, 32)])).slice(0, 96),
    micro_category_id: row.micro_category_id || null,
    sub_category_id: row.sub_category_id || null,
    head_category_id: row.head_category_id || null,
    micro_name: row.micro_name || '',
    micro_slug: row.micro_slug || null,
    sub_category_name: row.sub_category_name || '',
    sub_category_slug: row.sub_category_slug || null,
    head_category_name: row.head_category_name || '',
    head_category_slug: row.head_category_slug || null,
    vendor_name: row.vendor_name || '',
    vendor_slug: row.vendor_slug || null,
    vendor_city: row.vendor_city || '',
    vendor_state: row.vendor_state || '',
    vendor_state_id: row.vendor_state_id || null,
    vendor_city_id: row.vendor_city_id || null,
    vendor_all_india_visibility: Number(row.vendor_all_india_visibility || 0) === 1,
    vendor_active: activeBool(row.vendor_active),
    vendor_verified: String(row.vendor_kyc_status || '').toUpperCase() === 'VERIFIED' || Boolean(row.vendor_verification_badge),
    vendor_plan_name: row.vendor_plan_name || 'TRIAL',
    vendor_plan_priority: planPriority,
    premium_slot_matched: false,
    premium_slot_rank: 0,
    premium_slot_label: '',
    price: numberOrNull(row.price),
    price_unit: row.price_unit || null,
    status: row.status || 'ACTIVE',
    images: safeJson(row.images, []),
    created_at: toIsoDate(row.created_at),
    updated_at: toIsoDate(row.updated_at || row.created_at),
  };
}

export async function fetchProductRowsForOpenSearch({ limit = 500, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return mysqlQuery(
    `SELECT p.id, p.vendor_id, p.name, p.slug, p.description, p.price, p.price_unit, p.images,
            p.status, p.category, p.category_path, p.category_slug,
            p.micro_category_id, p.sub_category_id, p.head_category_id,
            p.created_at, p.updated_at,
            mc.name AS micro_name, mc.slug AS micro_slug,
            sc.name AS sub_category_name, sc.slug AS sub_category_slug,
            hc.name AS head_category_name, hc.slug AS head_category_slug,
            v.company_name AS vendor_name, v.slug AS vendor_slug, v.city AS vendor_city,
            v.state AS vendor_state, v.state_id AS vendor_state_id, v.city_id AS vendor_city_id,
            v.all_india_visibility AS vendor_all_india_visibility,
            v.is_active AS vendor_active, v.kyc_status AS vendor_kyc_status,
            v.verification_badge AS vendor_verification_badge,
            COALESCE(vp.name, 'TRIAL') AS vendor_plan_name,
            ${planPriorityCaseSql()} AS vendor_plan_priority,
            CASE WHEN ${premiumSlotMatchSql()} THEN 1 ELSE 0 END AS premium_slot_matched,
            ${premiumSlotRankSql()} AS premium_slot_rank,
            ${premiumSlotLabelSql()} AS premium_slot_label
       FROM products p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN micro_categories mc ON mc.id = p.micro_category_id
       LEFT JOIN sub_categories sc ON sc.id = COALESCE(p.sub_category_id, mc.sub_category_id)
       LEFT JOIN head_categories hc ON hc.id = COALESCE(p.head_category_id, sc.head_category_id)
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
      WHERE p.status = 'ACTIVE'
        AND COALESCE(v.is_active, 1) = 1
        AND ${premiumPreferenceReadySql()}
      ORDER BY p.updated_at DESC, p.created_at DESC, p.id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}`
  );
}

export async function bulkIndexProductRows(rows = []) {
  if (!rows.length) return { indexed: 0 };
  await ensureOpenSearchProductIndex();
  const index = getOpenSearchIndex();
  const body = rows
    .flatMap((row) => [
      { index: { _index: index, _id: row.id } },
      documentFromProductRow(row),
    ])
    .map((item) => JSON.stringify(item))
    .join('\n') + '\n';

  const result = await openSearchRequest('/_bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body,
    rawBody: true,
    timeoutMs: 45000,
  });

  if (result?.errors) {
    const failed = (result.items || []).find((item) => item.index?.error);
    throw new Error(failed?.index?.error?.reason || 'OpenSearch bulk index failed');
  }

  return { indexed: rows.length };
}

export async function reindexOpenSearchProducts({ batchSize = 500, recreate = false } = {}) {
  await ensureOpenSearchProductIndex({ recreate });
  let offset = 0;
  let total = 0;

  while (true) {
    const rows = await fetchProductRowsForOpenSearch({ limit: batchSize, offset });
    if (!rows.length) break;
    await bulkIndexProductRows(rows);
    total += rows.length;
    offset += rows.length;
    logger.log(`[opensearch] indexed ${total} products`);
    if (rows.length < batchSize) break;
  }

  await openSearchRequest(`/${encodeURIComponent(getOpenSearchIndex())}/_refresh`, { method: 'POST', timeoutMs: 15000 });
  return { indexed: total, index: getOpenSearchIndex() };
}

function addIdFilter(filter, field, value) {
  if (value) filter.push({ term: { [field]: value } });
}

function addLocationOrAllIndiaFilter(filter, field, value) {
  if (!value) return;
  filter.push({
    bool: {
      should: [
        { term: { [field]: value } },
        { term: { vendor_all_india_visibility: true } },
      ],
      minimum_should_match: 1,
    },
  });
}

function buildOpenSearchFilters({ microId, microIds, subCategoryId, headCategoryId, stateId, cityId } = {}) {
  const filter = [
    { term: { status: 'ACTIVE' } },
    { term: { vendor_active: true } },
  ];
  const scopedMicroIds = Array.isArray(microIds) ? microIds.filter(Boolean) : [];
  if (scopedMicroIds.length) filter.push({ terms: { micro_category_id: scopedMicroIds } });
  else if (microId) addIdFilter(filter, 'micro_category_id', microId);
  else if (subCategoryId) addIdFilter(filter, 'sub_category_id', subCategoryId);
  else if (headCategoryId) addIdFilter(filter, 'head_category_id', headCategoryId);
  addLocationOrAllIndiaFilter(filter, 'vendor_state_id', stateId);
  addLocationOrAllIndiaFilter(filter, 'vendor_city_id', cityId);
  return filter;
}

function openSearchSort(sort = '') {
  if (sort === 'price_asc') {
    return [{ price: { order: 'asc', missing: '_last' } }, { premium_slot_rank: 'desc' }, { _score: 'desc' }];
  }
  if (sort === 'price_desc') {
    return [{ price: { order: 'desc', missing: '_last' } }, { premium_slot_rank: 'desc' }, { _score: 'desc' }];
  }
  return [{ _score: 'desc' }, { premium_slot_rank: 'desc' }, { created_at: 'desc' }];
}

function buildProductSearchQuery({ q, microId, microIds, subCategoryId, headCategoryId, stateId, cityId }) {
  const filter = buildOpenSearchFilters({ microId, microIds, subCategoryId, headCategoryId, stateId, cityId });
  const queryText = String(q || '').trim();
  if (!queryText) return { bool: { filter, must: [{ match_all: {} }] } };

  const expandedTokens = searchTokens(queryText, 14);
  const expandedText = Array.from(new Set([queryText, ...expandedTokens])).join(' ');
  const should = [
    { match_phrase: { name: { query: queryText, boost: 16 } } },
    { match_phrase: { category: { query: queryText, boost: 10 } } },
    { match_phrase: { micro_name: { query: queryText, boost: 8 } } },
    { match_phrase: { vendor_name: { query: queryText, boost: 4 } } },
    { match_phrase_prefix: { name: { query: queryText, boost: 12, max_expansions: 30 } } },
    { match_phrase_prefix: { category: { query: queryText, boost: 9, max_expansions: 30 } } },
    {
      multi_match: {
        query: queryText,
        fields: ['name^9', 'category^7', 'micro_name^6', 'sub_category_name^5', 'head_category_name^4', 'category_path^4', 'vendor_name^2', 'description'],
        type: 'best_fields',
        fuzziness: 'AUTO',
        prefix_length: 1,
        max_expansions: 40,
        fuzzy_transpositions: true,
        operator: 'or',
        boost: 3,
      },
    },
    {
      multi_match: {
        query: queryText,
        fields: ['name^12', 'category^9', 'micro_name^7', 'sub_category_name^5', 'category_path^3'],
        type: 'best_fields',
        operator: 'and',
        boost: 5,
      },
    },
    {
      multi_match: {
        query: expandedText,
        fields: ['semantic_text^5', 'search_text^2', 'name^5', 'category^4', 'category_path^3'],
        type: 'best_fields',
        operator: 'or',
        boost: 2,
      },
    },
    { match: { semantic_text: { query: expandedText, operator: 'or', boost: 4 } } },
    { match: { search_text: { query: expandedText, operator: 'or', boost: 2 } } },
  ];
  if (expandedTokens.length) should.push({ terms: { search_tokens: expandedTokens, boost: 8 } });

  return {
    function_score: {
      boost_mode: 'sum',
      score_mode: 'sum',
      functions: [
        { field_value_factor: { field: 'premium_slot_rank', factor: 0.025, missing: 0 } },
        { filter: { term: { vendor_verified: true } }, weight: 1.5 },
      ],
      query: {
        bool: {
          filter,
          minimum_should_match: 1,
          should,
        },
      },
    },
  };
}

function productFromOpenSearchHit(hit = {}) {
  const src = hit._source || {};
  const vendor = {
    id: src.vendor_id || null,
    company_name: src.vendor_name || null,
    slug: src.vendor_slug || null,
    city: src.vendor_city || null,
    state: src.vendor_state || null,
    state_id: src.vendor_state_id || null,
    city_id: src.vendor_city_id || null,
    all_india_visibility: Boolean(src.vendor_all_india_visibility),
    verification_badge: Boolean(src.vendor_verified),
    kyc_status: src.vendor_verified ? 'VERIFIED' : null,
    plan_name: src.vendor_plan_name || 'TRIAL',
    plan_priority: Number(src.vendor_plan_priority || 100),
    premium_slot_matched: Boolean(src.premium_slot_matched),
    premium_slot_rank: Number(src.premium_slot_rank || 0),
    premium_slot_label: src.premium_slot_label || '',
  };
  return {
    id: src.id || hit._id,
    vendor_id: src.vendor_id || null,
    name: src.name || '',
    slug: src.slug || null,
    description: src.description || '',
    price: src.price,
    price_unit: src.price_unit || null,
    images: src.images || [],
    status: src.status || 'ACTIVE',
    category: src.category || '',
    category_path: src.category_path || '',
    category_slug: src.category_slug || null,
    micro_category_id: src.micro_category_id || null,
    sub_category_id: src.sub_category_id || null,
    head_category_id: src.head_category_id || null,
    created_at: src.created_at || null,
    updated_at: src.updated_at || null,
    vendors: vendor,
    vendorName: vendor.company_name,
    vendorId: vendor.id,
    vendorCity: vendor.city,
    vendorState: vendor.state,
    vendorVerified: Boolean(src.vendor_verified),
    vendorPlanName: src.vendor_plan_name || 'TRIAL',
    vendor_plan_name: src.vendor_plan_name || 'TRIAL',
    vendor_plan_priority: Number(src.vendor_plan_priority || 100),
    premium_slot_matched: Boolean(src.premium_slot_matched),
    premium_slot_rank: Number(src.premium_slot_rank || 0),
    premium_slot_label: src.premium_slot_label || '',
    __sortScore: Number(hit._score || 0),
    __searchEngine: 'opensearch',
  };
}

function autocompleteSuggestionFromSource(src = {}, hit = {}) {
  const name = src.name || hit.text || '';
  if (!name) return null;
  const id = src.id || hit._id || slugifySearch(name);
  const productSlug = src.slug || null;
  return {
    id,
    name,
    slug: src.micro_slug || src.category_slug || src.slug || slugifySearch(name),
    product_slug: productSlug,
    path: src.micro_name ? `Product in ${src.micro_name}` : (src.category || 'Product'),
    context: src.micro_name ? `Product in ${src.micro_name}` : (src.category || 'Product'),
    head_id: src.head_category_id || null,
    sub_id: src.sub_category_id || null,
    sub_slug: src.sub_category_slug || null,
    head_slug: src.head_category_slug || null,
    href: `/product/${productSlug || id}`,
    type: 'product',
    source: 'opensearch',
    score: Number(hit._score || hit._ranking_score || 0),
  };
}

function mergeAutocompleteSuggestions(...groups) {
  const seen = new Set();
  const merged = [];
  groups.flat().filter(Boolean).forEach((item) => {
    const key = `${item.type || 'product'}:${item.product_slug || item.slug || item.id || normalizeSearchText(item.name)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

export async function searchOpenSearchProducts(options = {}) {
  if (!isOpenSearchCatalogEnabled() || !String(options.q || '').trim()) return { rows: [], totalCount: 0, engine: 'mysql' };
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 50);
  const offset = Math.min(Math.max(Number(options.offset || 0), 0), 5000);
  const fetchSize = Math.min(Math.max(limit * 3, limit), 150);
  const body = {
    from: offset,
    size: fetchSize,
    track_total_hits: true,
    query: buildProductSearchQuery(options),
    sort: openSearchSort(options.sort),
  };
  const result = await openSearchRequest(`/${encodeURIComponent(getOpenSearchIndex())}/_search`, {
    method: 'POST',
    body,
    timeoutMs: 6500,
  });
  const hits = result?.hits?.hits || [];
  const rows = rankRowsForSearchIntent(
    dedupeProductRows(hits.map(productFromOpenSearchHit)),
    options.q,
    options.sort
  ).slice(0, limit);
  return {
    rows,
    totalCount: rows.length,
    engine: 'opensearch',
  };
}

export async function featuredOpenSearchProducts({ limit = 12, seed = Date.now() } = {}) {
  if (!isOpenSearchCatalogEnabled()) return [];
  const size = Math.min(Math.max(Number(limit) || 12, 1), 24);
  const numericSeed = Math.abs(Math.trunc(Number(seed) || Date.now())) % 2147483647;
  const result = await openSearchRequest(`/${encodeURIComponent(getOpenSearchIndex())}/_search`, {
    method: 'POST',
    body: {
      size,
      query: {
        function_score: {
          query: {
            bool: {
              filter: [
                { term: { status: 'ACTIVE' } },
                { term: { vendor_active: true } },
                { exists: { field: 'vendor_id' } },
              ],
            },
          },
          random_score: { seed: numericSeed, field: '_seq_no' },
          boost_mode: 'replace',
        },
      },
      collapse: { field: 'vendor_id' },
    },
    timeoutMs: 6500,
  });
  return (result?.hits?.hits || []).map(productFromOpenSearchHit).filter(Boolean).slice(0, size);
}

export async function autocompleteOpenSearchProducts(q, { limit = 8 } = {}) {
  const queryText = String(q || '').trim();
  if (!isOpenSearchCatalogEnabled() || queryText.length < 2) return [];
  const max = Math.min(Math.max(Number(limit), 1), 12);
  const expandedTokens = searchTokens(queryText, 10);
  const should = [
    { match_phrase_prefix: { name: { query: queryText, boost: 12, max_expansions: 30 } } },
    { match_phrase_prefix: { category: { query: queryText, boost: 8, max_expansions: 30 } } },
    { match_phrase_prefix: { vendor_name: { query: queryText, boost: 4, max_expansions: 20 } } },
    {
      multi_match: {
        query: queryText,
        fields: ['name^8', 'category^5', 'micro_name^4', 'sub_category_name^3', 'vendor_name^2'],
        fuzziness: 'AUTO',
        prefix_length: 1,
        max_expansions: 35,
        operator: 'or',
      },
    },
  ];
  if (expandedTokens.length) should.push({ terms: { search_tokens: expandedTokens, boost: 6 } });

  const completion = {
    field: 'suggest',
    size: max,
    skip_duplicates: true,
  };
  if (queryText.length >= 3) {
    completion.fuzzy = {
      fuzziness: queryText.length > 6 ? 2 : 1,
      min_length: 3,
      prefix_length: 1,
      transpositions: true,
    };
  }

  const body = {
    size: max,
    _source: [
      'id',
      'name',
      'slug',
      'category',
      'category_slug',
      'micro_name',
      'micro_slug',
      'sub_category_id',
      'sub_category_slug',
      'head_category_id',
      'head_category_slug',
      'vendor_plan_priority',
    ],
    suggest: {
      product_suggest: {
        prefix: queryText,
        completion,
      },
    },
    query: {
      function_score: {
        boost_mode: 'sum',
        functions: [
          { filter: { term: { vendor_verified: true } }, weight: 1.25 },
        ],
        query: {
          bool: {
            filter: [
              { term: { status: 'ACTIVE' } },
              { term: { vendor_active: true } },
            ],
            minimum_should_match: 1,
            should,
          },
        },
      },
    },
    sort: [{ _score: 'desc' }],
  };

  const result = await openSearchRequest(`/${encodeURIComponent(getOpenSearchIndex())}/_search`, {
    method: 'POST',
    body,
    timeoutMs: 4500,
  });

  const completionOptions = (result?.suggest?.product_suggest || [])
    .flatMap((group) => group?.options || [])
    .map((option) => autocompleteSuggestionFromSource(option?._source || {}, option));
  const hitSuggestions = (result?.hits?.hits || [])
    .map((hit) => autocompleteSuggestionFromSource(hit?._source || {}, hit));

  return mergeAutocompleteSuggestions(completionOptions, hitSuggestions).slice(0, max);
}
