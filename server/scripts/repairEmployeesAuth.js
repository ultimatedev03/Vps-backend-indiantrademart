import { supabase } from '../lib/supabaseClient.js';

const DEFAULT_PASSWORD = process.env.REPAIR_EMPLOYEE_DEFAULT_PASSWORD || 'Abcd@321';
const NOW = () => new Date().toISOString();

const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

async function listAllAuthUsersByEmail() {
  const perPage = 100;
  const maxPages = 50;
  const map = new Map();

  for (let page = 1; page <= maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`auth.admin.listUsers failed on page ${page}: ${error.message}`);
    }

    const users = data?.users || [];
    for (const u of users) {
      const email = normalizeEmail(u?.email);
      if (email) map.set(email, u);
    }

    if (users.length < perPage) break;
  }

  return map;
}

async function upsertPublicUser(userId, employee) {
  const email = normalizeEmail(employee?.email);
  if (!userId || !email) return;

  const payload = {
    id: userId,
    email,
    full_name: employee?.full_name || email.split('@')[0],
    role: String(employee?.role || 'DATA_ENTRY').toUpperCase(),
    phone: employee?.phone || null,
    updated_at: NOW(),
    created_at: NOW(),
  };

  const { error } = await supabase.from('users').upsert([payload], { onConflict: 'id' });
  if (error) {
    throw new Error(`users upsert failed for ${email}: ${error.message}`);
  }
}

async function run() {
  console.log('🔧 Repairing employee auth links...');

  const { data: employees, error: empError } = await supabase
    .from('employees')
    .select('id, user_id, full_name, email, phone, role, department, status, created_at')
    .order('created_at', { ascending: false });

  if (empError) {
    throw new Error(`Failed to load employees: ${empError.message}`);
  }

  const authByEmail = await listAllAuthUsersByEmail();

  let checked = 0;
  let linkedExisting = 0;
  let createdAuth = 0;
  let skipped = 0;
  const problems = [];

  for (const emp of employees || []) {
    checked += 1;
    const email = normalizeEmail(emp?.email);
    if (!email) {
      skipped += 1;
      problems.push({ id: emp?.id, reason: 'missing_email' });
      // eslint-disable-next-line no-continue
      continue;
    }

    // If already linked, just keep public.users aligned.
    if (emp.user_id) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await upsertPublicUser(emp.user_id, emp);
      } catch (e) {
        problems.push({ id: emp.id, email, reason: e.message });
      }
      // eslint-disable-next-line no-continue
      continue;
    }

    let authUser = authByEmail.get(email) || null;

    // Create auth user if not present.
    if (!authUser) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password: DEFAULT_PASSWORD,
        email_confirm: true,
        user_metadata: {
          full_name: emp?.full_name || email.split('@')[0],
          role: String(emp?.role || 'DATA_ENTRY').toUpperCase(),
          phone: emp?.phone || null,
          department: emp?.department || 'Operations',
        },
        app_metadata: {
          role: String(emp?.role || 'DATA_ENTRY').toUpperCase(),
        },
      });

      if (error || !data?.user) {
        skipped += 1;
        problems.push({ id: emp.id, email, reason: error?.message || 'createUser_failed' });
        // eslint-disable-next-line no-continue
        continue;
      }

      authUser = data.user;
      authByEmail.set(email, authUser);
      createdAuth += 1;
      console.log(`✅ Created auth user for ${email}`);
    }

    // Link employee -> auth user.
    // eslint-disable-next-line no-await-in-loop
    const { error: linkError } = await supabase
      .from('employees')
      .update({ user_id: authUser.id })
      .eq('id', emp.id);

    if (linkError) {
      skipped += 1;
      problems.push({ id: emp.id, email, reason: `link_failed: ${linkError.message}` });
      // eslint-disable-next-line no-continue
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      await upsertPublicUser(authUser.id, emp);
    } catch (e) {
      problems.push({ id: emp.id, email, reason: e.message });
    }

    if (createdAuth === 0 || authUser?.id !== emp.user_id) {
      linkedExisting += 1;
    }
  }

  console.log('\n📊 Repair summary');
  console.log(`- Employees checked: ${checked}`);
  console.log(`- Linked existing auth users: ${linkedExisting}`);
  console.log(`- Created auth users: ${createdAuth}`);
  console.log(`- Skipped/problem rows: ${skipped}`);

  if (problems.length) {
    console.log('\n⚠️ Problems (first 20):');
    for (const p of problems.slice(0, 20)) {
      console.log(`- ${p.id} (${p.email || 'no-email'}): ${p.reason}`);
    }
  }

  console.log('\n✅ Done. You can now reset passwords from Superadmin if needed.');
}

run().catch((e) => {
  console.error('❌ repairEmployeesAuth failed:', e?.message || e);
  process.exitCode = 1;
});

