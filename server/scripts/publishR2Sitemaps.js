import dotenv from 'dotenv';
import zlib from 'zlib';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getMysqlPool, mysqlQuery } from '../lib/mysqlPool.js';

dotenv.config();

const SITE_URL = String(process.env.SITE_URL || process.env.VITE_SITE_URL || 'https://indiantrademart.com').replace(/\/+$/, '');
const PUBLIC_BASE_URL = String(process.env.R2_SITEMAP_PUBLIC_BASE_URL || process.env.SITEMAP_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const BUCKET = process.env.R2_BUCKET || process.env.SITEMAP_R2_BUCKET || process.env.AWS_BUCKET;
const ENDPOINT = process.env.R2_ENDPOINT || process.env.SITEMAP_R2_ENDPOINT || (
  process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''
);
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const REGION = process.env.R2_REGION || process.env.AWS_REGION || 'auto';
const PREFIX = String(process.env.R2_SITEMAP_PREFIX || process.env.SITEMAP_R2_PREFIX || 'sitemaps').replace(/^\/+|\/+$/g, '');
const URL_LIMIT = clampInt(process.env.SITEMAP_R2_URL_LIMIT, 50000, 1, 50000);
const QUERY_LIMIT = clampInt(process.env.SITEMAP_R2_QUERY_LIMIT, 2000, 50, 10000);
const MAX_URLS = clampInt(process.env.SITEMAP_R2_MAX_URLS, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
const GZIP_LEVEL = clampInt(process.env.SITEMAP_R2_GZIP_LEVEL, 6, 1, 9);
const RETAIN_SNAPSHOTS = clampInt(process.env.SITEMAP_R2_RETAIN_SNAPSHOTS, 4, 2, 30);
const CATEGORY_SCOPE = String(process.env.SITEMAP_CATEGORY_SCOPE || 'all').trim().toLowerCase();
const DRY_RUN = String(process.env.SITEMAP_R2_DRY_RUN || '').trim() === '1' || String(process.env.DRY_RUN || '').trim() === '1';
const GENERATED_AT = new Date().toISOString();
const SNAPSHOT_ID = sanitizeSegment(
  process.env.SITEMAP_R2_SNAPSHOT_ID || GENERATED_AT.replace(/[-:.TZ]/g, '').slice(0, 14),
  'snapshot'
);
const SNAPSHOT_DIR = `snapshots/${SNAPSHOT_ID}`;
const MAX_XML_BYTES = 50 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 50000;
const PRODUCT_ACTIVE_WHERE = "LOWER(COALESCE(p.status,'active')) NOT IN ('deleted','inactive','rejected')";
const VENDOR_ACTIVE_WHERE = "COALESCE(v.is_active,1)=1 AND LOWER(COALESCE(v.status,'active')) NOT IN ('deleted','inactive','rejected','terminated')";

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeSegment(value = '', fallback = 'sitemap') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

const slugify = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'india';

const optionalSlug = (value = '') => {
  const clean = String(value || '').trim();
  return clean ? slugify(clean) : '';
};

const escapeXml = (value = '') =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const dateOnly = (value) => {
  if (!value) return GENERATED_AT.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return GENERATED_AT.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
};

const newestDate = (...values) => {
  const timestamps = values
    .map((value) => new Date(value || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : GENERATED_AT;
};

const absoluteUrl = (urlPath = '/') => {
  const clean = String(urlPath || '/').startsWith('/') ? String(urlPath || '/') : `/${urlPath}`;
  return `${SITE_URL}${clean}`;
};

const objectKey = (fileName) => (PREFIX ? `${PREFIX}/${fileName}` : fileName);
const publicUrlForKey = (key) => `${PUBLIC_BASE_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;

const renderUrlEntry = ({ loc, lastmod }) => {
  const url = String(loc || '').startsWith('http') ? loc : absoluteUrl(loc);
  return `  <url>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${escapeXml(dateOnly(lastmod))}</lastmod>\n  </url>\n`;
};

const renderUrlset = (entries) => (
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  entries.join('') +
  `</urlset>\n`
);

const renderIndex = (entries) => {
  const body = entries.map((entry) =>
    `  <sitemap>\n    <loc>${escapeXml(entry.loc)}</loc>\n    <lastmod>${escapeXml(entry.lastmod || GENERATED_AT)}</lastmod>\n  </sitemap>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
};

function createS3Client() {
  if (!ENDPOINT || !BUCKET || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

class StaticSitemapPublisher {
  constructor(s3) {
    this.s3 = s3;
    this.currentFamily = 'general';
    this.familyShardNo = 0;
    this.currentEntries = [];
    this.totalUrls = 0;
    this.indexEntries = [];
    this.familyStats = {};
  }

  get isFull() {
    return this.totalUrls >= MAX_URLS;
  }

  async startFamily(name) {
    await this.finishShard();
    this.currentFamily = sanitizeSegment(name, 'general');
    this.familyShardNo = 0;
    if (!this.familyStats[this.currentFamily]) {
      this.familyStats[this.currentFamily] = { urls: 0, shards: 0 };
    }
  }

  async add(entry) {
    if (this.isFull) return false;
    if (!entry?.loc) return true;
    if (this.currentEntries.length >= URL_LIMIT) await this.finishShard();

    this.currentEntries.push(renderUrlEntry(entry));
    this.totalUrls += 1;
    this.familyStats[this.currentFamily].urls += 1;
    return !this.isFull;
  }

  async finishShard() {
    if (!this.currentEntries.length) return;

    this.familyShardNo += 1;
    const fileName = `${this.currentFamily}-${String(this.familyShardNo).padStart(5, '0')}.xml.gz`;
    const key = objectKey(`${SNAPSHOT_DIR}/${fileName}`);
    const xml = renderUrlset(this.currentEntries);
    const xmlBytes = Buffer.byteLength(xml, 'utf8');
    const urlCount = this.currentEntries.length;
    this.currentEntries = [];

    if (xmlBytes > MAX_XML_BYTES) {
      throw new Error(`${fileName} exceeds the 50 MB uncompressed sitemap limit`);
    }

    const compressed = zlib.gzipSync(Buffer.from(xml, 'utf8'), { level: GZIP_LEVEL });
    await this.uploadBuffer(key, compressed, {
      ContentType: 'application/x-gzip',
      CacheControl: 'public, max-age=31536000, immutable',
    });

    this.indexEntries.push({ loc: publicUrlForKey(key), lastmod: GENERATED_AT });
    this.familyStats[this.currentFamily].shards += 1;
    console.log(`${SNAPSHOT_ID}/${fileName}: ${urlCount} urls, ${compressed.length} compressed bytes`);
  }

  async uploadBuffer(key, body, metadata = {}) {
    if (DRY_RUN || !this.s3) return;
    await this.s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ...metadata,
    }));
  }

  async cleanupOldSnapshots() {
    if (DRY_RUN || !this.s3) return;
    const snapshotsPrefix = objectKey('snapshots/');
    const keysBySnapshot = new Map();
    let continuationToken;

    do {
      const page = await this.s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: snapshotsPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const object of page.Contents || []) {
        const key = String(object.Key || '');
        const relative = key.slice(snapshotsPrefix.length);
        const snapshotId = relative.split('/')[0];
        if (!snapshotId || !relative.includes('/')) continue;
        if (!keysBySnapshot.has(snapshotId)) keysBySnapshot.set(snapshotId, []);
        keysBySnapshot.get(snapshotId).push(key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    const snapshotIds = Array.from(keysBySnapshot.keys()).sort().reverse();
    const keep = new Set(snapshotIds.slice(0, RETAIN_SNAPSHOTS));
    keep.add(SNAPSHOT_ID);
    const staleKeys = snapshotIds
      .filter((snapshotId) => !keep.has(snapshotId))
      .flatMap((snapshotId) => keysBySnapshot.get(snapshotId) || []);

    for (let offset = 0; offset < staleKeys.length; offset += 1000) {
      const batch = staleKeys.slice(offset, offset + 1000);
      await this.s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }));
    }

    if (staleKeys.length) {
      console.log(`cleanup: deleted ${staleKeys.length} objects from old snapshots`);
    }
  }

  async publish() {
    await this.finishShard();
    if (!this.indexEntries.length) throw new Error('No sitemap URLs were generated');
    if (this.indexEntries.length > MAX_INDEX_ENTRIES) {
      throw new Error(`Sitemap index has ${this.indexEntries.length} entries; maximum is ${MAX_INDEX_ENTRIES}`);
    }

    const indexXml = renderIndex(this.indexEntries);
    const manifest = {
      version: 1,
      mode: 'static-r2-snapshot',
      snapshotId: SNAPSHOT_ID,
      generatedAt: GENERATED_AT,
      siteUrl: SITE_URL,
      urlLimit: URL_LIMIT,
      totalUrls: this.totalUrls,
      totalShards: this.indexEntries.length,
      families: this.familyStats,
    };
    const snapshotIndexKey = objectKey(`${SNAPSHOT_DIR}/sitemap-index.xml`);
    const snapshotManifestKey = objectKey(`${SNAPSHOT_DIR}/manifest.json`);

    await this.uploadBuffer(snapshotIndexKey, Buffer.from(indexXml, 'utf8'), {
      ContentType: 'application/xml; charset=utf-8',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    await this.uploadBuffer(snapshotManifestKey, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), {
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    // Publish the stable master last. Until this succeeds, crawlers keep using the previous complete snapshot.
    await this.uploadBuffer(objectKey('sitemap-index.xml'), Buffer.from(indexXml, 'utf8'), {
      ContentType: 'application/xml; charset=utf-8',
      CacheControl: 'public, max-age=300, must-revalidate',
    });
    await this.uploadBuffer(objectKey('sitemap-manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), {
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=300, must-revalidate',
    });

    try {
      await this.cleanupOldSnapshots();
    } catch (error) {
      console.warn(`cleanup warning: ${error?.message || error}`);
    }

    console.log(`sitemap-index.xml: snapshot=${SNAPSHOT_ID}, files=${this.indexEntries.length}, urls=${this.totalUrls}`);
    console.log(`manifest: ${publicUrlForKey(objectKey('sitemap-manifest.json'))}`);
    console.log(`submit: ${SITE_URL}/sitemap.xml`);
  }
}

async function loadPagedRows(query) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await mysqlQuery(`${query}\nLIMIT ${QUERY_LIMIT} OFFSET ${offset}`);
    if (!page.length) break;
    rows.push(...page);
    offset += page.length;
  }
  return rows;
}

const uniqueRows = (rows, keyFor) => {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = String(keyFor(row) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
};

async function loadLocations() {
  const rows = await mysqlQuery(`
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
  return uniqueRows(rows, (row) => locationPath(row));
}

const locationPath = (loc) => {
  const state = slugify(loc.state_slug || loc.state_name);
  const district = slugify(loc.district_slug || loc.district_name);
  const city = slugify(loc.city_slug || loc.city_name);
  return district && district !== city && district !== state
    ? `${state}/${district}/${city}`
    : `${state}/${city}`;
};

const searchUrl = (baseSlug, loc) => `/directory/search/${encodeURIComponent(baseSlug)}/${locationPath(loc)}`;

async function addRows(publisher, rows, mapper) {
  for (const row of rows) {
    if (!(await publisher.add(mapper(row)))) return false;
  }
  return true;
}

async function addCrossLocation({ publisher, entities, locations, makeLoc }) {
  for (const entity of entities) {
    for (const loc of locations) {
      const url = makeLoc(entity, loc);
      if (!url) continue;
      if (!(await publisher.add({
        loc: url,
        lastmod: newestDate(entity.updated_at, loc.updated_at),
      }))) return false;
    }
  }
  return true;
}

const productQuery = `
  SELECT p.id, COALESCE(NULLIF(p.name,''), 'product') AS name,
    COALESCE(NULLIF(p.slug,''), p.name, p.id) AS slug,
    COALESCE(p.updated_at, p.created_at) AS updated_at
  FROM products p
  WHERE ${PRODUCT_ACTIVE_WHERE}
  ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC`;

const vendorQuery = `
  SELECT v.id, COALESCE(NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), v.email, 'vendor') AS name,
    COALESCE(NULLIF(v.slug,''), NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), v.id) AS slug,
    COALESCE(v.updated_at, v.created_at) AS updated_at
  FROM vendors v
  WHERE ${VENDOR_ACTIVE_WHERE}
  ORDER BY COALESCE(v.updated_at, v.created_at) DESC, v.id DESC`;

const microCategoryQuery = `
  SELECT mc.id, COALESCE(NULLIF(mc.name,''), 'category') AS name,
    COALESCE(NULLIF(mc.slug,''), mc.name, mc.id) AS slug,
    COALESCE(mc.updated_at, mc.created_at) AS updated_at,
    COALESCE(NULLIF(sc.slug,''), sc.name, sc.id) AS sub_slug,
    COALESCE(NULLIF(hc.slug,''), hc.name, hc.id) AS head_slug,
    'micro' AS category_level
  FROM micro_categories mc
  LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
  LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
  ${CATEGORY_SCOPE === 'all' ? '' : `JOIN (SELECT DISTINCT micro_category_id FROM products p WHERE ${PRODUCT_ACTIVE_WHERE} AND p.micro_category_id IS NOT NULL) used ON used.micro_category_id = mc.id`}
  WHERE COALESCE(mc.is_active,1)=1
  ORDER BY COALESCE(mc.updated_at, mc.created_at) DESC, mc.id DESC`;

const subCategoryQuery = `
  SELECT sc.id, COALESCE(NULLIF(sc.name,''), 'category') AS name,
    COALESCE(NULLIF(sc.slug,''), sc.name, sc.id) AS slug,
    COALESCE(sc.updated_at, sc.created_at) AS updated_at,
    '' AS sub_slug,
    COALESCE(NULLIF(hc.slug,''), hc.name, hc.id) AS head_slug,
    'sub' AS category_level
  FROM sub_categories sc
  LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
  WHERE COALESCE(sc.is_active,1)=1
  ORDER BY COALESCE(sc.updated_at, sc.created_at) DESC, sc.id DESC`;

const headCategoryQuery = `
  SELECT hc.id, COALESCE(NULLIF(hc.name,''), 'category') AS name,
    COALESCE(NULLIF(hc.slug,''), hc.name, hc.id) AS slug,
    COALESCE(hc.updated_at, hc.created_at) AS updated_at,
    '' AS sub_slug,
    '' AS head_slug,
    'head' AS category_level
  FROM head_categories hc
  WHERE COALESCE(hc.is_active,1)=1
  ORDER BY COALESCE(hc.updated_at, hc.created_at) DESC, hc.id DESC`;

const staticPages = [
  '/',
  '/directory',
  '/products',
  '/pricing',
  '/become-a-vendor',
  '/about-us',
  '/contact',
  '/help',
  '/privacy-policy',
  '/terms-of-service',
];

const categoryBasePath = (row) => {
  const slug = slugify(row.slug || row.name || row.id);
  const headSlug = optionalSlug(row.head_slug);
  const subSlug = optionalSlug(row.sub_slug);
  if (row.category_level === 'micro' && headSlug && subSlug) {
    return `/directory/${headSlug}/${subSlug}/${slug}`;
  }
  if (row.category_level === 'sub' && headSlug) {
    return `/directory/${headSlug}/${slug}`;
  }
  if (row.category_level === 'head') return `/directory/${slug}`;
  return `/directory/search/${encodeURIComponent(slug)}`;
};

const categoryLocationUrl = (row, loc) => {
  const basePath = categoryBasePath(row);
  if (row.category_level === 'micro' && !basePath.startsWith('/directory/search/')) {
    return `${basePath}/${locationPath(loc)}`;
  }
  return searchUrl(slugify(row.slug || row.name || row.id), loc);
};

async function main() {
  if (!PUBLIC_BASE_URL) throw new Error('R2_SITEMAP_PUBLIC_BASE_URL is required, for example https://sitemaps.indiantrademart.com');
  if (!DRY_RUN && (!ENDPOINT || !BUCKET || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY)) {
    throw new Error('R2_ENDPOINT/R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required');
  }

  const s3 = createS3Client();
  const publisher = new StaticSitemapPublisher(s3);

  try {
    const [locations, productRows, vendorRows, microRows, subRows, headRows] = await Promise.all([
      loadLocations(),
      loadPagedRows(productQuery),
      loadPagedRows(vendorQuery),
      loadPagedRows(microCategoryQuery),
      loadPagedRows(subCategoryQuery),
      loadPagedRows(headCategoryQuery),
    ]);

    const products = uniqueRows(productRows, (row) => slugify(row.slug || row.name || row.id));
    const vendors = uniqueRows(vendorRows, (row) => slugify(row.slug || row.name || row.id));
    const categories = uniqueRows([...microRows, ...subRows, ...headRows], categoryBasePath);

    console.log(JSON.stringify({
      mode: DRY_RUN ? 'dry-run' : 'publish',
      snapshotId: SNAPSHOT_ID,
      urlLimit: URL_LIMIT,
      maxUrls: MAX_URLS === Number.MAX_SAFE_INTEGER ? null : MAX_URLS,
      locations: locations.length,
      products: products.length,
      vendors: vendors.length,
      categories: categories.length,
    }));

    await publisher.startFamily('static');
    await addRows(publisher, staticPages, (page) => ({ loc: page, lastmod: GENERATED_AT }));

    if (!publisher.isFull) {
      await publisher.startFamily('products');
      await addRows(publisher, products, (row) => ({
        loc: `/product/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
        lastmod: row.updated_at,
      }));
    }

    if (!publisher.isFull) {
      await publisher.startFamily('vendors');
      await addRows(publisher, vendors, (row) => ({
        loc: `/directory/vendor/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
        lastmod: row.updated_at,
      }));
    }

    if (!publisher.isFull) {
      await publisher.startFamily('categories');
      await addRows(publisher, categories, (row) => ({
        loc: categoryBasePath(row),
        lastmod: row.updated_at,
      }));
    }

    if (!publisher.isFull) {
      await publisher.startFamily('locations');
      await addRows(publisher, locations, (loc) => ({
        loc: searchUrl('all', loc),
        lastmod: loc.updated_at,
      }));
    }

    // Category and service landing pages are generated first because they are the primary SEO inventory.
    if (!publisher.isFull) {
      await publisher.startFamily('category-locations');
      await addCrossLocation({
        publisher,
        entities: categories,
        locations,
        makeLoc: categoryLocationUrl,
      });
    }

    if (!publisher.isFull) {
      await publisher.startFamily('product-locations');
      await addCrossLocation({
        publisher,
        entities: products,
        locations,
        makeLoc: (row, loc) => searchUrl(slugify(row.slug || row.name || row.id), loc),
      });
    }

    if (!publisher.isFull) {
      await publisher.startFamily('vendor-locations');
      await addCrossLocation({
        publisher,
        entities: vendors,
        locations,
        makeLoc: (row, loc) => searchUrl(slugify(row.slug || row.name || row.id), loc),
      });
    }

    await publisher.publish();
  } finally {
    await getMysqlPool().end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
