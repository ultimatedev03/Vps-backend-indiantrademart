import express from 'express';
import { db } from '../lib/dbClient.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const textOrNull = (value, maxLen = 500) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLen) : null;
};
const parseNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(String(value).replace(/[, ]+/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
};

const omitKeys = (obj, keys = []) =>
  Object.fromEntries(
    Object.entries(obj || {}).filter(([key, value]) => !keys.includes(key) && value !== undefined)
  );

const getMissingColumnFromError = (error) => {
  const raw = `${error?.message || ''} ${error?.details || ''}`;
  const quotedMatch = raw.match(/column\s+"([^"]+)"/i);
  if (quotedMatch?.[1]) return String(quotedMatch[1]).trim();
  const schemaCacheMatch = raw.match(/could not find the ['"]([^'"]+)['"] column/i);
  if (schemaCacheMatch?.[1]) return String(schemaCacheMatch[1]).trim();
  const code = String(error?.code || '').toUpperCase();
  if (code !== '42703' && code !== 'PGRST204') return '';
  const match = raw.match(/column\s+([^ .]+)\s+/i);
  return String(match?.[1] || '').trim();
};

async function insertWithOptionalColumns({ table, payload, select = '*', fallbackDropSets = [] }) {
  const attempts = [];
  const seen = new Set();

  const enqueue = (candidate) => {
    const cleaned = omitKeys(candidate, []);
    const signature = JSON.stringify(Object.keys(cleaned).sort().reduce((acc, key) => {
      acc[key] = cleaned[key];
      return acc;
    }, {}));
    if (seen.has(signature)) return;
    seen.add(signature);
    attempts.push(cleaned);
  };

  enqueue(payload);
  fallbackDropSets.forEach((keys) => enqueue(omitKeys(payload, keys)));

  let lastError = null;
  while (attempts.length) {
    const candidate = attempts.shift();
    const { data, error } = await db.from(table).insert([candidate]).select(select).maybeSingle();
    if (!error) return data;

    lastError = error;
    const missingColumn = getMissingColumnFromError(error);
    if (missingColumn && Object.prototype.hasOwnProperty.call(candidate, missingColumn)) {
      enqueue(omitKeys(candidate, [missingColumn]));
    }
  }

  throw lastError || new Error(`Failed to insert ${table}`);
}

async function resolveBuyerForUser(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = normalizeEmail(user?.email || '');

  if (userId) {
    const { data, error } = await db
      .from('buyers')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
  }

  if (email) {
    const { data, error } = await db
      .from('buyers')
      .select('*')
      .ilike('email', email)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
  }

  return null;
}

async function enrichVendors(rows = []) {
  const vendorIds = Array.from(new Set((rows || []).map((row) => row?.vendor_id).filter(Boolean).map(String)));
  if (!vendorIds.length) return rows || [];

  const { data, error } = await db
    .from('vendors')
    .select('id, user_id, vendor_id, company_name, owner_name, email, phone, profile_image, avatar_url, is_verified, verification_badge, kyc_status, is_active')
    .in('id', vendorIds);

  if (error || !Array.isArray(data)) return rows || [];
  const vendorMap = new Map(data.map((vendor) => [String(vendor.id), vendor]));
  return (rows || []).map((row) => ({
    ...row,
    vendors: row?.vendors || vendorMap.get(String(row?.vendor_id || '')) || null,
    vendor: row?.vendor || vendorMap.get(String(row?.vendor_id || '')) || null,
  }));
}

function buildOwnerFilter(query, { buyerId, buyerEmail }) {
  if (buyerId && buyerEmail) return query.or(`buyer_id.eq.${buyerId},buyer_email.eq.${buyerEmail}`);
  if (buyerId) return query.eq('buyer_id', buyerId);
  if (buyerEmail) return query.eq('buyer_email', buyerEmail);
  return query.eq('buyer_id', '__no_buyer__');
}

async function listBuyerProposals(req, res) {
  try {
    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim();
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');
    if (!buyerId && !buyerEmail) return res.status(403).json({ success: false, error: 'Buyer access required' });

    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 50)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const status = String(req.query?.status || '').trim().toUpperCase();

    let query = db.from('proposals').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    query = buildOwnerFilter(query, { buyerId, buyerEmail });
    if (status && status !== 'ALL') query = query.eq('status', status);
    query = query.range(from, to);

    const { data, count, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    const proposals = await enrichVendors(data || []);
    return res.json({ success: true, proposals, requirements: proposals, data: proposals, total: count || proposals.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load proposals' });
  }
}

async function createBuyerProposal(req, res) {
  try {
    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim() || null;
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || req.body?.buyer_email || '');
    if (!buyerId && !buyerEmail) return res.status(403).json({ success: false, error: 'Buyer access required' });

    const payload = req.body || {};
    const title = textOrNull(payload.title || payload.product_name || payload.category || 'Product requirement', 200);
    const description = textOrNull(payload.description || payload.message, 5000);
    if (!title) return res.status(400).json({ success: false, error: 'title/product_name is required' });
    if (!description || description.length < 10) {
      return res.status(400).json({ success: false, error: 'description/message must be at least 10 characters' });
    }

    const createdAt = new Date().toISOString();
    const proposalPayload = {
      buyer_id: buyerId,
      buyer_email: buyerEmail || null,
      vendor_id: textOrNull(payload.vendor_id || payload.vendorId, 80),
      vendor_email: normalizeEmail(payload.vendor_email || ''),
      title,
      product_name: textOrNull(payload.product_name || title, 200),
      category: textOrNull(payload.category || payload.category_name, 320),
      category_slug: textOrNull(payload.category_slug, 160),
      micro_category_id: textOrNull(payload.micro_category_id, 80),
      sub_category_id: textOrNull(payload.sub_category_id, 80),
      head_category_id: textOrNull(payload.head_category_id, 80),
      state_id: textOrNull(payload.state_id, 80),
      city_id: textOrNull(payload.city_id, 80),
      location: textOrNull(payload.location || [payload.city, payload.state].filter(Boolean).join(', '), 200),
      pincode: textOrNull(payload.pincode, 10),
      quantity: textOrNull(payload.quantity, 80),
      budget: parseNumber(payload.budget),
      required_by_date: textOrNull(payload.required_by_date, 40),
      description,
      status: textOrNull(payload.status, 40) || 'SENT',
      created_at: createdAt,
      updated_at: createdAt,
    };

    const proposal = await insertWithOptionalColumns({
      table: 'proposals',
      payload: proposalPayload,
      select: '*',
      fallbackDropSets: [
        ['required_by_date'],
        ['required_by_date', 'buyer_email', 'vendor_email'],
        ['required_by_date', 'buyer_email', 'vendor_email', 'category', 'category_slug', 'micro_category_id', 'sub_category_id', 'head_category_id', 'state_id', 'city_id', 'location', 'pincode'],
      ],
    });

    let lead = null;
    try {
      lead = await insertWithOptionalColumns({
        table: 'leads',
        payload: {
          vendor_id: proposalPayload.vendor_id,
          vendor_email: proposalPayload.vendor_email,
          proposal_id: proposal?.id || null,
          buyer_id: buyerId,
          buyer_name: textOrNull(buyer?.full_name || buyer?.company_name || req.user?.email || 'Buyer', 160),
          buyer_email: buyerEmail || null,
          buyer_phone: textOrNull(buyer?.phone || buyer?.mobile_number || payload.buyer_phone, 60),
          company_name: textOrNull(buyer?.company_name || payload.company_name, 200),
          title: proposalPayload.title,
          product_name: proposalPayload.product_name,
          description,
          message: description,
          quantity: proposalPayload.quantity,
          budget: proposalPayload.budget,
          category: proposalPayload.category,
          category_slug: proposalPayload.category_slug,
          micro_category_id: proposalPayload.micro_category_id,
          sub_category_id: proposalPayload.sub_category_id,
          head_category_id: proposalPayload.head_category_id,
          location: proposalPayload.location,
          state: textOrNull(payload.state, 120),
          city: textOrNull(payload.city, 120),
          state_id: proposalPayload.state_id,
          city_id: proposalPayload.city_id,
          pincode: proposalPayload.pincode,
          source: proposalPayload.vendor_id ? 'DIRECT' : 'MARKETPLACE',
          status: 'AVAILABLE',
          created_at: createdAt,
        },
        select: '*',
        fallbackDropSets: [
          ['proposal_id'],
          ['proposal_id', 'vendor_email', 'buyer_phone', 'company_name', 'category_slug'],
          ['proposal_id', 'vendor_email', 'buyer_phone', 'company_name', 'category_slug', 'micro_category_id', 'sub_category_id', 'head_category_id', 'state_id', 'city_id', 'location', 'pincode', 'source', 'city', 'state'],
        ],
      });
    } catch {
      lead = null;
    }

    return res.status(201).json({ success: true, proposal, requirement: proposal, lead });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to create proposal' });
  }
}

async function listBuyerLeads(req, res) {
  try {
    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim();
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');
    if (!buyerId && !buyerEmail) return res.status(403).json({ success: false, error: 'Buyer access required' });

    let query = db.from('leads').select('*').order('created_at', { ascending: false }).limit(100);
    query = buildOwnerFilter(query, { buyerId, buyerEmail });
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    const leads = await enrichVendors(data || []);
    return res.json({ success: true, leads, requirements: leads, data: leads, total: leads.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load requirements' });
  }
}

async function listSuggestions(req, res) {
  try {
    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim();
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');
    if (!buyerId && !buyerEmail) return res.status(403).json({ success: false, error: 'Buyer access required' });

    let query = db.from('suggestions').select('*').order('created_at', { ascending: false }).limit(100);
    if (buyerId && buyerEmail) query = query.or(`buyer_id.eq.${buyerId},buyer_email.eq.${buyerEmail}`);
    else if (buyerId) query = query.eq('buyer_id', buyerId);
    else query = query.eq('buyer_email', buyerEmail);

    const { data, error } = await query;
    if (error) {
      const contactQuery = db
        .from('contact_submissions')
        .select('id, name, email, message, status, created_at')
        .eq('email', buyerEmail)
        .ilike('message', 'Suggestion:%')
        .order('created_at', { ascending: false })
        .limit(100);
      const contactRes = await contactQuery;
      if (contactRes.error) return res.status(500).json({ success: false, error: error.message });
      const suggestions = (contactRes.data || []).map((row) => ({
        ...row,
        subject: String(row.message || '').replace(/^Suggestion:\s*/i, '').split('\n')[0] || 'Suggestion',
      }));
      return res.json({ success: true, suggestions, data: suggestions, total: suggestions.length });
    }

    return res.json({ success: true, suggestions: data || [], data: data || [], total: data?.length || 0 });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load suggestions' });
  }
}

async function createSuggestion(req, res) {
  try {
    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim() || null;
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');
    if (!buyerId && !buyerEmail) return res.status(403).json({ success: false, error: 'Buyer access required' });

    const subject = textOrNull(req.body?.subject || req.body?.title || 'Suggestion', 200);
    const message = textOrNull(req.body?.message || req.body?.feedback || req.body?.description, 5000);
    if (!subject || !message) return res.status(400).json({ success: false, error: 'subject and message are required' });

    const payload = {
      buyer_id: buyerId,
      buyer_email: buyerEmail || null,
      subject,
      message,
      status: 'NEW',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      const suggestion = await insertWithOptionalColumns({
        table: 'suggestions',
        payload,
        select: '*',
        fallbackDropSets: [['buyer_email', 'status', 'updated_at'], ['buyer_email', 'status', 'updated_at', 'buyer_id']],
      });
      return res.status(201).json({ success: true, suggestion });
    } catch {
      const contactPayload = {
        name: textOrNull(buyer?.full_name || buyer?.company_name || req.user?.email || 'Buyer', 160),
        email: buyerEmail || 'buyer@unknown.local',
        phone: textOrNull(buyer?.phone || buyer?.mobile_number, 60),
        company: textOrNull(buyer?.company_name, 200),
        message: `Suggestion: ${subject}\n${message}`,
        status: 'new',
        created_at: new Date().toISOString(),
      };
      const { data, error } = await db.from('contact_submissions').insert([contactPayload]).select('*').maybeSingle();
      if (error) throw error;
      return res.status(201).json({ success: true, suggestion: { ...data, subject, message } });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to submit suggestion' });
  }
}

router.get('/proposals', requireAuth({ roles: ['BUYER'] }), listBuyerProposals);
router.post('/proposals', requireAuth({ roles: ['BUYER'] }), createBuyerProposal);
router.get('/requirements', requireAuth({ roles: ['BUYER'] }), listBuyerLeads);
router.post('/requirements', requireAuth({ roles: ['BUYER'] }), createBuyerProposal);
router.get('/leads', requireAuth({ roles: ['BUYER'] }), listBuyerLeads);
router.post('/leads', requireAuth({ roles: ['BUYER'] }), createBuyerProposal);
router.get('/rfq', requireAuth({ roles: ['BUYER'] }), listBuyerProposals);
router.post('/rfq', requireAuth({ roles: ['BUYER'] }), createBuyerProposal);
router.get('/rfqs', requireAuth({ roles: ['BUYER'] }), listBuyerProposals);
router.post('/rfqs', requireAuth({ roles: ['BUYER'] }), createBuyerProposal);
router.get('/suggestions', requireAuth({ roles: ['BUYER'] }), listSuggestions);
router.post('/suggestions', requireAuth({ roles: ['BUYER'] }), createSuggestion);
router.post('/feedback', requireAuth({ roles: ['BUYER'] }), createSuggestion);

export default router;
