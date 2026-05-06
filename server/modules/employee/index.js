/**
 * EMPLOYEE MODULE — Internal staff operations
 *
 * Covers: employee actions (uploads, approvals), data entry CRUD
 * (categories, locations, products, vendors), territory management,
 * support ticket handling.
 */
import employeeRouter from '../../routes/employee.js';
import dataEntryRouter from '../../routes/dataEntry.js';
import territoryRouter from '../../routes/territory.js';
import supportRouter from '../../routes/supportTickets.js';

export const employeeRoutes = Object.freeze([
  { path: '/api/employee', router: employeeRouter },
  { path: '/api/data-entry', router: dataEntryRouter },
  { path: '/api/territory', router: territoryRouter },
  { path: '/api/support', router: supportRouter },
]);
