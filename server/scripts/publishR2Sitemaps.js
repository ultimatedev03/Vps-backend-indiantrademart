import dotenv from 'dotenv';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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
const CATEGORY_SCOPE = String(process.env.SITEMAP_CATEGORY_SCOPE || 'all').trim().toLowerCase();
const DRY_RUN = String(process.env.SITEMAP_R2_DRY_RUN || '').trim() === '1' || String(process.env.DRY_RUN || '').trim() === '1';
const KEEP_LOCAL = String(process.env.SITEMAP_R2_KEEP_LOCAL || '').trim() === '1';
const TMP_ROOT = process.env.SITEMAP_R2_TMP_DIR || path.join(os.tmpdir(), 'itm-r2-sitemaps');
const GENERATED_AT = new Date().toISOString();
const PRODUCT_ACTIVE_WHERE = "LOWER(COALESCE(p.status,'active')) NOT IN ('deleted','inactive','rejected')";
const VENDOR_ACTIVE_WHERE = "COALESCE(v.is_active,1)=1 AND LOWER(COALESCE(v.status,'active')) NOT IN ('deleted','inactive','rejected','terminated')";

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

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

const dateOnly = (value) => {
  if (!value) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
};

const absoluteUrl = (urlPath = '/') => {
  const clean = String(urlPath || '/').startsWith('/') ? String(urlPath || '/') : `/${urlPath}`;
  return `${SITE_URL}${clean}`;
};

const objectKey = (fileName) => (PREFIX ? `${PREFIX}/${fileName}` : fileName);
const publicUrlForKey = (key) => `${PUBLIC_BASE_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;

const renderUrlEntry = ({ loc, lastmod, changefreq, priority }) => {
  const url = loc.startsWith('http') ? loc : absoluteUrl(loc);
  const freq = changefreq ? `\n    <changefreq>${escapeXml(changefreq)}</changefreq>` : '';
  const rank = priority ? `\n    <priority>${escapeXml(priority)}</priority>` : '';
  return `  <url>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${escapeXml(dateOnly(lastmod))}</lastmod>${freq}${rank}\n  </url>\n`;
};

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

class SitemapPublisher {
  constructor(s3) {
    this.s3 = s3;
    this.shardNo = 0;
    this.urlsInShard = 0;
    this.totalUrls = 0;
    this.indexEntries = [];
    this.current = null;
  }

  async add(entry) {
    if (this.totalUrls >= MAX_URLS) return false;
    if (!this.current || this.urlsInShard >= URL_LIMIT) {
      await this.finishShard();
      await this.startShard();
    }

    this.current.gzip.write(renderUrlEntry(entry));
    this.urlsInShard += 1;
    this.totalUrls += 1;
    return this.totalUrls < MAX_URLS;
  }

  get isFull() {
    return this.totalUrls >= MAX_URLS;
  }

  async startShard() {
    this.shardNo += 1;
    this.urlsInShard = 0;
    const fileName = `sitemap-${String(this.shardNo).padStart(5, '0')}.xml.gz`;
    const filePath = path.join(TMP_ROOT, fileName);
    const fileStream = fs.createWriteStream(filePath);
    const gzip = zlib.createGzip({ level: 9 });
    gzip.pipe(fileStream);
    const done = new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      gzip.on('error', reject);
    });
    gzip.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n');
    this.current = { fileName, filePath, gzip, done };
  }

  async finishShard() {
    if (!this.current) return;
    const shard = this.current;
    this.current = null;
    shard.gzip.end('</urlset>\n');
    await shard.done;
    const key = objectKey(shard.fileName);
    await this.uploadFile(key, shard.filePath, {
      ContentType: 'application/xml',
      ContentEncoding: 'gzip',
      CacheControl: 'public, max-age=86400, immutable',
    });
    this.indexEntries.push({ loc: publicUrlForKey(key), lastmod: GENERATED_AT });
    if (!KEEP_LOCAL && !DRY_RUN) await fsp.rm(shard.filePath, { force: true });
    console.log(`${shard.fileName}: ${this.urlsInShard} urls`);
  }

  async uploadFile(key, filePath, metadata = {}) {
    if (DRY_RUN || !this.s3) return;
    await this.s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(filePath),
      ...metadata,
    }));
  }

  async publishIndex() {
    await this.finishShard();
    const xml = renderIndex(this.indexEntries);
    const indexPath = path.join(TMP_ROOT, 'sitemap-index.xml');
    await fsp.writeFile(indexPath, xml, 'utf8');
    await this.uploadFile(objectKey('sitemap-index.xml'), indexPath, {
      ContentType: 'application/xml; charset=utf-8',
      CacheControl: 'public, max-age=300, must-revalidate',
    });
    console.log(`sitemap-index.xml: ${this.indexEntries.length} sitemap files, ${this.totalUrls} urls`);
    console.log(`submit: ${publicUrlForKey(objectKey('sitemap-index.xml'))}`);
  }
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

const searchUrl = (baseSlug, loc) => {
  const state = slugify(loc.state_slug || loc.state_name);
  const district = slugify(loc.district_slug || loc.district_name);
  const city = slugify(loc.city_slug || loc.city_name);
  if (district && district !== city && district !== state) {
    return `/directory/search/${baseSlug}/${state}/${district}/${city}`;
  }
  return `/directory/search/${baseSlug}/${state}/${city}`;
};

async function forEachPage(query, mapper, publisher) {
  let offset = 0;
  for (;;) {
    if (publisher.isFull) return false;
    const rows = await mysqlQuery(`${query}\nLIMIT ${QUERY_LIMIT} OFFSET ${offset}`);
    if (!rows.length) break;
    for (const row of rows) {
      const keepGoing = await publisher.add(mapper(row));
      if (!keepGoing) return false;
    }
    offset += rows.length;
  }
  return true;
}

async function forEachCrossLocation({ entityQuery, locations, makeBaseSlug, makeLastmod, priority, publisher }) {
  let offset = 0;
  for (;;) {
    if (publisher.isFull) return false;
    const rows = await mysqlQuery(`${entityQuery}\nLIMIT ${QUERY_LIMIT} OFFSET ${offset}`);
    if (!rows.length) break;
    for (const row of rows) {
      const baseSlug = makeBaseSlug(row);
      if (!baseSlug) continue;
      for (const loc of locations) {
        const keepGoing = await publisher.add({
          loc: searchUrl(baseSlug, loc),
          lastmod: makeLastmod(row, loc),
          changefreq: 'weekly',
          priority,
        });
        if (!keepGoing) return false;
      }
    }
    offset += rows.length;
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

const categoryQuery = `
  SELECT mc.id, COALESCE(NULLIF(mc.name,''), 'category') AS name,
    COALESCE(NULLIF(mc.slug,''), mc.name, mc.id) AS slug,
    COALESCE(mc.updated_at, mc.created_at) AS updated_at
  FROM micro_categories mc
  ${CATEGORY_SCOPE === 'all' ? '' : `JOIN (SELECT DISTINCT micro_category_id FROM products p WHERE ${PRODUCT_ACTIVE_WHERE} AND p.micro_category_id IS NOT NULL) used ON used.micro_category_id = mc.id`}
  WHERE COALESCE(mc.is_active,1)=1
  ORDER BY COALESCE(mc.updated_at, mc.created_at) DESC, mc.id DESC`;

const vendorServiceQuery = `
  SELECT p.vendor_id, p.micro_category_id,
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
  GROUP BY p.vendor_id, p.micro_category_id, mc.name, mc.slug, mc.id, mc.updated_at, mc.created_at, v.updated_at, v.created_at
  ORDER BY updated_at DESC, p.vendor_id DESC, p.micro_category_id DESC`;

async function main() {
  if (!PUBLIC_BASE_URL) throw new Error('R2_SITEMAP_PUBLIC_BASE_URL is required, for example https://sitemaps.indiantrademart.com');
  if (!DRY_RUN && (!ENDPOINT || !BUCKET || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY)) {
    throw new Error('R2_ENDPOINT/R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required');
  }

  await fsp.mkdir(TMP_ROOT, { recursive: true });
  const s3 = createS3Client();
  const publisher = new SitemapPublisher(s3);
  const locations = await loadLocations();
  const finish = async () => {
    await publisher.publishIndex();
    await getMysqlPool().end();
  };

  for (const page of [
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
  ]) {
    if (!(await publisher.add({ loc: page, lastmod: GENERATED_AT, changefreq: 'daily', priority: page === '/' ? '1.0' : '0.7' }))) break;
  }

  await forEachPage(productQuery, (row) => ({
    loc: `/product/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
    lastmod: row.updated_at,
    changefreq: 'weekly',
    priority: '0.85',
  }), publisher);

  await forEachPage(vendorQuery, (row) => ({
    loc: `/directory/vendor/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
    lastmod: row.updated_at,
    changefreq: 'weekly',
    priority: '0.8',
  }), publisher);

  await forEachPage(categoryQuery, (row) => ({
    loc: `/directory/search/${encodeURIComponent(slugify(row.slug || row.name || row.id))}`,
    lastmod: row.updated_at,
    changefreq: 'weekly',
    priority: '0.82',
  }), publisher);

  for (const loc of locations) {
    if (!(await publisher.add({ loc: searchUrl('all', loc), lastmod: loc.updated_at, changefreq: 'weekly', priority: '0.55' }))) break;
  }

  if (publisher.isFull) return finish();

  await forEachCrossLocation({
    entityQuery: productQuery,
    locations,
    makeBaseSlug: (row) => slugify(row.slug || row.name || row.id),
    makeLastmod: (row, loc) => row.updated_at || loc.updated_at,
    priority: '0.72',
    publisher,
  });

  if (publisher.isFull) return finish();

  await forEachCrossLocation({
    entityQuery: vendorQuery,
    locations,
    makeBaseSlug: (row) => slugify(row.slug || row.name || row.id),
    makeLastmod: (row, loc) => row.updated_at || loc.updated_at,
    priority: '0.66',
    publisher,
  });

  if (publisher.isFull) return finish();

  await forEachCrossLocation({
    entityQuery: vendorServiceQuery,
    locations,
    makeBaseSlug: (row) => slugify(row.service_slug || row.service_name),
    makeLastmod: (row, loc) => row.updated_at || loc.updated_at,
    priority: '0.7',
    publisher,
  });

  if (publisher.isFull) return finish();

  await forEachCrossLocation({
    entityQuery: categoryQuery,
    locations,
    makeBaseSlug: (row) => slugify(row.slug || row.name || row.id),
    makeLastmod: (row, loc) => row.updated_at || loc.updated_at,
    priority: '0.75',
    publisher,
  });

  await finish();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await getMysqlPool().end();
  } catch {
    // ignore cleanup failure
  }
  process.exitCode = 1;
});
