/**
 * ADMIN MODULE — Admin & Superadmin dashboards
 *
 * Covers: admin panel (vendor mgmt, buyer mgmt, KYC approvals,
 * audit logs), superadmin operations (system config, employee mgmt,
 * subscription management, analytics).
 */
import adminRouter from '../../routes/admin.js';
import superadminRouter from '../../routes/superadmin.js';

export const adminRoutes = Object.freeze([
  { path: '/api/admin', router: adminRouter },
  { path: '/api/superadmin', router: superadminRouter },
]);
