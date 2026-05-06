/**
 * Server entrypoint — imports the reusable Express app and starts listening.
 *
 * All middleware, route mounting, and security configuration lives in
 * `./app.js`. This file is responsible only for:
 *  1. Importing the configured app
 *  2. Running startup side-effects (cron jobs, dev bootstrap)
 *  3. Calling listen()
 */

import app from './app.js';
import runtimeConfig from './lib/runtimeConfig.js';
import { initializeSubscriptionCronJobs } from './lib/subscriptionCronJobs.js';
import { ensureDevAdmin } from './lib/devBootstrap.js';

// Initialize subscription monitoring cron jobs
initializeSubscriptionCronJobs();

// Dev-only admin bootstrap (set DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD)
ensureDevAdmin().catch((err) => {
  console.warn('[DevBootstrap] Failed:', err?.message || err);
});

const PORT = runtimeConfig.port;
const server = app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  console.log(`Environment: ${runtimeConfig.nodeEnv}`);
  if (runtimeConfig.gmailEmail) {
    console.log(`Mailer: ${runtimeConfig.gmailEmail}`);
  }
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(
      `[Startup] Port ${PORT} is already in use. ` +
      `Either stop the existing process or change PORT in backend/.env.local.`
    );
    process.exit(1);
  }

  console.error('[Startup] Server failed to start:', error?.message || error);
  process.exit(1);
});
