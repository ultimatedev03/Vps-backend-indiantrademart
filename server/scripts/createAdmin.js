import dotenv from 'dotenv';
import { db } from '../lib/dbClient.js';

dotenv.config();

const {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_NAME,
  ADMIN_PHONE,
} = process.env;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL or ADMIN_PASSWORD missing');
  process.exit(1);
}

async function createAdmin() {
  const email = String(ADMIN_EMAIL).trim().toLowerCase();
  const name = ADMIN_NAME || 'System Admin';

  const { data, error } = await db.auth.admin.createUser({
    email,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: {
      role: 'ADMIN',
      full_name: name,
      phone: ADMIN_PHONE || null,
    },
    app_metadata: { role: 'ADMIN' },
  });

  if (error && !String(error.message || '').toLowerCase().includes('already')) {
    console.error('Failed:', error.message);
    process.exit(1);
  }

  const userId = data?.user?.id;
  const user = userId
    ? data.user
    : (await db.from('users').select('*').eq('email', email).maybeSingle()).data;

  await db.from('users').upsert({
    id: user?.id || userId,
    email,
    full_name: name,
    role: 'ADMIN',
    phone: ADMIN_PHONE || null,
    updated_at: new Date().toISOString(),
  });

  const { data: existingEmployee } = await db
    .from('employees')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  const employeePayload = {
    user_id: user?.id || userId,
    email,
    full_name: name,
    phone: ADMIN_PHONE || null,
    role: 'ADMIN',
    department: 'Administration',
    status: 'ACTIVE',
    updated_at: new Date().toISOString(),
  };

  if (existingEmployee?.id) {
    await db.from('employees').update(employeePayload).eq('id', existingEmployee.id);
  } else {
    await db.from('employees').insert([{ ...employeePayload, created_at: new Date().toISOString() }]);
  }

  console.log(`Admin ready: ${email}`);
}

createAdmin().catch((error) => {
  console.error('createAdmin failed:', error?.message || error);
  process.exit(1);
});
