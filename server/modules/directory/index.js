/**
 * DIRECTORY MODULE — Public-facing catalog
 *
 * Covers: category hierarchy, product listings, search,
 * states/cities, public vendor profiles, data migration.
 */
import dirRouter from '../../routes/dir.js';
import migrationRouter from '../../routes/migration.js';
import publicConfigRouter from '../../routes/publicConfig.js';

export const directoryRoutes = Object.freeze([
  { path: '/api/dir', router: dirRouter },
  { path: '/api/public', router: publicConfigRouter },
  { path: '/api/migration', router: migrationRouter },
]);
