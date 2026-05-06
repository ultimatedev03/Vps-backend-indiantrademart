import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { buildAuthLookupMap, loadAuthLookupCache } from '../lib/authLookupCache.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

const BUYER_NOTIF_PREFIX = 'buyer_notif:';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeId = (value) => String(value || '').trim();
const toValuesArray = (value) => {
  if (Array.isArray(value)) return value.flatMap((entry) => toValuesArray(entry));
  if (value === null || value === undefined) return [];
  return [value];
};

const parseIdValues = (value) =>
  toValuesArray(value)
    .flatMap((entry) => String(entry || '').split(','))
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

const resolveRequestIds = (req) => {
  const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : parseIdValues(req.body?.id);
  const queryIds = [
    ...parseIdValues(req.query?.ids),
    ...parseIdValues(req.query?.id),
  ];

  return Array.from(
    new Set(
      [...bodyIds, ...queryIds]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
};

const toBuyerNotifId = (id) => `${BUYER_NOTIF_PREFIX}${id}`;
const isBuyerNotifId = (id) => String(id || '').startsWith(BUYER_NOTIF_PREFIX);
const fromBuyerNotifId = (id) => String(id || '').replace(BUYER_NOTIF_PREFIX, '');

const loadAuthLookupByEmail = async ({ force = false } = {}) => {
  return loadAuthLookupCache({
    force,
    loader: async () => {
      const emailMap = new Map();

      try {
        let page = 1;
        const perPage = 50;
        let errorPages = 0;

        while (true) {
          const paged = await supabase.auth.admin.listUsers({ page, perPage });
          const pagedError = paged?.error || null;
          const pagedUsers = Array.isArray(paged?.data?.users) ? paged.data.users : [];

          if (pagedError) {
            errorPages += 1;
            if (page === 1) {
              const fallback = await supabase.auth.admin.listUsers();
              if (!fallback?.error && Array.isArray(fallback?.data?.users)) {
                return buildAuthLookupMap(fallback.data.users);
              }
              break;
            }
            if (errorPages >= 5) break;
            page += 1;
            if (page > 50) break;
            continue;
          }

          errorPages = 0;
          buildAuthLookupMap(pagedUsers).forEach((id, email) => {
            emailMap.set(email, id);
          });

          if (pagedUsers.length < perPage) break;
          page += 1;
          if (page > 50) break;
        }
      } catch {
        return null;
      }

      return emailMap;
    },
  });
};

const resolveAuthUserIdByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const cached = await loadAuthLookupByEmail();
  if (cached.has(normalizedEmail)) {
    return cached.get(normalizedEmail);
  }

  const refreshed = await loadAuthLookupByEmail({ force: true });
  return refreshed.get(normalizedEmail) || null;
};

const resolveBuyerNotificationLink = (row = {}) => {
  const type = String(row?.type || '').trim().toUpperCase();
  const referenceId = String(row?.reference_id || '').trim();

  if (type === 'PROPOSAL_MESSAGE') {
    return referenceId ? `/buyer/messages?proposal=${referenceId}` : '/buyer/messages';
  }

  if (type === 'SUPPORT_MESSAGE' || type.startsWith('SUPPORT_')) {
    return '/buyer/tickets';
  }

  if (referenceId) {
    return `/buyer/proposals/${referenceId}`;
  }

  return '/buyer/proposals';
};

const mapBuyerNotificationRow = (row = {}) => ({
  ...row,
  id: toBuyerNotifId(row.id),
  link: resolveBuyerNotificationLink(row),
});

const resolveCurrentUserIds = async (reqUser = {}) => {
  const authUserId = normalizeId(reqUser?.id);
  const email = normalizeEmail(reqUser?.email || '');
  const idSet = new Set();
  const emailSet = new Set();

  if (authUserId) {
    idSet.add(authUserId);

    const { data: byId } = await supabase
      .from('users')
      .select('id, email')
      .eq('id', authUserId)
      .maybeSingle();
    if (byId?.id) idSet.add(normalizeId(byId.id));
    const mappedEmail = normalizeEmail(byId?.email);
    if (mappedEmail) emailSet.add(mappedEmail);
  }

  if (email) {
    emailSet.add(email);

    const { data: byEmail } = await supabase
      .from('users')
      .select('id, email')
      .ilike('email', email)
      .order('updated_at', { ascending: false })
      .limit(5);

    (byEmail || []).forEach((row) => {
      const id = normalizeId(row?.id);
      if (id) idSet.add(id);
      const rowEmail = normalizeEmail(row?.email);
      if (rowEmail) emailSet.add(rowEmail);
    });
  }

  const profileFilters = [];
  if (authUserId) profileFilters.push(`user_id.eq.${authUserId}`);
  if (email) profileFilters.push(`email.eq.${email}`);
  const profileFilter = profileFilters.join(',');

  if (profileFilter) {
    const profileQueries = ['employees', 'vendors', 'buyers'].map((table) =>
      supabase
        .from(table)
        .select('user_id, email')
        .or(profileFilter)
        .limit(5)
    );

    const profileResults = await Promise.all(profileQueries);
    profileResults.forEach((result) => {
      (result?.data || []).forEach((row) => {
        const profileUserId = normalizeId(row?.user_id);
        if (profileUserId) idSet.add(profileUserId);
        const profileEmail = normalizeEmail(row?.email);
        if (profileEmail) emailSet.add(profileEmail);
      });
    });
  }

  const authIds = await Promise.all(
    Array.from(emailSet).map((targetEmail) => resolveAuthUserIdByEmail(targetEmail))
  );
  authIds.forEach((id) => {
    const normalizedId = normalizeId(id);
    if (normalizedId) idSet.add(normalizedId);
  });

  return Array.from(idSet);
};

const resolveBuyerIdForUser = async (reqUser = {}, candidateUserIds = []) => {
  const email = normalizeEmail(reqUser?.email || '');
  const ids = Array.from(new Set((candidateUserIds || []).map((v) => String(v || '').trim()).filter(Boolean)));

  if (ids.length > 0) {
    const { data: rows } = await supabase
      .from('buyers')
      .select('id')
      .in('user_id', ids)
      .order('created_at', { ascending: false })
      .limit(1);
    if (Array.isArray(rows) && rows[0]?.id) return rows[0].id;
  }

  if (email) {
    const { data: byEmailRows } = await supabase
      .from('buyers')
      .select('id')
      .ilike('email', email)
      .order('created_at', { ascending: false })
      .limit(1);
    if (Array.isArray(byEmailRows) && byEmailRows[0]?.id) return byEmailRows[0].id;
  }

  return null;
};

// GET /api/notifications — alias for /list (default consumer path)
router.get('/', requireAuth(), async (req, res) => {
  try {
    const requestedLimit = Number(req.query?.limit || 100);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(200, Math.floor(requestedLimit))
      : 100;

    const userIds = await resolveCurrentUserIds(req.user);
    if (!userIds.length) return res.json({ success: true, notifications: [] });

    let query = supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (userIds.length === 1) {
      query = query.eq('user_id', userIds[0]);
    } else {
      query = query.in('user_id', userIds);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, notifications: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load notifications' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireAuth(), async (req, res) => {
  try {
    const userIds = await resolveCurrentUserIds(req.user);
    if (!userIds.length) return res.json({ success: true, count: 0 });

    let query = supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('is_read', false);

    if (userIds.length === 1) {
      query = query.eq('user_id', userIds[0]);
    } else {
      query = query.in('user_id', userIds);
    }

    const { count, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, count: count || 0 });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to get unread count' });
  }
});

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', requireAuth(), async (req, res) => {
  try {
    const userIds = await resolveCurrentUserIds(req.user);
    if (!userIds.length) return res.json({ success: true });

    let query = supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('is_read', false);

    if (userIds.length === 1) {
      query = query.eq('user_id', userIds[0]);
    } else {
      query = query.in('user_id', userIds);
    }

    const { error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to mark all as read' });
  }
});

// PATCH /api/notifications/:id/read — mark single notification as read
router.patch('/:id/read', requireAuth(), async (req, res) => {
  try {
    const notifId = String(req.params?.id || '').trim();
    if (!notifId) return res.status(400).json({ success: false, error: 'Notification ID required' });

    const userIds = await resolveCurrentUserIds(req.user);
    if (!userIds.length) return res.status(403).json({ success: false, error: 'Forbidden' });

    let query = supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notifId);

    if (userIds.length === 1) {
      query = query.eq('user_id', userIds[0]);
    } else {
      query = query.in('user_id', userIds);
    }

    const { error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to mark as read' });
  }
});

// DELETE /api/notifications/:id — delete single notification
router.delete('/:id', requireAuth(), async (req, res) => {
  try {
    const notifId = String(req.params?.id || '').trim();
    if (!notifId) return res.status(400).json({ success: false, error: 'Notification ID required' });

    const userIds = await resolveCurrentUserIds(req.user);
    if (!userIds.length) return res.status(403).json({ success: false, error: 'Forbidden' });

    let query = supabase
      .from('notifications')
      .delete()
      .eq('id', notifId);

    if (userIds.length === 1) {
      query = query.eq('user_id', userIds[0]);
    } else {
      query = query.in('user_id', userIds);
    }

    const { error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to delete notification' });
  }
});

router.get('/list', requireAuth(), async (req, res) => {
  try {
    const requestedLimit = Number(req.query?.limit || 100);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(200, Math.floor(requestedLimit))
      : 100;

    const userIds = await resolveCurrentUserIds(req.user);
    if (!userIds.length) {
      return res.json({ success: true, notifications: [] });
    }

    let query = supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (userIds.length === 1) {
      query = query.eq('user_id', userIds[0]);
    } else {
      query = query.in('user_id', userIds);
    }

    const { data: systemRows, error: systemError } = await query;
    if (systemError) {
      return res.status(500).json({ success: false, error: systemError.message || 'Failed to load notifications' });
    }

    let merged = Array.isArray(systemRows) ? [...systemRows] : [];
    const buyerId = await resolveBuyerIdForUser(req.user, userIds);

    if (buyerId) {
      const { data: buyerRows, error: buyerError } = await supabase
        .from('buyer_notifications')
        .select('*')
        .eq('buyer_id', buyerId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (buyerError) {
        return res.status(500).json({ success: false, error: buyerError.message || 'Failed to load buyer notifications' });
      }

      merged = [...merged, ...(buyerRows || []).map(mapBuyerNotificationRow)];
    }

    merged.sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
    return res.json({ success: true, notifications: merged });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load notifications' });
  }
});

router.patch('/read', requireAuth(), async (req, res) => {
  try {
    const normalizedIds = resolveRequestIds(req);
    if (normalizedIds.length === 0) {
      return res.json({ success: true });
    }

    const userIds = await resolveCurrentUserIds(req.user);
    const buyerId = await resolveBuyerIdForUser(req.user, userIds);

    const buyerIds = normalizedIds
      .filter((id) => isBuyerNotifId(id))
      .map((id) => fromBuyerNotifId(id));

    const normalIds = normalizedIds.filter((id) => !isBuyerNotifId(id));

    if (normalIds.length > 0) {
      let query = supabase
        .from('notifications')
        .update({ is_read: true })
        .in('id', normalIds);

      if (userIds.length === 1) {
        query = query.eq('user_id', userIds[0]);
      } else if (userIds.length > 1) {
        query = query.in('user_id', userIds);
      }

      const { error } = await query;
      if (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to mark notifications as read' });
      }
    }

    if (buyerIds.length > 0 && buyerId) {
      const { error } = await supabase
        .from('buyer_notifications')
        .update({ is_read: true })
        .eq('buyer_id', buyerId)
        .in('id', buyerIds);

      if (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to mark buyer notifications as read' });
      }
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to mark notifications as read' });
  }
});

router.delete('/', requireAuth(), async (req, res) => {
  try {
    const normalizedIds = resolveRequestIds(req);
    if (normalizedIds.length === 0) {
      return res.json({ success: true });
    }

    const userIds = await resolveCurrentUserIds(req.user);
    const buyerId = await resolveBuyerIdForUser(req.user, userIds);

    const buyerIds = normalizedIds
      .filter((id) => isBuyerNotifId(id))
      .map((id) => fromBuyerNotifId(id));

    const normalIds = normalizedIds.filter((id) => !isBuyerNotifId(id));

    if (normalIds.length > 0) {
      let query = supabase
        .from('notifications')
        .delete()
        .in('id', normalIds);

      if (userIds.length === 1) {
        query = query.eq('user_id', userIds[0]);
      } else if (userIds.length > 1) {
        query = query.in('user_id', userIds);
      }

      const { error } = await query;
      if (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to delete notifications' });
      }
    }

    if (buyerIds.length > 0 && buyerId) {
      const { error } = await supabase
        .from('buyer_notifications')
        .delete()
        .eq('buyer_id', buyerId)
        .in('id', buyerIds);

      if (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to delete buyer notifications' });
      }
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to delete notifications' });
  }
});

export default router;
