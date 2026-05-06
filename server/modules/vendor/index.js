/**
 * VENDOR MODULE — Vendor lifecycle & identity
 *
 * Covers: vendor profile CRUD, media uploads, KYC verification,
 * referral program, vendor onboarding.
 */
import vendorProfileRouter from '../../routes/vendorProfile.js';
import kycRouter from '../../routes/kyc.js';
import referralRouter from '../../routes/referrals.js';

export const vendorRoutes = Object.freeze([
  { path: '/api/vendors', router: vendorProfileRouter },
  { path: '/api/kyc', router: kycRouter },
  { path: '/api/referrals', router: referralRouter },
]);
