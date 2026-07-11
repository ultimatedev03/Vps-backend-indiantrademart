import express from 'express';

const router = express.Router();

const SITE_URL = String(
  process.env.SITE_URL || process.env.VITE_SITE_URL || 'https://indiantrademart.com'
).replace(/\/+$/, '');
const R2_PUBLIC_BASE_URL = String(
  process.env.R2_SITEMAP_PUBLIC_BASE_URL ||
  process.env.SITEMAP_PUBLIC_BASE_URL ||
  'https://sitemaps.indiantrademart.com'
).replace(/\/+$/, '');
const R2_PREFIX = String(
  process.env.R2_SITEMAP_PREFIX || process.env.SITEMAP_R2_PREFIX || 'sitemaps'
).replace(/^\/+|\/+$/g, '');
const EXTERNAL_INDEX_URL = String(
  process.env.EXTERNAL_SITEMAP_INDEX_URL ||
  process.env.R2_SITEMAP_INDEX_URL ||
  `${R2_PUBLIC_BASE_URL}/${R2_PREFIX ? `${R2_PREFIX}/` : ''}sitemap-index.xml`
).trim();
const XML_TYPE = 'application/xml; charset=utf-8';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedIndex = null;
let cacheExpiresAt = 0;
let indexRequest = null;

const absoluteUrl = (pathname = '/') => {
  const cleanPath = String(pathname || '/').startsWith('/') ? pathname : `/${pathname}`;
  return `${SITE_URL}${cleanPath}`;
};

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
  `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
  '',
].join('\n');

const normalizeIndex = (xml) => {
  if (!xml.includes('<sitemapindex')) {
    throw new Error('Canonical R2 sitemap did not return a sitemap index');
  }

  const storagePrefix = `${R2_PUBLIC_BASE_URL}/${R2_PREFIX ? `${R2_PREFIX}/` : ''}`;
  return xml.split(storagePrefix).join(`${SITE_URL}/sitemaps/`);
};

async function loadCanonicalIndex() {
  if (cachedIndex && cacheExpiresAt > Date.now()) return cachedIndex;
  if (indexRequest) return indexRequest;

  indexRequest = fetch(EXTERNAL_INDEX_URL, {
    headers: {
      Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
      'User-Agent': 'IndianTradeMart-SitemapProxy/2.0',
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Canonical R2 sitemap fetch failed with HTTP ${response.status}`);
      }
      const xml = normalizeIndex(await response.text());
      cachedIndex = xml;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return xml;
    })
    .finally(() => {
      indexRequest = null;
    });

  return indexRequest;
}

const sendCanonicalIndex = async (_req, res, next) => {
  try {
    const xml = await loadCanonicalIndex();
    res.removeHeader('X-Powered-By');
    res.setHeader('Content-Type', XML_TYPE);
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.setHeader('Content-Length', Buffer.byteLength(xml, 'utf8'));
    res.setHeader('X-Robots-Tag', 'index, follow');
    res.status(200).end(xml);
  } catch (error) {
    next(error);
  }
};

const retireLegacySitemap = (_req, res) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(410).type('text/plain').send('Legacy sitemap retired. Use /sitemap.xml.\n');
};

router.get('/robots.txt', (_req, res) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.type('text/plain').send(robotsText());
});

router.get('/sitemap.xml', sendCanonicalIndex);

// Old root-level generators are deliberately gone. The only submitted root feed is /sitemap.xml.
router.get('/sitemap-index.xml', retireLegacySitemap);
router.get(/^\/sitemap-[^/]*\.xml\/?$/, retireLegacySitemap);

export default router;
