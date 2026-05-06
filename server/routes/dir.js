// ✅ File: server/routes/dir.js
import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { cacheResponse } from '../lib/cacheMiddleware.js';

const router = express.Router();

// Plan priority (higher = better)
const PLAN_TIERS = [
  { key: 'diamond', label: 'DIAMOND', priority: 700 },
  { key: 'gold', label: 'GOLD', priority: 600 },
  { key: 'silver', label: 'SILVER', priority: 500 },
  { key: 'booster', label: 'BOOSTER', priority: 400 },
  { key: 'certified', label: 'CERTIFIED', priority: 300 },
  { key: 'startup', label: 'STARTUP', priority: 200 },
  { key: 'trial', label: 'TRIAL', priority: 100 },
];

function normPlanName(name) {
  return String(name || '').trim().toLowerCase();
}

function planToTierKey(planName) {
  const n = normPlanName(planName);
  if (!n) return 'trial';
  if (n.includes('diamond')) return 'diamond';
  if (n.includes('gold')) return 'gold';
  if (n.includes('silver')) return 'silver';
  if (n.includes('booster') || n.includes('boost')) return 'booster';
  if (n.includes('certified') || n.includes('certificate')) return 'certified';
  if (n.includes('startup')) return 'startup';
  if (n.includes('trial') || n.includes('free')) return 'trial';
  return 'trial';
}

function isValidId(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return s.length > 0;
}

function clampInt(v, def, min, max) {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function safeQ(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.slice(0, 100);
}

function applySort(q, sort) {
  if (sort === 'price_asc') return q.order('price', { ascending: true });
  if (sort === 'price_desc') return q.order('price', { ascending: false });
  return q.order('created_at', { ascending: false });
}

async function resolveMicroId(microSlug) {
  if (!microSlug) return null;

  const { data: micro, error } = await supabase
    .from('micro_categories')
    .select('id')
    .eq('slug', microSlug)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return micro?.id || null;
}

async function fetchRankedProductsViaRpc({ microId, cityId, stateId, q, sort, from, limit }) {
  const { data, error } = await supabase.rpc('dir_ranked_products', {
    p_micro_id: microId,
    p_city_id: cityId,
    p_state_id: stateId,
    p_q: q || null,
    p_sort: sort || null,
    p_limit: limit,
    p_offset: from,
  });

  if (error) throw error;

  const rows = data || [];
  let totalCount = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;

  // If we paged past the end, probe once to recover total_count.
  if (rows.length === 0 && from > 0) {
    const { data: probeRows, error: probeErr } = await supabase.rpc('dir_ranked_products', {
      p_micro_id: microId,
      p_city_id: cityId,
      p_state_id: stateId,
      p_q: q || null,
      p_sort: sort || null,
      p_limit: 1,
      p_offset: 0,
    });
    if (!probeErr && probeRows?.length) {
      totalCount = Number(probeRows[0].total_count || 0);
    }
  }

  const cleanedRows = rows.map(({ total_count, ...rest }) => rest);
  return { rows: cleanedRows, totalCount };
}

async function getActivePlanMaps() {
  const nowIso = new Date().toISOString();

  const { data: subs, error } = await supabase
    .from('vendor_plan_subscriptions')
    .select('vendor_id, plan_id, status, end_date, start_date, plan:vendor_plans(name)')
    .eq('status', 'ACTIVE')
    .or(`end_date.is.null,end_date.gt.${nowIso}`)
    .order('start_date', { ascending: false });

  if (error) throw error;

  const planNameByVendor = {};
  const tierKeyByVendor = {};

  for (const s of subs || []) {
    const vid = s?.vendor_id;
    if (!isValidId(vid)) continue;
    if (planNameByVendor[vid]) continue;

    const planName = s?.plan?.name || '';
    planNameByVendor[vid] = planName;
    tierKeyByVendor[vid] = planToTierKey(planName);
  }

  return { planNameByVendor, tierKeyByVendor };
}

/**
 * ✅ IMPORTANT:
 * Hide suspended/terminated vendors' products.
 * Assuming vendors table has boolean column: is_active
 */
function buildBaseProductQuery({ microId, q, stateId, cityId }) {
  let query = supabase
    .from('products')
    .select(
      `
        *,
        vendors!inner (
          id, company_name, city, state, state_id, city_id,
          seller_rating, kyc_status, verification_badge, trust_score,
          is_active
        )
      `,
      { count: 'exact' }
    )
    .eq('status', 'ACTIVE')
    // ✅ hide products of suspended vendors
    .eq('vendors.is_active', true);

  if (microId) query = query.eq('micro_category_id', microId);
  if (q) query = query.ilike('name', `%${q}%`);
  if (stateId) query = query.eq('vendors.state_id', stateId);
  if (cityId) query = query.eq('vendors.city_id', cityId);

  return query;
}

async function countForVendorFilter({ microId, q, stateId, cityId, vendorFilter }) {
  let query = buildBaseProductQuery({ microId, q, stateId, cityId });

  if (vendorFilter?.type === 'in') {
    if (!vendorFilter.ids?.length) return 0;
    query = query.in('vendor_id', vendorFilter.ids);
  }

  if (vendorFilter?.type === 'notin') {
    if (vendorFilter.ids?.length) {
      const list = `(${vendorFilter.ids.join(',')})`;
      query = query.not('vendor_id', 'in', list);
    }
  }

  // NOTE: keep vendors embedded in the head-count query, otherwise
  // PostgREST throws: "'vendors' is not an embedded resource in this request".
  const { count, error } = await query.select('id, vendors!inner(id)', {
    count: 'exact',
    head: true,
  });
  if (error) throw error;
  return Number(count || 0);
}

async function fetchForVendorFilter({ microId, q, stateId, cityId, vendorFilter, sort, offsetInGroup, limit }) {
  let query = buildBaseProductQuery({ microId, q, stateId, cityId });

  if (vendorFilter?.type === 'in') {
    if (!vendorFilter.ids?.length) return [];
    query = query.in('vendor_id', vendorFilter.ids);
  }

  if (vendorFilter?.type === 'notin') {
    if (vendorFilter.ids?.length) {
      const list = `(${vendorFilter.ids.join(',')})`;
      query = query.not('vendor_id', 'in', list);
    }
  }

  query = applySort(query, sort);

  const from = offsetInGroup;
  const to = offsetInGroup + limit - 1;
  query = query.range(from, to);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function handleRankedProducts(req, res) {
  try {
    // NOTE: search page may send `q` OR `query` OR `term`
    const q = safeQ(req.query.q || req.query.query || req.query.term);
    const microSlug = safeQ(req.query.microSlug || req.query.micro || req.query.micro_slug);
    const sort = String(req.query.sort || '').trim();
    const page = clampInt(req.query.page, 1, 1, 5000);
    const limit = clampInt(req.query.limit, 20, 1, 50);
    const stateId = isValidId(req.query.stateId) ? req.query.stateId : (isValidId(req.query.state_id) ? req.query.state_id : null);
    const cityId = isValidId(req.query.cityId) ? req.query.cityId : (isValidId(req.query.city_id) ? req.query.city_id : null);

    const from = (page - 1) * limit;

    const microId = await resolveMicroId(microSlug);

    // ✅ Preferred path: slot-aware ranking via DB RPC (capacity-based seats).
    // If the migration isn't applied yet, we fall back to legacy tier buckets.
    try {
      const { rows, totalCount } = await fetchRankedProductsViaRpc({
        microId,
        cityId,
        stateId,
        q,
        sort,
        from,
        limit,
      });

      return res.json({ success: true, data: rows, count: totalCount });
    } catch (rpcErr) {
      // Continue to legacy logic below.
      logger.warn('[dir] dir_ranked_products RPC failed, using legacy ranking:', rpcErr?.message);
    }

    const { planNameByVendor, tierKeyByVendor } = await getActivePlanMaps();
    const activeVendorIds = Object.keys(tierKeyByVendor);

    const bucketIds = {};
    PLAN_TIERS.forEach((t) => (bucketIds[t.key] = []));

    for (const [vendorId, tierKey] of Object.entries(tierKeyByVendor)) {
      if (bucketIds[tierKey]) bucketIds[tierKey].push(vendorId);
    }

    let totalCount = 0;
    let remainingOffset = from;
    let remainingLimit = limit;
    const out = [];

    // 1) Subscribed buckets (diamond..trial)
    for (const tier of PLAN_TIERS) {
      const ids = bucketIds[tier.key] || [];
      if (!ids.length) continue;

      const groupCount = await countForVendorFilter({
        microId,
        q,
        stateId,
        cityId,
        vendorFilter: { type: 'in', ids },
      });

      totalCount += groupCount;
      if (groupCount <= 0) continue;

      if (remainingOffset >= groupCount) {
        remainingOffset -= groupCount;
        continue;
      }

      if (remainingLimit > 0) {
        const rows = await fetchForVendorFilter({
          microId,
          q,
          stateId,
          cityId,
          vendorFilter: { type: 'in', ids },
          sort,
          offsetInGroup: remainingOffset,
          limit: remainingLimit,
        });

        out.push(...rows);
        remainingLimit = Math.max(0, remainingLimit - rows.length);
        remainingOffset = 0;
      }

      if (remainingLimit <= 0) break;
    }

    // 2) Vendors with NO active subscription (bottom)
    if (remainingLimit > 0) {
      const excludeIds = activeVendorIds.length <= 1000 ? activeVendorIds : [];

      const groupCount = await countForVendorFilter({
        microId,
        q,
        stateId,
        cityId,
        vendorFilter: { type: 'notin', ids: excludeIds },
      });

      totalCount += groupCount;

      if (groupCount > 0) {
        if (remainingOffset >= groupCount) {
          remainingOffset -= groupCount;
        } else {
          const rows = await fetchForVendorFilter({
            microId,
            q,
            stateId,
            cityId,
            vendorFilter: { type: 'notin', ids: excludeIds },
            sort,
            offsetInGroup: remainingOffset,
            limit: remainingLimit,
          });

          out.push(...rows);
          remainingLimit = Math.max(0, remainingLimit - rows.length);
          remainingOffset = 0;
        }
      }
    }

    const finalRows = (out || []).map((p) => {
      const vid = p?.vendor_id;
      const tierKey = tierKeyByVendor[vid] || 'trial';
      const planName = planNameByVendor[vid] || 'TRIAL';
      const tierMeta = PLAN_TIERS.find((x) => x.key === tierKey) || PLAN_TIERS[PLAN_TIERS.length - 1];

      const vendors = p?.vendors ? { ...p.vendors } : null;
      if (vendors) {
        vendors.plan_name = planName;
        vendors.plan_tier = tierMeta.label;
        vendors.plan_priority = tierMeta.priority;
      }

      return {
        ...p,
        vendors,
        vendor_plan_name: planName,
        vendor_plan_tier: tierMeta.label,
        vendor_plan_priority: tierMeta.priority,
      };
    });

    return res.json({ success: true, data: finalRows, count: totalCount });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: 'DIR_PRODUCTS_FAILED',
      details: e.message,
    });
  }
}

// ✅ IMPORTANT: your UI search page calls /api/dir/search
router.get('/search', cacheResponse('dir:search', 120), handleRankedProducts);

// existing endpoint
router.get('/products', cacheResponse('dir:products', 120), handleRankedProducts);

// --- PUBLIC LOCATION ROUTES ---
router.get('/states', cacheResponse('dir:states', 3600), async (req, res) => {
  try {
    const { data, error } = await supabase.from('states').select('id, name, slug').order('name');
    if (error) throw error;
    res.json({ success: true, states: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/cities', cacheResponse('dir:cities', 3600), async (req, res) => {
  try {
    const { stateId } = req.query;
    if (!isValidId(stateId)) return res.status(400).json({ success: false, error: 'stateId required' });
    let query = supabase.from('cities').select('id, name, slug, suplier_count, state_id').eq('state_id', stateId).order('name');
    const { data, error } = await query;
    if (error && String(error.message).includes('does not exist')) {
      const fb = await supabase.from('cities').select('id, name, slug, supplier_count, state_id').eq('state_id', stateId).order('name');
      return res.json({ success: true, cities: fb.data || [] });
    }
    if (error) throw error;
    res.json({ success: true, cities: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PUBLIC CATEGORY ROUTES ---
router.get('/head-categories', cacheResponse('dir:head-categories', 1800), async (req, res) => {
  try {
    const { data, error } = await supabase.from('head_categories').select('id, name, slug, image_url, description').eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/sub-categories', cacheResponse('dir:sub-categories', 1800), async (req, res) => {
  try {
    const { headId } = req.query;
    if (!isValidId(headId)) return res.status(400).json({ success: false, error: 'headId required' });
    const { data, error } = await supabase.from('sub_categories').select('id, name, slug, image_url, description').eq('head_category_id', headId).eq('is_active', true).order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/micro-categories', cacheResponse('dir:micro-categories', 1800), async (req, res) => {
  try {
    const { subId } = req.query;
    if (!isValidId(subId)) return res.status(400).json({ success: false, error: 'subId required' });
    const { data, error } = await supabase.from('micro_categories').select('id, name, slug, sort_order, image_url').eq('sub_category_id', subId).eq('is_active', true).order('sort_order').order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ADVANCED DIRECTORY ENDPOINTS ---

router.get('/search-micro', cacheResponse('dir:search-micro', 300), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ success: true, results: [] });

    let results = [];

    const { data: microData } = await supabase
      .from('micro_categories')
      .select('id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug))')
      .ilike('name', `%${q}%`)
      .limit(10);

    if (microData) {
      results = microData.map(item => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        path: `${item.sub_categories?.head_categories?.name} > ${item.sub_categories?.name} > ${item.name}`,
        head_id: item.sub_categories?.head_categories?.id,
        sub_id: item.sub_categories?.id,
        sub_slug: item.sub_categories?.slug,
        head_slug: item.sub_categories?.head_categories?.slug,
        type: 'micro'
      }));
    }

    if (results.length < 6) {
      const { data: prodData } = await supabase
        .from('products')
        .select('id, micro_category_id, status')
        .ilike('name', `%${q}%`)
        .or('status.eq.ACTIVE,status.is.null')
        .limit(20);

      if (prodData) {
        const microIds = Array.from(new Set(prodData.map(p => p.micro_category_id).filter(Boolean)));
        if (microIds.length > 0) {
          const { data: microFromProducts } = await supabase
            .from('micro_categories')
            .select('id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug))')
            .in('id', microIds)
            .limit(10);

          if (microFromProducts) {
            const mapped = microFromProducts.map(item => ({
              id: item.id,
              name: item.name,
              slug: item.slug,
              path: `${item.sub_categories?.head_categories?.name} > ${item.sub_categories?.name} > ${item.name}`,
              head_id: item.sub_categories?.head_categories?.id,
              sub_id: item.sub_categories?.id,
              sub_slug: item.sub_categories?.slug,
              head_slug: item.sub_categories?.head_categories?.slug,
              type: 'micro'
            }));
            results = [...mapped, ...results];
          }
        }
      }
    }

    if (results.length < 5) {
      const { data: subData } = await supabase
        .from('sub_categories')
        .select('id, name, slug, head_categories(id, name, slug)')
        .ilike('name', `%${q}%`)
        .limit(10);

      if (subData) {
        const subResults = subData.map(item => ({
          id: item.id,
          name: item.name,
          slug: item.slug,
          path: `${item.head_categories?.name} > ${item.name}`,
          head_id: item.head_categories?.id,
          sub_id: item.id,
          sub_slug: item.slug,
          head_slug: item.head_categories?.slug,
          type: 'sub'
        }));
        results = [...results, ...subResults];
      }
    }

    const seen = new Set();
    const unique = [];
    for (const r of results) {
      const key = r.type + ':' + r.slug;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
      }
    }
    
    res.json({ success: true, results: unique.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/products-preview', cacheResponse('dir:products-preview', 300), async (req, res) => {
  try {
    const microIdsParam = String(req.query.microIds || '');
    const ids = microIdsParam.split(',').filter(Boolean);
    if (!ids.length) return res.json({ success: true, previews: {} });
    
    const per = Math.max(1, Math.min(Number(req.query.perMicro) || 6, 12));
    const fetchLimit = Math.min(ids.length * per * 3, 600);

    const { data, error } = await supabase
      .from('products')
      .select('id, name, slug, price, images, micro_category_id, created_at, vendors!inner(is_active)')
      .in('micro_category_id', ids)
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);

    if (error) throw error;
    
    const map = {};
    for (const row of data || []) {
      const mid = row.micro_category_id;
      if (!mid) continue;
      if (!map[mid]) map[mid] = [];
      if (map[mid].length >= per) continue;
      map[mid].push(row);
    }
    
    res.json({ success: true, previews: map });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/micro-covers', cacheResponse('dir:micro-covers', 600), async (req, res) => {
  try {
    const microIdsParam = String(req.query.microIds || '');
    const ids = microIdsParam.split(',').filter(Boolean);
    if (!ids.length) return res.json({ success: true, covers: {} });

    // 1) First prefer explicit micro category images (if configured)
    const { data: microData, error: microErr } = await supabase
      .from('micro_categories')
      .select('id, image_url')
      .in('id', ids);
      
    if (microErr) throw microErr;

    const map = {};
    for (const m of microData || []) {
      const url = typeof m?.image_url === 'string' ? m.image_url.trim() : '';
      if (m?.id && url) map[m.id] = url;
    }

    const missing = ids.filter((id) => !map[id]);
    if (missing.length === 0) return res.json({ success: true, covers: map });

    const { data, error } = await supabase
      .from('products')
      .select('micro_category_id, images, created_at, vendors!inner(is_active)')
      .in('micro_category_id', missing)
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true)
      .order('created_at', { ascending: false });
      
    if (error) throw error;

    for (const row of data || []) {
      const mid = row.micro_category_id;
      if (!mid || map[mid]) continue;
      
      const imgs = row.images;
      let url = null;
      
      if (Array.isArray(imgs) && imgs.length > 0) {
        const first = imgs[0];
        if (typeof first === 'string') url = first;
        else if (first && typeof first === 'object') url = first.url || first.image_url || first.src || null;
      }
      
      if (typeof url === 'string' && url.trim().length > 0) map[mid] = url.trim();
    }
    
    res.json({ success: true, covers: map });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/category/:type/:slug', cacheResponse('dir:category-detail', 1800, { includeParams: true }), async (req, res) => {
  try {
    const { type, slug } = req.params;
    
    if (type === 'head') {
      let headRes = await supabase.from('head_categories').select('id, name, slug, description, meta_tags, keywords').eq('slug', slug).limit(1);
      if (headRes.error) headRes = await supabase.from('head_categories').select('id, name, slug, description').eq('slug', slug).limit(1);
      return res.json({ success: true, category: headRes.data?.[0] || null });
    }
    
    if (type === 'sub') {
      let subRes = await supabase.from('sub_categories').select('id, name, slug, description, meta_tags, keywords, head_category_id').eq('slug', slug).limit(1);
      if (subRes.error) subRes = await supabase.from('sub_categories').select('id, name, slug, description, head_category_id').eq('slug', slug).limit(1);
      return res.json({ success: true, category: subRes.data?.[0] || null });
    }
    
    if (type === 'micro') {
      const { data: micro, error } = await supabase.from('micro_categories').select(`
          id, name, slug,
          sub_categories (id, name, slug, head_categories (id, name, slug))
        `).eq('slug', slug).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        
      if (error || !micro) return res.json({ success: true, category: null });
      
      let metaRes = await supabase.from('micro_category_meta').select('meta_tags, description, keywords').eq('micro_categories', micro.id).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (metaRes.error) metaRes = await supabase.from('micro_category_meta').select('meta_tags, description').eq('micro_category_id', micro.id).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      
      return res.json({ 
        success: true, 
        category: {
          ...micro,
          meta_tags: metaRes?.data?.meta_tags,
          meta_description: metaRes?.data?.description,
          meta_keywords: metaRes?.data?.keywords
        }
      });
    }

    res.status(400).json({ success: false, error: 'Invalid type' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/product/:slug', cacheResponse('dir:product', 300, { includeParams: true }), async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!slug) return res.status(400).json({ success: false, error: 'Slug required' });

    const { data: product, error } = await supabase
      .from('products')
      .select('*, vendors(*), micro_categories(id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug)))')
      .eq('slug', slug)
      .eq('status', 'ACTIVE')
      .limit(1)
      .maybeSingle();

    if (error || !product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    // Attempt to increment view count asynchronously without blocking
    supabase.from('products').update({ views: (product.views || 0) + 1 }).eq('id', product.id).then();

    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PUBLIC API ROUTES ---

const isMissingColumnErr = (error, columnName) => {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('column') && msg.includes(String(columnName).toLowerCase()) && msg.includes('does not exist');
};

const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const fetchMicroCategoriesBySubIds = async (subIds) => {
  if (!Array.isArray(subIds) || subIds.length === 0) return [];
  const chunks = chunkArray(subIds, 60);
  const runChunk = async (ids) => {
    let q = supabase.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    let res = await q;
    if (res.error && isMissingColumnErr(res.error, 'is_active')) res = await supabase.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (res.error && isMissingColumnErr(res.error, 'sort_order')) {
      let q2 = supabase.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).order('name', { ascending: true });
      if (!isMissingColumnErr(res.error, 'is_active')) {
        q2 = q2.eq('is_active', true);
      }
      res = await q2;
      if (res.error && isMissingColumnErr(res.error, 'is_active')) {
        res = await supabase.from('micro_categories').select('id, sub_category_id, name, slug').in('sub_category_id', ids).order('name', { ascending: true });
      }
    }
    return res.data || [];
  };
  const results = [];
  // Run with limited parallelism to avoid rate limits
  for (let i = 0; i < chunks.length; i += 4) {
    const batchRes = await Promise.all(chunks.slice(i, i + 4).map(runChunk));
    batchRes.forEach((r) => results.push(...r));
  }
  return results;
};

router.get('/categories/home-showcase', cacheResponse('dir:home-showcase', 900), async (req, res) => {
  try {
    const headLimit = Number(req.query.headLimit) || 0;
    const subLimit = Number(req.query.subLimit) || 0;
    const microLimit = Number(req.query.microLimit) || 0;

    let headQuery = supabase.from('head_categories').select('id, name, slug, image_url, description').eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (headLimit > 0) headQuery = headQuery.limit(headLimit);
    let headRes = await headQuery;
    if (headRes.error && isMissingColumnErr(headRes.error, 'sort_order')) {
      let fallbackHeadQuery = supabase.from('head_categories').select('id, name, slug, image_url, description').eq('is_active', true).order('name', { ascending: true });
      if (headLimit > 0) fallbackHeadQuery = fallbackHeadQuery.limit(headLimit);
      headRes = await fallbackHeadQuery;
    }
    if (headRes.error) throw headRes.error;
    const heads = headRes.data || [];
    if (heads.length === 0) return res.json({ success: true, categories: [] });

    const headIds = heads.map((h) => h.id);
    let subRes = await supabase.from('sub_categories').select('id, head_category_id, name, slug, image_url, description').in('head_category_id', headIds).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (subRes.error && isMissingColumnErr(subRes.error, 'sort_order')) {
      subRes = await supabase.from('sub_categories').select('id, head_category_id, name, slug, image_url, description').in('head_category_id', headIds).eq('is_active', true).order('name', { ascending: true });
    }
    if (subRes.error) throw subRes.error;
    const subs = subRes.data || [];

    let limitedSubs = subs;
    if (subLimit > 0) {
      const subsByHeadRaw = subs.reduce((acc, s) => {
        if (!acc[s.head_category_id]) acc[s.head_category_id] = [];
        acc[s.head_category_id].push(s);
        return acc;
      }, {});
      limitedSubs = [];
      for (const h of heads) {
        limitedSubs.push(...(subsByHeadRaw[h.id] || []).slice(0, subLimit));
      }
    }

    const micros = await fetchMicroCategoriesBySubIds(limitedSubs.map((s) => s.id));
    const microsBySub = micros.reduce((acc, m) => {
      if (!acc[m.sub_category_id]) acc[m.sub_category_id] = [];
      if (microLimit <= 0 || acc[m.sub_category_id].length < microLimit) {
        acc[m.sub_category_id].push({ id: m.id, name: m.name, slug: m.slug });
      }
      return acc;
    }, {});

    const subsByHead = limitedSubs.reduce((acc, s) => {
      if (!acc[s.head_category_id]) acc[s.head_category_id] = [];
      acc[s.head_category_id].push({ ...s, micros: microsBySub[s.id] || [] });
      return acc;
    }, {});

    const payload = heads.map((h) => ({ ...h, subcategories: subsByHead[h.id] || [] }));
    res.json({ success: true, categories: payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/children', cacheResponse('dir:categories-children', 1800), async (req, res) => {
  try {
    const { parentId, parentType } = req.query;
    let table = parentType === 'SUB' ? 'micro_categories' : 'sub_categories';
    let foreignKey = parentType === 'SUB' ? 'sub_category_id' : 'head_category_id';

    let r = await supabase.from(table).select('*').eq(foreignKey, parentId).eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (r.error && isMissingColumnErr(r.error, 'sort_order')) {
      r = await supabase.from(table).select('*').eq(foreignKey, parentId).eq('is_active', true).order('name', { ascending: true });
    }
    if (r.error) throw r.error;
    res.json({ success: true, children: r.data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/top-level', cacheResponse('dir:categories-top', 1800), async (req, res) => {
  try {
    let r = await supabase.from('head_categories').select('*').eq('is_active', true).order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (r.error && isMissingColumnErr(r.error, 'sort_order')) {
      r = await supabase.from('head_categories').select('*').eq('is_active', true).order('name', { ascending: true });
    }
    if (r.error) throw r.error;
    res.json({ success: true, categories: r.data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/head-count', cacheResponse('dir:head-count', 1800), async (req, res) => {
  try {
    const { count, error } = await supabase.from('head_categories').select('*', { count: 'exact', head: true }).eq('is_active', true);
    if (error) throw error;
    res.json({ success: true, count: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/category/universal/:slug', cacheResponse('dir:universal', 1800, { includeParams: true }), async (req, res) => {
  try {
    const { slug } = req.params;
    const { data: h } = await supabase.from('head_categories').select('*').eq('slug', slug).eq('is_active', true).maybeSingle();
    if (h) return res.json({ success: true, category: { ...h, type: 'HEAD' } });
    
    const { data: s } = await supabase.from('sub_categories').select('*, parent:head_categories(id, name, slug)').eq('slug', slug).eq('is_active', true).maybeSingle();
    if (s) return res.json({ success: true, category: { ...s, type: 'SUB' } });
    
    const { data: m } = await supabase.from('micro_categories').select('*, parent:sub_categories(id, name, slug, grandparent:head_categories(id, name, slug))').eq('slug', slug).eq('is_active', true).maybeSingle();
    if (m) return res.json({ success: true, category: { ...m, type: 'MICRO' } });
    
    res.json({ success: true, category: null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendor/:vendorSlug — public vendor profile by slug
router.get('/vendor/:vendorSlug', cacheResponse('dir:vendor', 300, { includeParams: true }), async (req, res) => {
  try {
    const { vendorSlug } = req.params;
    if (!vendorSlug) return res.status(400).json({ success: false, error: 'Vendor slug required' });

    const { data: vendor, error } = await supabase
      .from('vendors')
      .select(`
        id, vendor_id, company_name, owner_name, email, phone,
        city, state, state_id, city_id, website, description,
        kyc_status, verification_badge, trust_score, seller_rating,
        is_active, avatar_url, banner_url, established_year,
        created_at, updated_at,
        products(id, name, slug, price, images, status, micro_category_id)
      `)
      .eq('slug', vendorSlug)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      // Retry without slug column if it doesn't exist
      if (String(error.message).includes('slug')) {
        const { data: byId, error: idErr } = await supabase
          .from('vendors')
          .select('id, vendor_id, company_name, owner_name, city, state, is_active, avatar_url, kyc_status, verification_badge, seller_rating')
          .eq('vendor_id', vendorSlug)
          .eq('is_active', true)
          .maybeSingle();
        if (!idErr && byId) return res.json({ success: true, vendor: byId });
      }
      throw error;
    }

    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    return res.json({ success: true, vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/categories — flat list of all categories (head level)
router.get('/categories', cacheResponse('dir:categories', 1800), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('head_categories')
      .select('id, name, slug, image_url, description')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/hierarchy — full 3-level category hierarchy
router.get('/hierarchy', cacheResponse('dir:hierarchy', 1800), async (req, res) => {
  try {
    const [headsRes, subsRes, microsRes] = await Promise.all([
      supabase.from('head_categories').select('id, name, slug, image_url').eq('is_active', true).order('name'),
      supabase.from('sub_categories').select('id, name, slug, head_category_id').eq('is_active', true).order('name'),
      supabase.from('micro_categories').select('id, name, slug, sub_category_id').eq('is_active', true).order('name'),
    ]);

    if (headsRes.error) throw headsRes.error;

    const microsBySub = (microsRes.data || []).reduce((acc, m) => {
      if (!acc[m.sub_category_id]) acc[m.sub_category_id] = [];
      acc[m.sub_category_id].push({ id: m.id, name: m.name, slug: m.slug });
      return acc;
    }, {});

    const subsByHead = (subsRes.data || []).reduce((acc, s) => {
      if (!acc[s.head_category_id]) acc[s.head_category_id] = [];
      acc[s.head_category_id].push({ id: s.id, name: s.name, slug: s.slug, micros: microsBySub[s.id] || [] });
      return acc;
    }, {});

    const hierarchy = (headsRes.data || []).map((h) => ({
      ...h,
      subcategories: subsByHead[h.id] || [],
    }));

    res.json({ success: true, hierarchy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/products/list — product listing with filters
router.get('/products/list', cacheResponse('dir:products-list', 120), async (req, res) => {
  try {
    const microId = req.query.microId || req.query.micro_id || null;
    const q = safeQ(req.query.q || req.query.search || '');
    const stateId = req.query.stateId || req.query.state_id || null;
    const cityId = req.query.cityId || req.query.city_id || null;
    const sort = req.query.sort || 'recent';
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 10000);

    let query = supabase
      .from('products')
      .select('*, vendors!inner(id, company_name, city, state, is_active, kyc_status, verification_badge)', { count: 'exact' })
      .eq('status', 'ACTIVE')
      .eq('vendors.is_active', true);

    if (microId) query = query.eq('micro_category_id', microId);
    if (q) query = query.ilike('name', `%${q}%`);
    if (stateId) query = query.eq('vendors.state_id', stateId);
    if (cityId) query = query.eq('vendors.city_id', cityId);

    query = applySort(query, sort);
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({ success: true, products: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/product/id/:productId — product by UUID/ID (not slug)
router.get('/product/id/:productId', cacheResponse('dir:product-id', 300, { includeParams: true }), async (req, res) => {
  try {
    const { productId } = req.params;
    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

    const { data: product, error } = await supabase
      .from('products')
      .select('*, vendors(*), micro_categories(id, name, slug, sub_categories(id, name, slug, head_categories(id, name, slug)))')
      .eq('id', productId)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (error) throw error;
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendors/search — search vendors by keyword
router.get('/vendors/search', cacheResponse('dir:vendors-search', 120), async (req, res) => {
  try {
    const q = safeQ(req.query.q || req.query.search || '');
    const stateId = req.query.stateId || req.query.state_id || null;
    const cityId = req.query.cityId || req.query.city_id || null;
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 10000);

    let query = supabase
      .from('vendors')
      .select('id, vendor_id, company_name, owner_name, city, state, state_id, city_id, avatar_url, kyc_status, verification_badge, seller_rating, trust_score', { count: 'exact' })
      .eq('is_active', true);

    if (q) query = query.ilike('company_name', `%${q}%`);
    if (stateId) query = query.eq('state_id', stateId);
    if (cityId) query = query.eq('city_id', cityId);

    query = query.order('company_name', { ascending: true }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, vendors: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendors/detail/:vendorId — vendor detail by UUID
router.get('/vendors/detail/:vendorId', cacheResponse('dir:vendor-detail', 300, { includeParams: true }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!vendorId) return res.status(400).json({ success: false, error: 'Vendor ID required' });

    const { data: vendor, error } = await supabase
      .from('vendors')
      .select(`
        id, vendor_id, company_name, owner_name, city, state, state_id, city_id,
        website, description, kyc_status, verification_badge, trust_score, seller_rating,
        is_active, avatar_url, banner_url, established_year, created_at,
        products(id, name, slug, price, images, status, micro_category_id)
      `)
      .eq('id', vendorId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    res.json({ success: true, vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/vendors/:vendorId/ratings — vendor ratings summary
router.get('/vendors/:vendorId/ratings', cacheResponse('dir:vendor-ratings', 300, { includeParams: true }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { data: vendor, error } = await supabase
      .from('vendors')
      .select('id, seller_rating, trust_score')
      .eq('id', vendorId)
      .maybeSingle();

    if (error) throw error;
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    // Attempt to fetch review rows if table exists
    let reviews = [];
    const reviewsRes = await supabase
      .from('vendor_reviews')
      .select('id, rating, comment, created_at, buyer_id')
      .eq('vendor_id', vendorId)
      .order('created_at', { ascending: false })
      .limit(20)
      .catch(() => ({ data: [], error: null }));

    reviews = reviewsRes?.data || [];

    res.json({
      success: true,
      ratings: {
        average: vendor.seller_rating || 0,
        trust_score: vendor.trust_score || 0,
        reviews,
        total_reviews: reviews.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/leads/public — public lead listings (read-only, no auth)
router.get('/leads/public', cacheResponse('dir:leads-public', 120), async (req, res) => {
  try {
    const microId = req.query.microId || req.query.micro_id || null;
    const stateId = req.query.stateId || req.query.state_id || null;
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 10000);

    let query = supabase
      .from('proposals')
      .select('id, buyer_name, buyer_email, product_description, quantity, budget, created_at, micro_category_id', { count: 'exact' })
      .eq('status', 'OPEN');

    if (microId) query = query.eq('micro_category_id', microId);
    if (stateId) query = query.eq('state_id', stateId);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      // Fallback: try leads table
      const leadsRes = await supabase
        .from('leads')
        .select('id, buyer_name, product_description, quantity, budget, created_at, micro_category_id', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      return res.json({ success: true, leads: leadsRes.data || [], total: leadsRes.count || 0 });
    }

    res.json({ success: true, leads: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dir/contact — public contact form submission
router.post('/contact', async (req, res) => {
  try {
    const { name, email, phone, message, company } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'name, email and message are required' });
    }

    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
    if (!emailValid) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    const nowIso = new Date().toISOString();
    const payload = {
      name: String(name || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      phone: phone ? String(phone).trim() : null,
      message: String(message || '').trim(),
      company: company ? String(company).trim() : null,
      status: 'new',
      created_at: nowIso,
    };

    const { data, error } = await supabase
      .from('contact_submissions')
      .insert([payload])
      .select()
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, submission: data || payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Aliases used by employeeApiComplete.js
// GET /api/dir/categories/heads → same as /head-categories
router.get('/categories/heads', cacheResponse('dir:heads-alias', 1800), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('head_categories')
      .select('id, name, slug, image_url, description, is_active')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/categories/subs?head_id=... → sub-categories by head
router.get('/categories/subs', cacheResponse('dir:subs-alias', 1800), async (req, res) => {
  try {
    const headId = req.query.head_id || req.query.headId || req.query.headCategoryId;
    if (!headId) return res.status(400).json({ success: false, error: 'head_id is required' });
    const { data, error } = await supabase
      .from('sub_categories')
      .select('id, name, slug, head_category_id, is_active')
      .eq('head_category_id', headId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dir/categories/micros?sub_id=... → micro-categories by sub
router.get('/categories/micros', cacheResponse('dir:micros-alias', 1800), async (req, res) => {
  try {
    const subId = req.query.sub_id || req.query.subId || req.query.subCategoryId;
    if (!subId) return res.status(400).json({ success: false, error: 'sub_id is required' });
    const { data, error } = await supabase
      .from('micro_categories')
      .select('id, name, slug, sub_category_id, is_active')
      .eq('sub_category_id', subId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, categories: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
