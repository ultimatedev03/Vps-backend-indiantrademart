/**
 * LEAD MODULE — Leads, Quotations & Buyer inquiries
 *
 * Covers: quotation CRUD, proposal management, lead marketplace,
 * category requests from vendors, buyer-vendor communication.
 */
import quotationRouter from '../../routes/quotation.js';
import categoryRequestRouter from '../../routes/categoryRequests.js';

export const leadRoutes = Object.freeze([
  { path: '/api/quotation', router: quotationRouter },
  { path: '/api/category-requests', router: categoryRequestRouter },
]);
