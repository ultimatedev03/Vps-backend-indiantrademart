import { supabase } from './supabaseClient.js';
import { hashPassword, normalizeEmail, upsertPublicUser } from './auth.js';

const truthy = (value) => String(value || '').toLowerCase() === 'true';

export async function ensureDevAdmin() {
  const emailRaw = process.env.DEV_ADMIN_EMAIL || '';
  const passwordRaw = process.env.DEV_ADMIN_PASSWORD || '';

  if (!emailRaw || !passwordRaw) return;
  if (process.env.NODE_ENV === 'production' && !truthy(process.env.ALLOW_DEV_BOOTSTRAP_IN_PROD)) {
    return;
  }

  const email = normalizeEmail(emailRaw);
  const fullName = process.env.DEV_ADMIN_NAME || email.split('@')[0] || 'Admin';
  const password_hash = await hashPassword(passwordRaw);

  const adminUser = await upsertPublicUser({
    email,
    full_name: fullName,
    role: 'ADMIN',
    password_hash,
    allowPasswordUpdate: true,
  });

  // Optional employee profile (for internal portals)
  const { data: existingEmp, error: empErr } = await supabase
    .from('employees')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (empErr) {
    console.warn('[DevBootstrap] Employee lookup failed:', empErr.message || empErr);
    return;
  }

  if (!existingEmp?.id) {
    const { error: insertErr } = await supabase
      .from('employees')
      .insert([{
        user_id: adminUser?.id || null,
        full_name: fullName,
        email,
        role: 'ADMIN',
        status: 'ACTIVE',
        created_at: new Date().toISOString(),
      }]);

    if (insertErr) {
      console.warn('[DevBootstrap] Employee insert failed:', insertErr.message || insertErr);
    }
  }
}
