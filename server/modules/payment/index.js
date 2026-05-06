/**
 * PAYMENT MODULE — Billing & Money flow
 *
 * Covers: Razorpay orders & verification, subscription payments,
 * invoices, financial reports, revenue tracking.
 */
import paymentRouter from '../../routes/payment.js';
import financeRouter from '../../routes/finance.js';

export const paymentRoutes = Object.freeze([
  { path: '/api/payment', router: paymentRouter },
  { path: '/api/finance', router: financeRouter },
]);
