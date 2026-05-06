import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { notifyUser, notifyRole } from '../lib/notify.js';
import { isEmailTransportConfigured, sendEmail } from '../lib/emailService.js';
import { requireEmployeeRoles } from '../middleware/requireEmployeeRoles.js';

const router = express.Router();

const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const looksLikePdf = (v = '') => String(v || '').toLowerCase().includes('.pdf');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const sendReminderEmail = async ({ to, subject, text, html }) => {
  const safeTo = normalizeEmail(to);
  if (!safeTo) return false;

  try {
    await sendEmail({
      to: safeTo,
      subject,
      text,
      html,
      purpose: 'notification',
    });
    return true;
  } catch (error) {
    logger.warn('[KYC] Reminder email failed:', error?.message || error);
    return false;
  }
};

const getReminderContent = ({ context, vendorName, rejectionReason }) => {
  const isRejected = String(context || '').toLowerCase() === 'rejected';

  const vendorTitle = isRejected ? 'Action Required: KYC Rejected' : 'Reminder: Upload KYC Documents';
  const vendorMessage = isRejected
    ? `Your KYC for "${vendorName}" is rejected. Please upload corrected documents and resubmit.`
    : `Please upload pending KYC documents for "${vendorName}" to complete verification.`;

  const reasonLine = rejectionReason ? `Reason: ${rejectionReason}` : '';

  const buyerTitle = isRejected ? 'Supplier KYC Rejected Update' : 'Supplier KYC Pending Update';
  const buyerMessage = isRejected
    ? `KYC of supplier "${vendorName}" is currently rejected and under review by support team.`
    : `KYC of supplier "${vendorName}" is pending document submission and under review by support team.`;

  return {
    vendorTitle,
    vendorMessage: [vendorMessage, reasonLine].filter(Boolean).join(' '),
    buyerTitle,
    buyerMessage,
  };
};

const resolveBuyerReminderTargets = async (vendorId) => {
  const buyerMap = new Map();
  const addTarget = ({ user_id, email, full_name }) => {
    const safeUserId = String(user_id || '').trim();
    const safeEmail = normalizeEmail(email);
    if (!safeUserId && !safeEmail) return;
    const key = safeUserId || safeEmail;
    if (buyerMap.has(key)) return;
    buyerMap.set(key, {
      user_id: safeUserId || null,
      email: safeEmail || null,
      full_name: full_name || null,
    });
  };

  const { data: proposalRows } = await supabase
    .from('proposals')
    .select('buyer_id, buyer_email, buyer_name')
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false })
    .limit(500);

  const buyerIds = Array.from(
    new Set(
      (proposalRows || [])
        .map((row) => String(row?.buyer_id || '').trim())
        .filter(Boolean)
    )
  );

  const proposalEmails = Array.from(
    new Set(
      (proposalRows || [])
        .map((row) => normalizeEmail(row?.buyer_email))
        .filter(Boolean)
    )
  );

  if (buyerIds.length > 0) {
    const { data: buyersById } = await supabase
      .from('buyers')
      .select('id, user_id, email, full_name, company_name')
      .in('id', buyerIds);

    (buyersById || []).forEach((buyer) =>
      addTarget({
        user_id: buyer?.user_id,
        email: buyer?.email,
        full_name: buyer?.full_name || buyer?.company_name || null,
      })
    );
  }

  if (proposalEmails.length > 0) {
    const { data: buyersByEmail } = await supabase
      .from('buyers')
      .select('id, user_id, email, full_name, company_name')
      .in('email', proposalEmails);

    (buyersByEmail || []).forEach((buyer) =>
      addTarget({
        user_id: buyer?.user_id,
        email: buyer?.email,
        full_name: buyer?.full_name || buyer?.company_name || null,
      })
    );
  }

  (proposalRows || []).forEach((row) =>
    addTarget({
      user_id: null,
      email: row?.buyer_email,
      full_name: row?.buyer_name || null,
    })
  );

  return Array.from(buyerMap.values());
};

function normalizeDocType(type = '') {
  return String(type || '').trim().toLowerCase().replace(/\s+/g, '_') || 'document';
}

function extractSupabasePath(url) {
  if (!isHttpUrl(url)) return null;

  const m =
    url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/i) ||
    url.match(/\/storage\/v1\/object\/sign\/([^/]+)\/(.+?)(\?.*)?$/i) ||
    url.match(/\/storage\/v1\/object\/([^/]+)\/(.+)$/i);

  if (!m) return null;

  const bucket = decodeURIComponent(m[1]);
  const path = decodeURIComponent(m[2]).split('?')[0];
  return { bucket, path };
}

async function toWorkingUrl(value, defaultBucket = 'avatars', expiresSec = 60 * 60) {
  try {
    if (!value) return '';

    if (isHttpUrl(value)) {
      const info = extractSupabasePath(value);
      if (info?.bucket && info?.path) {
        const { data, error } = await supabase.storage.from(info.bucket).createSignedUrl(info.path, expiresSec);
        if (!error && data?.signedUrl) return data.signedUrl;
      }
      return value;
    }

    const path = String(value).replace(/^\/+/, '');
    const { data, error } = await supabase.storage.from(defaultBucket).createSignedUrl(path, expiresSec);
    if (!error && data?.signedUrl) return data.signedUrl;

    return '';
  } catch {
    return '';
  }
}

// GET /api/kyc/vendors?status=ALL|PENDING|SUBMITTED|APPROVED|REJECTED
router.get('/vendors', async (req, res) => {
  try {
    const { status = 'ALL' } = req.query;

    let query = supabase.from('vendors').select('*').order('created_at', { ascending: false });
    if (status && status !== 'ALL') query = query.eq('kyc_status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch vendors', details: error.message });

    return res.json({ success: true, vendors: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to fetch vendors', details: e.message });
  }
});

// POST /api/kyc/vendors/document-counts
router.post(
  '/vendors/document-counts',
  requireEmployeeRoles(['SUPPORT', 'DATA_ENTRY', 'ADMIN', 'SUPERADMIN']),
  async (req, res) => {
    try {
      const rawIds = Array.isArray(req.body?.vendorIds) ? req.body.vendorIds : [];
      const vendorIds = Array.from(
        new Set(
          rawIds
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        )
      );

      if (!vendorIds.length) {
        return res.json({ success: true, counts: {} });
      }

      const counts = {};
      const bumpCount = (vendorId) => {
        const key = String(vendorId || '').trim();
        if (!key) return;
        counts[key] = (counts[key] || 0) + 1;
      };

      const dedupe = new Set();
      const markAndCount = (vendorId, signature) => {
        const key = String(vendorId || '').trim();
        if (!key) return;
        const dedupeKey = `${key}::${String(signature || '').trim()}`;
        if (dedupe.has(dedupeKey)) return;
        dedupe.add(dedupeKey);
        bumpCount(key);
      };

      const { data: vDocs, error: vDocsError } = await supabase
        .from('vendor_documents')
        .select('vendor_id, document_type, document_url, original_name, uploaded_at, created_at')
        .in('vendor_id', vendorIds);
      if (vDocsError) {
        return res.status(500).json({ success: false, error: vDocsError.message || 'Failed to fetch vendor documents' });
      }

      (vDocs || []).forEach((row) => {
        const signature =
          row?.document_url ||
          row?.original_name ||
          `${row?.document_type || ''}:${row?.uploaded_at || row?.created_at || ''}`;
        markAndCount(row?.vendor_id, signature);
      });

      try {
        const { data: legacyDocs, error: legacyError } = await supabase
          .from('kyc_documents')
          .select('vendor_id, document_type, document_url, url, file_path, path, created_at')
          .in('vendor_id', vendorIds);

        if (!legacyError) {
          (legacyDocs || []).forEach((row) => {
            const signature =
              row?.document_url ||
              row?.url ||
              row?.file_path ||
              row?.path ||
              `${row?.document_type || ''}:${row?.created_at || ''}`;
            markAndCount(row?.vendor_id, signature);
          });
        }
      } catch {
        // ignore optional legacy table failures
      }

      vendorIds.forEach((id) => {
        if (!Object.prototype.hasOwnProperty.call(counts, id)) {
          counts[id] = 0;
        }
      });

      return res.json({ success: true, counts });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to calculate document counts' });
    }
  }
);

// GET /api/kyc/vendors/:vendorId/documents
router.get('/vendors/:vendorId/documents', async (req, res) => {
  try {
    const { vendorId } = req.params;

    // ✅ NO kyc_docs column here
    const { data: vendor, error: vErr } = await supabase
      .from('vendors')
      .select('id, company_name, owner_name, email, phone, kyc_status, gst_number, pan_number, created_at, updated_at')
      .eq('id', vendorId)
      .maybeSingle();

    if (vErr) return res.status(500).json({ success: false, error: 'Failed to fetch vendor', details: vErr.message });

    const docs = [];

    // 1) vendor_documents table (your upload is saving here)
    try {
      const { data: vDocs, error } = await supabase
        .from('vendor_documents')
        .select('*')
        .eq('vendor_id', vendorId)
        .order('uploaded_at', { ascending: false });

      if (!error && vDocs?.length) {
        for (const d of vDocs) {
          const raw = d.document_url || d.url || d.file_path || d.path || d.public_url || '';
          const url = await toWorkingUrl(raw, 'avatars');
          if (!url) continue;

          docs.push({
            document_type: normalizeDocType(d.document_type || d.type || 'document'),
            url,
            original: raw,
            status: d.verification_status || d.status || 'PENDING',
            is_pdf: looksLikePdf(url) || looksLikePdf(raw),
            created_at: d.uploaded_at || d.created_at || vendor?.created_at || new Date().toISOString(),
            source: 'vendor_documents',
          });
        }
      }
    } catch {
      // ignore
    }

    // 2) Optional: kyc_documents table (if exists in your DB)
    try {
      const { data: tableDocs, error } = await supabase
        .from('kyc_documents')
        .select('*')
        .eq('vendor_id', vendorId)
        .order('created_at', { ascending: false });

      if (!error && tableDocs?.length) {
        for (const d of tableDocs) {
          const raw = d.url || d.document_url || d.file_path || d.path || d.public_url || '';
          const url = await toWorkingUrl(raw, 'avatars');
          if (!url) continue;

          docs.push({
            document_type: normalizeDocType(d.document_type || d.type || 'document'),
            url,
            original: raw,
            status: d.status || d.verification_status || 'PENDING',
            is_pdf: looksLikePdf(url) || looksLikePdf(raw),
            created_at: d.created_at || vendor?.created_at || new Date().toISOString(),
            source: 'kyc_documents',
          });
        }
      }
    } catch {
      // ignore
    }

    // 3) Storage fallback (even if DB row missing)
    const folders = [`vendor-docs/${vendorId}`, `vendor-kyc/${vendorId}`];
    for (const folder of folders) {
      try {
        const { data: files, error } = await supabase.storage.from('avatars').list(folder, { limit: 100 });
        if (error || !files?.length) continue;

        for (const f of files) {
          if (!f?.name) continue;
          const fullPath = `${folder}/${f.name}`;

          const { data: signed, error: signErr } = await supabase.storage.from('avatars').createSignedUrl(fullPath, 60 * 60);
          if (signErr || !signed?.signedUrl) continue;

          docs.push({
            document_type: normalizeDocType((f.name.split('_')[0] || 'document').trim()),
            url: signed.signedUrl,
            original: fullPath,
            status: 'PENDING',
            is_pdf: looksLikePdf(f.name) || looksLikePdf(signed.signedUrl),
            created_at: f.created_at || vendor?.created_at || new Date().toISOString(),
            source: 'storage:list',
          });
        }
      } catch {
        // ignore
      }
    }

    // dedupe
    const seen = new Set();
    const finalDocs = (docs || []).filter((d) => {
      const key = `${d.document_type}::${d.url}`;
      if (!d.url) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.json({
      success: true,
      vendor: vendor || null,
      documents: finalDocs,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to load documents', details: e.message });
  }
});

router.post('/vendors/:vendorId/approve', async (req, res) => {
  try {
    const { vendorId } = req.params;

    const { data, error } = await supabase
      .from('vendors')
      .update({
        kyc_status: 'APPROVED',
        is_verified: true,
        verification_badge: true,
        verified_at: new Date().toISOString(),
      })
      .eq('id', vendorId)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: 'Approve failed', details: error.message });

    if (data?.user_id) {
      await notifyUser({
        user_id: data.user_id,
        email: data?.email || null,
        type: 'KYC_APPROVED',
        title: 'KYC Approved',
        message: 'Your KYC has been approved. Your account is now verified.',
        link: '/vendor/profile?tab=kyc',
      });
    } else if (data?.email) {
      await notifyUser({
        email: data.email,
        type: 'KYC_APPROVED',
        title: 'KYC Approved',
        message: 'Your KYC has been approved. Your account is now verified.',
        link: '/vendor/profile?tab=kyc',
      });
    }

    await notifyRole('DATA_ENTRY', {
      type: 'KYC_VENDOR_APPROVED',
      title: 'Vendor KYC approved',
      message: `Admin approved KYC for vendor "${data?.company_name || 'Vendor'}".`,
      link: '/employee/dataentry/kyc-review',
    });

    await notifyRole('SUPPORT', {
      type: 'KYC_VENDOR_APPROVED',
      title: 'Vendor KYC approved',
      message: `KYC approved for vendor "${data?.company_name || 'Vendor'}".`,
      link: '/employee/support/kyc-review',
    });
    return res.json({ success: true, vendor: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Approve failed', details: e.message });
  }
});

router.post('/vendors/:vendorId/reject', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { remarks } = req.body || {};

    const { data, error } = await supabase
      .from('vendors')
      .update({
        kyc_status: 'REJECTED',
        is_verified: false,
        verification_badge: false,
        rejection_reason: (remarks || '').trim() || null,
      })
      .eq('id', vendorId)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: 'Reject failed', details: error.message });

    if (data?.user_id) {
      await notifyUser({
        user_id: data.user_id,
        email: data?.email || null,
        type: 'KYC_REJECTED',
        title: 'KYC Rejected',
        message: (remarks || '').trim() || 'Your KYC was rejected. Please re-upload the correct documents.',
        link: '/vendor/profile?tab=kyc',
      });
    } else if (data?.email) {
      await notifyUser({
        email: data.email,
        type: 'KYC_REJECTED',
        title: 'KYC Rejected',
        message: (remarks || '').trim() || 'Your KYC was rejected. Please re-upload the correct documents.',
        link: '/vendor/profile?tab=kyc',
      });
    }

    await notifyRole('DATA_ENTRY', {
      type: 'KYC_VENDOR_REJECTED',
      title: 'Vendor KYC rejected',
      message:
        `Admin rejected KYC for vendor "${data?.company_name || 'Vendor'}"` +
        `${(remarks || '').trim() ? `: ${(remarks || '').trim()}` : '.'}`,
      link: '/employee/dataentry/kyc-review',
    });

    await notifyRole('SUPPORT', {
      type: 'KYC_VENDOR_REJECTED',
      title: 'Vendor KYC rejected',
      message:
        `KYC rejected for vendor "${data?.company_name || 'Vendor'}"` +
        `${(remarks || '').trim() ? `: ${(remarks || '').trim()}` : '.'}`,
      link: '/employee/support/kyc-review',
    });
    return res.json({ success: true, vendor: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Reject failed', details: e.message });
  }
});

router.post(
  '/vendors/:vendorId/reminder',
  requireEmployeeRoles(['SUPPORT', 'DATA_ENTRY', 'ADMIN', 'SUPERADMIN']),
  async (req, res) => {
    try {
      const { vendorId } = req.params;
      const context = String(req.body?.context || 'awaiting_documents').trim().toLowerCase();
      const target = String(req.body?.target || 'vendor').trim().toLowerCase();
      const delivery = String(req.body?.delivery || 'both').trim().toLowerCase();
      const validTargets = new Set(['vendor', 'buyers', 'both']);
      const validDelivery = new Set(['bell', 'email', 'both']);
      if (!validTargets.has(target)) {
        return res.status(400).json({ success: false, error: 'Invalid target. Use vendor, buyers, or both.' });
      }
      if (!validDelivery.has(delivery)) {
        return res.status(400).json({ success: false, error: 'Invalid delivery. Use bell, email, or both.' });
      }
      const sendBell = delivery === 'both' || delivery === 'bell';
      const sendEmail = delivery === 'both' || delivery === 'email';

      const { data: vendor, error: vendorError } = await supabase
        .from('vendors')
        .select('id, user_id, email, company_name, vendor_id, rejection_reason')
        .eq('id', vendorId)
        .maybeSingle();

      if (vendorError) {
        return res.status(500).json({ success: false, error: vendorError.message || 'Failed to load vendor' });
      }
      if (!vendor) {
        return res.status(404).json({ success: false, error: 'Vendor not found' });
      }

      const vendorName = vendor?.company_name || vendor?.vendor_id || 'Vendor';
      const content = getReminderContent({
        context,
        vendorName,
        rejectionReason: vendor?.rejection_reason || '',
      });

      let vendorBellSent = 0;
      let vendorEmailSent = 0;
      let buyersBellSent = 0;
      let buyersEmailSent = 0;
      let buyersMatched = 0;

      if (target === 'vendor' || target === 'both') {
        if (sendBell) {
          const vendorNotif = await notifyUser({
            user_id: vendor?.user_id || null,
            email: vendor?.email || null,
            type: 'KYC_REMINDER_VENDOR',
            title: content.vendorTitle,
            message: content.vendorMessage,
            link: '/vendor/profile?tab=kyc',
          });
          if (vendorNotif) vendorBellSent += 1;
        }

        if (sendEmail) {
          const vendorEmailOk = await sendReminderEmail({
            to: vendor?.email || null,
            subject: content.vendorTitle,
            text: content.vendorMessage,
            html: `<p>${content.vendorMessage}</p>`,
          });
          if (vendorEmailOk) vendorEmailSent += 1;
        }
      }

      if (target === 'buyers' || target === 'both') {
        const buyerTargets = await resolveBuyerReminderTargets(vendor.id);
        buyersMatched = buyerTargets.length;

        for (const buyer of buyerTargets) {
          if (sendBell) {
            const notif = await notifyUser({
              user_id: buyer?.user_id || null,
              email: buyer?.email || null,
              type: 'KYC_REMINDER_BUYER',
              title: content.buyerTitle,
              message: content.buyerMessage,
              link: '/buyer/proposals',
            });
            if (notif) buyersBellSent += 1;
          }

          if (sendEmail) {
            const buyerEmailOk = await sendReminderEmail({
              to: buyer?.email || null,
              subject: content.buyerTitle,
              text: content.buyerMessage,
              html: `<p>${content.buyerMessage}</p>`,
            });
            if (buyerEmailOk) buyersEmailSent += 1;
          }
        }
      }

      return res.json({
        success: true,
        summary: {
          target,
          delivery,
          context,
          vendorBellSent,
          vendorEmailSent,
          buyersMatched,
          buyersBellSent,
          buyersEmailSent,
          emailConfigured: isEmailTransportConfigured(),
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to send reminder' });
    }
  }
);

// GET /api/kyc/vendors/:vendorId/remarks — reviewer remarks for a vendor's KYC
router.get('/vendors/:vendorId/remarks', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { data, error } = await supabase
      .from('kyc_remarks')
      .select('*, created_by_user:users(full_name)')
      .eq('vendor_id', vendorId)
      .order('created_at', { ascending: false });

    if (error) {
      // Table may not exist in all DB versions — return empty gracefully
      if (error.code === '42P01') return res.json({ success: true, remarks: [] });
      return res.status(500).json({ success: false, error: error.message });
    }
    return res.json({ success: true, remarks: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
