import express from 'express';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { mysqlQuery } from '../lib/mysqlPool.js';

const router = express.Router();

const SITE_URL = String(process.env.SITE_URL || process.env.VITE_SITE_URL || 'https://indiantrademart.com').replace(/\/+$/, '');
const DEFAULT_SITEMAP_URL_LIMIT = 5000;
const parseSitemapLimit = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SITEMAP_URL_LIMIT;
  return Math.min(50000, Math.max(1000, parsed));
};
const SITEMAP_LIMIT = parseSitemapLimit(process.env.SITEMAP_URL_LIMIT);
const CATEGORY_SCOPE = String(process.env.SITEMAP_CATEGORY_SCOPE || 'all').trim().toLowerCase();
const XML_TYPE = 'application/xml; charset=utf-8';
const PRODUCT_ACTIVE_WHERE = "LOWER(COALESCE(p.status,'active')) NOT IN ('deleted','inactive','rejected')";
const VENDOR_ACTIVE_WHERE = "COALESCE(v.is_active,1)=1 AND LOWER(COALESCE(v.status,'active')) NOT IN ('deleted','inactive','rejected','terminated')";
const SITEMAP_GENERATED_AT = new Date().toISOString();
const sanitizeSitemapRevision = (value = '') => String(value || '')
  .trim()
  .replace(/[^a-z0-9_-]+/gi, '')
  .slice(0, 32);
const revisionSegmentFor = (value = '') => {
  const revision = sanitizeSitemapRevision(value);
  return revision ? `-${revision}` : '';
};
const SITEMAP_REVISION = sanitizeSitemapRevision(process.env.SITEMAP_REVISION);
const SITEMAP_REVISION_SEGMENT = revisionSegmentFor(SITEMAP_REVISION);
const EXTERNAL_SITEMAP_INDEX_URL = String(
  process.env.EXTERNAL_SITEMAP_INDEX_URL ||
  process.env.R2_SITEMAP_INDEX_URL ||
  `${SITE_URL}/sitemaps/sitemap-index.xml`
).trim();
const toPositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};
const SITEMAP_INDEX_ENTRY_LIMIT = toPositiveInt(process.env.SITEMAP_INDEX_ENTRY_LIMIT, 50000, 50000);
const SITEMAP_BATCH_URL_TARGET = toPositiveInt(process.env.SITEMAP_BATCH_URL_TARGET, 10000000, 2500000000);
const COUNTS_CACHE_MS = toPositiveInt(process.env.SITEMAP_COUNTS_CACHE_MS, 10 * 60 * 1000, 60 * 60 * 1000);
const LOCATIONS_CACHE_MS = toPositiveInt(process.env.SITEMAP_LOCATIONS_CACHE_MS, 10 * 60 * 1000, 60 * 60 * 1000);
const XML_CACHE_MS = toPositiveInt(process.env.SITEMAP_XML_CACHE_MS, 15 * 60 * 1000, 60 * 60 * 1000);
const XML_CACHE_MAX_ENTRIES = toPositiveInt(process.env.SITEMAP_XML_CACHE_MAX_ENTRIES, 64, 500);
const safeSqlInt = (value, fallback = 0, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
};

const sitemapXmlCache = new Map();
const sitemapXmlInflight = new Map();
const countsCache = { value: null, expiresAt: 0, promise: null };
const locationsCache = { value: null, expiresAt: 0, promise: null };

const staticPages = [
  { loc: '/', priority: '1.0', changefreq: 'daily' },
  { loc: '/directory', priority: '0.9', changefreq: 'daily' },
  { loc: '/products', priority: '0.9', changefreq: 'daily' },
  { loc: '/pricing', priority: '0.8', changefreq: 'weekly' },
  { loc: '/become-a-vendor', priority: '0.8', changefreq: 'weekly' },
  { loc: '/about-us', priority: '0.7', changefreq: 'monthly' },
  { loc: '/contact', priority: '0.7', changefreq: 'monthly' },
  { loc: '/help', priority: '0.6', changefreq: 'monthly' },
  { loc: '/privacy-policy', priority: '0.4', changefreq: 'yearly' },
  { loc: '/terms-of-service', priority: '0.4', changefreq: 'yearly' },
];

const slugify = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'india';

const escapeXml = (value = '') =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const absoluteUrl = (urlPath = '/') => {
  const clean = String(urlPath || '/').startsWith('/') ? String(urlPath || '/') : `/${urlPath}`;
  return `${SITE_URL}${clean}`;
};

const removeCrawlerUnfriendlyHeaders = (res) => {
  [
    'Content-Security-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    'Origin-Agent-Cluster',
    'Permissions-Policy',
    'Access-Control-Allow-Credentials',
    'Access-Control-Allow-Origin',
    'ETag',
    'Vary',
    'X-Powered-By',
    'X-Frame-Options',
  ].forEach((header) => res.removeHeader(header));
};

const dateOnly = (value) => {
  if (!value) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
};

const sitemapLastmod = (value) => {
  if (!value) return SITEMAP_GENERATED_AT;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return SITEMAP_GENERATED_AT;
  return parsed.toISOString();
};

async function readThroughCache(cache, ttlMs, loader) {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (cache.promise) return cache.promise;

  cache.promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + ttlMs;
      return value;
    })
    .finally(() => {
      cache.promise = null;
    });

  return cache.promise;
}

function getCachedXml(cacheKey) {
  const hit = sitemapXmlCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    sitemapXmlCache.delete(cacheKey);
    return null;
  }

  sitemapXmlCache.delete(cacheKey);
  sitemapXmlCache.set(cacheKey, hit);
  return hit.xml;
}

function setCachedXml(cacheKey, xml, ttlMs = XML_CACHE_MS) {
  if (!cacheKey || !xml) return;
  sitemapXmlCache.delete(cacheKey);
  sitemapXmlCache.set(cacheKey, {
    xml,
    expiresAt: Date.now() + ttlMs,
  });

  while (sitemapXmlCache.size > XML_CACHE_MAX_ENTRIES) {
    const oldestKey = sitemapXmlCache.keys().next().value;
    sitemapXmlCache.delete(oldestKey);
  }
}

async function buildXmlWithCache(cacheKey, producer, ttlMs = XML_CACHE_MS) {
  const cached = getCachedXml(cacheKey);
  if (cached) return cached;
  if (sitemapXmlInflight.has(cacheKey)) return sitemapXmlInflight.get(cacheKey);

  const promise = Promise.resolve()
    .then(producer)
    .then((xml) => {
      setCachedXml(cacheKey, xml, ttlMs);
      return xml;
    })
    .finally(() => {
      sitemapXmlInflight.delete(cacheKey);
    });

  sitemapXmlInflight.set(cacheKey, promise);
  return promise;
}

const sendXml = (res, xml, maxAge = 900) => {
  removeCrawlerUnfriendlyHeaders(res);
  res.setHeader('Content-Type', XML_TYPE);
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, must-revalidate`);
  res.setHeader('Last-Modified', new Date(SITEMAP_GENERATED_AT).toUTCString());
  res.setHeader('Content-Length', Buffer.byteLength(xml, 'utf8'));
  res.setHeader('X-Robots-Tag', 'index, follow');
  res.status(200).end(xml);
};

async function sendXmlFromCache(req, res, cacheKey, producer, maxAge = 900) {
  const xml = await buildXmlWithCache(cacheKey || req.originalUrl || req.url, producer);
  sendXml(res, xml, maxAge);
}

const renderUrlset = (entries = [], options = {}) => {
  const includeSeo = Boolean(options.includeSeo);
  const rows = entries
    .filter((entry) => entry?.loc)
    .map((entry) => {
      const loc = escapeXml(entry.loc.startsWith('http') ? entry.loc : absoluteUrl(entry.loc));
      const lastmod = escapeXml(dateOnly(entry.lastmod));
      const changefreq = entry.changefreq ? `\n    <changefreq>${escapeXml(entry.changefreq)}</changefreq>` : '';
      const priority = entry.priority ? `\n    <priority>${escapeXml(entry.priority)}</priority>` : '';
      const seoTitle = includeSeo && entry.title ? `\n    <seo:title>${escapeXml(entry.title)}</seo:title>` : '';
      const seoDescription = includeSeo && entry.description ? `\n    <seo:description>${escapeXml(entry.description)}</seo:description>` : '';
      const seoKeywords = includeSeo && entry.keywords ? `\n    <seo:keywords>${escapeXml(entry.keywords)}</seo:keywords>` : '';
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>${changefreq}${priority}${seoTitle}${seoDescription}${seoKeywords}\n  </url>`;
    })
    .join('\n');
  const seoNs = includeSeo ? ' xmlns:seo="https://indiantrademart.com/schemas/seo/1.0"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${seoNs}>\n${rows}\n</urlset>`;
};

const renderIndex = (entries = []) => {
  const rows = entries
    .filter((entry) => entry?.loc)
    .map((entry) => {
      const loc = escapeXml(entry.loc.startsWith('http') ? entry.loc : absoluteUrl(entry.loc));
      return `  <sitemap>\n    <loc>${loc}</loc>\n    <lastmod>${escapeXml(sitemapLastmod(entry.lastmod))}</lastmod>\n  </sitemap>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</sitemapindex>`;
};

const firstNumber = (rows, key = 'total') => Number(rows?.[0]?.[key] || 0);

async function tableExists(tableName) {
  const rows = await mysqlQuery(
    'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tableName]
  );
  return firstNumber(rows) > 0;
}

async function loadCounts() {
  const [locations, products, vendors, allMicros, usedMicros, vendorServices] = await Promise.all([
    mysqlQuery(`
      SELECT COUNT(*) AS total
      FROM cities c
      JOIN states s ON s.id = c.state_id
      WHERE COALESCE(c.is_active,1)=1 AND COALESCE(s.is_active,1)=1
    `),
    mysqlQuery(`SELECT COUNT(*) AS total FROM products p WHERE ${PRODUCT_ACTIVE_WHERE}`),
    mysqlQuery(`SELECT COUNT(*) AS total FROM vendors v WHERE ${VENDOR_ACTIVE_WHERE}`),
    mysqlQuery('SELECT COUNT(*) AS total FROM micro_categories mc WHERE COALESCE(mc.is_active,1)=1'),
    mysqlQuery(`
      SELECT COUNT(DISTINCT p.micro_category_id) AS total
      FROM products p
      JOIN micro_categories mc ON mc.id = p.micro_category_id
      WHERE ${PRODUCT_ACTIVE_WHERE} AND p.micro_category_id IS NOT NULL AND COALESCE(mc.is_active,1)=1
    `),
    mysqlQuery(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT DISTINCT p.vendor_id, p.micro_category_id
        FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        JOIN micro_categories mc ON mc.id = p.micro_category_id
        WHERE ${PRODUCT_ACTIVE_WHERE}
          AND ${VENDOR_ACTIVE_WHERE}
          AND p.micro_category_id IS NOT NULL
          AND COALESCE(mc.is_active,1)=1
      ) x
    `),
  ]);

  const locationCount = firstNumber(locations);
  const categoryCount = CATEGORY_SCOPE === 'all' ? firstNumber(allMicros) : firstNumber(usedMicros);

  return {
    locations: locationCount,
    products: firstNumber(products),
    vendors: firstNumber(vendors),
    categories: categoryCount,
    vendorServices: firstNumber(vendorServices),
    productLocations: firstNumber(products) * locationCount,
    vendorLocations: firstNumber(vendors) * locationCount,
    categoryLocations: categoryCount * locationCount,
    vendorServiceLocations: firstNumber(vendorServices) * locationCount,
  };
}

async function getCounts() {
  return readThroughCache(countsCache, COUNTS_CACHE_MS, loadCounts);
}

async function loadLocations() {
  return mysqlQuery(`
    SELECT
      COALESCE(s.name,'') AS state_name,
      COALESCE(NULLIF(s.slug,''), s.name) AS state_slug,
      COALESCE(d.name,'') AS district_name,
      COALESCE(NULLIF(d.slug,''), d.name) AS district_slug,
      COALESCE(c.name,'') AS city_name,
      COALESCE(NULLIF(c.slug,''), c.name) AS city_slug,
      GREATEST(
        COALESCE(c.updated_at, c.created_at, '1970-01-01'),
        COALESCE(d.updated_at, d.created_at, '1970-01-01'),
        COALESCE(s.updated_at, s.created_at, '1970-01-01')
      ) AS updated_at
    FROM cities c
    JOIN states s ON s.id = c.state_id
    LEFT JOIN districts d ON d.id = c.district_id
    WHERE COALESCE(c.is_active,1)=1 AND COALESCE(s.is_active,1)=1
    ORDER BY s.name, d.name, c.name
  `);
}

async function fetchLocations() {
  return readThroughCache(locationsCache, LOCATIONS_CACHE_MS, loadLocations);
}

const searchUrl = (baseSlug, loc) => {
  const state = slugify(loc.state_slug || loc.state_name);
  const district = slugify(loc.district_slug || loc.district_name);
  const city = slugify(loc.city_slug || loc.city_name);
  if (district && district !== city && district !== state) {
    return `/directory/search/${baseSlug}/${state}/${district}/${city}`;
  }
  return `/directory/search/${baseSlug}/${state}/${city}`;
};

const pagesFor = (baseName, total, revisionSegment = SITEMAP_REVISION_SEGMENT) => {
  const pages = Math.ceil(Math.max(0, Number(total || 0)) / SITEMAP_LIMIT);
  return Array.from({ length: pages }, (_, index) => ({
    loc: pages === 1 && !revisionSegment
      ? `/${baseName}.xml`
      : `/${baseName}${revisionSegment}-${index + 1}.xml`,
    lastmod: SITEMAP_GENERATED_AT,
  }));
};

const sitemapFamilyIndexes = [
  {
    loc: '/sitemap-products-index.xml',
    baseName: 'sitemap-products',
    countKey: 'products',
  },
  {
    loc: '/sitemap-product-locations-index.xml',
    baseName: 'sitemap-product-locations',
    countKey: 'productLocations',
  },
  {
    loc: '/sitemap-vendors-index.xml',
    baseName: 'sitemap-vendors',
    countKey: 'vendors',
  },
  {
    loc: '/sitemap-vendor-locations-index.xml',
    baseName: 'sitemap-vendor-locations',
    countKey: 'vendorLocations',
  },
  {
    loc: '/sitemap-vendor-services-index.xml',
    baseName: 'sitemap-vendor-services',
    countKey: 'vendorServiceLocations',
  },
  {
    loc: '/sitemap-categories-index.xml',
    baseName: 'sitemap-categories',
    countKey: 'categories',
  },
  {
    loc: '/sitemap-category-locations-index.xml',
    baseName: 'sitemap-category-locations',
    countKey: 'categoryLocations',
  },
  {
    loc: '/sitemap-locations-index.xml',
    baseName: 'sitemap-locations',
    countKey: 'locations',
  },
];

const versionedFamilyIndexLoc = (loc) => {
  if (!SITEMAP_REVISION_SEGMENT) return null;
  return loc.replace(/-index\.xml$/i, `${SITEMAP_REVISION_SEGMENT}-index.xml`);
};

const sitemapFamilyByBaseName = new Map(
  sitemapFamilyIndexes.map((family) => [family.baseName, family])
);

const VERSIONED_FAMILY_INDEX_RE = /^\/(sitemap-(?:products|product-locations|vendors|vendor-locations|vendor-services|categories|category-locations|locations))-([A-Za-z0-9_-]+)-index\.xml$/;

const familyPageEntries = (counts, revisionSegment = SITEMAP_REVISION_SEGMENT) => sitemapFamilyIndexes
  .flatMap(({ baseName, countKey }) => pagesFor(baseName, counts?.[countKey] || 0, revisionSegment));

const roundRobinFamilyPageEntries = (
  counts,
  entryLimit = Math.ceil(SITEMAP_BATCH_URL_TARGET / SITEMAP_LIMIT),
  revisionSegment = SITEMAP_REVISION_SEGMENT
) => {
  const queues = sitemapFamilyIndexes
    .map(({ baseName, countKey }) => pagesFor(baseName, counts?.[countKey] || 0, revisionSegment))
    .filter((entries) => entries.length > 0);
  const limitedEntryCount = Math.min(SITEMAP_INDEX_ENTRY_LIMIT, Math.max(1, Number(entryLimit) || 1));
  const entries = [];

  while (queues.length && entries.length < limitedEntryCount) {
    for (let index = 0; index < queues.length && entries.length < limitedEntryCount;) {
      const nextEntry = queues[index].shift();
      if (nextEntry) entries.push(nextEntry);
      if (!queues[index]?.length) {
        queues.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }

  return entries;
};

const sitemapIndexEntries = (counts) => [
  { loc: '/sitemap-static.xml', lastmod: SITEMAP_GENERATED_AT },
  ...familyPageEntries(counts),
].slice(0, SITEMAP_INDEX_ENTRY_LIMIT);

const batchSitemapIndexEntries = (counts) => [
  { loc: '/sitemap-static.xml', lastmod: SITEMAP_GENERATED_AT },
  ...roundRobinFamilyPageEntries(counts),
].slice(0, SITEMAP_INDEX_ENTRY_LIMIT);

const fullSitemapIndexEntries = sitemapIndexEntries;

const parsePage = (req) => Math.max(1, Number.parseInt(String(req.params?.page || req.query.page || '1'), 10) || 1);

async function fetchProducts(limit, offset) {
  const safeLimit = safeSqlInt(limit, SITEMAP_LIMIT, SITEMAP_LIMIT);
  const safeOffset = safeSqlInt(offset, 0);
  return mysqlQuery(`
      SELECT
        p.id,
        COALESCE(NULLIF(p.name,''), 'product') AS name,
        COALESCE(NULLIF(p.slug,''), p.name, p.id) AS slug,
        COALESCE(p.updated_at, p.created_at) AS updated_at
      FROM products p
      WHERE ${PRODUCT_ACTIVE_WHERE}
      ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `);
}

async function fetchVendors(limit, offset) {
  const safeLimit = safeSqlInt(limit, SITEMAP_LIMIT, SITEMAP_LIMIT);
  const safeOffset = safeSqlInt(offset, 0);
  return mysqlQuery(`
      SELECT
        v.id,
        COALESCE(NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), v.email, 'vendor') AS name,
        COALESCE(NULLIF(v.slug,''), NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), v.id) AS slug,
        COALESCE(v.updated_at, v.created_at) AS updated_at
      FROM vendors v
      WHERE ${VENDOR_ACTIVE_WHERE}
      ORDER BY COALESCE(v.updated_at, v.created_at) DESC, v.id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `);
}

async function fetchCategories(limit, offset) {
  const safeLimit = safeSqlInt(limit, SITEMAP_LIMIT, SITEMAP_LIMIT);
  const safeOffset = safeSqlInt(offset, 0);
  const usedJoin = CATEGORY_SCOPE === 'all'
    ? ''
    : `JOIN (SELECT DISTINCT micro_category_id FROM products p WHERE ${PRODUCT_ACTIVE_WHERE} AND p.micro_category_id IS NOT NULL) used ON used.micro_category_id = mc.id`;
  return mysqlQuery(`
      SELECT
        mc.id,
        COALESCE(NULLIF(mc.name,''), 'category') AS name,
        COALESCE(NULLIF(mc.slug,''), mc.name, mc.id) AS slug,
        COALESCE(mc.updated_at, mc.created_at) AS updated_at
      FROM micro_categories mc
      ${usedJoin}
      WHERE COALESCE(mc.is_active,1)=1
      ORDER BY COALESCE(mc.updated_at, mc.created_at) DESC, mc.id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `);
}

async function fetchVendorServices(limit, offset) {
  const safeLimit = safeSqlInt(limit, SITEMAP_LIMIT, SITEMAP_LIMIT);
  const safeOffset = safeSqlInt(offset, 0);
  return mysqlQuery(`
      SELECT
        p.vendor_id,
        p.micro_category_id,
        COALESCE(NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), v.email, 'vendor') AS vendor_name,
        COALESCE(NULLIF(v.slug,''), NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), v.id) AS vendor_slug,
        COALESCE(NULLIF(mc.name,''), 'service') AS service_name,
        COALESCE(NULLIF(mc.slug,''), mc.name, mc.id) AS service_slug,
        GREATEST(
          COALESCE(MAX(p.updated_at), MAX(p.created_at), '1970-01-01'),
          COALESCE(v.updated_at, v.created_at, '1970-01-01'),
          COALESCE(mc.updated_at, mc.created_at, '1970-01-01')
        ) AS updated_at
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      JOIN micro_categories mc ON mc.id = p.micro_category_id
      WHERE ${PRODUCT_ACTIVE_WHERE}
        AND ${VENDOR_ACTIVE_WHERE}
        AND p.micro_category_id IS NOT NULL
        AND COALESCE(mc.is_active,1)=1
      GROUP BY p.vendor_id, p.micro_category_id, v.company_name, v.vendor_id, v.email, v.slug, v.id, v.updated_at, v.created_at, mc.name, mc.slug, mc.id, mc.updated_at, mc.created_at
      ORDER BY updated_at DESC, p.vendor_id DESC, p.micro_category_id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `);
}

async function crossLocationEntries({ req, fetchEntities, entityCount, makeBaseSlug, priority = '0.65' }) {
  const page = parsePage(req);
  const locations = await fetchLocations();
  if (!locations.length || !entityCount) return [];

  const offset = (page - 1) * SITEMAP_LIMIT;
  const startEntityIndex = Math.floor(offset / locations.length);
  const entityOffsetRemainder = offset % locations.length;
  const entityLimit = Math.ceil((entityOffsetRemainder + SITEMAP_LIMIT) / locations.length);
  const entities = await fetchEntities(entityLimit, startEntityIndex);
  const entries = [];

  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    const entity = entities[entityIndex];
    const locationStart = entityIndex === 0 ? entityOffsetRemainder : 0;
    const baseSlug = makeBaseSlug(entity);
    if (!baseSlug) continue;
    for (let locationIndex = locationStart; locationIndex < locations.length; locationIndex += 1) {
      const loc = locations[locationIndex];
      entries.push({
        loc: searchUrl(baseSlug, loc),
        lastmod: entity.updated_at || loc.updated_at,
        changefreq: 'weekly',
        priority,
      });
      if (entries.length >= SITEMAP_LIMIT) return entries;
    }
  }

  return entries;
}

async function listSeoExportFiles() {
  const urls = [];
  for (const dir of EXPORT_DIRS) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(zip|xlsx|csv)$/i.test(entry.name)) continue;
        const stat = await fs.stat(path.join(dir, entry.name));
        urls.push({
          loc: `/seo-url-exports/${encodeURIComponent(entry.name)}`,
          lastmod: stat.mtime,
          changefreq: 'weekly',
          priority: '0.3',
        });
      }
    } catch {
      // Optional export folder. Ignore missing folders.
    }
  }
  return urls
    .sort((a, b) => new Date(b.lastmod).getTime() - new Date(a.lastmod).getTime())
    .slice(0, 200);
}

const normalizeHeader = (value = '') => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const parseCsvLine = (line = '') => {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
};

const valueByHeader = (row = {}, names = []) => {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (row[key]) return row[key];
  }
  return '';
};

const rowToSeoEntry = (row = {}, stat) => {
  const url = valueByHeader(row, ['url', 'profile url', 'search url']);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return {
    loc: url,
    lastmod: stat?.mtime || new Date(),
    changefreq: 'weekly',
    priority: '0.64',
    title: valueByHeader(row, ['title', 'seo title', 'page title']),
    description: valueByHeader(row, ['description', 'seo description', 'meta description']),
    keywords: valueByHeader(row, ['keywords', 'seo keywords', 'meta keywords']),
  };
};

async function getLatestSeoExportCsvFiles() {
  const now = Date.now();
  if (seoExportCache.expiresAt > now) return seoExportCache.files;

  const candidates = [];
  const topLevelCsv = [];

  for (const dir of EXPORT_DIRS) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && /^indiantrademart-all-seo-live-urls-\d{8}-\d{6}$/i.test(entry.name)) {
          const stat = await fs.stat(fullPath);
          candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        } else if (entry.isFile() && /\.csv$/i.test(entry.name) && !/^00-summary/i.test(entry.name)) {
          const stat = await fs.stat(fullPath);
          topLevelCsv.push({ path: fullPath, mtimeMs: stat.mtimeMs, stat });
        }
      }
    } catch {
      // Optional export folder. Ignore missing folders.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latestDir = candidates[0]?.path;
  let files = [];
  let summaryPath = '';

  if (latestDir) {
    try {
      const entries = await fs.readdir(latestDir, { withFileTypes: true });
      const summaryEntry = entries.find((entry) => entry.isFile() && /^00-summary.*\.csv$/i.test(entry.name));
      summaryPath = summaryEntry ? path.join(latestDir, summaryEntry.name) : '';
      files = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && /\.csv$/i.test(entry.name) && !/^00-summary/i.test(entry.name))
          .map(async (entry) => {
            const filePath = path.join(latestDir, entry.name);
            const stat = await fs.stat(filePath);
            return { path: filePath, name: entry.name, stat, mtimeMs: stat.mtimeMs };
          })
      );
    } catch {
      files = [];
    }
  }

  if (!files.length) files = topLevelCsv;
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const previousSignature = [
    ...seoExportCache.files.map((file) => `${file.path}:${file.mtimeMs}`),
    seoExportCache.summaryPath,
  ].join('|');
  const nextSignature = [
    ...files.map((file) => `${file.path}:${file.mtimeMs}`),
    summaryPath,
  ].join('|');
  seoExportCache = {
    expiresAt: now + SEO_EXPORT_CACHE_MS,
    files,
    summaryPath,
    totalRows: previousSignature === nextSignature ? seoExportCache.totalRows : 0,
  };
  return files;
}

async function countCsvRows(filePath) {
  let count = 0;
  const rl = readline.createInterface({
    input: fsSync.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const _line of rl) count += 1;
  return Math.max(0, count - 1);
}

async function countRowsFromSummary(summaryPath) {
  if (!summaryPath) return 0;

  try {
    const text = await fs.readFile(summaryPath, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return 0;

    const header = parseCsvLine(lines[0]).map(normalizeHeader);
    const rowsIndex = header.findIndex((key) => key === 'rows' || key === 'row_count' || key === 'total_rows');
    if (rowsIndex < 0) return 0;

    return lines.slice(1).reduce((total, line) => {
      const cells = parseCsvLine(line);
      const count = Number(String(cells[rowsIndex] || '0').replace(/,/g, ''));
      return total + (Number.isFinite(count) ? count : 0);
    }, 0);
  } catch {
    return 0;
  }
}

async function getSeoExportRowCount() {
  const files = await getLatestSeoExportCsvFiles();
  if (!files.length) return 0;
  if (seoExportCache.totalRows && seoExportCache.expiresAt > Date.now()) return seoExportCache.totalRows;
  const summaryRows = await countRowsFromSummary(seoExportCache.summaryPath);
  if (summaryRows > 0) {
    seoExportCache = { ...seoExportCache, totalRows: summaryRows };
    return summaryRows;
  }
  const counts = await Promise.all(files.map((file) => countCsvRows(file.path).catch(() => 0)));
  const totalRows = counts.reduce((sum, count) => sum + count, 0);
  seoExportCache = { ...seoExportCache, totalRows };
  return totalRows;
}

async function readSeoExportEntries(page = 1, limit = SITEMAP_LIMIT) {
  const files = await getLatestSeoExportCsvFiles();
  const skipTarget = (Math.max(1, page) - 1) * limit;
  const entries = [];
  let seenRows = 0;
  const seenUrls = new Set();

  for (const file of files) {
    if (entries.length >= limit) break;

    const rl = readline.createInterface({
      input: fsSync.createReadStream(file.path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let header = null;
    for await (const line of rl) {
      if (!header) {
        header = parseCsvLine(line).map(normalizeHeader);
        continue;
      }

      if (seenRows < skipTarget) {
        seenRows += 1;
        continue;
      }

      const cells = parseCsvLine(line);
      const row = {};
      header.forEach((key, index) => {
        row[key] = cells[index] || '';
      });

      const entry = rowToSeoEntry(row, file.stat);
      if (!entry || seenUrls.has(entry.loc)) {
        seenRows += 1;
        continue;
      }
      seenUrls.add(entry.loc);
      entries.push(entry);
      seenRows += 1;
      if (entries.length >= limit) break;
    }
  }

  return entries;
}

const robotsSitemapEntries = () => [
  EXTERNAL_SITEMAP_INDEX_URL,
  '/sitemap.xml',
  '/sitemap-1cr.xml',
  '/sitemap-static.xml',
  ...sitemapFamilyIndexes.map((entry) => entry.loc),
  ...sitemapFamilyIndexes.map((entry) => versionedFamilyIndexLoc(entry.loc)).filter(Boolean),
];

const robotsText = () => [
  'User-agent: *',
  'Allow: /',
  'Disallow: /admin/',
  'Disallow: /superadmin/',
  'Disallow: /vendor/',
  'Disallow: /buyer/',
  'Disallow: /employee/',
  'Disallow: /finance-portal/',
  'Disallow: /migration-tools',
  '',
  ...robotsSitemapEntries().map((loc) => `Sitemap: ${absoluteUrl(loc)}`),
  '',
].join('\n');

router.get('/robots.txt', (_req, res) => {
  removeCrawlerUnfriendlyHeaders(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.send(robotsText());
});

async function handleSitemapIndex(_req, res, next) {
  try {
    await sendXmlFromCache(_req, res, 'sitemap:index', async () => {
      const counts = await getCounts();
      return renderIndex(sitemapIndexEntries(counts));
    }, 900);
  } catch (error) {
    next(error);
  }
}

async function handleOneCroreSitemapIndex(req, res, next) {
  try {
    await sendXmlFromCache(req, res, `sitemap:batch:1cr:${SITEMAP_REVISION_SEGMENT || 'plain'}:${SITEMAP_BATCH_URL_TARGET}`, async () => {
      const counts = await getCounts();
      return renderIndex(batchSitemapIndexEntries(counts));
    }, 900);
  } catch (error) {
    next(error);
  }
}

function makeFamilyIndexHandler(baseName, countKey, revisionSegment = SITEMAP_REVISION_SEGMENT) {
  return async (_req, res, next) => {
    try {
      const requestRevisionSegment = revisionSegment || revisionSegmentFor(_req.query?.rev) || SITEMAP_REVISION_SEGMENT;
      await sendXmlFromCache(_req, res, `sitemap:index:${baseName}:${requestRevisionSegment || 'plain'}`, async () => {
        const counts = await getCounts();
        return renderIndex(pagesFor(baseName, counts[countKey], requestRevisionSegment));
      }, 900);
    } catch (error) {
      next(error);
    }
  };
}

async function handleStaticSitemap(req, res, next) {
  try {
    await sendXmlFromCache(req, res, 'sitemap:static', () => renderUrlset(staticPages), 1800);
  } catch (error) {
    next(error);
  }
}

async function handleProductsSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:products:${page}`, async () => {
      const rows = await fetchProducts(SITEMAP_LIMIT, (page - 1) * SITEMAP_LIMIT);
      return renderUrlset(rows.map((row) => ({
        loc: `/product/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
        lastmod: row.updated_at,
        changefreq: 'weekly',
        priority: '0.85',
      })));
    });
  } catch (error) {
    next(error);
  }
}

async function handleVendorsSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:vendors:${page}`, async () => {
      const rows = await fetchVendors(SITEMAP_LIMIT, (page - 1) * SITEMAP_LIMIT);
      return renderUrlset(rows.map((row) => ({
        loc: `/directory/vendor/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
        lastmod: row.updated_at,
        changefreq: 'weekly',
        priority: '0.8',
      })));
    });
  } catch (error) {
    next(error);
  }
}

async function handleLocationsSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:locations:${page}`, async () => {
      const locations = await fetchLocations();
      const start = (page - 1) * SITEMAP_LIMIT;
      return renderUrlset(locations.slice(start, start + SITEMAP_LIMIT).map((loc) => ({
        loc: searchUrl('all', loc),
        lastmod: loc.updated_at,
        changefreq: 'weekly',
        priority: '0.55',
      })));
    });
  } catch (error) {
    next(error);
  }
}

async function handleProductLocationsSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:product-locations:${page}`, async () => {
      const counts = await getCounts();
      const entries = await crossLocationEntries({
        req,
        fetchEntities: fetchProducts,
        entityCount: counts.products,
        makeBaseSlug: (row) => slugify(row.slug || row.name || row.id),
        priority: '0.72',
      });
      return renderUrlset(entries);
    });
  } catch (error) {
    next(error);
  }
}

async function handleVendorLocationsSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:vendor-locations:${page}`, async () => {
      const counts = await getCounts();
      const entries = await crossLocationEntries({
        req,
        fetchEntities: fetchVendors,
        entityCount: counts.vendors,
        makeBaseSlug: (row) => slugify(row.slug || row.name || row.id),
        priority: '0.66',
      });
      return renderUrlset(entries);
    });
  } catch (error) {
    next(error);
  }
}

async function handleCategoriesSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:categories:${page}`, async () => {
      const rows = await fetchCategories(SITEMAP_LIMIT, (page - 1) * SITEMAP_LIMIT);
      return renderUrlset(rows.map((row) => ({
        loc: `/directory/search/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
        lastmod: row.updated_at,
        changefreq: 'weekly',
        priority: '0.82',
      })));
    });
  } catch (error) {
    next(error);
  }
}

async function handleCategoryLocationsSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:category-locations:${page}`, async () => {
      const counts = await getCounts();
      const entries = await crossLocationEntries({
        req,
        fetchEntities: fetchCategories,
        entityCount: counts.categories,
        makeBaseSlug: (row) => slugify(row.slug || row.name || row.id),
        priority: '0.75',
      });
      return renderUrlset(entries);
    });
  } catch (error) {
    next(error);
  }
}

async function handleVendorServicesSitemap(req, res, next) {
  try {
    const page = parsePage(req);
    await sendXmlFromCache(req, res, `sitemap:vendor-services:${page}`, async () => {
      const counts = await getCounts();
      const entries = await crossLocationEntries({
        req,
        fetchEntities: fetchVendorServices,
        entityCount: counts.vendorServices,
        makeBaseSlug: (row) => slugify(row.service_slug || row.service_name),
        priority: '0.7',
      });
      return renderUrlset(entries);
    });
  } catch (error) {
    next(error);
  }
}

const cleanPagedSitemapHandlers = {
  'sitemap-products': handleProductsSitemap,
  'sitemap-product-locations': handleProductLocationsSitemap,
  'sitemap-vendors': handleVendorsSitemap,
  'sitemap-vendor-locations': handleVendorLocationsSitemap,
  'sitemap-vendor-services': handleVendorServicesSitemap,
  'sitemap-categories': handleCategoriesSitemap,
  'sitemap-category-locations': handleCategoryLocationsSitemap,
  'sitemap-locations': handleLocationsSitemap,
};

router.get('/sitemap.xml', handleSitemapIndex);
router.get('/sitemap-1cr.xml', handleOneCroreSitemapIndex);
router.get(/^\/sitemap-1cr(?:-[A-Za-z0-9_-]+)?\.xml$/, handleOneCroreSitemapIndex);
router.get('/sitemap-static.xml', handleStaticSitemap);
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const cleanPath = String(req.path || req.url || '').split('?')[0];
  const match = VERSIONED_FAMILY_INDEX_RE.exec(cleanPath);
  if (!match) return next();
  const family = sitemapFamilyByBaseName.get(match[1]);
  const revisionSegment = revisionSegmentFor(match[2]);
  if (!family || !revisionSegment) return next();
  return makeFamilyIndexHandler(family.baseName, family.countKey, revisionSegment)(req, res, next);
});
sitemapFamilyIndexes.forEach((family) => {
  router.get(family.loc, makeFamilyIndexHandler(family.baseName, family.countKey));
  const revisedLoc = versionedFamilyIndexLoc(family.loc);
  if (revisedLoc) {
    router.get(revisedLoc, makeFamilyIndexHandler(family.baseName, family.countKey));
  }
  router.get(`/${family.baseName}-:revision-index.xml`, (req, res, next) => {
    const revisionSegment = revisionSegmentFor(req.params?.revision);
    if (!revisionSegment) return next();
    return makeFamilyIndexHandler(family.baseName, family.countKey, revisionSegment)(req, res, next);
  });
});

router.get(/^\/(sitemap-(?:products|product-locations|vendors|vendor-locations|vendor-services|categories|category-locations|locations))-([A-Za-z0-9_-]+)-index\.xml$/, (req, res, next) => {
  const family = sitemapFamilyByBaseName.get(req.params?.[0]);
  const revisionSegment = revisionSegmentFor(req.params?.[1]);
  if (!family || !revisionSegment) return next();
  return makeFamilyIndexHandler(family.baseName, family.countKey, revisionSegment)(req, res, next);
});

router.get(/^\/sitemap-.*-index\.xml$/, (req, res, next) => {
  const cleanPath = String(req.path || req.url || '').split('?')[0];
  const match = VERSIONED_FAMILY_INDEX_RE.exec(cleanPath);
  if (!match) return next();
  const family = sitemapFamilyByBaseName.get(match[1]);
  const revisionSegment = revisionSegmentFor(match[2]);
  if (!family || !revisionSegment) return next();
  return makeFamilyIndexHandler(family.baseName, family.countKey, revisionSegment)(req, res, next);
});

router.get('/sitemap-products.xml', handleProductsSitemap);
router.get('/sitemap-vendors.xml', handleVendorsSitemap);
router.get('/sitemap-locations.xml', handleLocationsSitemap);
router.get('/sitemap-product-locations.xml', handleProductLocationsSitemap);
router.get('/sitemap-vendor-locations.xml', handleVendorLocationsSitemap);
router.get('/sitemap-categories.xml', handleCategoriesSitemap);
router.get('/sitemap-category-locations.xml', handleCategoryLocationsSitemap);
router.get('/sitemap-vendor-services.xml', handleVendorServicesSitemap);

router.get(/^\/(sitemap-(?:products|product-locations|vendors|vendor-locations|vendor-services|categories|category-locations|locations))(?:-[A-Za-z0-9_-]+)?-(\d+)\.xml$/, (req, res, next) => {
  const family = req.params?.[0];
  const page = req.params?.[1];
  const handler = cleanPagedSitemapHandlers[family];
  if (!handler) return next();
  req.params = { page };
  return handler(req, res, next);
});

router.get('/sitemap-seo-files.xml', async (req, res, next) => {
  try {
    await sendXmlFromCache(req, res, 'sitemap:seo-files', () => renderUrlset([]), 900);
  } catch (error) {
    next(error);
  }
});

router.get('/sitemap-seo-exports.xml', async (req, res, next) => {
  try {
    await sendXmlFromCache(req, res, 'sitemap:seo-exports', async () => {
      const counts = await getCounts();
      return renderIndex(fullSitemapIndexEntries(counts));
    }, 900);
  } catch (error) {
    next(error);
  }
});

export default router;
