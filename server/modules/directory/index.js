/**
 * DIRECTORY MODULE — Public-facing catalog
 *
 * Covers: category hierarchy, product listings, search,
 * states/cities, public vendor profiles, data migration.
 */
import dirRouter from '../../routes/dir.js';
import migrationRouter from '../../routes/migration.js';
import publicConfigRouter from '../../routes/publicConfig.js';
import seoPagesRouter from '../../routes/seoPages.js';
import sitemapRouter from '../../routes/sitemaps.js';
import visitorTrackingRouter from '../../routes/visitorTracking.js';

export const directoryRoutes = Object.freeze([
  { path: '/api/dir', router: dirRouter },
  { path: '/api/public', router: publicConfigRouter },
  { path: '/api/visitor', router: visitorTrackingRouter },
  { path: '/api/migration', router: migrationRouter },
  { path: '/', router: seoPagesRouter },
  { path: '/', router: sitemapRouter },
]);
