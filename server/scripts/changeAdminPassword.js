import 'dotenv/config';
import { db } from '../lib/dbClient.js';

async function changePassword() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const newPassword = String(process.env.ADMIN_PASSWORD || '');

  if (!email || !newPassword) {
    console.error('ADMIN_EMAIL or ADMIN_PASSWORD missing in .env');
    process.exit(1);
  }

  const { data: userRow, error: userError } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (userError || !userRow?.id) {
    console.error('Admin user not found in users table');
    process.exit(1);
  }

  const { error } = await db.auth.admin.updateUserById(userRow.id, { password: newPassword });
  if (error) {
    console.error('Password update failed:', error.message);
    process.exit(1);
  }

  console.log(`Admin password updated: ${email}`);
}

changePassword().catch((error) => {
  console.error('changeAdminPassword failed:', error?.message || error);
  process.exit(1);
});
