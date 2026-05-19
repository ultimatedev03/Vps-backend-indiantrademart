/**
 * LEAD MODULE — Leads, Quotations & Buyer inquiries
 *
 * Covers: quotation CRUD, proposal management, lead marketplace,
 * category requests from vendors, buyer-vendor communication.
 */
import quotationRouter from '../../routes/quotation.js';
import categoryRequestRouter from '../../routes/categoryRequests.js';
import buyerRouter from '../../routes/buyer.js';

export const leadRoutes = Object.freeze([
  { path: '/api/quotation', router: quotationRouter },
  { path: '/api/category-requests', router: categoryRequestRouter },
  { path: '/api/buyer', router: buyerRouter },
  { path: '/api/buyers', router: buyerRouter },
  { path: '/api/support', router: buyerRouter },
  { path: '/buyer', router: buyerRouter },
  { path: '/buyers', router: buyerRouter },
  { path: '/support', router: buyerRouter },
  { path: '/api', router: buyerRouter },
  { path: '/', router: buyerRouter },
]);
