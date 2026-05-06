import { supabase } from '../lib/supabaseClient.js';
import fs from 'fs';
import { resolve as pathResolve } from 'path';

const NOW = () => new Date().toISOString();

const cfg = {
  vendorCount: Math.max(0, Number(process.env.SEED_VENDORS || 25)),
  buyerCount: Math.max(0, Number(process.env.SEED_BUYERS || 25)),
  password: process.env.SEED_PASSWORD || 'Pass@1234!',
  emailDomain: (process.env.SEED_EMAIL_DOMAIN || 'staging-seed.local').toLowerCase(),
  vendorPrefix: process.env.SEED_VENDOR_PREFIX || 'vendor',
  buyerPrefix: process.env.SEED_BUYER_PREFIX || 'buyer',
};

function pad(n, w = 4) { return String(n).padStart(w, '0'); }
function randDigits(n = 4) { return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join(''); }

function genVendorId(ownerName, companyName, phoneDigits) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  const p1 = (norm(ownerName).slice(0,4) || 'VEND').padEnd(4, 'X');
  const p2 = (norm(companyName).slice(0,4) || 'COMP').padEnd(4, 'Z');
  const p3 = (String(phoneDigits || '').replace(/\D/g, '').slice(-2) || randDigits(2));
  const p4 = randDigits(2);
  return `${p1}-V-${p2}-${p3}${p4}`;
}

async function createAuthUser({ email, password, role, meta = {} }) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, ...meta },
    app_metadata: { role },
  });
  if (error) throw new Error(`auth.createUser failed for ${email}: ${error.message}`);
  return data.user;
}

async function upsertPublicUser({ userId, email, role, fullName, phone }) {
  const payload = {
    id: userId,
    email: String(email || '').toLowerCase().trim(),
    full_name: fullName || (email ? String(email).split('@')[0] : null),
    role: String(role || '').toUpperCase() || null,
    phone: phone || null,
    updated_at: NOW(),
    created_at: NOW(),
  };

  const { error } = await supabase.from('users').upsert([payload], { onConflict: 'id' });
  if (error) throw new Error(`users upsert failed for ${email}: ${error.message}`);
}

async function upsertVendor({ userId, email, companyName, ownerName, phone }) {
  const vendorId = genVendorId(ownerName, companyName, phone);
  const payload = {
    user_id: userId,
    email,
    company_name: companyName,
    owner_name: ownerName,
    phone,
    vendor_id: vendorId,
    slug: `${companyName}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + randDigits(3),
    kyc_status: 'PENDING',
    profile_completion: 10,
    is_active: true,
    is_verified: true,
    created_at: NOW(),
    updated_at: NOW(),
  };
  const { data, error } = await supabase.from('vendors').insert([payload]).select('id').maybeSingle();
  if (error) throw new Error(`vendors insert failed for ${email}: ${error.message}`);
  return data;
}

async function upsertBuyer({ userId, email, fullName, phone }) {
  const payload = {
    user_id: userId,
    email,
    full_name: fullName,
    phone,
    is_active: true,
    created_at: NOW(),
    updated_at: NOW(),
  };
  const { data, error } = await supabase.from('buyers').insert([payload]).select('id').maybeSingle();
  if (error) throw new Error(`buyers insert failed for ${email}: ${error.message}`);
  return data;
}

async function run() {
  console.log('🚀 Seeding staging test users...');
  console.log(`Vendors: ${cfg.vendorCount}, Buyers: ${cfg.buyerCount}, Domain: ${cfg.emailDomain}`);

  const vendorCreds = [];
  const buyerCreds = [];

  // Vendors
  for (let i = 1; i <= cfg.vendorCount; i += 1) {
    const email = `${cfg.vendorPrefix}+${pad(i)}@${cfg.emailDomain}`;
    const password = cfg.password;
    const owner = `Owner ${pad(i)}`;
    const company = `Seed Vendor ${pad(i)}`;
    const phone = `99999${pad(i,5)}`;
    try {
      const user = await createAuthUser({ email, password, role: 'VENDOR', meta: { owner_name: owner, company_name: company } });
      await upsertPublicUser({ userId: user.id, email, role: 'VENDOR', fullName: owner, phone });
      await upsertVendor({ userId: user.id, email, companyName: company, ownerName: owner, phone });
      vendorCreds.push(`${email}:${password}`);
      if (i % 10 === 0) console.log(`  ✅ Vendor ${i} created`);
    } catch (e) {
      console.warn(`  ⚠️ Vendor ${email} skipped: ${e.message}`);
    }
  }

  // Buyers
  for (let i = 1; i <= cfg.buyerCount; i += 1) {
    const email = `${cfg.buyerPrefix}+${pad(i)}@${cfg.emailDomain}`;
    const password = cfg.password;
    const name = `Buyer ${pad(i)}`;
    const phone = `88888${pad(i,5)}`;
    try {
      const user = await createAuthUser({ email, password, role: 'BUYER', meta: { full_name: name } });
      await upsertPublicUser({ userId: user.id, email, role: 'BUYER', fullName: name, phone });
      await upsertBuyer({ userId: user.id, email, fullName: name, phone });
      buyerCreds.push(`${email}:${password}`);
      if (i % 10 === 0) console.log(`  ✅ Buyer ${i} created`);
    } catch (e) {
      console.warn(`  ⚠️ Buyer ${email} skipped: ${e.message}`);
    }
  }

  console.log('\n📄 Export these to run k6:');
  console.log('----- VENDOR_CREDENTIALS -----');
  console.log(vendorCreds.join('\n'));
  console.log('----- BUYER_CREDENTIALS ------');
  console.log(buyerCreds.join('\n'));

  try {
    const root = process.cwd();
    const outDir = pathResolve(root, '..', 'load', 'k6');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(pathResolve(outDir, 'vendor.creds'), vendorCreds.join('\n'), 'utf8');
    fs.writeFileSync(pathResolve(outDir, 'buyer.creds'), buyerCreds.join('\n'), 'utf8');
    console.log(`\n💾 Saved credentials to: ${pathResolve(outDir, 'vendor.creds')} and buyer.creds`);
  } catch (e) {
    console.warn('⚠️ Failed to write creds files:', e?.message || e);
  }

  console.log('\n✅ Done.');
}

run().catch((e) => {
  console.error('❌ seedStagingTestUsers failed:', e?.message || e);
  process.exitCode = 1;
});
