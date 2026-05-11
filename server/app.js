/**
 * Reusable Express application bootstrap.
 *
 * This module builds and configures the full Express app WITHOUT calling
 * `listen()`. The entrypoint (`server.js`) imports the app and starts
 * listening using the centralized runtime config.
 *
 * This separation allows:
 *  - Testing the app without binding a port
 *  - Reusing the same app in future adapters (Netlify, serverless, etc.)
 *  - Centralizing middleware and route registration
 */

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';

import runtimeConfig from './lib/runtimeConfig.js';
import { backendModules } from './modules/index.js';

// Middleware imports
import { subdomainMiddleware, subdomainRedirectMiddleware, getSubdomainAwareCORS } from './middleware/subdomainMiddleware.js';
import { SECURITY_HEADERS } from './lib/httpSecurity.js';

// ---------------------------------------------------------------------------
// Build the Express app
// ---------------------------------------------------------------------------

const app = express();

// Netlify/Render terminate TLS and forward requests to Express.
app.set('trust proxy', 1);

const resolveExpressMiddleware = (candidate) => {
  if (!candidate) return null;
  if (typeof candidate === 'function') return candidate;

  // Some serverless bundlers wrap ESM default exports in a namespace object.
  if (typeof candidate?.default === 'function') return candidate.default;

  return null;
};

// 1. Subdomain detection (BEFORE cors)
app.use(subdomainMiddleware);

// 2. CORS with subdomain support
app.use(cors(getSubdomainAwareCORS()));

// 3. Security headers
app.use((req, res, next) => {
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  next();
});

// 4. Subdomain redirect (optional — redirects wrong subdomain access)
app.use(subdomainRedirectMiddleware);

// 5. Body parsing
//    Quotation PDF attachments are sent as base64 in JSON, so we need a
//    generous limit. This is configurable via JSON_BODY_LIMIT env var.
app.use(express.json({ limit: runtimeConfig.jsonBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: runtimeConfig.jsonBodyLimit }));

// 6. Input sanitization — prevent NoSQL injection and basic XSS
app.use(mongoSanitize());
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    Object.keys(req.body).forEach(key => {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key]
          .replace(/[<>"']/g, '')
          .trim();
      }
    });
  }
  next();
});

// 7. Rate limiting
const otpLimiter = rateLimit({
  windowMs: runtimeConfig.otpRateWindowMs,
  max: runtimeConfig.otpRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => runtimeConfig.disableApiRateLimit,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many OTP attempts. Please wait a few minutes and try again.',
    });
  },
});

const apiLimiter = rateLimit({
  windowMs: runtimeConfig.apiRateWindowMs,
  max: runtimeConfig.apiRateMax,
  message: 'Too many requests, try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (runtimeConfig.disableApiRateLimit) return true;
    if (!runtimeConfig.isProd && req.path.startsWith('/auth/')) return true;
    return false;
  },
});

const authLimiter = rateLimit({
  windowMs: runtimeConfig.authRateWindowMs,
  max: runtimeConfig.authRateMax,
  message: 'Too many auth attempts, try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => runtimeConfig.disableApiRateLimit,
});

app.use('/api/', apiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/otp', otpLimiter);

// 8. Routes
backendModules.forEach((moduleConfig) => {
  moduleConfig.routes.forEach(({ path, router }) => {
    const middleware = resolveExpressMiddleware(router);

    if (!middleware) {
      const routeLabel = `${moduleConfig?.name || 'unknown'}:${path || '(missing-path)'}`;
      throw new TypeError(`Invalid router registered for ${routeLabel}`);
    }

    app.use(path, middleware);
  });
});

// 9. Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// 10. Global error handler
app.use((err, req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default app;
export { app };
