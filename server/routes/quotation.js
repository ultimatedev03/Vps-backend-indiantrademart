import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { sendEmail } from '../lib/emailService.js';
import { notifyUser } from '../lib/notify.js';

const router = express.Router();

const _cacheReceived = new Map();
const _nowMs = () => Date.now();
const _getCached = (m, k) => {
  const e = m.get(k);
  return e && e.exp > _nowMs() ? e.val : null;
};
const _setCached = (m, k, v, ttl) => {
  m.set(k, { val: v, exp: _nowMs() + ttl });
};

/**
 * Middleware to check basic request validation
 */
const validateQuotationRequest = (req, res, next) => {
  // Ensure required fields are present
  const { buyer_email, vendor_id, quotation_title } = req.body || {};
  
  if (!buyer_email || !vendor_id || !quotation_title) {
    return res.status(400).json({ error: 'Missing required fields: buyer_email, vendor_id, quotation_title' });
  }
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(buyer_email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  
  // Validate vendor_id is UUID or numeric
  if (!/^[a-f0-9-]{36}$|^\d+$/.test(vendor_id.toString())) {
    return res.status(400).json({ error: 'Invalid vendor_id format' });
  }
  
  next();
};

const insertNotification = async (payload) => {
  const safeUserId = String(payload?.user_id || '').trim();
  const safeEmail = normalizeEmail(payload?.user_email || payload?.email || '');
  if (!safeUserId && !safeEmail) return null;

  // Prefer direct insert first (keeps extended columns like reference_id when schema allows).
  if (safeUserId) {
    let { error } = await supabase
      .from('notifications')
      .insert([{ ...payload, user_id: safeUserId }]);

    if (error && String(error?.message || '').toLowerCase().includes('reference_id')) {
      const fallbackPayload = { ...payload, user_id: safeUserId };
      delete fallbackPayload.reference_id;
      ({ error } = await supabase.from('notifications').insert([fallbackPayload]));
    }

    if (!error) return true;
  }

  // Fallback to robust resolver (auth/public user id reconciliation + upsert).
  const created = await notifyUser({
    user_id: safeUserId || null,
    email: safeEmail || null,
    type: payload?.type,
    title: payload?.title,
    message: payload?.message,
    link: payload?.link,
  });

  if (!created) {
    throw new Error('Failed to insert notification');
  }

  return true;
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

async function resolveVendorForUser(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = normalizeEmail(user?.email || '');

  if (userId) {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (!error && data) return data;
  }

  if (email) {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('email', email)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
  }

  return null;
}

async function resolveBuyerForUser(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = normalizeEmail(user?.email || '');

  if (userId) {
    const { data, error } = await supabase
      .from('buyers')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (!error && data) return data;
  }

  if (email) {
    const { data, error } = await supabase
      .from('buyers')
      .select('*')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
  }

  return null;
}

const enrichBuyers = async (rows = []) => {
  const buyerIds = Array.from(
    new Set(
      (rows || [])
        .map((row) => String(row?.buyer_id || '').trim())
        .filter(Boolean)
    )
  );

  if (!buyerIds.length) return rows || [];

  const { data: buyers, error } = await supabase
    .from('buyers')
    .select('id, full_name, company_name, email, phone, avatar_url, is_active')
    .in('id', buyerIds);

  if (error || !Array.isArray(buyers)) return rows || [];

  const buyerMap = new Map(
    buyers.map((buyer) => [
      String(buyer.id),
      {
        full_name: buyer?.full_name || buyer?.company_name || null,
        company_name: buyer?.company_name || null,
        email: buyer?.email || null,
        phone: buyer?.phone || null,
        avatar_url: buyer?.avatar_url || null,
        is_active: typeof buyer?.is_active === 'boolean' ? buyer.is_active : null,
      },
    ])
  );

  return (rows || []).map((row) => ({
    ...row,
    buyers: buyerMap.get(String(row?.buyer_id || '').trim()) || null,
  }));
};

const enrichVendors = async (rows = []) => {
  const vendorIds = Array.from(
    new Set(
      (rows || [])
        .map((row) => String(row?.vendor_id || '').trim())
        .filter(Boolean)
    )
  );

  if (!vendorIds.length) return rows || [];

  const { data: vendors, error } = await supabase
    .from('vendors')
    .select('id, company_name, owner_name, phone, email, profile_image, is_verified, verification_badge, kyc_status, is_active')
    .in('id', vendorIds);

  if (error || !Array.isArray(vendors)) return rows || [];

  const vendorMap = new Map(vendors.map((vendor) => [String(vendor.id), vendor]));

  return (rows || []).map((row) => ({
    ...row,
    vendors: vendorMap.get(String(row?.vendor_id || '').trim()) || null,
  }));
};

const sanitizeMessageText = (value) =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();

const toNotificationSnippet = (value, maxLength = 160) => {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 1))}...`;
};

const MESSAGE_MARKERS = {
  edited: /^::itm_edited::$/i,
  deliveredBuyer: /^::itm_delivered_buyer::(.+)$/i,
  deliveredVendor: /^::itm_delivered_vendor::(.+)$/i,
  readBuyer: /^::itm_read_buyer::(.+)$/i,
  readVendor: /^::itm_read_vendor::(.+)$/i,
};

const parseStoredMessage = (rawValue) => {
  const lines = String(rawValue || '').replace(/\r\n/g, '\n').split('\n');
  const contentLines = [];
  const meta = {
    edited: false,
    delivered_buyer_at: null,
    delivered_vendor_at: null,
    read_buyer_at: null,
    read_vendor_at: null,
  };

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      contentLines.push(line);
      continue;
    }

    if (MESSAGE_MARKERS.edited.test(trimmed)) {
      meta.edited = true;
      continue;
    }

    const deliveredBuyerMatch = trimmed.match(MESSAGE_MARKERS.deliveredBuyer);
    if (deliveredBuyerMatch) {
      meta.delivered_buyer_at = String(deliveredBuyerMatch[1] || '').trim() || null;
      continue;
    }

    const deliveredVendorMatch = trimmed.match(MESSAGE_MARKERS.deliveredVendor);
    if (deliveredVendorMatch) {
      meta.delivered_vendor_at = String(deliveredVendorMatch[1] || '').trim() || null;
      continue;
    }

    const readBuyerMatch = trimmed.match(MESSAGE_MARKERS.readBuyer);
    if (readBuyerMatch) {
      meta.read_buyer_at = String(readBuyerMatch[1] || '').trim() || null;
      continue;
    }

    const readVendorMatch = trimmed.match(MESSAGE_MARKERS.readVendor);
    if (readVendorMatch) {
      meta.read_vendor_at = String(readVendorMatch[1] || '').trim() || null;
      continue;
    }

    contentLines.push(line);
  }

  return {
    text: contentLines.join('\n').trimEnd(),
    meta,
  };
};

const composeStoredMessage = (textValue, meta = {}) => {
  const cleanText = sanitizeMessageText(textValue);
  if (!cleanText) return '';

  const lines = [cleanText];
  if (meta?.edited) lines.push('::itm_edited::');
  if (meta?.delivered_buyer_at) lines.push(`::itm_delivered_buyer::${meta.delivered_buyer_at}`);
  if (meta?.delivered_vendor_at) lines.push(`::itm_delivered_vendor::${meta.delivered_vendor_at}`);
  if (meta?.read_buyer_at) lines.push(`::itm_read_buyer::${meta.read_buyer_at}`);
  if (meta?.read_vendor_at) lines.push(`::itm_read_vendor::${meta.read_vendor_at}`);
  return lines.join('\n');
};

const resolveActorMessagingRole = (access = {}, user = {}) => {
  if (access?.isVendorParticipant && !access?.isBuyerParticipant) return 'vendor';
  if (access?.isBuyerParticipant && !access?.isVendorParticipant) return 'buyer';

  const role = String(user?.role || '').trim().toUpperCase();
  if (role === 'VENDOR') return 'vendor';
  return 'buyer';
};

const getRoleMarkerKeys = (role = 'buyer') =>
  role === 'vendor'
    ? { deliveredKey: 'delivered_vendor_at', readKey: 'read_vendor_at' }
    : { deliveredKey: 'delivered_buyer_at', readKey: 'read_buyer_at' };

const buildStoredMessageText = (value, existingMeta = {}, { edited = false } = {}) => {
  const parsed = parseStoredMessage(value);
  const mergedMeta = {
    edited: edited || Boolean(existingMeta?.edited),
    delivered_buyer_at: existingMeta?.delivered_buyer_at || parsed.meta.delivered_buyer_at || null,
    delivered_vendor_at: existingMeta?.delivered_vendor_at || parsed.meta.delivered_vendor_at || null,
    read_buyer_at: existingMeta?.read_buyer_at || parsed.meta.read_buyer_at || null,
    read_vendor_at: existingMeta?.read_vendor_at || parsed.meta.read_vendor_at || null,
  };
  return composeStoredMessage(parsed.text, mergedMeta);
};

const normalizeMessageRow = (row = {}, actorPublicUserId = null, actorRole = 'buyer') => {
  const parsed = parseStoredMessage(row?.message);
  const isMe =
    !!actorPublicUserId &&
    String(row?.sender_id || '').trim() === String(actorPublicUserId).trim();

  const recipientRole = actorRole === 'buyer' ? 'vendor' : 'buyer';
  const { deliveredKey, readKey } = getRoleMarkerKeys(recipientRole);
  const deliveredAt = parsed.meta?.[deliveredKey] || null;
  const readAt = parsed.meta?.[readKey] || null;

  let deliveryState = 'sent';
  if (readAt) deliveryState = 'read';
  else if (deliveredAt) deliveryState = 'delivered';

  return {
    ...row,
    message: parsed.text,
    is_edited: Boolean(parsed.meta.edited),
    is_me: isMe,
    delivered_at: deliveredAt,
    read_at: readAt,
    delivery_state: isMe ? deliveryState : 'received',
  };
};

async function applyMessageAcks(rows = [], actorRole = 'buyer', actorPublicUserId = null, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length || !actorPublicUserId) return list;

  const markDelivered = options?.markDelivered !== false;
  const markRead = options?.markRead === true;
  const { deliveredKey, readKey } = getRoleMarkerKeys(actorRole);
  const nowIso = new Date().toISOString();

  const output = [];

  for (const row of list) {
    if (!row?.id) {
      output.push(row);
      continue;
    }

    if (String(row?.sender_id || '').trim() === String(actorPublicUserId).trim()) {
      output.push(row);
      continue;
    }

    const parsed = parseStoredMessage(row?.message);
    const nextMeta = { ...parsed.meta };
    let changed = false;

    if (markDelivered && !nextMeta[deliveredKey]) {
      nextMeta[deliveredKey] = nowIso;
      changed = true;
    }
    if (markRead && !nextMeta[readKey]) {
      nextMeta[readKey] = nowIso;
      changed = true;
    }

    if (!changed) {
      output.push(row);
      continue;
    }

    const storedMessage = composeStoredMessage(parsed.text, nextMeta);

    const { data: updatedRow, error } = await supabase
      .from('proposal_messages')
      .update({ message: storedMessage })
      .eq('id', row.id)
      .select('*')
      .maybeSingle();

    if (error || !updatedRow) {
      output.push(row);
      continue;
    }

    output.push(updatedRow);
  }

  return output;
}

async function resolvePublicUserIdForActor(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = normalizeEmail(user?.email || '');

  if (userId) {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .maybeSingle();
    if (!error && data?.id) return String(data.id);
  }

  if (email) {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data?.id) return String(data.id);
  }

  return null;
}

async function resolveProposalForMessaging(proposalId) {
  if (!proposalId) return null;

  const { data, error } = await supabase
    .from('proposals')
    .select('id, vendor_id, buyer_id, buyer_email, title, product_name')
    .eq('id', proposalId)
    .maybeSingle();

  if (error) throw new Error(error.message || 'Failed to load proposal');
  return data || null;
}

async function resolveProposalParticipantUserIds(proposal = {}) {
  const participantIds = {
    buyer_user_id: null,
    buyer_email: null,
    vendor_user_id: null,
    vendor_email: null,
  };

  const buyerId = String(proposal?.buyer_id || '').trim();
  const vendorId = String(proposal?.vendor_id || '').trim();
  const buyerEmail = normalizeEmail(proposal?.buyer_email || '');

  if (buyerId) {
    const { data: buyerRow } = await supabase
      .from('buyers')
      .select('user_id, email')
      .eq('id', buyerId)
      .maybeSingle();
    participantIds.buyer_user_id = String(buyerRow?.user_id || '').trim() || null;
    participantIds.buyer_email = normalizeEmail(buyerRow?.email || buyerEmail || '');
  }

  if (!participantIds.buyer_user_id && buyerEmail) {
    const { data: buyerByEmail } = await supabase
      .from('buyers')
      .select('user_id')
      .eq('email', buyerEmail)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    participantIds.buyer_user_id = String(buyerByEmail?.user_id || '').trim() || null;
    if (!participantIds.buyer_email) {
      participantIds.buyer_email = normalizeEmail(buyerEmail);
    }
  }

  if (!participantIds.buyer_user_id && buyerEmail) {
    const { data: buyerUserByEmail } = await supabase
      .from('users')
      .select('id')
      .eq('email', buyerEmail)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    participantIds.buyer_user_id = String(buyerUserByEmail?.id || '').trim() || null;
    if (!participantIds.buyer_email) {
      participantIds.buyer_email = normalizeEmail(buyerEmail);
    }
  }

  if (vendorId) {
    const { data: vendorRow } = await supabase
      .from('vendors')
      .select('user_id, email')
      .eq('id', vendorId)
      .maybeSingle();
    participantIds.vendor_user_id = String(vendorRow?.user_id || '').trim() || null;
    participantIds.vendor_email = normalizeEmail(vendorRow?.email || '');

    const vendorEmail = normalizeEmail(vendorRow?.email || '');
    if (!participantIds.vendor_user_id && vendorEmail) {
      const { data: vendorUserByEmail } = await supabase
        .from('users')
        .select('id')
        .eq('email', vendorEmail)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      participantIds.vendor_user_id = String(vendorUserByEmail?.id || '').trim() || null;
      if (!participantIds.vendor_email) {
        participantIds.vendor_email = vendorEmail;
      }
    }
  }

  if (!participantIds.buyer_email && buyerEmail) {
    participantIds.buyer_email = normalizeEmail(buyerEmail);
  }

  return participantIds;
}

const DEFAULT_CHAT_BLOCK_STATUS = Object.freeze({
  blocked_by_me: false,
  blocked_me: false,
  can_message: true,
  counterpart_user_id: null,
});
let hasWarnedMissingChatBlocks = false;

const warnMissingChatBlocksOnce = () => {
  if (hasWarnedMissingChatBlocks) return;
  hasWarnedMissingChatBlocks = true;
  logger.warn('chat_blocks relation missing while reading block status (run migration: 20260224_chat_blocks_safe.sql)');
};

const isMissingChatBlocksRelation = (error) => {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  const hint = String(error?.hint || '').toLowerCase();
  const payload = `${message} ${details} ${hint}`.trim();

  if (code === '42P01' || code === 'PGRST204' || code === 'PGRST205') return true;
  if (!payload.includes('chat_blocks')) return false;
  return (
    payload.includes('does not exist') ||
    payload.includes('schema cache') ||
    payload.includes('could not find the table')
  );
};

const resolveCounterpartUserIdForProposal = (participants = {}, actorPublicUserId = '') => {
  const actorUserId = String(actorPublicUserId || '').trim();
  if (!actorUserId) return null;

  const buyerUserId = String(participants?.buyer_user_id || '').trim();
  const vendorUserId = String(participants?.vendor_user_id || '').trim();

  if (buyerUserId && buyerUserId !== actorUserId) return buyerUserId;
  if (vendorUserId && vendorUserId !== actorUserId) return vendorUserId;
  return null;
};

async function resolveChatBlockStatusForProposal(proposal = {}, actorPublicUserId = '') {
  const actorUserId = String(actorPublicUserId || '').trim();
  if (!actorUserId) {
    return { ...DEFAULT_CHAT_BLOCK_STATUS };
  }

  const participants = await resolveProposalParticipantUserIds(proposal);
  const counterpartUserId = resolveCounterpartUserIdForProposal(participants, actorUserId);
  if (!counterpartUserId) {
    return { ...DEFAULT_CHAT_BLOCK_STATUS };
  }

  const filter = `and(blocker_user_id.eq.${actorUserId},blocked_user_id.eq.${counterpartUserId}),and(blocker_user_id.eq.${counterpartUserId},blocked_user_id.eq.${actorUserId})`;
  const { data, error } = await supabase
    .from('chat_blocks')
    .select('blocker_user_id, blocked_user_id')
    .or(filter);

  if (error) {
    if (isMissingChatBlocksRelation(error)) {
      warnMissingChatBlocksOnce();
      return {
        ...DEFAULT_CHAT_BLOCK_STATUS,
        counterpart_user_id: counterpartUserId,
      };
    }
    throw new Error(error.message || 'Failed to load chat block status');
  }

  const rows = Array.isArray(data) ? data : [];
  const blockedByMe = rows.some(
    (row) =>
      String(row?.blocker_user_id || '').trim() === actorUserId &&
      String(row?.blocked_user_id || '').trim() === counterpartUserId
  );
  const blockedMe = rows.some(
    (row) =>
      String(row?.blocker_user_id || '').trim() === counterpartUserId &&
      String(row?.blocked_user_id || '').trim() === actorUserId
  );

  return {
    blocked_by_me: blockedByMe,
    blocked_me: blockedMe,
    can_message: !(blockedByMe || blockedMe),
    counterpart_user_id: counterpartUserId,
  };
}

async function applyChatBlockActionForProposal({ proposal = {}, actorPublicUserId = '', action = 'block' } = {}) {
  const actorUserId = String(actorPublicUserId || '').trim();
  if (!actorUserId) {
    throw new Error('User profile not found for messaging');
  }

  const participants = await resolveProposalParticipantUserIds(proposal);
  const counterpartUserId = resolveCounterpartUserIdForProposal(participants, actorUserId);
  if (!counterpartUserId) {
    throw new Error('Counterpart user not found for this chat');
  }

  const safeAction = String(action || '').trim().toLowerCase();

  if (safeAction === 'block') {
    const { error } = await supabase
      .from('chat_blocks')
      .upsert(
        [
          {
            blocker_user_id: actorUserId,
            blocked_user_id: counterpartUserId,
          },
        ],
        { onConflict: 'blocker_user_id,blocked_user_id', ignoreDuplicates: true }
      );

    if (error) {
      if (isMissingChatBlocksRelation(error)) {
        throw new Error('Chat block feature is unavailable. Please run the latest migration.');
      }
      throw new Error(error.message || 'Failed to block user');
    }
  } else if (safeAction === 'unblock') {
    const { error } = await supabase
      .from('chat_blocks')
      .delete()
      .eq('blocker_user_id', actorUserId)
      .eq('blocked_user_id', counterpartUserId);

    if (error) {
      if (isMissingChatBlocksRelation(error)) {
        throw new Error('Chat block feature is unavailable. Please run the latest migration.');
      }
      throw new Error(error.message || 'Failed to unblock user');
    }
  } else {
    throw new Error('Invalid block action');
  }

  return resolveChatBlockStatusForProposal(proposal, actorUserId);
}

async function canActorAccessProposalMessages(user = {}, proposal = {}) {
  const [buyer, vendor] = await Promise.all([
    resolveBuyerForUser(user),
    resolveVendorForUser(user),
  ]);

  const actorEmail = normalizeEmail(user?.email || '');
  const buyerEmail = normalizeEmail(proposal?.buyer_email || '');
  const proposalBuyerId = String(proposal?.buyer_id || '').trim();
  const proposalVendorId = String(proposal?.vendor_id || '').trim();

  const isVendorParticipant = Boolean(
    vendor?.id && String(vendor.id).trim() === proposalVendorId
  );

  const isBuyerParticipant = Boolean(
    (buyer?.id && String(buyer.id).trim() === proposalBuyerId) ||
    (buyerEmail && actorEmail && buyerEmail === actorEmail) ||
    (buyerEmail && normalizeEmail(buyer?.email || '') === buyerEmail)
  );

  return {
    isAllowed: isBuyerParticipant || isVendorParticipant,
    isBuyerParticipant,
    isVendorParticipant,
  };
}

// GET /api/quotation/sent (vendor dashboard list)
router.get('/sent', requireAuth(), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor?.id) {
      return res.status(403).json({ success: false, error: 'Vendor access required' });
    }

    let query = supabase
      .from('proposals')
      .select('*')
      .eq('vendor_id', vendor.id)
      .eq('status', 'SENT')
      .not('buyer_email', 'is', null)
      .neq('buyer_email', '')
      .order('created_at', { ascending: false });

    const requestedLimit = Number(req.query?.limit || 0);
    if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
      query = query.limit(Math.min(requestedLimit, 200));
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch sent quotations' });
    }

    const enriched = await enrichBuyers(data || []);
    return res.json({ success: true, quotations: enriched, total: enriched.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch sent quotations' });
  }
});

// GET /api/quotation/received (buyer dashboard list)
router.get('/received', requireAuth(), async (req, res) => {
  try {
    const buyer = await resolveBuyerForUser(req.user);
    if (!buyer?.id && !normalizeEmail(req.user?.email || '')) {
      return res.status(403).json({ success: false, error: 'Buyer access required' });
    }

    const buyerId = String(buyer?.id || '').trim();
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');

    const page = Math.max(1, Number(req.query?.page || 1));
    const limitReq = Number(req.query?.limit || 20);
    const limit = Math.min(50, Math.max(1, isFinite(limitReq) ? limitReq : 20));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const ck = `qrcv:${buyerId || buyerEmail}:${page}:${limit}`;
    const hit = _getCached(_cacheReceived, ck);
    if (hit) return res.json(hit);

    let query = supabase
      .from('proposals')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (buyerId && buyerEmail) {
      query = query.or(`buyer_id.eq.${buyerId},buyer_email.eq.${buyerEmail}`);
    } else if (buyerId) {
      query = query.eq('buyer_id', buyerId);
    } else if (buyerEmail) {
      query = query.eq('buyer_email', buyerEmail);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message || 'Failed to fetch received quotations' });

    const enriched = await enrichVendors(data || []);
    const payload = { success: true, quotations: enriched, total: enriched.length };
    _setCached(_cacheReceived, ck, payload, 20000);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch received quotations' });
  }
});

// GET /api/quotation/received/:quotationId (buyer quotation detail)
router.get('/received/:quotationId', requireAuth(), async (req, res) => {
  try {
    const quotationId = String(req.params?.quotationId || '').trim();
    if (!quotationId) {
      return res.status(400).json({ success: false, error: 'Invalid quotation id' });
    }

    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim();
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');

    if (!buyerId && !buyerEmail) {
      return res.status(403).json({ success: false, error: 'Buyer access required' });
    }

    const { data: quotation, error } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', quotationId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch quotation detail' });
    }
    if (!quotation) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    const ownerMatch =
      (buyerId && String(quotation?.buyer_id || '').trim() === buyerId) ||
      (buyerEmail && normalizeEmail(quotation?.buyer_email || '') === buyerEmail);

    if (!ownerMatch) {
      return res.status(404).json({ success: false, error: 'Quotation not found' });
    }

    const [enrichedQuotation] = await enrichVendors([quotation]);

    const { data: messages, error: msgError } = await supabase
      .from('proposal_messages')
      .select('*')
      .eq('proposal_id', quotationId)
      .order('created_at', { ascending: true });

    if (msgError) {
      return res.status(500).json({ success: false, error: msgError.message || 'Failed to fetch quotation messages' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    const actorRole = 'buyer';

    return res.json({
      success: true,
      quotation: {
        ...(enrichedQuotation || quotation),
        messages: (messages || []).map((row) => normalizeMessageRow(row, actorPublicUserId, actorRole)),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch quotation detail' });
  }
});

// POST /api/quotation/messages/ack-delivered
router.post('/messages/ack-delivered', requireAuth(), async (req, res) => {
  try {
    const requestedIds = Array.isArray(req.body?.proposal_ids)
      ? req.body.proposal_ids
      : Array.isArray(req.body?.proposalIds)
        ? req.body.proposalIds
        : [];

    const proposalIds = Array.from(
      new Set(
        requestedIds
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 200);

    if (!proposalIds.length) {
      return res.json({ success: true, updated: 0 });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    if (!actorPublicUserId) {
      return res.status(403).json({ success: false, error: 'User profile not found for messaging' });
    }

    let updated = 0;

    for (const proposalId of proposalIds) {
      const proposal = await resolveProposalForMessaging(proposalId);
      if (!proposal) continue;

      const access = await canActorAccessProposalMessages(req.user, proposal);
      if (!access.isAllowed) continue;

      const actorRole = resolveActorMessagingRole(access, req.user);
      const { data, error } = await supabase
        .from('proposal_messages')
        .select('*')
        .eq('proposal_id', proposalId)
        .order('created_at', { ascending: true });

      if (error) continue;

      const ackedRows = await applyMessageAcks(data || [], actorRole, actorPublicUserId, {
        markDelivered: true,
        markRead: false,
      });

      for (let i = 0; i < (data || []).length; i += 1) {
        const before = data[i];
        const after = ackedRows[i];
        if (!before?.id || !after?.id) continue;
        if (String(before.message || '') !== String(after.message || '')) {
          updated += 1;
        }
      }
    }

    return res.json({ success: true, updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to acknowledge delivery' });
  }
});

// GET /api/quotation/unread-count (buyer chat unread messages)
router.get('/unread-count', requireAuth(), async (req, res) => {
  try {
    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    if (!actorPublicUserId) {
      return res.json({ success: true, unread: 0 });
    }

    const buyer = await resolveBuyerForUser(req.user);
    const buyerId = String(buyer?.id || '').trim();
    const buyerEmail = normalizeEmail(buyer?.email || req.user?.email || '');

    if (!buyerId && !buyerEmail) {
      return res.json({ success: true, unread: 0 });
    }

    const proposalIdSet = new Set();

    if (buyerId) {
      const { data: byIdRows } = await supabase
        .from('proposals')
        .select('id')
        .eq('buyer_id', buyerId)
        .order('created_at', { ascending: false })
        .limit(1000);

      (byIdRows || []).forEach((row) => {
        const id = String(row?.id || '').trim();
        if (id) proposalIdSet.add(id);
      });
    }

    if (buyerEmail) {
      const { data: byEmailRows } = await supabase
        .from('proposals')
        .select('id')
        .eq('buyer_email', buyerEmail)
        .order('created_at', { ascending: false })
        .limit(1000);

      (byEmailRows || []).forEach((row) => {
        const id = String(row?.id || '').trim();
        if (id) proposalIdSet.add(id);
      });
    }

    const proposalIds = Array.from(proposalIdSet).slice(0, 1000);
    if (!proposalIds.length) {
      return res.json({ success: true, unread: 0 });
    }

    const { data: messages, error } = await supabase
      .from('proposal_messages')
      .select('id, proposal_id, sender_id, message')
      .in('proposal_id', proposalIds);

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to calculate unread messages' });
    }

    let unread = 0;
    for (const row of messages || []) {
      const senderId = String(row?.sender_id || '').trim();
      if (senderId === String(actorPublicUserId).trim()) continue;
      const parsed = parseStoredMessage(row?.message || '');
      if (!parsed?.meta?.read_buyer_at) unread += 1;
    }

    return res.json({ success: true, unread });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to calculate unread messages' });
  }
});

// GET /api/quotation/:proposalId/messages
router.get('/:proposalId/block-status', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    if (!proposalId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    if (!actorPublicUserId) {
      return res.status(403).json({ success: false, error: 'User profile not found for messaging' });
    }

    const blockStatus = await resolveChatBlockStatusForProposal(proposal, actorPublicUserId);
    return res.json({ success: true, block_status: blockStatus });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load block status' });
  }
});

// POST /api/quotation/:proposalId/block
router.post('/:proposalId/block', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    if (!proposalId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const action = String(req.body?.action || '').trim().toLowerCase();
    if (action !== 'block' && action !== 'unblock') {
      return res.status(400).json({ success: false, error: 'Invalid block action' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    if (!actorPublicUserId) {
      return res.status(403).json({ success: false, error: 'User profile not found for messaging' });
    }

    const blockStatus = await applyChatBlockActionForProposal({
      proposal,
      actorPublicUserId,
      action,
    });

    return res.json({
      success: true,
      action,
      block_status: blockStatus,
    });
  } catch (e) {
    const safeMessage = e?.message || 'Failed to update block status';
    if (String(safeMessage).toLowerCase().includes('chat block feature is unavailable')) {
      return res.status(503).json({
        success: false,
        error: safeMessage,
        code: 'CHAT_BLOCKS_UNAVAILABLE',
      });
    }
    return res.status(500).json({ success: false, error: e.message || 'Failed to update block status' });
  }
});

// GET /api/quotation/:proposalId/messages
router.get('/:proposalId/messages', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    if (!proposalId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    const actorRole = resolveActorMessagingRole(access, req.user);

    const { data, error } = await supabase
      .from('proposal_messages')
      .select('*')
      .eq('proposal_id', proposalId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to load messages' });
    }

    const ackedRows = await applyMessageAcks(data || [], actorRole, actorPublicUserId, {
      markDelivered: true,
      markRead: true,
    });
    const participants = await resolveProposalParticipantUserIds(proposal);
    const blockStatus = await resolveChatBlockStatusForProposal(proposal, actorPublicUserId);

    const normalizedMessages = (ackedRows || []).map((row) =>
      normalizeMessageRow(row, actorPublicUserId, actorRole)
    );

    return res.json({
      success: true,
      proposal: {
        id: proposal.id,
        title: proposal.title,
        product_name: proposal.product_name,
      },
      actor_user_id: actorPublicUserId,
      participants,
      messages: normalizedMessages,
      block_status: blockStatus,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load messages' });
  }
});

// POST /api/quotation/:proposalId/messages
router.post('/:proposalId/messages', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    if (!proposalId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const messageText = sanitizeMessageText(req.body?.message);
    if (!messageText) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    if (messageText.length > 4000) {
      return res.status(400).json({ success: false, error: 'Message is too long' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    const actorRole = resolveActorMessagingRole(access, req.user);
    if (!actorPublicUserId) {
      return res.status(403).json({ success: false, error: 'User profile not found for messaging' });
    }

    const blockStatus = await resolveChatBlockStatusForProposal(proposal, actorPublicUserId);
    if (!blockStatus.can_message) {
      return res.status(403).json({
        success: false,
        error: blockStatus.blocked_by_me
          ? 'You blocked this user. Unblock to send messages.'
          : 'You cannot message this user because they blocked you.',
        code: 'CHAT_BLOCKED',
        block_status: blockStatus,
      });
    }

    const storedMessage = buildStoredMessageText(messageText, {}, { edited: false });
    if (!storedMessage) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const { data, error } = await supabase
      .from('proposal_messages')
      .insert([
        {
          proposal_id: proposalId,
          sender_id: actorPublicUserId,
          message: storedMessage,
          created_at: new Date().toISOString(),
        },
      ])
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to send message' });
    }

    try {
      const participants = await resolveProposalParticipantUserIds(proposal);
      const receiverUserId =
        actorRole === 'buyer' ? participants?.vendor_user_id : participants?.buyer_user_id;
      const receiverEmail =
        actorRole === 'buyer' ? participants?.vendor_email : participants?.buyer_email;
      const receiverLink =
        actorRole === 'buyer'
          ? `/vendor/messages?proposal=${proposalId}`
          : `/buyer/messages?proposal=${proposalId}`;
      const senderLabel = actorRole === 'buyer' ? 'buyer' : 'vendor';
      const contextLabel = String(proposal?.product_name || proposal?.title || '').trim();
      const preview = toNotificationSnippet(messageText);

      if (receiverUserId || receiverEmail) {
        await insertNotification({
          user_id: receiverUserId,
          user_email: receiverEmail || null,
          type: 'PROPOSAL_MESSAGE',
          title: `New message from ${senderLabel}`,
          message: preview || (contextLabel ? `New message on ${contextLabel}` : 'You received a new message.'),
          link: receiverLink,
          reference_id: proposalId,
          is_read: false,
          created_at: new Date().toISOString(),
        });
      }

      if (actorRole === 'vendor') {
        const buyerId = String(proposal?.buyer_id || '').trim();
        if (buyerId) {
          await supabase.from('buyer_notifications').insert([
            {
              buyer_id: buyerId,
              type: 'PROPOSAL_MESSAGE',
              title: 'New message from vendor',
              message: preview || (contextLabel ? `New update on ${contextLabel}` : 'You received a new message.'),
              reference_id: proposalId,
              reference_type: 'proposal',
              is_read: false,
              created_at: new Date().toISOString(),
            },
          ]);
        }
      }
    } catch (notificationError) {
      logger.warn('Proposal message notification failed:', notificationError);
    }

    return res.status(201).json({
      success: true,
      message: normalizeMessageRow(data || {}, actorPublicUserId, actorRole),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to send message' });
  }
});

// PATCH /api/quotation/:proposalId/messages/:messageId
router.patch('/:proposalId/messages/:messageId', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    const messageId = String(req.params?.messageId || '').trim();

    if (!proposalId || !messageId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal or message id' });
    }

    const messageText = sanitizeMessageText(req.body?.message);
    if (!messageText) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    if (messageText.length > 4000) {
      return res.status(400).json({ success: false, error: 'Message is too long' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    const actorRole = resolveActorMessagingRole(access, req.user);
    if (!actorPublicUserId) {
      return res.status(403).json({ success: false, error: 'User profile not found for messaging' });
    }

    const { data: existingRow, error: existingError } = await supabase
      .from('proposal_messages')
      .select('*')
      .eq('id', messageId)
      .eq('proposal_id', proposalId)
      .eq('sender_id', actorPublicUserId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ success: false, error: existingError.message || 'Failed to load message' });
    }
    if (!existingRow) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const existingParsed = parseStoredMessage(existingRow?.message);
    const storedMessage = buildStoredMessageText(messageText, existingParsed.meta, { edited: true });
    if (!storedMessage) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const { data, error } = await supabase
      .from('proposal_messages')
      .update({ message: storedMessage })
      .eq('id', existingRow.id)
      .select('*')
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to edit message' });
    }
    if (!data) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    return res.json({
      success: true,
      message: normalizeMessageRow(data, actorPublicUserId, actorRole),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to edit message' });
  }
});

// DELETE /api/quotation/:proposalId/messages
router.delete('/:proposalId/messages', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    if (!proposalId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const { data, error } = await supabase
      .from('proposal_messages')
      .delete()
      .eq('proposal_id', proposalId)
      .select('id');

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to delete chat' });
    }

    return res.json({
      success: true,
      deletedCount: Array.isArray(data) ? data.length : 0,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to delete chat' });
  }
});

// DELETE /api/quotation/:proposalId/messages/:messageId
router.delete('/:proposalId/messages/:messageId', requireAuth(), async (req, res) => {
  try {
    const proposalId = String(req.params?.proposalId || '').trim();
    const messageId = String(req.params?.messageId || '').trim();

    if (!proposalId || !messageId) {
      return res.status(400).json({ success: false, error: 'Invalid proposal or message id' });
    }

    const proposal = await resolveProposalForMessaging(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const access = await canActorAccessProposalMessages(req.user, proposal);
    if (!access.isAllowed) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const actorPublicUserId = await resolvePublicUserIdForActor(req.user);
    if (!actorPublicUserId) {
      return res.status(403).json({ success: false, error: 'User profile not found for messaging' });
    }

    const { data, error } = await supabase
      .from('proposal_messages')
      .delete()
      .eq('id', messageId)
      .eq('proposal_id', proposalId)
      .eq('sender_id', actorPublicUserId)
      .select('id');

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to delete message' });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    return res.json({ success: true, deletedMessageId: messageId });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to delete message' });
  }
});

async function sendQuotationEmail(to, data, isRegistered) {
  const vendor = data.vendor || {};
  const quotation = data.quotation || {};

  // Optional PDF attachment
  let attachments = [];
  try {
    const name = quotation.attachment_name;
    const b64 = quotation.attachment_base64;
    const mime = quotation.attachment_mime;
    if (b64) {
      const safeMime = (mime || 'application/pdf').toLowerCase();
      if (safeMime !== 'application/pdf') {
        throw new Error('Only PDF attachments are supported');
      }
      const buf = Buffer.from(String(b64), 'base64');
      const maxBytes = 2 * 1024 * 1024; // 2MB (matches UI)
      if (buf.length > maxBytes) {
        throw new Error('PDF too large (max 2MB)');
      }
      attachments = [
        {
          filename: name || 'quotation.pdf',
          content: buf,
          contentType: 'application/pdf',
        },
      ];
    }
  } catch (e) {
    // Attachment errors should not break the full flow; send without attachment.
    logger.warn('Attachment skipped:', e?.message || e);
    attachments = [];
  }

  const subject = `Quotation from ${vendor.company_name || vendor.owner_name || 'Vendor'}`;

  const text = `
Quotation Details
-----------------
Title: ${quotation.title || ''}
Amount: ${quotation.quotation_amount || ''}
Quantity: ${quotation.quantity || ''} ${quotation.unit || ''}
Validity Days: ${quotation.validity_days || ''}
Delivery Days: ${quotation.delivery_days || ''}
Terms: ${quotation.terms_conditions || ''}

Vendor
------
Name: ${vendor.owner_name || ''}
Company: ${vendor.company_name || ''}
Phone: ${vendor.phone || ''}
Email: ${vendor.email || ''}

${isRegistered ? 'You can also view this quotation in your dashboard.' : 'Register on IndianTradeMart to view quotations in your dashboard.'}
`;

  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.6;">
    <h2 style="margin:0 0 10px 0;">Quotation from ${vendor.company_name || vendor.owner_name || 'Vendor'}</h2>

    <h3 style="margin:20px 0 8px 0;">Quotation Details</h3>
    <ul>
      <li><b>Title:</b> ${quotation.title || ''}</li>
      <li><b>Amount:</b> ${quotation.quotation_amount || ''}</li>
      <li><b>Quantity:</b> ${quotation.quantity || ''} ${quotation.unit || ''}</li>
      <li><b>Validity Days:</b> ${quotation.validity_days || ''}</li>
      <li><b>Delivery Days:</b> ${quotation.delivery_days || ''}</li>
    </ul>

    <h3 style="margin:20px 0 8px 0;">Terms & Conditions</h3>
    <p>${(quotation.terms_conditions || '').replace(/\n/g, '<br/>')}</p>

    <h3 style="margin:20px 0 8px 0;">Vendor</h3>
    <ul>
      <li><b>Name:</b> ${vendor.owner_name || ''}</li>
      <li><b>Company:</b> ${vendor.company_name || ''}</li>
      <li><b>Phone:</b> ${vendor.phone || ''}</li>
      <li><b>Email:</b> ${vendor.email || ''}</li>
    </ul>

    <p style="margin-top: 18px;">
      ${isRegistered ? 'You can also view this quotation in your dashboard.' : 'Register on IndianTradeMart to view quotations in your dashboard.'}
    </p>
  </div>
  `;

  await sendEmail({
    to,
    subject,
    text,
    html,
    purpose: 'quotation',
    ...(attachments.length ? { attachments } : {}),
  });
}

// POST /api/quotation/send
router.post('/send', validateQuotationRequest, async (req, res) => {
  try {
    const {
      quotation_title,
      quotation_amount,
      quantity,
      unit, // ✅ still accepted (email me use hoga)
      validity_days,
      delivery_days,
      terms_conditions,
      buyer_email,
      vendor_id,
      vendor_name,
      vendor_company,
      vendor_phone,
      vendor_email,

      // ✅ Optional PDF attachment (base64)
      attachment_name,
      attachment_base64,
      attachment_mime,

      // ⚠️ Ignore buyer_id from request (UI was sending lead.id sometimes)
      buyer_id,
    } = req.body || {};

    if (!buyer_email || !vendor_id || !quotation_title) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const buyerEmail = String(buyer_email).toLowerCase().trim();

    // ✅ Make quantity store-friendly (merge unit into quantity; proposals table has no `unit`)
    let qtyValue = quantity ?? null;
    if (qtyValue !== null && qtyValue !== undefined) {
      const qStr = String(qtyValue).trim();
      const uStr = String(unit || '').trim();
      if (uStr && qStr && !qStr.toLowerCase().includes(uStr.toLowerCase())) {
        qtyValue = `${qStr} ${uStr}`; // e.g. "10 kg"
      } else {
        qtyValue = qStr || null;
      }
    }

    // Check if buyer exists (handle duplicate legacy rows safely).
    const { data: buyerRows, error: buyerErr } = await supabase
      .from('buyers')
      .select('id, user_id, full_name, email, created_at')
      .eq('email', buyerEmail)
      .order('created_at', { ascending: false })
      .limit(5);

    if (buyerErr) logger.warn('Buyer lookup warning:', buyerErr);

    const buyerMatches = Array.isArray(buyerRows) ? buyerRows : [];
    const buyerCheck = buyerMatches.find((row) => row?.user_id) || buyerMatches[0] || null;

    let buyerUserId = buyerCheck?.user_id || null;
    if (!buyerUserId) {
      const { data: userRow, error: userErr } = await supabase
        .from('users')
        .select('id')
        .eq('email', buyerEmail)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const userErrMessage = String(userErr?.message || '').toLowerCase();
      if (userErr && !userErrMessage.includes('multiple')) {
        logger.warn('Public user lookup warning:', userErr);
      }
      buyerUserId = userRow?.id || null;
    }

    const isRegistered = Boolean(buyerCheck?.id || buyerUserId);

    // Buyer candidates depending on FK configuration
    const buyerCandidateSet = new Set();
    if (buyerCheck?.id) buyerCandidateSet.add(buyerCheck.id);
    if (buyerCheck?.user_id && buyerCheck.user_id !== buyerCheck.id) buyerCandidateSet.add(buyerCheck.user_id);
    if (buyerUserId && buyerUserId !== buyerCheck?.id) buyerCandidateSet.add(buyerUserId);

    // Optional legacy: if buyer_id provided and exists in buyers, accept it as candidate
    if (buyer_id) {
      const { data: buyerById } = await supabase.from('buyers').select('id').eq('id', buyer_id).maybeSingle();
      if (buyerById?.id) buyerCandidateSet.add(buyerById.id);
    }
    const buyerCandidates = Array.from(buyerCandidateSet);

    const baseQuotationPayload = {
      vendor_id,
      buyer_id: null,
      buyer_email: buyerEmail,
      title: quotation_title,
      product_name: quotation_title,
      quantity: qtyValue, // ✅ contains unit inside
      // ✅ REMOVED: unit (column doesn't exist in proposals)
      budget: quotation_amount ? parseFloat(quotation_amount) : null,
      description: terms_conditions || '',
      status: 'SENT',
    };

    const optionalProposalFields = {
      validity_days: validity_days ? Number(validity_days) || null : null,
      delivery_days: delivery_days ? Number(delivery_days) || null : null,
      attachment_name: attachment_name ? String(attachment_name).trim() || null : null,
      attachment_mime: attachment_mime ? String(attachment_mime).trim() || null : null,
    };
    const optionalProposalFieldNames = Object.keys(optionalProposalFields);

    const extractMissingOptionalField = (error) => {
      const code = String(error?.code || '').trim();
      const message = String(error?.message || '');
      if (code !== '42703' && !/column.+does not exist/i.test(message)) return '';
      const match = message.match(/column\s+"?([a-zA-Z0-9_]+)"?/i);
      const field = String(match?.[1] || '').trim();
      return optionalProposalFieldNames.includes(field) ? field : '';
    };

    const tryInsert = async (buyerIdValue) => {
      const omittedOptionalFields = new Set();

      while (true) {
        const payload = { ...baseQuotationPayload, buyer_id: buyerIdValue ?? null };

        optionalProposalFieldNames.forEach((field) => {
          const value = optionalProposalFields[field];
          if (omittedOptionalFields.has(field)) return;
          if (value === null || value === undefined || value === '') return;
          payload[field] = value;
        });

        const result = await supabase.from('proposals').insert([payload]).select('*').single();
        const missingField = extractMissingOptionalField(result?.error);
        if (missingField && !omittedOptionalFields.has(missingField)) {
          omittedOptionalFields.add(missingField);
          continue;
        }

        return result;
      }
    };

    let savedQuotation = null;
    let lastError = null;

    for (const candidate of buyerCandidates) {
      const { data, error } = await tryInsert(candidate);
      if (!error && data) {
        savedQuotation = data;
        break;
      }
      lastError = error;
      const msg = (error?.message || '').toLowerCase();
      const code = error?.code;
      const retryable = msg.includes('foreign key') || code === '23503' || code === '22P02';
      if (!retryable) break;
    }

    if (!savedQuotation) {
      const { data, error } = await tryInsert(null);
      if (!error && data) savedQuotation = data;
      else lastError = error;
    }

    if (!savedQuotation) {
      logger.error('Database INSERT error:', lastError);
      return res.status(500).json({
        error: lastError?.message || 'Failed to save quotation',
        details: lastError,
      });
    }

    // Email vendor data
    const vendorData = {
      owner_name: vendor_name,
      company_name: vendor_company,
      phone: vendor_phone,
      email: vendor_email,
    };

    // Send email (non-blocking for DB)
    try {
      await sendQuotationEmail(
        buyerEmail,
        {
          vendor: vendorData,
          quotation: {
            title: quotation_title,
            quotation_amount,
            quantity, // email me quantity original
            unit,     // ✅ email me unit show hoga
            validity_days,
            delivery_days,
            terms_conditions,

            // ✅ attachment
            attachment_name,
            attachment_base64,
            attachment_mime,
          },
        },
        isRegistered
      );

      await supabase.from('quotation_emails').insert([
        {
          quotation_id: savedQuotation.id,
          recipient_email: buyerEmail,
          subject: `Quotation from ${vendor_company || vendor_name}`,
          status: 'SENT',
        },
      ]);
    } catch (emailError) {
      logger.error('Email sending error (non-blocking):', emailError);
      try {
        await supabase.from('quotation_emails').insert([
          {
            quotation_id: savedQuotation.id,
            recipient_email: buyerEmail,
            subject: `Quotation from ${vendor_company || vendor_name}`,
            status: 'FAILED',
            error_message: emailError?.message || 'Email failed',
          },
        ]);
      } catch (_) {}
    }

    // Create notification if registered buyer.
    if (isRegistered) {
      try {
        if (buyerCheck?.id) {
          await supabase.from('buyer_notifications').insert([
            {
              buyer_id: buyerCheck.id,
              type: 'QUOTATION_RECEIVED',
              title: `New Quotation from ${vendor_company || vendor_name}`,
              message: `Received quotation: ${quotation_title}`,
              reference_id: savedQuotation.id,
              reference_type: 'quotation',
              is_read: false,
              created_at: new Date().toISOString(),
            },
          ]);
        }

        if (buyerUserId || buyerEmail) {
          await insertNotification({
            user_id: buyerUserId,
            user_email: buyerEmail || null,
            type: 'QUOTATION_RECEIVED',
            title: `New Quotation from ${vendor_company || vendor_name}`,
            message: `You received quotation: ${quotation_title}`,
            link: `/buyer/proposals/${savedQuotation.id}`,
            reference_id: savedQuotation.id,
            is_read: false,
            created_at: new Date().toISOString(),
          });
        }
      } catch (notifError) {
        logger.warn('Notification creation failed:', notifError);
      }
    } else {
      // Track unregistered buyer
      try {
        await supabase.from('quotation_unregistered').insert([
          {
            email: buyerEmail,
            quotation_id: savedQuotation.id,
            vendor_id,
            created_at: new Date().toISOString(),
          },
        ]);
      } catch (trackError) {
        logger.warn('Unregistered tracking failed:', trackError);
      }
    }

    // Also notify vendor bell so sent quotations reflect in dashboard activity.
    try {
      const { data: vendorRow } = await supabase
        .from('vendors')
        .select('user_id, email')
        .eq('id', vendor_id)
        .maybeSingle();

      let vendorUserId = vendorRow?.user_id || null;
      if (!vendorUserId) {
        const vendorEmail = String(vendor_email || vendorRow?.email || '').toLowerCase().trim();
        if (vendorEmail) {
          const { data: vendorUserRow } = await supabase
            .from('users')
            .select('id')
            .eq('email', vendorEmail)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          vendorUserId = vendorUserRow?.id || null;
        }
      }

      if (vendorUserId || vendor_email) {
        await insertNotification({
          user_id: vendorUserId,
          user_email: vendor_email || null,
          type: 'QUOTATION_SENT',
          title: 'Quotation sent',
          message: `Quotation sent to ${buyerEmail}`,
          link: '/vendor/proposals?tab=sent',
          reference_id: savedQuotation.id,
          is_read: false,
          created_at: new Date().toISOString(),
        });
      }
    } catch (vendorNotifError) {
      logger.warn('Vendor quotation notification failed:', vendorNotifError);
    }

    return res.status(200).json({
      success: true,
      message: `Quotation sent successfully to ${buyerEmail}${
        isRegistered ? ' and added to their dashboard' : ' - they will see it after registering'
      }`,
      quotation_id: savedQuotation.id,
      buyer_registered: isRegistered,
    });
  } catch (e) {
    logger.error('Quotation route error:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ✅ GET /api/quotation/admin/quotes — admin view of all quotations/proposals
router.get('/admin/quotes', requireAuth(), async (req, res) => {
  try {
    const { limit = 50, page = 1, status } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('proposals')
      .select('id, title, product_name, status, buyer_email, vendor_id, created_at, budget, quantity')
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status && status !== 'ALL') query = query.eq('status', status.toUpperCase());

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, quotations: data || [], quotes: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
