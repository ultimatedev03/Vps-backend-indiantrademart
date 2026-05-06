/**
 * Backend Module Registry
 *
 * 8 business-domain modules, each owning its routes:
 *
 *  auth           →  login, signup, OTP, password reset
 *  vendor         →  vendor profile, KYC, referrals
 *  directory      →  public catalog (categories, products, search, locations)
 *  payment        →  Razorpay, invoices, finance
 *  lead           →  quotations, proposals, category requests
 *  employee       →  data entry, territory, support tickets
 *  admin          →  admin panel, superadmin
 *  notifications  →  in-app alerts, AI chatbot
 */
import { authRoutes } from './auth/index.js';
import { vendorRoutes } from './vendor/index.js';
import { directoryRoutes } from './directory/index.js';
import { paymentRoutes } from './payment/index.js';
import { leadRoutes } from './lead/index.js';
import { employeeRoutes } from './employee/index.js';
import { adminRoutes } from './admin/index.js';
import { notificationRoutes } from './notifications/index.js';

export const backendModules = Object.freeze([
  { name: 'auth', routes: authRoutes },
  { name: 'vendor', routes: vendorRoutes },
  { name: 'directory', routes: directoryRoutes },
  { name: 'payment', routes: paymentRoutes },
  { name: 'lead', routes: leadRoutes },
  { name: 'employee', routes: employeeRoutes },
  { name: 'admin', routes: adminRoutes },
  { name: 'notifications', routes: notificationRoutes },
]);
