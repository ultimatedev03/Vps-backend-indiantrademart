/**
 * AUTH MODULE — Authentication & Identity
 *
 * Covers: buyer/vendor login & signup, OTP verification,
 * password reset, session management, avatar uploads.
 */
import authRouter from '../../routes/auth.js';
import otpRouter from '../../routes/otp.js';
import passwordResetRouter from '../../routes/passwordReset.js';

export const authRoutes = Object.freeze([
  { path: '/api/auth', router: authRouter },
  { path: '/api/otp', router: otpRouter },
  { path: '/api/password-reset', router: passwordResetRouter },
]);
