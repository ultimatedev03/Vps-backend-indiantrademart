import express from 'express';
import fs from 'fs';
import path from 'path';
import { mysqlQuery } from '../lib/mysqlPool.js';

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

function renderSeoShell({ req, title, description, keywords = '', bodyHtml = '' }) {
  const canonical = absoluteUrl(req);
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
  if (/<div\s+id=["']root["'][^>]*>\s*<\/div>/i.test(html)) {
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
  res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=3600');
  res.setHeader('X-Robots-Tag', 'index, follow');
  res.status(200).send(html);
};

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
        COALESCE(NULLIF(v.description,''), NULLIF(v.business_description,''), '') AS description
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

async function findService(slug) {
  const searchText = slugToSearchText(slug);
  const rows = await mysqlQuery(
    `
      SELECT
        COALESCE(NULLIF(mc.name,''), ?) AS name,
        COALESCE(NULLIF(mc.slug,''), ?) AS slug,
        COALESCE(NULLIF(sc.name,''), '') AS sub_name,
        COALESCE(NULLIF(hc.name,''), '') AS head_name
      FROM micro_categories mc
      LEFT JOIN sub_categories sc ON sc.id = mc.sub_category_id
      LEFT JOIN head_categories hc ON hc.id = sc.head_category_id
      WHERE COALESCE(mc.is_active,1)=1
        AND (
          mc.slug = ?
          OR LOWER(COALESCE(mc.name,'')) = ?
          OR LOWER(COALESCE(mc.name,'')) LIKE ?
        )
      ORDER BY mc.id DESC
      LIMIT 1
    `,
    [slugToTitle(slug), slug, slug, searchText, `%${searchText}%`]
  );
  return rows?.[0] || { name: slugToTitle(slug), slug, sub_name: '', head_name: '' };
}

const locationName = (params = {}) => {
  const city = slugToTitle(params.city || '');
  const district = slugToTitle(params.district || '');
  const state = slugToTitle(params.state || '');
  return [city, district, state].filter(Boolean).join(', ') || 'India';
};

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
    const service = await findService(String(req.params.service || 'all').trim());
    const serviceName = service?.name || slugToTitle(req.params.service || 'All');
    const place = locationName(req.params);
    const isAll = String(req.params.service || '').toLowerCase() === 'all';
    const title = isAll
      ? `Suppliers and Manufacturers in ${place} | IndianTradeMart`
      : `${serviceName} in ${place} | Suppliers, Manufacturers and Service Providers`;
    const description = isAll
      ? `Find verified suppliers, manufacturers, exporters and service providers in ${place} on IndianTradeMart.`
      : `Find verified ${serviceName} suppliers, manufacturers and service providers in ${place}. Compare businesses and send enquiries on IndianTradeMart.`;
    sendSeoHtml(req, res, {
      title: `${title} | IndianTradeMart`,
      description,
      keywords: `${serviceName}, ${place}, suppliers, manufacturers, service providers, IndianTradeMart`,
      bodyHtml: `
        <h1>${escapeHtml(title)}</h1>
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

export default router;
