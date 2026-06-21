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
        vendor_active: { type: 'boolean' },
        vendor_verified: { type: 'boolean' },
        vendor_plan_name: { type: 'keyword' },
        vendor_plan_priority: { type: 'integer' },
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
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%diamond%' THEN 700
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%gold%' THEN 600
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%silver%' THEN 500
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%boost%' THEN 400
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%certif%' THEN 300
    WHEN LOWER(COALESCE(vp.name, '')) LIKE '%startup%' THEN 200
    ELSE 100
  END`;
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
    vendor_active: activeBool(row.vendor_active),
    vendor_verified: String(row.vendor_kyc_status || '').toUpperCase() === 'VERIFIED' || Boolean(row.vendor_verification_badge),
    vendor_plan_name: row.vendor_plan_name || 'TRIAL',
    vendor_plan_priority: planPriority,
    price: numberOrNull(row.price),
    price_unit: row.price_unit || null,
    status: row.status || 'ACTIVE',
    images: safeJson(row.images, []),
    created_at: toIsoDate(row.created_at),
    updated_at: toIsoDate(row.updated_at || row.created_at),
  };
}

export async function fetchProductRowsForOpenSearch({ limit = 500, offset = 0 } = {}) {
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
            v.is_active AS vendor_active, v.kyc_status AS vendor_kyc_status,
            v.verification_badge AS vendor_verification_badge,
            COALESCE(vp.name, 'TRIAL') AS vendor_plan_name,
            ${planPriorityCaseSql()} AS vendor_plan_priority
       FROM products p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN micro_categories mc ON mc.id = p.micro_category_id
       LEFT JOIN sub_categories sc ON sc.id = COALESCE(p.sub_category_id, mc.sub_category_id)
       LEFT JOIN head_categories hc ON hc.id = COALESCE(p.head_category_id, sc.head_category_id)
       LEFT JOIN vendor_plan_subscriptions vps
         ON vps.vendor_id = p.vendor_id
        AND vps.status = 'ACTIVE'
        AND (vps.end_date IS NULL OR vps.end_date > UTC_TIMESTAMP())
       LEFT JOIN vendor_plans vp ON vp.id = vps.plan_id
      WHERE p.status = 'ACTIVE'
        AND COALESCE(v.is_active, 1) = 1
      ORDER BY p.updated_at DESC, p.created_at DESC, p.id DESC
      LIMIT ? OFFSET ?`,
    [Number(limit), Number(offset)]
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
    logger.info(`[opensearch] indexed ${total} products`);
    if (rows.length < batchSize) break;
  }

  await openSearchRequest(`/${encodeURIComponent(getOpenSearchIndex())}/_refresh`, { method: 'POST', timeoutMs: 15000 });
  return { indexed: total, index: getOpenSearchIndex() };
}

function addIdFilter(filter, field, value) {
  if (value) filter.push({ term: { [field]: value } });
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
  addIdFilter(filter, 'vendor_state_id', stateId);
  addIdFilter(filter, 'vendor_city_id', cityId);
  return filter;
}

function openSearchSort(sort = '') {
  if (sort === 'price_asc') {
    return [{ price: { order: 'asc', missing: '_last' } }, { vendor_plan_priority: 'desc' }, { _score: 'desc' }];
  }
  if (sort === 'price_desc') {
    return [{ price: { order: 'desc', missing: '_last' } }, { vendor_plan_priority: 'desc' }, { _score: 'desc' }];
  }
  return [{ _score: 'desc' }, { vendor_plan_priority: 'desc' }, { created_at: 'desc' }];
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
        { field_value_factor: { field: 'vendor_plan_priority', factor: 0.015, missing: 100 } },
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
    verification_badge: Boolean(src.vendor_verified),
    kyc_status: src.vendor_verified ? 'VERIFIED' : null,
    plan_name: src.vendor_plan_name || 'TRIAL',
    plan_priority: Number(src.vendor_plan_priority || 100),
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
    __sortScore: Number(hit._score || 0),
    __searchEngine: 'opensearch',
  };
}

function autocompleteSuggestionFromSource(src = {}, hit = {}) {
  const name = src.name || hit.text || '';
  if (!name) return null;
  return {
    id: src.id || hit._id || slugifySearch(name),
    name,
    slug: src.micro_slug || src.category_slug || src.slug || slugifySearch(name),
    product_slug: src.slug || null,
    path: src.micro_name ? `Product in ${src.micro_name}` : (src.category || 'Product'),
    head_id: src.head_category_id || null,
    sub_id: src.sub_category_id || null,
    sub_slug: src.sub_category_slug || null,
    head_slug: src.head_category_slug || null,
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
  const body = {
    from: offset,
    size: limit,
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
  const total = typeof result?.hits?.total === 'number'
    ? result.hits.total
    : Number(result?.hits?.total?.value || hits.length);
  return {
    rows: hits.map(productFromOpenSearchHit),
    totalCount: total,
    engine: 'opensearch',
  };
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
          { field_value_factor: { field: 'vendor_plan_priority', factor: 0.01, missing: 100 } },
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
    sort: [{ _score: 'desc' }, { vendor_plan_priority: 'desc' }],
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
