// server/middleware/subdomainMiddleware.js
/**
 * Subdomain Detection & Routing Middleware for Express
 * 
 * ARCHITECTURE:
 * vendor.company.com  → Vendor app (all vendor routes, no path prefix)
 * buyer.company.com   → Buyer app (all buyer routes, no path prefix)
 * dir.company.com     → Directory app
 * management.company.com → Management portal
 * company.com         → Main domain (localhost-style routing)
 * 
 * Each subdomain serves its OWN COMPLETE APPLICATION
 * NOT path-based routing like /vendor/* on main domain
 */

const DEFAULT_MAIN_DOMAIN = 'indiantrademart.com';
const PRODUCTION_SUBDOMAINS = [
  'vendor',
  'buyer',
  'dir',
  'directory',
  'admin',
  'career',
  'man',
  'management',
  'emp',
  'employee',
];

const normalizeDomain = (value = '') =>
  String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./i, '')
    .toLowerCase();

const deriveMainDomain = () => {
  const explicit = normalizeDomain(process.env.MAIN_DOMAIN);
  if (explicit) return explicit;

  const fallbackUrl =
    process.env.FRONTEND_URL ||
    process.env.VITE_FRONTEND_URL ||
    process.env.VITE_SITE_URL ||
    '';

  try {
    const hostname = new URL(String(fallbackUrl || '').trim()).hostname;
    const normalized = normalizeDomain(hostname);
    if (normalized) return normalized;
  } catch {
    // Ignore malformed fallback URLs and use the default domain.
  }

  return DEFAULT_MAIN_DOMAIN;
};

const MAIN_DOMAIN = deriveMainDomain();
const getExtraOrigins = () =>
  (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const getProductionOrigins = () => {
  const origins = new Set([
    `https://${MAIN_DOMAIN}`,
    `https://www.${MAIN_DOMAIN}`,
  ]);

  PRODUCTION_SUBDOMAINS.forEach((subdomain) => {
    origins.add(`https://${subdomain}.${MAIN_DOMAIN}`);
  });

  getExtraOrigins().forEach((origin) => origins.add(origin));
  return Array.from(origins);
};

// Subdomain -> App Type mapping
// These are COMPLETE INDEPENDENT APPLICATIONS, not just path prefixes
const SUBDOMAIN_MAP = {
  vendor: 'vendor',           // vendor.company.com
  buyer: 'buyer',             // buyer.company.com
  dir: 'directory',           // dir.company.com
  directory: 'directory',     // directory.company.com (alternate)
  management: 'management',   // management.company.com
  man: 'management',          // man.company.com (short form)
  admin: 'admin',             // admin.company.com
  career: 'career',           // career.company.com
  emp: 'employee',            // emp.company.com
  employee: 'employee',       // employee.company.com
};

/**
 * Extract subdomain from hostname
 * @param {string} hostname - e.g., "vendor.indiantrademart.com" or "vendor.localhost"
 * @returns {string|null} - subdomain or null if main domain
 */
function extractSubdomain(hostname) {
  if (!hostname) return null;

  // Remove port if present
  const host = hostname.split(':')[0];

  // Development: localhost or 127.0.0.1
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    const parts = host.split('.');
    // vendor.localhost or buyer.localhost -> return subdomain
    return parts.length > 1 && parts[0] !== 'localhost' ? parts[0] : null;
  }

  // Production: vendor.indiantrademart.com
  // Split by dots: [vendor, indiantrademart, com]
  const parts = host.split('.');

  // Ignore 'www'
  if (parts[0] === 'www') {
    return null;
  }

  // If we have more than 2 parts and first part is not main domain
  if (parts.length > 2) {
    // vendor.indiantrademart.com -> vendor
    return parts[0];
  }

  // Main domain (indiantrademart.com)
  return null;
}

/**
 * Main subdomain middleware
 */
export function subdomainMiddleware(req, res, next) {
  const hostname = req.get('host') || '';
  const subdomain = extractSubdomain(hostname);

  // Attach to request object
  req.subdomain = subdomain;
  req.appType = SUBDOMAIN_MAP[subdomain] || 'main';
  req.isSubdomainMode = !!subdomain;

  // Log for debugging
  if (process.env.DEBUG_SUBDOMAIN === 'true') {
    console.log(`[Subdomain] Host: ${hostname} → Subdomain: ${subdomain} → AppType: ${req.appType}`);
  }

  next();
}

/**
 * Redirect middleware - handles wrong subdomain scenarios
 * E.g., accessing vendor routes on buyer subdomain
 */
export function subdomainRedirectMiddleware(req, res, next) {
  const subdomain = req.subdomain;
  const path = req.path;

  // If accessing a module-specific route on wrong subdomain, redirect
  // E.g., accessing /vendor/dashboard on buyer.domain.com
  
  // Check if route belongs to a specific module
  const pathParts = path.split('/').filter(Boolean);
  const firstPath = pathParts[0]; // vendor, buyer, directory, etc.

  // Map of path prefixes to subdomains
  const pathToSubdomain = {
    vendor: 'vendor',
    buyer: 'buyer',
    directory: 'dir',
    dir: 'dir',
    employee: 'emp',
    management: 'man',
    admin: 'admin',
    career: 'career',
  };

  const expectedSubdomain = pathToSubdomain[firstPath];

  // If accessing module-specific route on different subdomain, redirect
  if (expectedSubdomain && expectedSubdomain !== subdomain) {
    const hostname = req.get('host') || '';
    const port = hostname.split(':')[1] ? `:${hostname.split(':')[1]}` : '';

    let newHostname;
    if (hostname.includes('localhost')) {
      newHostname = `${expectedSubdomain}.localhost${port}`;
    } else {
      newHostname = `${expectedSubdomain}.${MAIN_DOMAIN}`;
    }

    const newUrl = `${req.protocol}://${newHostname}${req.originalUrl}`;
    
    console.log(`[Subdomain Redirect] ${hostname}${req.originalUrl} → ${newUrl}`);
    return res.redirect(302, newUrl);
  }

  next();
}

/**
 * CORS configuration that respects subdomains
 */
export function getSubdomainAwareCORS() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    // Production: Only allow specific subdomains
    const allowedOrigins = getProductionOrigins();

    return {
      origin: function (origin, callback) {
        // Allow requests without origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        // Only allow whitelisted origins
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        console.warn(`[CORS] Rejected origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    };
  }

  // Development: Allow specific localhost variants only
  return {
    origin: function (origin, callback) {
      const devOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:8888',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:8888',
        'http://127.0.0.1:62128', // Cascade preview proxy
      ];
      const extraOrigins = getExtraOrigins();
      const allowedOrigins = [...devOrigins, ...extraOrigins];

      const localhostRegex = /^http:\/\/(localhost|127\.0\.0\.1)(:\\d+)?$/i;
      const ipv4HttpRegex = /^http:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/i;

      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        localhostRegex.test(origin) ||
        ipv4HttpRegex.test(origin)
      ) {
        return callback(null, true);
      }

      console.warn(`[CORS] Rejected dev origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'x-requested-with'],
  };
}

/**
 * Helper to build subdomain URL
 * @param {string} subdomain - e.g., 'vendor', 'buyer', 'dir'
 * @param {string} path - e.g., '/dashboard', '/register'
 * @param {boolean} isLocalhost - whether in development
 * @returns {string} - full URL
 */
export function buildSubdomainUrl(subdomain, path = '/', isLocalhost = false) {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  if (isLocalhost) {
    return `http://${subdomain}.localhost:3000${cleanPath}`;
  }

  return `https://${subdomain}.${MAIN_DOMAIN}${cleanPath}`;
}

/**
 * Create a request object with subdomain info for frontend consumption
 * Useful for sending subdomain context from backend
 */
export function getSubdomainContext(req) {
  return {
    subdomain: req.subdomain,
    appType: req.appType,
    isSubdomainMode: req.isSubdomainMode,
    hostname: req.get('host'),
    protocol: req.protocol,
  };
}

export default subdomainMiddleware;
