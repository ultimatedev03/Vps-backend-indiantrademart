import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import {
  getPublicUserByEmail,
  normalizeEmail,
  setPublicUserPassword,
  upsertPublicUser,
} from '../lib/auth.js';
import { validateStrongPassword } from '../lib/passwordPolicy.js';

const router = express.Router();

// POST /api/password-reset - Reset password after OTP verification
router.post('/', async (req, res) => {
  try {
    const { email, new_password } = req.body;

    // Validate inputs
    if (!email || !new_password) {
      return res.status(400).json({ error: 'Email and new password are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const passwordValidation = validateStrongPassword(new_password);
    if (!passwordValidation.ok) {
      return res.status(400).json({ error: passwordValidation.error });
    }

    const emailLower = normalizeEmail(email);

    // Step 1: Find user_id from buyers or vendors table
    let userId = null;
    let userRole = null;

    // Check in buyers table
    const { data: buyer } = await supabase
      .from('buyers')
      .select('user_id, email')
      .eq('email', emailLower)
      .maybeSingle();

    if (buyer && buyer.user_id) {
      userId = buyer.user_id;
      userRole = 'BUYER';
    }

    // If not found in buyers, check vendors table
    if (!userId) {
      const { data: vendor } = await supabase
        .from('vendors')
        .select('user_id, email')
        .eq('email', emailLower)
        .maybeSingle();

      if (vendor && vendor.user_id) {
        userId = vendor.user_id;
        userRole = 'VENDOR';
      }
    }

    if (!userId) {
      return res.status(404).json({ error: 'Email not found in our records' });
    }

    // Step 2: Update password in public.users (with self-heal for stale/missing users row)
    let resolvedPublicUserId = String(userId || '').trim();
    try {
      await setPublicUserPassword(resolvedPublicUserId, new_password);
    } catch (passwordError) {
      if (String(passwordError?.message || '').toLowerCase().includes('target user not found')) {
        const existingByEmail = await getPublicUserByEmail(emailLower);
        if (existingByEmail?.id) {
          resolvedPublicUserId = String(existingByEmail.id);
          await setPublicUserPassword(resolvedPublicUserId, new_password);
        } else {
          await upsertPublicUser({
            id: resolvedPublicUserId,
            email: emailLower,
            role: userRole || 'USER',
            allowPasswordUpdate: false,
          });
          await setPublicUserPassword(resolvedPublicUserId, new_password);
        }
      } else {
        throw passwordError;
      }
    }

    // Step 3: Best-effort sync with Supabase auth.users
    let authPasswordSynced = false;
    const authIdCandidates = Array.from(
      new Set(
        [String(userId || '').trim(), String(resolvedPublicUserId || '').trim()]
          .filter(Boolean)
      )
    );
    for (const authCandidateId of authIdCandidates) {
      try {
        const { error: authSyncError } = await supabase.auth.admin.updateUserById(authCandidateId, {
          password: new_password,
        });
        if (!authSyncError) {
          authPasswordSynced = true;
          break;
        }
      } catch {
        // Ignore sync failures for non-Supabase identities.
      }
    }

    // Log the password reset event for security
    logger.log(`✅ Password reset successfully for ${userRole} user: ${emailLower}`);

    res.json({
      success: true,
      message: 'Password has been reset successfully',
      email: emailLower,
      role: userRole,
      auth_password_synced: authPasswordSynced,
    });

  } catch (error) {
    logger.error('Password reset error:', error);
    res.status(500).json({ error: error.message || 'Failed to reset password' });
  }
});

// POST /api/password-reset/verify-email - Verify if email exists for password reset
router.post('/verify-email', async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const emailLower = email.toLowerCase().trim();

    // Verify the role matches by checking the specific table
    if (role === 'BUYER') {
      const { data: buyer, error: buyerError } = await supabase
        .from('buyers')
        .select('id, email, user_id')
        .eq('email', emailLower)
        .maybeSingle();

      if (buyerError) {
        logger.error('Error checking buyer:', buyerError);
        return res.status(500).json({ error: 'Failed to verify email' });
      }

      if (!buyer) {
        return res.status(404).json({ error: 'This email is not registered as a buyer' });
      }

      return res.json({
        success: true,
        found: true,
        role: 'BUYER',
        email: emailLower,
        message: 'Email verified successfully'
      });

    } else if (role === 'VENDOR') {
      logger.log('[verify-email] Checking vendor for email:', emailLower);
      const { data: vendor, error: vendorError } = await supabase
        .from('vendors')
        .select('id, email, user_id')
        .eq('email', emailLower)
        .maybeSingle();

      if (vendorError) {
        logger.error('[verify-email] Error checking vendor:', vendorError);
        logger.error('[verify-email] Query details - Email:', emailLower, 'Role:', role);
        return res.status(500).json({ error: 'Failed to verify email: ' + (vendorError.message || JSON.stringify(vendorError)) });
      }

      if (!vendor) {
        logger.log('[verify-email] No vendor found for email:', emailLower);
        return res.status(404).json({ error: 'This email is not registered as a vendor' });
      }

      logger.log('[verify-email] Vendor found:', vendor.email, 'UserID:', vendor.user_id);

      return res.json({
        success: true,
        found: true,
        role: 'VENDOR',
        email: emailLower,
        message: 'Email verified successfully'
      });

    } else {
      return res.status(400).json({ error: 'Invalid role' });
    }

  } catch (error) {
    logger.error('Email verification error:', error);
    res.status(500).json({ error: error.message || 'Failed to verify email' });
  }
});

export default router;
