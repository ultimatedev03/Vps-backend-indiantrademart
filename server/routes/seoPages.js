import express from 'express';
import fs from 'fs';
import path from 'path';
import { mysqlQuery } from '../lib/mysqlPool.js';
import { findPageSeoOverride } from '../services/pageSeoService.js';

const router = express.Router();

const SITE_URL = String(process.env.SITE_URL || process.env.VITE_SITE_URL || 'https://indiantrademart.com').replace(/\/+$/, '');
const INDEX_HTML_CANDIDATES = [
  process.env.SEO_INDEX_HTML,
  process.env.FRONTEND_INDEX_HTML,
  '/var/www/indiantrademart/index.html',
].filter(Boolean);

const PRODUCT_ACTIVE_WHERE = "LOWER(COALESCE(p.status,'active')) NOT IN ('deleted','inactive','rejected')";
const VENDOR_ACTIVE_WHERE = "COALESCE(v.is_active,1)=1 AND LOWER(COALESCE(v.status,'active')) NOT IN ('deleted','inactive','rejected','terminated')";

let templateCache = { path: '', mtimeMs: 0, html: '' };

const escapeHtml = (value = '') =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

const slugToTitle = (value = '') =>
  String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const slugToSearchText = (value = '') => String(value || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const cleanText = (value = '') => String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const truncateText = (value = '', limit = 160) => {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
};

const fitSeoPart = (value = '', limit = 60) => {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, '').trim() || text.slice(0, limit).trim();
};

const buildKeywords = (...values) => {
  const seen = new Set();
  const keywords = [];
  values.filter(Boolean).forEach((value) => {
    String(value).split(',').forEach((part) => {
      const keyword = cleanText(part);
      const key = keyword.toLowerCase();
      if (!keyword || seen.has(key)) return;
      seen.add(key);
      keywords.push(keyword);
    });
  });
  return keywords.slice(0, 24).join(', ');
};

const buildLocationSeoTitle = (topic = '', location = '') => {
  const maxLength = 60;
  const suffix = ' | IndianTradeMart';
  const locationBudget = maxLength - suffix.length - 14 - ' in '.length;
  const fittedLocation = fitSeoPart(location, locationBudget);
  const geo = fittedLocation ? ` in ${fittedLocation}` : '';
  let cleanTopic = cleanText(topic)
    .replace(/\s*\|\s*IndianTradeMart.*$/i, '')
    .trim();
  if (!/\b(supplier|manufacturer|service provider)s?\b/i.test(cleanTopic)) {
    cleanTopic = `${cleanTopic} Suppliers`.trim();
  }
  const available = maxLength - suffix.length - geo.length;
  const fittedTopic = fitSeoPart(cleanTopic, available);
  return `${fittedTopic || 'B2B Suppliers'}${geo}${suffix}`;
};

const absoluteUrl = (req) => `${SITE_URL}${String(req.path || '/').startsWith('/') ? req.path : `/${req.path}`}`;

function loadIndexTemplate() {
  for (const candidate of INDEX_HTML_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate);
      if (templateCache.path === candidate && templateCache.mtimeMs === stat.mtimeMs && templateCache.html) {
        return templateCache.html;
      }
      const html = fs.readFileSync(candidate, 'utf8');
      templateCache = { path: candidate, mtimeMs: stat.mtimeMs, html };
      return html;
    } catch {
      // Try the next candidate.
    }
  }

  return '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IndianTradeMart</title></head><body><div id="root"></div></body></html>';
}

function stripManagedHeadTags(html = '') {
  return String(html)
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\b[^>]*(?:name|property)=["'](?:description|keywords|robots|googlebot|og:title|og:description|og:url|twitter:title|twitter:description)["'][^>]*>\s*/gi, '')
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>\s*/gi, '');
}

function renderSeoShell({ req, title, description, keywords = '', canonical: requestedCanonical = '', bodyHtml = '' }) {
  const canonical = requestedCanonical || absoluteUrl(req);
  const safeTitle = escapeHtml(title || 'IndianTradeMart');
  const safeDescription = escapeHtml(description || 'Find verified suppliers, products, manufacturers and service providers on IndianTradeMart.');
  const safeKeywords = escapeHtml(keywords);
  const safeCanonical = escapeHtml(canonical);
  const seoHead = [
    `<title>${safeTitle}</title>`,
    `<meta name="description" content="${safeDescription}">`,
    safeKeywords ? `<meta name="keywords" content="${safeKeywords}">` : '',
    '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">',
    '<meta name="googlebot" content="index, follow">',
    `<link rel="canonical" href="${safeCanonical}">`,
    `<meta property="og:title" content="${safeTitle}">`,
    `<meta property="og:description" content="${safeDescription}">`,
    `<meta property="og:url" content="${safeCanonical}">`,
    '<meta property="og:type" content="website">',
    `<meta name="twitter:title" content="${safeTitle}">`,
    `<meta name="twitter:description" content="${safeDescription}">`,
  ].filter(Boolean).join('\n    ');

  const fallbackHtml = `<main data-seo-fallback="true" style="font-family:Arial,sans-serif;max-width:1040px;margin:0 auto;padding:32px 20px;line-height:1.65;color:#111827">${bodyHtml}</main>`;
  let html = stripManagedHeadTags(loadIndexTemplate());
  html = html.includes('</head>') ? html.replace('</head>', `    ${seoHead}\n</head>`) : `${seoHead}${html}`;
  const hydratedRoot = /<div\s+id=["']root["'][^>]*>[\s\S]*<\/div>(?=\s*(?:<script\b[^>]*>[\s\S]*?<\/script>\s*)*<\/body>)/i;
  if (hydratedRoot.test(html)) {
    html = html.replace(hydratedRoot, `<div id="root">${fallbackHtml}</div>`);
  } else if (/<div\s+id=["']root["'][^>]*>\s*<\/div>/i.test(html)) {
    html = html.replace(/<div\s+id=["']root["'][^>]*>\s*<\/div>/i, `<div id="root">${fallbackHtml}</div>`);
  } else if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1><div id="root">${fallbackHtml}</div>`);
  } else {
    html += fallbackHtml;
  }
  return html;
}

const sendSeoHtml = (req, res, payload) => {
  const html = renderSeoShell({ req, ...payload });
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'index, follow');
  res.status(200).send(html);
};

router.use(async (req, res, next) => {
  if (!String(req.path || '').startsWith('/directory/')) return next();
  try {
    const seo = await findPageSeoOverride(req.path);
    if (!seo) return next();
    return sendSeoHtml(req, res, {
      title: seo.meta_title,
      description: seo.meta_description,
      keywords: seo.meta_keywords,
      canonical: seo.canonical_url,
      bodyHtml: `
        <h1>${escapeHtml(seo.h1)}</h1>
        <p>${escapeHtml(seo.meta_description)}</p>
        <p>Browse verified manufacturers, suppliers, products and business services on Indian Trade Mart.</p>
      `,
    });
  } catch (error) {
    console.error('[seoPages] DB page override failed:', error?.message || error);
    return next();
  }
});

async function findProduct(slug) {
  const searchText = slugToSearchText(slug);
  const rows = await mysqlQuery(
    `
      SELECT
        p.id,
        COALESCE(NULLIF(p.name,''), 'Product') AS name,
        COALESCE(NULLIF(p.slug,''), '') AS slug,
        COALESCE(NULLIF(p.description,''), NULLIF(p.category_path,''), NULLIF(p.category,''), '') AS description,
        COALESCE(NULLIF(p.category,''), NULLIF(mc.name,''), 'Products') AS category,
        COALESCE(NULLIF(v.company_name,''), 'Verified supplier') AS vendor_name,
        COALESCE(NULLIF(v.slug,''), '') AS vendor_slug,
        COALESCE(NULLIF(mc.name,''), '') AS micro_name,
        COALESCE(NULLIF(mc.slug,''), '') AS micro_slug
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN micro_categories mc ON mc.id = p.micro_category_id
      WHERE ${PRODUCT_ACTIVE_WHERE}
        AND (v.id IS NULL OR ${VENDOR_ACTIVE_WHERE})
        AND (
          p.slug = ?
          OR CAST(p.id AS CHAR) = ?
          OR LOWER(COALESCE(p.name,'')) = ?
          OR LOWER(COALESCE(p.name,'')) LIKE ?
        )
      ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC
      LIMIT 1
    `,
    [slug, slug, searchText, `%${searchText}%`]
  );
  return rows?.[0] || null;
}

async function findVendor(slug) {
  const searchText = slugToSearchText(slug);
  const rows = await mysqlQuery(
    `
      SELECT
        v.id,
        COALESCE(NULLIF(v.company_name,''), NULLIF(v.vendor_id,''), 'Verified supplier') AS company_name,
        COALESCE(NULLIF(v.slug,''), '') AS slug,
        COALESCE(NULLIF(v.city,''), '') AS city,
        COALESCE(NULLIF(v.state,''), '') AS state,
        COALESCE(NULLIF(v.primary_business_type,''), NULLIF(v.secondary_business,''), '') AS business_type,
        COALESCE(NULLIF(v.business_description,''), '') AS description
      FROM vendors v
      WHERE ${VENDOR_ACTIVE_WHERE}
        AND (
          v.slug = ?
          OR CAST(v.id AS CHAR) = ?
          OR LOWER(COALESCE(v.company_name,'')) = ?
          OR LOWER(COALESCE(v.company_name,'')) LIKE ?
        )
      ORDER BY COALESCE(v.updated_at, v.created_at) DESC, v.id DESC
      LIMIT 1
    `,
    [slug, slug, searchText, `%${searchText}%`]
  );
  return rows?.[0] || null;
}

async function findService(slug, hierarchy = {}) {
  const headSlug = String(hierarchy.head || '').trim();
  const subSlug = String(hierarchy.sub || '').trim();
  const microFilters = ['COALESCE(mc.is_active,1)=1', 'mc.slug = ?'];
  const microParams = [slugToTitle(slug), slug, slug];

  if (headSlug) {
    microFilters.push('hc.slug = ?');
    microParams.push(headSlug);
  }
  if (subSlug) {
    microFilters.push('sc.slug = ?');
    microParams.push(subSlug);
  }

  const microRows = await mysqlQuery(
    `
      SELECT
        COALESCE(NULLIF(mc.name,''), ?) AS name,
        COALESCE(NULLIF(mc.slug,''), ?) AS slug,
        COALESCE(NULLIF(sc.name,''), '') AS sub_name,
        COALESCE(NULLIF(hc.name,''), '') AS head_name,
        COALESCE(NULLIF(meta.meta_tags,''), '') AS seo_title,
        COALESCE(NULLIF(meta.description,''), '') AS meta_description,
        COALESCE(NULLIF(meta.keywords,''), '') AS meta_keywords,
        'micro' AS category_level
      FROM micro_categories mc
      LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
      LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
      LEFT JOIN micro_category_meta meta ON meta.id = (
        SELECT latest.id
        FROM micro_category_meta latest
        WHERE latest.micro_categories = mc.id
        ORDER BY COALESCE(latest.updated_at, latest.created_at) DESC, latest.id DESC
        LIMIT 1
      )
      WHERE ${microFilters.join('\n        AND ')}
      ORDER BY mc.id DESC
      LIMIT 1
    `,
    microParams
  );
  if (microRows?.[0]) return microRows[0];

  const subRows = await mysqlQuery(
    `
      SELECT
        COALESCE(NULLIF(sc.name,''), ?) AS name,
        COALESCE(NULLIF(sc.slug,''), ?) AS slug,
        COALESCE(NULLIF(sc.name,''), '') AS sub_name,
        COALESCE(NULLIF(hc.name,''), '') AS head_name,
        COALESCE(NULLIF(sc.meta_tags,''), '') AS seo_title,
        COALESCE(NULLIF(sc.description,''), '') AS meta_description,
        COALESCE(NULLIF(sc.keywords,''), '') AS meta_keywords,
        'sub' AS category_level
      FROM sub_categories sc
      LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
      WHERE COALESCE(sc.is_active,1)=1 AND sc.slug = ?
      ORDER BY sc.id DESC
      LIMIT 1
    `,
    [slugToTitle(slug), slug, slug]
  );
  if (subRows?.[0]) return subRows[0];

  const headRows = await mysqlQuery(
    `
      SELECT
        COALESCE(NULLIF(hc.name,''), ?) AS name,
        COALESCE(NULLIF(hc.slug,''), ?) AS slug,
        '' AS sub_name,
        COALESCE(NULLIF(hc.name,''), '') AS head_name,
        COALESCE(NULLIF(hc.meta_tags,''), '') AS seo_title,
        COALESCE(NULLIF(hc.description,''), '') AS meta_description,
        COALESCE(NULLIF(hc.keywords,''), '') AS meta_keywords,
        'head' AS category_level
      FROM head_categories hc
      WHERE COALESCE(hc.is_active,1)=1 AND hc.slug = ?
      ORDER BY hc.id DESC
      LIMIT 1
    `,
    [slugToTitle(slug), slug, slug]
  );

  return headRows?.[0] || {
    name: slugToTitle(slug),
    slug,
    sub_name: '',
    head_name: '',
    seo_title: '',
    meta_description: '',
    meta_keywords: '',
    category_level: 'keyword',
  };
}

const locationName = (params = {}) => {
  const city = slugToTitle(params.city || '');
  const district = slugToTitle(params.district || '');
  const state = slugToTitle(params.state || '');
  return [city, district, state].filter(Boolean).join(', ') || 'India';
};

const primaryLocationName = (params = {}) => (
  slugToTitle(params.city || params.district || params.state || '') || 'India'
);

router.get('/product/:slug', async (req, res, next) => {
  try {
    const product = await findProduct(String(req.params.slug || '').trim());
    const name = product?.name || slugToTitle(req.params.slug);
    const vendor = product?.vendor_name || 'verified Indian suppliers';
    const category = product?.micro_name || product?.category || 'B2B products';
    const description = product?.description || `Source ${name} from ${vendor}. Compare suppliers, product details and business enquiries on IndianTradeMart.`;
    sendSeoHtml(req, res, {
      title: `${name} | ${vendor} | IndianTradeMart`,
      description: description.slice(0, 300),
      keywords: `${name}, ${category}, ${vendor}, IndianTradeMart, B2B marketplace`,
      bodyHtml: `
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(description)}</p>
        <p><strong>Supplier:</strong> ${escapeHtml(vendor)}</p>
        <p><strong>Category:</strong> ${escapeHtml(category)}</p>
        <p>IndianTradeMart helps buyers discover verified products, suppliers and service providers across India.</p>
      `,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/directory/vendor/:slug', async (req, res, next) => {
  try {
    const vendor = await findVendor(String(req.params.slug || '').trim());
    const name = vendor?.company_name || slugToTitle(req.params.slug);
    const place = [vendor?.city, vendor?.state].filter(Boolean).join(', ') || 'India';
    const businessType = vendor?.business_type || 'B2B supplier';
    const description = vendor?.description || `${name} is listed on IndianTradeMart as a ${businessType} in ${place}. View company profile, products and enquiry options.`;
    sendSeoHtml(req, res, {
      title: `${name} - ${businessType} in ${place} | IndianTradeMart`,
      description: description.slice(0, 300),
      keywords: `${name}, ${businessType}, ${place}, supplier, IndianTradeMart`,
      bodyHtml: `
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(description)}</p>
        <p><strong>Location:</strong> ${escapeHtml(place)}</p>
        <p><strong>Business type:</strong> ${escapeHtml(businessType)}</p>
      `,
    });
  } catch (error) {
    next(error);
  }
});

async function handleSearchPage(req, res, next) {
  try {
    const service = await findService(
      String(req.params.service || 'all').trim(),
      { head: req.params.head, sub: req.params.sub }
    );
    const serviceName = service?.name || slugToTitle(req.params.service || 'All');
    const place = locationName(req.params);
    const primaryPlace = primaryLocationName(req.params);
    const isAll = String(req.params.service || '').toLowerCase() === 'all';
    const heading = isAll
      ? `Suppliers and Manufacturers in ${place} | IndianTradeMart`
      : `${serviceName} in ${place} | Suppliers, Manufacturers and Service Providers`;
    const generatedDescription = isAll
      ? `Find verified suppliers, manufacturers, exporters and service providers in ${place} on IndianTradeMart.`
      : `Find verified ${serviceName} suppliers, manufacturers and service providers in ${place}. Compare businesses and send enquiries on IndianTradeMart.`;
    const description = truncateText(
      service?.meta_description
        ? `Find ${serviceName} suppliers and service providers in ${place}. ${service.meta_description}`
        : generatedDescription,
      160
    );
    const title = buildLocationSeoTitle(
      isAll ? 'Suppliers and Manufacturers' : serviceName,
      primaryPlace
    );
    const keywords = buildKeywords(
      service?.meta_keywords,
      service?.seo_title,
      serviceName,
      `${serviceName} suppliers in ${place}`,
      `${serviceName} manufacturers in ${place}`,
      place,
      service?.sub_name,
      service?.head_name,
      'IndianTradeMart'
    );
    sendSeoHtml(req, res, {
      title,
      description,
      keywords,
      bodyHtml: `
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(description)}</p>
        <p>Browse business listings, product suppliers and local service providers for ${escapeHtml(serviceName)} across ${escapeHtml(place)}.</p>
        <ul>
          <li>Verified supplier discovery</li>
          <li>City and category based B2B search</li>
          <li>Product and service enquiry support</li>
        </ul>
      `,
    });
  } catch (error) {
    next(error);
  }
}

router.get('/directory/search/:service/:state/:district/:city', handleSearchPage);
router.get('/directory/search/:service/:state/:city', handleSearchPage);
router.get('/directory/search/:service/:state', handleSearchPage);
router.get('/directory/search/:service', handleSearchPage);
router.get('/directory/:head/:sub/:service/:state/:district/:city', handleSearchPage);
router.get('/directory/:head/:sub/:service/:state/:city', handleSearchPage);

export default router;
