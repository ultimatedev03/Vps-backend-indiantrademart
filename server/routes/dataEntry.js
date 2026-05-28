/**
 * server/routes/dataEntry.js
 *
 * Data Entry employee operations: vendor CRUD, category management,
 * location management, product management, and vendor sub-table access.
 *
 * All routes require `requireAuth` middleware. Role enforcement depends on
 * the calling employee's role (DATA_ENTRY, SUPPORT, ADMIN, SUPERADMIN).
 *
 * Mounted at: /api/data-entry
 */

import express from 'express';
import { db } from '../lib/dbClient.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { writeAuditLog } from '../lib/audit.js';
import { invalidateDirCache } from '../lib/cacheMiddleware.js';
import {
  getPublicUserByEmail,
  hashPassword,
  normalizeEmail,
  upsertPublicUser,
} from '../lib/auth.js';
import { sendTemporaryPasswordEmail, sendWelcomeEmail } from '../lib/emailService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeSlug = (name = '') =>
  String(name).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

const DATA_ENTRY_ROLES = new Set(['DATA_ENTRY', 'DATAENTRY', 'SUPPORT', 'ADMIN', 'SUPERADMIN']);

/** Resolve the authenticated employee record from the session user. */
async function resolveEmployee(req, res) {
  const user = req.user;
  if (!user?.id) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return null;
  }

  let { data: emp } = await db
    .from('employees')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!emp && user.email) {
    const { data: byEmail } = await db
      .from('employees')
      .select('*')
      .ilike('email', user.email)
      .maybeSingle();
    emp = byEmail || null;
    if (emp && !emp.user_id) {
      await db.from('employees').update({ user_id: user.id }).eq('id', emp.id).catch(() => {});
      emp = { ...emp, user_id: user.id };
    }
  }

  if (!emp) {
    res.status(403).json({ success: false, error: 'Employee record not found' });
    return null;
  }

  if (!DATA_ENTRY_ROLES.has(emp.role)) {
    res.status(403).json({ success: false, error: 'Data entry access required' });
    return null;
  }

  return emp;
}

/** Build an OR filter scoped to the employee's assigned vendors. */
function buildVendorFilter(userId, employeeId) {
  const parts = [];
  if (userId) {
    parts.push(`assigned_to.eq.${userId}`, `created_by_user_id.eq.${userId}`, `user_id.eq.${userId}`);
  }
  if (employeeId && employeeId !== userId) {
    parts.push(`assigned_to.eq.${employeeId}`);
  }
  return parts.join(',');
}

function sanitizeProductPayload(payload = {}) {
  const next = { ...(payload || {}) };
  delete next.created_by;
  delete next.created_by_user_id;
  delete next.created_by_email;
  return next;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

const generateTemporaryPassword = () => {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$%&*!?';
  const all = upper + lower + digits + symbols;
  const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];

  while (chars.length < 10) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

const isDuplicateUserError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('already') || message.includes('exists') || message.includes('registered');
};

const normalizeVendorOnboardingInput = (body = {}) => ({
  companyName: String(body.companyName || body.company_name || '').trim(),
  ownerName: String(body.ownerName || body.owner_name || '').trim(),
  email: normalizeEmail(body.email),
  phone: String(body.phone || '').replace(/\D/g, '').slice(0, 10),
  address: String(body.address || body.registered_address || '').trim(),
  gstNumber: String(body.gstNumber || body.gst_number || '').trim().toUpperCase() || null,
  stateId: String(body.stateId || body.state_id || '').trim() || null,
  cityId: String(body.cityId || body.city_id || '').trim() || null,
  stateName: String(body.stateName || body.state || '').trim() || null,
  cityName: String(body.cityName || body.city || '').trim() || null,
  tempPassword: String(body.tempPassword || body.temp_password || '').trim(),
});

async function ensureVendorAuthUser({ email, password, fullName, phone }) {
  const password_hash = await hashPassword(password);
  const existing = await getPublicUserByEmail(email);

  if (existing?.id) {
    if (db?.auth?.admin?.updateUserById) {
      db.auth.admin
        .updateUserById(existing.id, {
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName, role: 'VENDOR', phone },
          app_metadata: { role: 'VENDOR' },
        })
        .then(({ error }) => {
          if (error) logger.warn('[DataEntry] MySQL auth password update failed:', error.message);
        })
        .catch((error) => logger.warn('[DataEntry] MySQL auth password update failed:', error?.message || error));
    }

    return upsertPublicUser({
      id: existing.id,
      email,
      full_name: fullName,
      role: 'VENDOR',
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });
  }

  let authUserId = null;
  if (db?.auth?.admin?.createUser) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: 'VENDOR', phone },
      app_metadata: { role: 'VENDOR' },
    });

    if (error && !isDuplicateUserError(error)) {
      throw new Error(error.message || 'Auth signup failed');
    }

    authUserId = data?.user?.id || null;
  }

  return upsertPublicUser({
    id: authUserId || undefined,
    email,
    full_name: fullName,
    role: 'VENDOR',
    phone,
    password_hash,
    allowPasswordUpdate: true,
  });
}

function isMissingSchemaColumnError(error, columnName = '') {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const normalizedColumn = String(columnName || '').trim().toLowerCase();

  if (code === '42703' || code === 'PGRST204') return true;
  if (!message) return false;
  if (message.includes('does not exist') && message.includes('column')) return true;
  if (
    normalizedColumn &&
    message.includes(`'${normalizedColumn}'`) &&
    message.includes('schema cache')
  ) {
    return true;
  }
  return false;
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

// GET /api/data-entry/dashboard/stats
router.get('/dashboard/stats', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;

    const filter = buildVendorFilter(emp.user_id, emp.id);
    const KYC_PENDING = ['PENDING', 'SUBMITTED'];
    const KYC_APPROVED = ['APPROVED', 'VERIFIED'];

    let qs = db.from('vendors').select('*', { count: 'exact', head: true });
    if (filter) qs = qs.or(filter);
    const { count: totalVendors } = await qs;

    let idQ = db.from('vendors').select('id');
    if (filter) idQ = idQ.or(filter);
    const { data: vendorRows } = await idQ;
    const ids = (vendorRows || []).map(v => v.id);

    let totalProducts = 0;
    if (ids.length > 0) {
      const { count } = await db.from('products').select('*', { count: 'exact', head: true }).in('vendor_id', ids);
      totalProducts = count || 0;
    }

    let pQ = db.from('vendors').select('*', { count: 'exact', head: true }).in('kyc_status', KYC_PENDING);
    if (filter) pQ = pQ.or(filter);
    const { count: pendingKyc } = await pQ;

    let aQ = db.from('vendors').select('*', { count: 'exact', head: true }).in('kyc_status', KYC_APPROVED);
    if (filter) aQ = aQ.or(filter);
    const { count: approvedKyc } = await aQ;

    return res.json({
      success: true,
      stats: {
        totalVendors: totalVendors || 0,
        totalProducts,
        pendingKyc: pendingKyc || 0,
        approvedKyc: approvedKyc || 0,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/dashboard/recent-activities
router.get('/dashboard/recent-activities', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;

    const filter = buildVendorFilter(emp.user_id, emp.id);
    let q = db.from('vendors')
      .select('id, company_name, created_at, kyc_status')
      .order('created_at', { ascending: false })
      .limit(10);
    if (filter) q = q.or(filter);
    const { data: vendors } = await q;

    const activities = (vendors || []).map(v => ({
      type: 'VENDOR',
      message: `Vendor ${v.company_name} added`,
      time: v.created_at,
      id: v.id,
    }));

    return res.json({ success: true, activities });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/dashboard/category-requests
router.get('/dashboard/category-requests', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const limit = Math.min(Number(req.query.limit || 6), 50);
    const { data, error } = await db
      .from('support_tickets')
      .select('id, subject, description, status, priority, created_at, vendor_id, vendors(company_name), attachments')
      .eq('category', 'Category Request')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, tickets: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── VENDORS ─────────────────────────────────────────────────────────────────

// GET /api/data-entry/vendors — list all/scoped vendors
router.get('/vendors', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;

    const { mine, status, search } = req.query;
    const KYC_PENDING = ['PENDING', 'SUBMITTED'];
    const KYC_APPROVED = ['APPROVED', 'VERIFIED'];

    let q = db.from('vendors').select('*, products(count)').order('created_at', { ascending: false });

    if (mine === 'true') {
      const filter = buildVendorFilter(emp.user_id, emp.id);
      if (filter) q = q.or(filter);
    }

    if (status && status !== 'all') {
      if (status === 'pending') q = q.in('kyc_status', KYC_PENDING);
      else if (status === 'approved') q = q.in('kyc_status', KYC_APPROVED);
      else if (status === 'rejected') q = q.in('kyc_status', ['REJECTED']);
    }

    if (search) {
      const term = String(search).trim();
      if (term) q = q.or(`vendor_id.ilike.%${term}%,company_name.ilike.%${term}%,owner_name.ilike.%${term}%,email.ilike.%${term}%`);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, vendors: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/vendors/:vendorId
router.get('/vendors/:vendorId', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;

    const { data, error } = await db.from('vendors').select('*').eq('id', req.params.vendorId).maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Vendor not found' });
    return res.json({ success: true, vendor: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/vendors — create vendor
router.post('/vendors', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;

    const actorId = emp.user_id;
    const vendorData = normalizeVendorOnboardingInput(req.body || {});

    if (!vendorData.companyName) {
      return res.status(400).json({ success: false, error: 'Company name is required' });
    }
    if (!vendorData.ownerName) {
      return res.status(400).json({ success: false, error: 'Owner name is required' });
    }
    if (!vendorData.email || !EMAIL_REGEX.test(vendorData.email)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    if (!vendorData.phone || vendorData.phone.length !== 10) {
      return res.status(400).json({ success: false, error: 'Valid 10-digit business phone is required' });
    }
    if (!vendorData.address) {
      return res.status(400).json({ success: false, error: 'Business address is required' });
    }
    if (!vendorData.stateId || !vendorData.cityId) {
      return res.status(400).json({ success: false, error: 'State and city are required' });
    }

    const existingVendorByEmail = await db
      .from('vendors')
      .select('id, vendor_id, company_name, email')
      .eq('email', vendorData.email)
      .maybeSingle();

    if (existingVendorByEmail.error) {
      return res.status(500).json({ success: false, error: existingVendorByEmail.error.message });
    }

    if (existingVendorByEmail.data?.id) {
      return res.status(409).json({
        success: false,
        error: `Vendor already exists for ${vendorData.email}`,
        vendor: existingVendorByEmail.data,
      });
    }

    // Generate vendor ID
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const rand = (len, chars) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const generatedId = `${rand(3, letters)}-VIN-${rand(4, digits)}-${rand(3, letters)}`;
    const tempPassword = vendorData.tempPassword || generateTemporaryPassword();

    if (!STRONG_PASSWORD_REGEX.test(tempPassword)) {
      return res.status(400).json({
        success: false,
        error: 'Temporary password must be 8+ chars with upper, lower, number and symbol',
      });
    }

    const authUser = await ensureVendorAuthUser({
      email: vendorData.email,
      password: tempPassword,
      fullName: vendorData.ownerName,
      phone: vendorData.phone,
    });

    const payload = {
      user_id: authUser.id,
      company_name: vendorData.companyName,
      owner_name: vendorData.ownerName,
      email: vendorData.email,
      phone: vendorData.phone,
      address: vendorData.address,
      registered_address: vendorData.address,
      gst_number: vendorData.gstNumber,
      state_id: vendorData.stateId,
      city_id: vendorData.cityId,
      state: vendorData.stateName,
      city: vendorData.cityName,
      vendor_id: generatedId,
      assigned_to: actorId,
      created_by_user_id: actorId,
      kyc_status: 'PENDING',
      profile_completion: 10,
      is_active: true,
      is_verified: true,
      verified_at: new Date().toISOString(),
      is_password_temporary: true,
    };

    const { data, error } = await db.from('vendors').insert([payload]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({ action: 'VENDOR_CREATED', entity_type: 'vendor', entity_id: data.id, actor_id: actorId }).catch(() => {});

    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_SITE_URL || 'https://indiantrademart.com';
    const dashboardUrl = `${frontendUrl}/vendor/dashboard`;
    const forgotPasswordUrl = `${frontendUrl}/vendor/forgot-password`;
    sendWelcomeEmail({
      to: vendorData.email,
      fullName: vendorData.ownerName,
      role: 'VENDOR',
      dashboardUrl,
    }).catch((error) => logger.warn('[DataEntry] Vendor welcome email failed:', error?.message || error));

    sendTemporaryPasswordEmail({
      to: vendorData.email,
      fullName: vendorData.ownerName,
      temporaryPassword: tempPassword,
      loginUrl: dashboardUrl,
      forgotPasswordUrl,
    }).catch((error) => logger.warn('[DataEntry] Vendor temporary password email failed:', error?.message || error));

    return res.status(201).json({ success: true, vendor: { ...data, password: tempPassword } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── KYC DOCUMENTS ───────────────────────────────────────────────────────────

// GET /api/data-entry/vendors/:vendorId/documents
router.get('/vendors/:vendorId/documents', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db
      .from('vendor_documents')
      .select('*')
      .eq('vendor_id', req.params.vendorId)
      .order('uploaded_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, documents: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/vendors/:vendorId/documents
router.post('/vendors/:vendorId/documents', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { document_type, document_url, original_name } = req.body || {};
    const { data, error } = await db.from('vendor_documents').insert([{
      vendor_id: req.params.vendorId,
      document_type,
      document_url,
      original_name,
      verification_status: 'PENDING',
    }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, document: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/vendors/:vendorId/kyc-grouped
router.get('/vendors/:vendorId/kyc-grouped', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const KYC_PENDING = ['PENDING', 'SUBMITTED'];
    const { data: vendors, error: vErr } = await db
      .from('vendors').select('*').in('kyc_status', KYC_PENDING).order('created_at', { ascending: false });
    if (vErr) return res.status(500).json({ success: false, error: vErr.message });
    if (!vendors?.length) return res.json({ success: true, withDocuments: [], withoutDocuments: [] });

    const { data: allDocs } = await db
      .from('vendor_documents').select('vendor_id').in('vendor_id', vendors.map(v => v.id));
    const withDocs = new Set((allDocs || []).map(d => d.vendor_id));

    return res.json({
      success: true,
      withDocuments: vendors.filter(v => withDocs.has(v.id)),
      withoutDocuments: vendors.filter(v => !withDocs.has(v.id)),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

// GET /api/data-entry/vendors/:vendorId/products
router.get('/vendors/:vendorId/products', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data: products, error } = await db
      .from('products').select('*').eq('vendor_id', req.params.vendorId).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });

    if (!products?.length) return res.json({ success: true, products: [] });

    const ids = products.map(p => p.id);
    const { data: images } = await db.from('product_images').select('*').in('product_id', ids);
    const imgMap = {};
    (images || []).forEach(img => { imgMap[img.product_id] = imgMap[img.product_id] || []; imgMap[img.product_id].push(img); });

    return res.json({ success: true, products: products.map(p => ({ ...p, product_images: imgMap[p.id] || [] })) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/products/:productId
router.get('/products/:productId', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('products').select('*').eq('id', req.params.productId).maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Product not found' });

    const { data: images } = await db.from('product_images').select('*').eq('product_id', req.params.productId);
    return res.json({ success: true, product: { ...data, product_images: images || [] } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/products — create product
router.post('/products', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const actorId = emp.user_id;
    const productData = {
      ...sanitizeProductPayload(req.body),
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    };

    // Try actor audit column variants for schema compatibility across DB versions.
    const candidates = [
      { ...productData, created_by_user_id: actorId },
      productData,
      { ...productData, created_by: actorId },
    ];

    let data = null, lastError = null;
    for (const payload of candidates) {
      const { data: d, error: e } = await db.from('products').insert([payload]).select().single();
      if (!e) { data = d; break; }
      const isColMissing =
        isMissingSchemaColumnError(e, 'created_by') ||
        isMissingSchemaColumnError(e, 'created_by_user_id');
      if (!isColMissing) return res.status(500).json({ success: false, error: e.message });
      lastError = e;
    }
    if (!data) return res.status(500).json({ success: false, error: lastError?.message || 'Failed to create product' });
    invalidateDirCache();
    return res.status(201).json({ success: true, product: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/data-entry/products/:productId
router.put('/products/:productId', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const updatePayload = sanitizeProductPayload(req.body);
    const { error } = await db.from('products').update(updatePayload).eq('id', req.params.productId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true, product: { id: req.params.productId, ...updatePayload } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/products/:productId/images
router.post('/products/:productId/images', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { image_url } = req.body || {};
    const { data, error } = await db.from('product_images')
      .insert([{ product_id: req.params.productId, image_url }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, image: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── CATEGORIES ───────────────────────────────────────────────────────────────

// GET /api/data-entry/categories/tree
router.get('/categories/tree', requireAuth(), async (req, res) => {
  try {
    const { data, error } = await db
      .from('head_categories')
      .select('id, name, slug, image_url, sub_categories(id, name, slug, micro_categories(id, name, slug))')
      .order('name');
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, tree: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/categories/head
router.get('/categories/head', requireAuth(), async (req, res) => {
  try {
    const withSubs = req.query.withSubs === 'true';
    const select = withSubs ? '*, sub_categories(count)' : '*';
    const { data, error } = await db.from('head_categories').select(select).order('name');
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, categories: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/categories/head
router.post('/categories/head', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const payload = { ...req.body, slug: req.body.slug || makeSlug(req.body.name) };
    const { data, error } = await db.from('head_categories').insert([payload]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.status(201).json({ success: true, category: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/data-entry/categories/head/:id
router.put('/categories/head/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('head_categories').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true, category: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/data-entry/categories/head/:id
router.delete('/categories/head/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { error } = await db.from('head_categories').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/categories/sub?headId=...
router.get('/categories/sub', requireAuth(), async (req, res) => {
  try {
    const { headId } = req.query;
    let q = db.from('sub_categories').select('*, micro_categories(count)').order('name');
    if (headId) q = q.eq('head_category_id', headId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, categories: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/categories/sub
router.post('/categories/sub', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const payload = { ...req.body, slug: req.body.slug || makeSlug(req.body.name) };
    const { data, error } = await db.from('sub_categories').insert([payload]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.status(201).json({ success: true, category: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/data-entry/categories/sub/:id
router.put('/categories/sub/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('sub_categories').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true, category: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/data-entry/categories/sub/:id
router.delete('/categories/sub/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { error } = await db.from('sub_categories').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/categories/micro?subId=...
router.get('/categories/micro', requireAuth(), async (req, res) => {
  try {
    const { subId } = req.query;
    let q = db.from('micro_categories').select('*').order('name');
    if (subId) q = q.eq('sub_category_id', subId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, categories: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/categories/micro
router.post('/categories/micro', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const payload = { ...req.body, slug: req.body.slug || makeSlug(req.body.name) };
    const { data, error } = await db.from('micro_categories').insert([payload]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.status(201).json({ success: true, category: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/data-entry/categories/micro/:id
router.put('/categories/micro/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('micro_categories').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true, category: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/data-entry/categories/micro/:id
router.delete('/categories/micro/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { error } = await db.from('micro_categories').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/categories/import-csv
router.post('/categories/import-csv', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    let success = 0, failed = 0, errors = [];

    for (const row of rows) {
      try {
        const headName = row.head_category || row.head_category_name;
        const subName = row.sub_category || row.sub_category_name;
        const microName = row.micro_category || row.micro_category_name;
        if (!headName || !subName || !microName) throw new Error('Missing names');

        const headSlug = makeSlug(headName);
        let { data: head } = await db.from('head_categories').select('id').eq('slug', headSlug).maybeSingle();
        if (!head) {
          const { data: nh, error } = await db.from('head_categories').insert([{ name: headName, slug: headSlug, is_active: true }]).select().single();
          if (error) throw error;
          head = nh;
        }

        const subSlug = makeSlug(subName);
        let { data: sub } = await db.from('sub_categories').select('id').eq('slug', subSlug).eq('head_category_id', head.id).maybeSingle();
        if (!sub) {
          const { data: ns, error } = await db.from('sub_categories').insert([{ head_category_id: head.id, name: subName, slug: subSlug, is_active: true }]).select().single();
          if (error) throw error;
          sub = ns;
        }

        const microSlug = makeSlug(microName);
        const { data: existing } = await db.from('micro_categories').select('id').eq('slug', microSlug).eq('sub_category_id', sub.id).maybeSingle();
        if (!existing) {
          const { error } = await db.from('micro_categories').insert([{
            sub_category_id: sub.id, name: microName, slug: microSlug,
            description: row.description, meta_tags: row.meta_tags, is_active: true,
          }]);
          if (error) throw error;
        }
        success++;
      } catch (e) { failed++; errors.push(e.message); }
    }
    invalidateDirCache();
    return res.json({ success: true, imported: success, failed, errors });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── LOCATIONS ───────────────────────────────────────────────────────────────

// GET /api/data-entry/locations/states
router.get('/locations/states', requireAuth(), async (req, res) => {
  try {
    const { data, error } = await db.from('states').select('*').order('name');
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, states: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/locations/states
router.post('/locations/states', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { name } = req.body || {};
    const slug = makeSlug(name);
    const { error } = await db.from('states').insert([{ name, slug, is_active: true }]);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.status(201).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/data-entry/locations/states/:id
router.put('/locations/states/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { name } = req.body || {};
    const { error } = await db.from('states').update({ name }).eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/data-entry/locations/states/:id
router.delete('/locations/states/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { error } = await db.from('states').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/locations/cities?stateId=...
router.get('/locations/cities', requireAuth(), async (req, res) => {
  try {
    const { stateId } = req.query;
    let q = db.from('cities').select('*').order('name');
    if (stateId) q = q.eq('state_id', stateId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, cities: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/locations/cities
router.post('/locations/cities', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { state_id, name } = req.body || {};
    const slug = makeSlug(name);
    const { error } = await db.from('cities').insert([{ state_id, name, slug, is_active: true }]);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.status(201).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/data-entry/locations/cities/:id
router.put('/locations/cities/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { name } = req.body || {};
    const { error } = await db.from('cities').update({ name }).eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/data-entry/locations/cities/:id
router.delete('/locations/cities/:id', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { error } = await db.from('cities').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    invalidateDirCache();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/locations/import-csv
router.post('/locations/import-csv', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    let success = 0, failed = 0;

    for (const row of rows) {
      try {
        const sName = row.state_name || row.State;
        const cName = row.city_name || row.City;
        if (!sName || !cName) { failed++; continue; }

        let { data: s } = await db.from('states').select('id').ilike('name', sName).maybeSingle();
        if (!s) {
          const { data: ns } = await db.from('states').insert([{ name: sName, slug: makeSlug(sName), is_active: true }]).select().single();
          s = ns;
        }
        if (s?.id) {
          await db.from('cities').insert([{ state_id: s.id, name: cName, slug: makeSlug(cName), is_active: true }]);
          success++;
        } else { failed++; }
      } catch { failed++; }
    }
    invalidateDirCache();
    return res.json({ success: true, imported: success, failed });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── VENDOR SUB-TABLES ───────────────────────────────────────────────────────

// GET /api/data-entry/vendors/:vendorId/bank-details
router.get('/vendors/:vendorId/bank-details', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('vendor_bank_details').select('*').eq('vendor_id', req.params.vendorId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, bankDetails: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/vendors/:vendorId/bank-details
router.post('/vendors/:vendorId/bank-details', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('vendor_bank_details')
      .insert([{ vendor_id: req.params.vendorId, ...req.body }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, bankDetail: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/vendors/:vendorId/contacts
router.get('/vendors/:vendorId/contacts', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('vendor_contact_persons').select('*').eq('vendor_id', req.params.vendorId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, contacts: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/data-entry/vendors/:vendorId/contacts
router.post('/vendors/:vendorId/contacts', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('vendor_contact_persons')
      .insert([{ vendor_id: req.params.vendorId, ...req.body }]).select().single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, contact: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/vendors/:vendorId/subscriptions
router.get('/vendors/:vendorId/subscriptions', requireAuth(), async (req, res) => {
  try {
    const emp = await resolveEmployee(req, res);
    if (!emp) return;
    const { data, error } = await db.from('vendor_plan_subscriptions')
      .select('*, vendor_plans(*)').eq('vendor_id', req.params.vendorId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, subscriptions: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/data-entry/vendor-plans
router.get('/vendor-plans', requireAuth(), async (req, res) => {
  try {
    const { data, error } = await db.from('vendor_plans').select('*').eq('is_active', true).order('price');
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, plans: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
