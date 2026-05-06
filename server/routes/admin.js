import { logger } from '../utils/logger.js';
import express from "express";
import { supabase } from "../lib/supabaseClient.js";
import { notifyRole, notifyUser } from "../lib/notify.js";
import { writeAuditLog } from "../lib/audit.js";
import { requireEmployeeRoles } from "../middleware/requireEmployeeRoles.js";
import {
  getPublicUserByEmail,
  getPublicUserById,
  hashPassword,
  normalizeEmail,
  normalizeRole,
  setPublicUserPassword,
  upsertPublicUser,
} from "../lib/auth.js";
import { validateStrongPassword } from "../lib/passwordPolicy.js";

const router = express.Router();

// All admin routes require a valid ADMIN employee session.
router.use(requireEmployeeRoles(["ADMIN"]));

/**
 * Returns the state scope for the logged-in admin.
 * - If states_scope is a non-empty array  → return that array (admin is region-scoped)
 * - If states_scope is empty / null       → return null (admin sees all India)
 */
function getAdminScope(req) {
  const raw = req.employee?.states_scope;
  const arr = Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
  return arr.length > 0 ? arr : null;
}

/**
 * =========================
 * UTIL
 * =========================
 */
function isActiveSub(s) {
  const st = String(s?.status || "").toUpperCase();
  if (st !== "ACTIVE") return false;
  const end = s?.end_date ? new Date(s.end_date).getTime() : null;
  if (!end) return true;
  return end > Date.now();
}

function roleToDepartment(role) {
  switch (normalizeRole(role)) {
    case "ADMIN":
      return "Administration";
    case "HR":
      return "Human Resources";
    case "FINANCE":
      return "Finance";
    case "SUPPORT":
      return "Support";
    case "SALES":
      return "Sales";
    case "DATA_ENTRY":
    case "DATAENTRY":
      return "Operations";
    default:
      return "";
  }
}

const EMAIL_SEARCH_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeIlikeTerm(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/,/g, " ");
}

async function findPublicUserByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  return getPublicUserByEmail(target);
}

async function getPublicUserByIdSafe(userId) {
  if (!userId) return null;
  return getPublicUserById(userId);
}

async function resolveEmployeeUser(employee) {
  if (!employee) return null;
  const email = normalizeEmail(employee?.email);
  let publicUser = null;

  if (employee.user_id) {
    publicUser = await getPublicUserByIdSafe(employee.user_id);
  }

  if (publicUser && email) {
    const storedEmail = normalizeEmail(publicUser?.email);
    if (storedEmail && storedEmail !== email) {
      publicUser = null;
    }
  }

  if (!publicUser && email) {
    publicUser = await findPublicUserByEmail(email);
  }

  if (publicUser?.id && publicUser.id !== employee.user_id) {
    await supabase
      .from("employees")
      .update({ user_id: publicUser.id })
      .eq("id", employee.id);
  }

  return publicUser;
}

async function ensureEmployeeUser(employee, password) {
  if (!employee) return null;
  const email = normalizeEmail(employee?.email);
  if (!email) return null;

  let publicUser = await resolveEmployeeUser(employee);

  if (!publicUser) {
    if (!password) {
      const err = new Error("Password required to create employee user");
      err.statusCode = 400;
      throw err;
    }

    const fullName = String(employee?.full_name || "").trim();
    const role = normalizeRole(employee?.role || "DATA_ENTRY");
    const phone = String(employee?.phone || "").trim() || null;

    const password_hash = await hashPassword(password);

    publicUser = await upsertPublicUser({
      email,
      full_name: fullName,
      role,
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });
  }

  if (publicUser?.id && publicUser.id !== employee.user_id) {
    await supabase.from("employees").update({ user_id: publicUser.id }).eq("id", employee.id);
  }

  return publicUser;
}

async function resolveBuyerRecordForAdmin(buyerId) {
  const id = String(buyerId || "").trim();
  if (!id) return { data: null, error: null };

  const byId = await supabase.from("buyers").select("*").eq("id", id).maybeSingle();
  if (byId.error) return { data: null, error: byId.error };
  if (byId.data) return { data: byId.data, error: null };

  const byUserId = await supabase.from("buyers").select("*").eq("user_id", id).maybeSingle();
  if (byUserId.error) return { data: null, error: byUserId.error };
  if (byUserId.data) return { data: byUserId.data, error: null };

  return { data: null, error: null };
}

async function resolveVendorRecordForAdmin(vendorId) {
  const id = String(vendorId || "").trim();
  if (!id) return { data: null, error: null };

  const byId = await supabase.from("vendors").select("*").eq("id", id).maybeSingle();
  if (byId.error) return { data: null, error: byId.error };
  if (byId.data) return { data: byId.data, error: null };

  const byUserId = await supabase.from("vendors").select("*").eq("user_id", id).maybeSingle();
  if (byUserId.error) return { data: null, error: byUserId.error };
  if (byUserId.data) return { data: byUserId.data, error: null };

  const normalizedIdEmail = normalizeIdentityEmail(id);
  if (normalizedIdEmail) {
    const byEmail = await supabase
      .from("vendors")
      .select("*")
      .ilike("email", normalizedIdEmail)
      .maybeSingle();
    if (byEmail.error) return { data: null, error: byEmail.error };
    if (byEmail.data) return { data: byEmail.data, error: null };
  }

  return { data: null, error: null };
}

const normalizeIdentityEmail = (value) => normalizeEmail(value || "");

function buildBuyerStatusUpdates(current, { isActive, reason = "" }) {
  const updates = { updated_at: new Date().toISOString() };

  if (typeof current?.is_active === "boolean" || "is_active" in (current || {})) {
    updates.is_active = !!isActive;
  }

  if (typeof current?.status === "string" || "status" in (current || {})) {
    updates.status = isActive ? "ACTIVE" : "TERMINATED";
  }

  if ("terminated_at" in (current || {})) {
    updates.terminated_at = isActive ? null : new Date().toISOString();
  }

  if ("terminated_reason" in (current || {})) {
    updates.terminated_reason = isActive ? null : (String(reason || "").trim() || null);
  }

  return updates;
}

function buildVendorStatusUpdates(current, { isActive, reason = "" }) {
  const updates = { updated_at: new Date().toISOString() };

  if (typeof current?.is_active === "boolean" || "is_active" in (current || {})) {
    updates.is_active = !!isActive;
  }

  if (typeof current?.status === "string" || "status" in (current || {})) {
    updates.status = isActive ? "ACTIVE" : "TERMINATED";
  }

  if ("terminated_at" in (current || {})) {
    updates.terminated_at = isActive ? null : new Date().toISOString();
  }

  if ("terminated_reason" in (current || {})) {
    updates.terminated_reason = isActive ? null : (String(reason || "").trim() || null);
  }

  return updates;
}

const MIN_VALID_JOIN_DATE_MS = Date.UTC(2000, 0, 1);

function normalizeEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function parseJoinedDateValue(value) {
  if (!value) return null;

  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time) || time < MIN_VALID_JOIN_DATE_MS) return null;
    return value;
  }

  if (typeof value === "number") {
    const epochMs = normalizeEpochMs(value);
    if (!epochMs) return null;
    const parsed = new Date(epochMs);
    return parseJoinedDateValue(parsed);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{10,13}$/.test(trimmed)) {
      return parseJoinedDateValue(Number(trimmed));
    }
    const parsed = new Date(trimmed);
    return parseJoinedDateValue(parsed);
  }

  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      return parseJoinedDateValue(value.toDate());
    }
    if ("seconds" in value) {
      return parseJoinedDateValue(value.seconds);
    }
    if ("_seconds" in value) {
      return parseJoinedDateValue(value._seconds);
    }
    if ("milliseconds" in value) {
      return parseJoinedDateValue(value.milliseconds);
    }
    if ("ms" in value) {
      return parseJoinedDateValue(value.ms);
    }
    if ("iso" in value) {
      return parseJoinedDateValue(value.iso);
    }
  }

  return null;
}

function getVendorJoinedOn(vendor = null) {
  const parsed =
    parseJoinedDateValue(vendor?.joined_on) ||
    parseJoinedDateValue(vendor?.joined_at) ||
    parseJoinedDateValue(vendor?.registration_date) ||
    parseJoinedDateValue(vendor?.registered_at) ||
    parseJoinedDateValue(vendor?.created_at);

  return parsed ? parsed.toISOString() : null;
}

function buildAdminSupportTicketId() {
  const rand = Math.floor(100 + Math.random() * 900);
  return `TKT-${Date.now()}-${rand}`;
}

async function createSupportStatusTicket({
  entityType,
  entityId,
  entityName,
  action,
  reason = "",
}) {
  const normalizedEntity = String(entityType || "").trim().toUpperCase();
  const normalizedAction = String(action || "").trim().toUpperCase();
  const label = String(entityName || normalizedEntity || "Account").trim();
  const reasonText = String(reason || "").trim();
  const actor = normalizedEntity === "VENDOR" ? "Vendor" : "Buyer";
  const statusText = normalizedAction === "TERMINATED" ? "suspended" : "activated";

  const payload = {
    subject: `${actor} account ${statusText}: ${label}`,
    description:
      normalizedAction === "TERMINATED"
        ? `Admin suspended ${actor.toLowerCase()} "${label}".${reasonText ? ` Reason: ${reasonText}` : ""}`
        : `Admin activated ${actor.toLowerCase()} "${label}".`,
    category: "Account Status",
    priority: normalizedAction === "TERMINATED" ? "HIGH" : "MEDIUM",
    status: "OPEN",
    vendor_id: normalizedEntity === "VENDOR" ? entityId : null,
    buyer_id: normalizedEntity === "BUYER" ? entityId : null,
    ticket_display_id: buildAdminSupportTicketId(),
    attachments: JSON.stringify([]),
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("support_tickets").insert([payload]);
    if (error) {
      logger.warn(
        `[admin] support ticket create failed for ${normalizedEntity} ${normalizedAction}:`,
        error?.message || error
      );
    }
  } catch (err) {
    logger.warn(
      `[admin] support ticket create exception for ${normalizedEntity} ${normalizedAction}:`,
      err?.message || err
    );
  }
}

/**
 * =========================
 * COUPON APPROVALS (ADMIN)
 * =========================
 */

// GET /api/admin/coupons/pending — list all coupons awaiting approval
router.get("/coupons/pending", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("vendor_plan_coupons")
      .select("*")
      .eq("approval_status", "PENDING_APPROVAL")
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/coupons/:id/decision — approve or reject a pending coupon
router.post("/coupons/:id/decision", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const decision = String(req.body?.decision || "").toUpperCase();
    if (!["APPROVE", "REJECT"].includes(decision)) {
      return res.status(400).json({ success: false, error: "decision must be APPROVE or REJECT" });
    }

    const rejectionReason = String(req.body?.reason || "").trim() || null;
    if (decision === "REJECT" && !rejectionReason) {
      return res.status(400).json({ success: false, error: "reason is required when rejecting" });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("vendor_plan_coupons")
      .select("id, code, approval_status")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ success: false, error: fetchErr.message });
    if (!existing) return res.status(404).json({ success: false, error: "Coupon not found" });
    if (existing.approval_status !== "PENDING_APPROVAL") {
      return res.status(409).json({
        success: false,
        error: `Coupon is already ${existing.approval_status.toLowerCase().replace("_", " ")}`,
      });
    }

    const updates =
      decision === "APPROVE"
        ? {
            approval_status: "APPROVED",
            is_active: true,
            approved_by: req.actor?.email || null,
            approved_at: new Date().toISOString(),
            rejection_reason: null,
          }
        : {
            approval_status: "REJECTED",
            is_active: false,
            rejection_reason: rejectionReason,
            approved_by: req.actor?.email || null,
            approved_at: new Date().toISOString(),
          };

    const { data, error } = await supabase
      .from("vendor_plan_coupons")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: decision === "APPROVE" ? "COUPON_APPROVED" : "COUPON_REJECTED",
      entityType: "vendor_plan_coupons",
      entityId: id,
      details: {
        code: existing.code,
        decision,
        reason: rejectionReason,
        approved_by: req.actor?.email || null,
      },
    });

    return res.json({
      success: true,
      data,
      message: decision === "APPROVE" ? "Coupon approved and activated." : "Coupon rejected.",
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/*
 * =========================
 * AUDIT LOGS (READ)
 * =========================
 */
router.get("/audit-logs", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("audit_logs")
      .select("id, user_id, action, entity_type, entity_id, details, ip_address, created_at")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({
      success: true,
      logs: (data || []).map((l) => ({
        id: l.id,
        created_at: l.created_at,
        action: l.action,
        entity_type: l.entity_type,
        entity_id: l.entity_id,
        ip_address: l.ip_address || null,
        details: l.details || {},
        actor: {
          id: l?.details?.actor_id || l.user_id || null,
          type: l?.details?.actor_type || null,
          role: l?.details?.actor_role || null,
          email: l?.details?.actor_email || null,
        },
      })),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * =========================
 * VENDORS
 * =========================
 */
router.get("/vendors", async (req, res) => {
  try {
    const REQUIRED_VENDOR_DOCUMENT_TYPES = new Set(["GST", "PAN", "AADHAR", "BANK"]);
    const normalizeDocumentType = (value) => {
      const raw = String(value || "").trim().toUpperCase();
      if (!raw) return "";
      if (["GST", "GST_CERTIFICATE", "GSTIN_CERTIFICATE"].includes(raw)) return "GST";
      if (["PAN", "PAN_CARD"].includes(raw)) return "PAN";
      if (["AADHAR", "AADHAAR", "AADHAR_CARD", "AADHAAR_CARD", "COMPANY_REGISTRATION", "REGISTRATION_CERTIFICATE"].includes(raw)) return "AADHAR";
      if (raw.startsWith("BANK") || ["BANK_PROOF", "BANK_STATEMENT", "CANCELLED_CHEQUE", "CHEQUE_COPY", "PASSBOOK"].includes(raw)) return "BANK";
      return raw;
    };
    const rawSearch = String(req.query?.search || "").trim();
    const search = rawSearch.replace(/,/g, " ").trim();
    const kycRaw = String(req.query?.kyc || req.query?.kyc_status || "all").trim();
    const activeRaw = String(req.query?.active || req.query?.status || "all").trim();
    const joinedFromRaw = String(req.query?.joined_from || "").trim();
    const joinedToRaw = String(req.query?.joined_to || "").trim();
    const parsedLimit = Number(req.query?.limit);
    const parsedOffset = Number(req.query?.offset);
    const parsedJoinedFrom = joinedFromRaw ? new Date(joinedFromRaw) : null;
    const parsedJoinedTo = joinedToRaw ? new Date(joinedToRaw) : null;
    const hasJoinedFrom = parsedJoinedFrom && !Number.isNaN(parsedJoinedFrom.getTime());
    const hasJoinedTo = parsedJoinedTo && !Number.isNaN(parsedJoinedTo.getTime());
    const MAX_VENDOR_LIMIT = 1000;
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_VENDOR_LIMIT)
      : MAX_VENDOR_LIMIT;
    const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0
      ? parsedOffset
      : 0;

    let vendorQuery = supabase
      .from("vendors")
      .select(
        "id, vendor_id, company_name, owner_name, email, phone, kyc_status, created_at, is_active",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);

    // State-scope filtering: admin only sees vendors from their assigned states
    const adminScope = getAdminScope(req);
    if (adminScope) {
      vendorQuery = vendorQuery.in("state", adminScope);
    }

    const kyc = kycRaw.toUpperCase();
    if (kyc && kyc !== "ALL") {
      vendorQuery = vendorQuery.eq("kyc_status", kyc);
    }

    const active = activeRaw.toLowerCase();
    if (active === "active") {
      vendorQuery = vendorQuery.neq("is_active", false);
    } else if (active === "inactive" || active === "terminated" || active === "suspended") {
      vendorQuery = vendorQuery.eq("is_active", false);
    }

    if (search) {
      const normalizedSearchEmail = normalizeEmail(search);
      const escapedSearch = escapeIlikeTerm(search);
      const looksLikeEmailSearch = EMAIL_SEARCH_RE.test(search);
      const looksLikeUuidSearch = UUID_LIKE_RE.test(search);

      if (looksLikeEmailSearch) {
        vendorQuery = vendorQuery.ilike("email", normalizedSearchEmail);
      } else if (looksLikeUuidSearch) {
        vendorQuery = vendorQuery.eq("id", search);
      } else {
        vendorQuery = vendorQuery.or(
          [
            `company_name.ilike.%${escapedSearch}%`,
            `owner_name.ilike.%${escapedSearch}%`,
            `vendor_id.ilike.%${escapedSearch}%`,
            `email.ilike.%${escapedSearch}%`,
          ].join(",")
        );
      }
    }

    if (hasJoinedFrom) {
      vendorQuery = vendorQuery.gte("created_at", parsedJoinedFrom.toISOString());
    }

    if (hasJoinedTo) {
      vendorQuery = vendorQuery.lt("created_at", parsedJoinedTo.toISOString());
    }

    const { data: vendors, error, count } = await vendorQuery;
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const vendorsList = Array.isArray(vendors) ? vendors : [];
    const vendorIds = vendorsList.map((v) => v.id).filter(Boolean);
    const publicVendorIds = vendorsList.map((v) => v.vendor_id).filter(Boolean);
    const vendorLookupMap = new Map();
    vendorsList.forEach((vendor) => {
      const internalId = String(vendor?.id || "").trim();
      const publicId = String(vendor?.vendor_id || "").trim();
      if (internalId) vendorLookupMap.set(internalId, internalId);
      if (publicId) vendorLookupMap.set(publicId, internalId);
    });
    const chunk = (arr, size = 120) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };
    const countMap = {};
    if (vendorIds.length) {
      for (const ids of chunk(vendorIds)) {
        const { data: pRows, error: pErr } = await supabase
          .from("products")
          .select("vendor_id")
          .in("vendor_id", ids);

        if (pErr) {
          return res.status(500).json({ success: false, error: pErr.message });
        }

        (pRows || []).forEach((r) => {
          if (!r.vendor_id) return;
          countMap[r.vendor_id] = (countMap[r.vendor_id] || 0) + 1;
        });
      }
    }

    const documentTypeMap = new Map();
    const collectDocumentRows = (rows = []) => {
      (rows || []).forEach((row) => {
        const vendorLookupKey = String(row?.vendor_id || "").trim();
        const vendorId = vendorLookupMap.get(vendorLookupKey) || "";
        const docType = normalizeDocumentType(row?.document_type || row?.type);
        if (!vendorId || !REQUIRED_VENDOR_DOCUMENT_TYPES.has(docType)) return;

        if (!documentTypeMap.has(vendorId)) {
          documentTypeMap.set(vendorId, new Set());
        }
        documentTypeMap.get(vendorId).add(docType);
      });
    };

    if (vendorIds.length) {
      for (const ids of chunk(vendorIds)) {
        const { data: vendorDocs, error: vendorDocsError } = await supabase
          .from("vendor_documents")
          .select("*")
          .in("vendor_id", ids);

        if (vendorDocsError) {
          return res.status(500).json({ success: false, error: vendorDocsError.message });
        }
        collectDocumentRows(vendorDocs);
      }

      const legacyLookupKeys = Array.from(
        new Set([...vendorIds, ...publicVendorIds].map((value) => String(value || "").trim()).filter(Boolean))
      );
      const legacyUuidKeys = legacyLookupKeys.filter((value) => UUID_LIKE_RE.test(value));
      const legacyPublicKeys = legacyLookupKeys.filter((value) => !UUID_LIKE_RE.test(value));

      for (const ids of chunk(legacyUuidKeys)) {
        const { data: legacyDocs, error: legacyDocsError } = await supabase
          .from("kyc_documents")
          .select("*")
          .in("vendor_id", ids);

        if (!legacyDocsError) {
          collectDocumentRows(legacyDocs);
        }
      }

      for (const ids of chunk(legacyPublicKeys)) {
        const { data: legacyDocs, error: legacyDocsError } = await supabase
          .from("kyc_documents")
          .select("*")
          .in("vendor_id", ids);

        if (!legacyDocsError) {
          collectDocumentRows(legacyDocs);
        }
      }
    }

    let activeSubByVendor = {};
    let planMap = {};

    if (vendorIds.length) {
      const subRows = [];
      for (const ids of chunk(vendorIds)) {
        const { data: subs, error: sErr } = await supabase
          .from("vendor_plan_subscriptions")
          .select("vendor_id, plan_id, status, start_date, end_date")
          .in("vendor_id", ids)
          .order("start_date", { ascending: false });

        if (sErr) {
          return res.status(500).json({ success: false, error: sErr.message });
        }
        if (Array.isArray(subs) && subs.length) subRows.push(...subs);
      }

      subRows.sort(
        (a, b) =>
          new Date(b?.start_date || 0).getTime() - new Date(a?.start_date || 0).getTime()
      );

      activeSubByVendor = {};
      (subRows || []).forEach((s) => {
        if (!s.vendor_id) return;
        if (activeSubByVendor[s.vendor_id]) return;
        if (isActiveSub(s)) activeSubByVendor[s.vendor_id] = s;
      });

      const planIds = Array.from(
        new Set(
          Object.values(activeSubByVendor)
            .map((x) => x?.plan_id)
            .filter(Boolean)
        )
      );

      if (planIds.length) {
        planMap = {};
        for (const ids of chunk(planIds)) {
          const { data: plans, error: pErr2 } = await supabase
            .from("vendor_plans")
            .select("id, name, price")
            .in("id", ids);

          if (pErr2) {
            return res.status(500).json({ success: false, error: pErr2.message });
          }

          (plans || []).forEach((p) => {
            planMap[p.id] = p;
          });
        }
      }
    }

    const result = (vendors || []).map((v) => {
      const sub = activeSubByVendor[v.id] || null;
      const plan = sub?.plan_id ? planMap[sub.plan_id] : null;
      const documentCount = documentTypeMap.get(v.id)?.size || 0;
      const normalizedKycStatus = String(v?.kyc_status || "").trim().toUpperCase();
      const hasSubmittedKyc =
        documentCount > 0 ||
        ["SUBMITTED", "APPROVED", "VERIFIED"].includes(normalizedKycStatus);
      return {
        ...v,
        joined_on: getVendorJoinedOn(v),
        document_count: documentCount,
        has_submitted_kyc: hasSubmittedKyc,
        has_all_required_documents: documentCount >= REQUIRED_VENDOR_DOCUMENT_TYPES.size,
        product_count: countMap[v.id] || 0,
        package: plan
          ? {
              plan_id: plan.id,
              plan_name: plan.name,
              price: plan.price,
              end_date: sub?.end_date || null,
            }
          : { plan_id: null, plan_name: "FREE", price: 0, end_date: null },
      };
    });

    return res.json({
      success: true,
      vendors: result,
      total: Number.isFinite(count) ? count : result.length,
      limit: safeLimit,
      offset: safeOffset,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/admin/vendors/:vendorId — fetch a single vendor by UUID
router.get("/vendors/:vendorId", async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!vendorId) {
      return res.status(400).json({ success: false, error: "vendorId is required" });
    }

    // Guard against sub-path collisions (e.g. "products", "terminate")
    const SUBPATH_RESERVED = new Set(["products", "terminate", "activate"]);
    if (SUBPATH_RESERVED.has(vendorId)) {
      return res.status(400).json({ success: false, error: "Invalid vendorId" });
    }

    const { data: vendor, error } = await supabase
      .from("vendors")
      .select("*")
      .eq("id", vendorId)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!vendor) return res.status(404).json({ success: false, error: "Vendor not found" });

    return res.json({ success: true, vendor });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/vendors/:vendorId/products", async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!vendorId) {
      return res.status(400).json({ success: false, error: "vendorId missing" });
    }

    const { data: vendor, error: vErr } = await supabase
      .from("vendors")
      .select("id, vendor_id, company_name, owner_name, email, phone, kyc_status, is_active")
      .eq("id", vendorId)
      .maybeSingle();

    if (vErr) {
      return res.status(500).json({ success: false, error: vErr.message });
    }
    if (!vendor) {
      return res.status(404).json({ success: false, error: "Vendor not found" });
    }

    let query = supabase
      .from("products")
      .select("*")
      .eq("vendor_id", vendorId)
      .order("created_at", { ascending: false });

    const limit = Number(req.query?.limit);
    const offset = Number(req.query?.offset);
    if (Number.isFinite(limit) && limit > 0) {
      const safeLimit = Math.min(limit, 2000);
      const start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
      query = query.range(start, start + safeLimit - 1);
    }

    const { data: products, error: pErr } = await query;
    if (pErr) {
      return res.status(500).json({ success: false, error: pErr.message });
    }

    const ids = (products || []).map((p) => p.id);
    let imagesByProduct = {};
    if (ids.length) {
      const { data: imgs, error: imgErr } = await supabase
        .from("product_images")
        .select("*")
        .in("product_id", ids);
      if (imgErr) {
        return res.status(500).json({ success: false, error: imgErr.message });
      }

      (imgs || []).forEach((img) => {
        imagesByProduct[img.product_id] = imagesByProduct[img.product_id] || [];
        imagesByProduct[img.product_id].push(img);
      });
    }

    const out = (products || []).map((p) => ({
      ...p,
      product_images: imagesByProduct[p.id] || [],
    }));

    return res.json({ success: true, vendor, products: out });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/vendors/:vendorId/terminate", async (req, res) => {
  try {
    const { vendorId } = req.params;
    const reason = String(req.body?.reason || "").trim();
    const { data: existing, error: findErr } = await resolveVendorRecordForAdmin(vendorId);
    if (findErr) {
      return res.status(500).json({ success: false, error: findErr.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: "Vendor not found" });
    }

    const updates = buildVendorStatusUpdates(existing, { isActive: false, reason });

    const { data, error } = await supabase
      .from("vendors")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .maybeSingle();

    if (error)
      return res.status(500).json({ success: false, error: error.message });
    const updatedVendor = data || { ...existing, ...updates };

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "VENDOR_TERMINATE",
      entityType: "vendors",
      entityId: existing.id,
      details: { reason },
    });

    await createSupportStatusTicket({
      entityType: "VENDOR",
      entityId: updatedVendor?.id || existing.id,
      entityName:
        updatedVendor?.company_name ||
        updatedVendor?.vendor_id ||
        updatedVendor?.owner_name ||
        "Vendor",
      action: "TERMINATED",
      reason,
    });

    if (updatedVendor?.user_id) {
      await notifyUser({
        user_id: updatedVendor.user_id,
        email: updatedVendor?.email || null,
        type: "ACCOUNT_SUSPENDED",
        title: "Account suspended",
        message: reason || "Your vendor account has been suspended by admin.",
        link: "/vendor/support",
        role: "VENDOR",
        full_name: updatedVendor?.owner_name || updatedVendor?.company_name || "Vendor",
      });
    } else if (updatedVendor?.email) {
      await notifyUser({
        email: updatedVendor.email,
        type: "ACCOUNT_SUSPENDED",
        title: "Account suspended",
        message: reason || "Your vendor account has been suspended by admin.",
        link: "/vendor/support",
        role: "VENDOR",
        full_name: updatedVendor?.owner_name || updatedVendor?.company_name || "Vendor",
      });
    }

    await Promise.all([
      notifyRole("SUPPORT", {
        type: "VENDOR_STATUS_UPDATED",
        title: "Vendor account suspended",
        message:
          `Admin suspended vendor "${updatedVendor?.company_name || updatedVendor?.vendor_id || "Vendor"}"` +
          `${reason ? `: ${reason}` : "."}`,
        link: "/employee/support/tickets/vendor",
      }),
      notifyRole("DATA_ENTRY", {
        type: "VENDOR_STATUS_UPDATED",
        title: "Vendor account suspended",
        message:
          `Admin suspended vendor "${updatedVendor?.company_name || updatedVendor?.vendor_id || "Vendor"}"` +
          `${reason ? `: ${reason}` : "."}`,
        link: "/employee/dataentry/vendors",
      }),
    ]);

    return res.json({ success: true, vendor: updatedVendor });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/vendors/:vendorId/activate", async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { data: existing, error: findErr } = await resolveVendorRecordForAdmin(vendorId);
    if (findErr) {
      return res.status(500).json({ success: false, error: findErr.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: "Vendor not found" });
    }

    const updates = buildVendorStatusUpdates(existing, { isActive: true });

    const { data, error } = await supabase
      .from("vendors")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .maybeSingle();

    if (error)
      return res.status(500).json({ success: false, error: error.message });
    const updatedVendor = data || { ...existing, ...updates };

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "VENDOR_ACTIVATE",
      entityType: "vendors",
      entityId: existing.id,
    });

    await createSupportStatusTicket({
      entityType: "VENDOR",
      entityId: updatedVendor?.id || existing.id,
      entityName:
        updatedVendor?.company_name ||
        updatedVendor?.vendor_id ||
        updatedVendor?.owner_name ||
        "Vendor",
      action: "ACTIVATED",
    });

    if (updatedVendor?.user_id) {
      await notifyUser({
        user_id: updatedVendor.user_id,
        email: updatedVendor?.email || null,
        type: "ACCOUNT_ACTIVATED",
        title: "Account re-activated",
        message: "Your vendor account has been activated by admin.",
        link: "/vendor/dashboard",
        role: "VENDOR",
        full_name: updatedVendor?.owner_name || updatedVendor?.company_name || "Vendor",
      });
    } else if (updatedVendor?.email) {
      await notifyUser({
        email: updatedVendor.email,
        type: "ACCOUNT_ACTIVATED",
        title: "Account re-activated",
        message: "Your vendor account has been activated by admin.",
        link: "/vendor/dashboard",
        role: "VENDOR",
        full_name: updatedVendor?.owner_name || updatedVendor?.company_name || "Vendor",
      });
    }

    await Promise.all([
      notifyRole("SUPPORT", {
        type: "VENDOR_STATUS_UPDATED",
        title: "Vendor account activated",
        message: `Admin activated vendor "${updatedVendor?.company_name || updatedVendor?.vendor_id || "Vendor"}".`,
        link: "/employee/support/tickets/vendor",
      }),
      notifyRole("DATA_ENTRY", {
        type: "VENDOR_STATUS_UPDATED",
        title: "Vendor account activated",
        message: `Admin activated vendor "${updatedVendor?.company_name || updatedVendor?.vendor_id || "Vendor"}".`,
        link: "/employee/dataentry/vendors",
      }),
    ]);

    return res.json({ success: true, vendor: updatedVendor });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * =========================
 * BUYERS (NEW – SAME AS VENDORS)
 * =========================
 */
router.get("/buyers", async (req, res) => {
  try {
    let buyerQuery = supabase
      .from("buyers")
      .select("*")
      .order("created_at", { ascending: false });

    // State-scope filtering: admin only sees buyers from their assigned states
    const adminScope = getAdminScope(req);
    if (adminScope) {
      buyerQuery = buyerQuery.in("state", adminScope);
    }

    const { data, error } = await buyerQuery;

    if (error)
      return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, buyers: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.put("/buyers/:buyerId", async (req, res) => {
  try {
    const { buyerId } = req.params;
    const { data: existing, error: findErr } = await resolveBuyerRecordForAdmin(buyerId);
    if (findErr) {
      return res.status(500).json({ success: false, error: findErr.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: "Buyer not found" });
    }

    const payload = {
      full_name: String(req.body?.full_name || req.body?.fullName || "").trim() || null,
      phone: String(req.body?.phone || "").trim() || null,
      company_name: String(req.body?.company_name || req.body?.companyName || "").trim() || null,
      address: String(req.body?.address || "").trim() || null,
      city: String(req.body?.city || "").trim() || null,
      state: String(req.body?.state || "").trim() || null,
      pincode: String(req.body?.pincode || "").trim() || null,
      pan_card: String(req.body?.pan_card || req.body?.panCard || "").trim().toUpperCase() || null,
      gst_number: String(req.body?.gst_number || req.body?.gstNumber || "").trim().toUpperCase() || null,
      updated_at: new Date().toISOString(),
    };

    const updates = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) updates[key] = value;
    }

    const { data, error } = await supabase
      .from("buyers")
      .update(updates)
      .eq("id", existing.id)
      .select("*")
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const updatedBuyer = data || { ...existing, ...updates };

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "BUYER_UPDATE",
      entityType: "buyers",
      entityId: existing.id,
      details: { fields: Object.keys(updates) },
    });

    return res.json({ success: true, buyer: updatedBuyer });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/buyers/:buyerId/terminate", async (req, res) => {
  try {
    const { buyerId } = req.params;
    const reason = String(req.body?.reason || "").trim();

    const { data: existing, error: findErr } = await resolveBuyerRecordForAdmin(buyerId);
    if (findErr) {
      return res.status(500).json({ success: false, error: findErr.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: "Buyer not found" });
    }

    const updates = buildBuyerStatusUpdates(existing, { isActive: false, reason });

    const { data, error } = await supabase
      .from("buyers")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .maybeSingle();

    if (error)
      return res.status(500).json({ success: false, error: error.message });

    const updatedBuyer = data || { ...existing, ...updates };

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "BUYER_TERMINATE",
      entityType: "buyers",
      entityId: existing.id,
      details: { reason },
    });

    await createSupportStatusTicket({
      entityType: "BUYER",
      entityId: existing.id,
      entityName: updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer",
      action: "TERMINATED",
      reason,
    });

    if (updatedBuyer?.user_id) {
      await notifyUser({
        user_id: updatedBuyer.user_id,
        email: updatedBuyer?.email || null,
        type: "ACCOUNT_SUSPENDED",
        title: "Account suspended",
        message: reason || "Your buyer account has been suspended by admin.",
        link: "/buyer/tickets",
        role: "BUYER",
        full_name: updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer",
      });
    } else if (updatedBuyer?.email) {
      await notifyUser({
        email: updatedBuyer.email,
        type: "ACCOUNT_SUSPENDED",
        title: "Account suspended",
        message: reason || "Your buyer account has been suspended by admin.",
        link: "/buyer/tickets",
        role: "BUYER",
        full_name: updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer",
      });
    }

    await notifyRole("SUPPORT", {
      type: "BUYER_STATUS_UPDATED",
      title: "Buyer account suspended",
      message:
        `Admin suspended buyer "${updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer"}"` +
        `${reason ? `: ${reason}` : "."}`,
      link: "/employee/support/tickets/buyer",
    });

    return res.json({ success: true, buyer: updatedBuyer });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/buyers/:buyerId/activate", async (req, res) => {
  try {
    const { buyerId } = req.params;

    const { data: existing, error: findErr } = await resolveBuyerRecordForAdmin(buyerId);
    if (findErr) {
      return res.status(500).json({ success: false, error: findErr.message });
    }
    if (!existing) {
      return res.status(404).json({ success: false, error: "Buyer not found" });
    }

    const updates = buildBuyerStatusUpdates(existing, { isActive: true });

    const { data, error } = await supabase
      .from("buyers")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .maybeSingle();

    if (error)
      return res.status(500).json({ success: false, error: error.message });

    const updatedBuyer = data || { ...existing, ...updates };

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "BUYER_ACTIVATE",
      entityType: "buyers",
      entityId: existing.id,
    });

    await createSupportStatusTicket({
      entityType: "BUYER",
      entityId: existing.id,
      entityName: updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer",
      action: "ACTIVATED",
    });

    if (updatedBuyer?.user_id) {
      await notifyUser({
        user_id: updatedBuyer.user_id,
        email: updatedBuyer?.email || null,
        type: "ACCOUNT_ACTIVATED",
        title: "Account re-activated",
        message: "Your buyer account has been activated by admin.",
        link: "/buyer/dashboard",
        role: "BUYER",
        full_name: updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer",
      });
    } else if (updatedBuyer?.email) {
      await notifyUser({
        email: updatedBuyer.email,
        type: "ACCOUNT_ACTIVATED",
        title: "Account re-activated",
        message: "Your buyer account has been activated by admin.",
        link: "/buyer/dashboard",
        role: "BUYER",
        full_name: updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer",
      });
    }

    await notifyRole("SUPPORT", {
      type: "BUYER_STATUS_UPDATED",
      title: "Buyer account activated",
      message: `Admin activated buyer "${updatedBuyer?.full_name || updatedBuyer?.company_name || "Buyer"}".`,
      link: "/employee/support/tickets/buyer",
    });

    return res.json({ success: true, buyer: updatedBuyer });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * =========================
 * PRODUCTS
 * =========================
 */
router.put("/products/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    const { data, error } = await supabase
      .from("products")
      .update(req.body)
      .eq("id", productId)
      .select()
      .maybeSingle();

    if (error)
      return res.status(500).json({ success: false, error: error.message });

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "PRODUCT_UPDATE",
      entityType: "products",
      entityId: productId,
      details: { payload: req.body },
    });

    return res.json({ success: true, product: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete("/products/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    await supabase.from("product_images").delete().eq("product_id", productId);
    await supabase.from("products").delete().eq("id", productId);

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "PRODUCT_DELETE",
      entityType: "products",
      entityId: productId,
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * =========================
 * STAFF
 * =========================
 */
router.get("/staff", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("employees")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, employees: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Roles ADMIN portal is allowed to create (HR and FINANCE only)
const ADMIN_CREATABLE_ROLES = ['HR', 'FINANCE'];

router.post("/staff", async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || "").trim();
    const email = normalizeEmail(req.body?.email || "");
    const password = String(req.body?.password || "").trim();
    const role = normalizeRole(req.body?.role || "HR") || "HR";
    const phone = String(req.body?.phone || "").trim() || null;
    const department = String(req.body?.department || "").trim() || roleToDepartment(role);

    if (!full_name || !email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "full_name, email and password are required" });
    }

    // ADMIN can only create HR and FINANCE roles.
    // SUPERADMIN creates ADMIN. HR creates SALES/SUPPORT/DATA_ENTRY/MANAGER/VP.
    if (!ADMIN_CREATABLE_ROLES.includes(role)) {
      return res.status(403).json({
        success: false,
        error: `ADMIN can only create roles: ${ADMIN_CREATABLE_ROLES.join(', ')}. Use the correct portal for other roles.`,
      });
    }

    const passwordValidation = validateStrongPassword(password);
    if (!passwordValidation.ok) {
      return res.status(400).json({ success: false, error: passwordValidation.error });
    }

    const password_hash = await hashPassword(password);
    const publicUser = await upsertPublicUser({
      email,
      full_name,
      role,
      phone,
      password_hash,
      allowPasswordUpdate: true,
    });
    const userId = publicUser.id;

    const employeePayload = {
      user_id: userId,
      full_name,
      email,
      phone,
      role,
      department: department || null,
      status: "ACTIVE",
      updated_at: new Date().toISOString(),
    };

    const { data: existingByUserId, error: existingByUserIdError } = await supabase
      .from("employees")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (existingByUserIdError) {
      return res.status(500).json({ success: false, error: existingByUserIdError.message });
    }

    let existingEmployee = existingByUserId || null;

    if (!existingEmployee) {
      const { data: existingByEmail, error: existingByEmailError } = await supabase
        .from("employees")
        .select("*")
        .ilike("email", email)
        .limit(1)
        .maybeSingle();
      if (existingByEmailError) {
        return res.status(500).json({ success: false, error: existingByEmailError.message });
      }
      existingEmployee = existingByEmail || null;
    }

    let emp = null;
    if (existingEmployee?.id) {
      const { data: updatedEmployee, error: updateEmployeeError } = await supabase
        .from("employees")
        .update(employeePayload)
        .eq("id", existingEmployee.id)
        .select()
        .maybeSingle();
      if (updateEmployeeError) {
        return res.status(500).json({ success: false, error: updateEmployeeError.message });
      }
      emp = updatedEmployee || { ...existingEmployee, ...employeePayload };
    } else {
      const { data: insertedEmployee, error: insertEmployeeError } = await supabase
        .from("employees")
        .insert([
          {
            ...employeePayload,
            created_at: new Date().toISOString(),
          },
        ])
        .select()
        .maybeSingle();
      if (insertEmployeeError) {
        return res.status(500).json({ success: false, error: insertEmployeeError.message });
      }
      emp = insertedEmployee || null;
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: existingEmployee?.id ? "STAFF_UPSERT" : "STAFF_CREATE",
      entityType: "employees",
      entityId: emp?.id || null,
      details: { email, role, user_id: userId, department: department || null },
    });

    if (userId) {
      await notifyUser({
        user_id: userId,
        type: "WELCOME",
        title: "Welcome to the Admin Team",
        message: "Your staff account has been created. Please log in to continue.",
        link: "/employee/login",
      });
    }

    return res.json({
      success: true,
      employee: emp,
      reused_existing: Boolean(existingEmployee?.id),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete("/staff/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;

    const { data: emp } = await supabase
      .from("employees")
      .select("*")
      .eq("id", employeeId)
      .single();

    await supabase.from("employees").delete().eq("id", employeeId);
    if (emp?.user_id) {
      await supabase.from("users").delete().eq("id", emp.user_id);
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "STAFF_DELETE",
      entityType: "employees",
      entityId: employeeId,
      details: { user_id: emp?.user_id || null, email: emp?.email || null },
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.put("/staff/:employeeId/password", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const password = String(req.body?.password || "").trim();
    const passwordValidation = validateStrongPassword(password);
    if (!passwordValidation.ok) {
      return res.status(400).json({ success: false, error: passwordValidation.error });
    }

    const { data: emp, error: empErr } = await supabase
      .from("employees")
      .select("id, user_id, email")
      .eq("id", employeeId)
      .single();
    if (empErr) {
      return res.status(500).json({ success: false, error: empErr.message || "Failed to fetch employee" });
    }
    if (!emp?.id) {
      return res.status(404).json({ success: false, error: "Employee not found" });
    }

    let publicUser = await resolveEmployeeUser(emp);
    if (!publicUser?.id) {
      try {
        publicUser = await ensureEmployeeUser(emp, password);
      } catch (err) {
        const statusCode = err?.statusCode || 500;
        return res.status(statusCode).json({ success: false, error: err?.message || "Auth user create failed" });
      }
    }
    await setPublicUserPassword(publicUser.id, password);

    // Keep Supabase auth credential in sync for any auth-provider based login flows.
    if (supabase?.auth?.admin?.updateUserById) {
      const authIds = [emp?.user_id, publicUser?.id].filter(Boolean);
      const seen = new Set();
      for (const authUserId of authIds) {
        if (!authUserId || seen.has(authUserId)) continue;
        seen.add(authUserId);
        // best-effort: if candidate id is not an auth user id, continue silently
        // eslint-disable-next-line no-await-in-loop
        const { error: authErr } = await supabase.auth.admin.updateUserById(authUserId, { password });
        if (!authErr) break;
      }
    }

    await writeAuditLog({
      req,
      actor: req.actor,
      action: "STAFF_PASSWORD_CHANGE",
      entityType: "employees",
      entityId: employeeId,
      details: { user_id: publicUser.id || null, email: emp?.email || null },
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


router.get("/dashboard/overview", async (req, res) => {
  try {
    const scope = getAdminScope(req);

    // Base queries — scoped by admin's states if assigned
    let vendorsActiveQ = supabase.from("vendors").select("*", { count: "exact", head: true }).eq("is_active", true);
    let buyersQ        = supabase.from("buyers").select("*", { count: "exact", head: true });
    let pendingKycQ    = supabase.from("vendors").select("*", { count: "exact", head: true }).in("kyc_status", ["PENDING", "SUBMITTED"]);
    let recentVendorsQ = supabase.from("vendors").select("id");
    let openTicketsQ   = supabase.from("support_tickets").select("*", { count: "exact", head: true }).in("status", ["OPEN", "IN_PROGRESS"]);

    if (scope) {
      vendorsActiveQ = vendorsActiveQ.in("state", scope);
      buyersQ        = buyersQ.in("state", scope);
      pendingKycQ    = pendingKycQ.in("state", scope);
      recentVendorsQ = recentVendorsQ.in("state", scope);
      // tickets: filter via vendor state join
      openTicketsQ   = supabase
        .from("support_tickets")
        .select("id, vendors!inner(state)", { count: "exact", head: true })
        .in("status", ["OPEN", "IN_PROGRESS"])
        .in("vendors.state", scope);
    }

    // If scoped, first get vendor IDs in this admin's states to filter revenue/orders
    let scopedVendorIdList = null;
    if (scope) {
      const { data: sv } = await recentVendorsQ;
      scopedVendorIdList = (sv || []).map((v) => v.id).filter(Boolean);
    }

    // Revenue queries — scoped by vendorIds when admin is region-restricted
    let leadPurchasesAmtQ = supabase.from("lead_purchases").select("amount");
    let vendorPaymentsQ   = supabase.from("vendor_payments").select("amount, net_amount");
    let ordersCountQ      = supabase.from("lead_purchases").select("*", { count: "exact", head: true });

    if (scopedVendorIdList && scopedVendorIdList.length > 0) {
      leadPurchasesAmtQ = leadPurchasesAmtQ.in("vendor_id", scopedVendorIdList);
      vendorPaymentsQ   = vendorPaymentsQ.in("vendor_id", scopedVendorIdList);
      ordersCountQ      = ordersCountQ.in("vendor_id", scopedVendorIdList);
    }

    const [
      usersRes,
      vendorsRes,
      buyersRes,
      productsRes,
      pendingKycRes,
      ordersRes,
      leadPurchasesRes,
      vendorPaymentsRes,
      openTicketsRes,
    ] = await Promise.all([
      supabase.from("users").select("*", { count: "exact", head: true }),
      vendorsActiveQ,
      buyersQ,
      supabase.from("products").select("*", { count: "exact", head: true }),
      pendingKycQ,
      ordersCountQ,
      leadPurchasesAmtQ,
      vendorPaymentsQ,
      openTicketsQ,
    ]);

    const countErrors = [
      usersRes.error,
      vendorsRes.error,
      buyersRes.error,
      productsRes.error,
      pendingKycRes.error,
      ordersRes.error,
      leadPurchasesRes.error,
      vendorPaymentsRes.error,
      openTicketsRes.error,
    ].filter(Boolean);

    if (countErrors.length > 0) {
      return res.status(500).json({ success: false, error: countErrors[0].message });
    }

    const leadRevenue = (leadPurchasesRes.data || []).reduce(
      (sum, row) => sum + Number(row?.amount || 0),
      0
    );
    const vendorRevenue = (vendorPaymentsRes.data || []).reduce(
      (sum, row) => sum + Number(row?.net_amount ?? row?.amount ?? 0),
      0
    );

    return res.json({
      success: true,
      overview: {
        totalUsers: usersRes.count || 0,
        activeVendors: vendorsRes.count || 0,
        totalOrders: ordersRes.count || 0,
        totalRevenue: leadRevenue + vendorRevenue,
        totalBuyers: buyersRes.count || 0,
        totalProducts: productsRes.count || 0,
        pendingKyc: pendingKycRes.count || 0,
        openTickets: openTicketsRes.count || 0,
        scopedToStates: scope || null,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


// Dashboard counts (buyers/products/pending KYC)
router.get("/dashboard/counts", async (req, res) => {
  try {
    const scope = getAdminScope(req);

    let buyersQ     = supabase.from("buyers").select("*", { count: "exact", head: true });
    let pendingKycQ = supabase.from("vendors").select("*", { count: "exact", head: true }).in("kyc_status", ["PENDING", "SUBMITTED"]);

    if (scope) {
      buyersQ     = buyersQ.in("state", scope);
      pendingKycQ = pendingKycQ.in("state", scope);
    }

    const [buyersRes, productsRes, pendingKycRes] = await Promise.all([
      buyersQ,
      supabase.from("products").select("*", { count: "exact", head: true }),
      pendingKycQ,
    ]);

    if (buyersRes.error) return res.status(500).json({ success: false, error: buyersRes.error.message });
    if (productsRes.error) return res.status(500).json({ success: false, error: productsRes.error.message });
    if (pendingKycRes.error) return res.status(500).json({ success: false, error: pendingKycRes.error.message });

    return res.json({
      success: true,
      counts: {
        totalBuyers: buyersRes.count || 0,
        totalProducts: productsRes.count || 0,
        pendingKyc: pendingKycRes.count || 0,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


// -------------------------
// DASHBOARD DATA (ADMIN)
// -------------------------
router.get("/dashboard/recent-support-tickets", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query?.limit || 5), 50);
    const scope = getAdminScope(req);

    // When scoped: only show tickets whose vendor is in this admin's states
    // Tickets with no vendor (buyer-only) are included when unscoped, excluded when scoped
    let q = supabase
      .from("support_tickets")
      .select(
        "id, subject, priority, status, created_at, vendor_id, buyer_id, vendors(company_name, owner_name, state), buyers(full_name, company_name)"
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    // Fetch more rows then post-filter by vendor state when scoped
    if (scope) q = q.limit(limit * 10); // fetch extra so we have enough after filtering
    const { data, error } = await q;

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const tickets = scope
      ? (data || [])
          .filter((t) => {
            const vendorState = t.vendors?.state;
            // Include if vendor state matches scope; exclude buyer-only tickets when scoped
            return vendorState && scope.includes(vendorState);
          })
          .slice(0, limit)
      : (data || []);

    return res.json({ success: true, tickets });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/dashboard/recent-vendors", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query?.limit || 5), 50);
    const scope = getAdminScope(req);

    let q = supabase
      .from("vendors")
      .select("id, company_name, kyc_status, created_at, owner_name, state")
      .not("created_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (scope) q = q.in("state", scope);

    const { data, error } = await q;

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, vendors: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/dashboard/recent-lead-purchases", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query?.limit || 10), 50);
    const { data, error } = await supabase
      .from("lead_purchases")
      .select("id, vendor_id, amount, payment_status, purchase_date, created_at, vendor:vendors(company_name)")
      .order("purchase_date", { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, orders: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get("/dashboard/data-entry-performance", async (req, res) => {
  try {
    const { data: employees, error } = await supabase
      .from("employees")
      .select("id, full_name, email, user_id, role")
      .in("role", ["DATA_ENTRY", "DATAENTRY"]);

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const performance = await Promise.all(
      (employees || []).map(async (emp) => {
        const displayName = emp.full_name || emp.email || "Data Entry";
        const publicUser = await resolveEmployeeUser(emp);
        const userId = publicUser?.id || emp.user_id;

        if (!userId) {
          return {
            id: emp.id,
            name: displayName,
            vendorsCreated: 0,
            productsListed: 0,
            hasUserId: false,
          };
        }

        const vendorFilter = [
          `created_by_user_id.eq.${userId}`,
          `assigned_to.eq.${userId}`,
          `user_id.eq.${userId}`,
          emp?.id ? `assigned_to.eq.${emp.id}` : null,
        ].filter(Boolean).join(',');
        const { count: vendorCount } = await supabase
          .from("vendors")
          .select("*", { count: "exact", head: true })
          .or(vendorFilter);

        const { data: vendors } = await supabase
          .from("vendors")
          .select("id")
          .or(vendorFilter);

        let productCount = 0;
        if (vendors && vendors.length > 0) {
          const vendorIds = vendors.map((v) => v.id);
          const { count: pCount } = await supabase
            .from("products")
            .select("*", { count: "exact", head: true })
            .in("vendor_id", vendorIds);
          productCount = pCount || 0;
        } else {
          const { count: pCount, error: pErr } = await supabase
            .from("products")
            .select("*", { count: "exact", head: true })
            .eq("created_by", userId);
          if (!pErr) productCount = pCount || 0;
        }

        return {
          id: userId,
          name: displayName,
          vendorsCreated: vendorCount || 0,
          productsListed: productCount,
          hasUserId: true,
        };
      })
    );

    return res.json({ success: true, performance });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION EXTENSION REQUEST — ADMIN RESOLUTION (state-scoped)
// ─────────────────────────────────────────────────────────────────────────────

// ADMIN: List pending extension requests forwarded to admin level (state-scoped)
router.get('/subscription-requests/pending', async (req, res) => {
  try {
    const adminScope = getAdminScope(req); // null = all India, array = specific states

    let query = supabase
      .from('subscription_extension_requests')
      .select('*')
      .eq('status', 'FORWARDED')
      .eq('current_level', 'VP')
      .order('created_at', { ascending: false });

    if (adminScope) {
      query = query.in('vendor_state', adminScope);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, requests: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to list pending subscription requests' });
  }
});

// ADMIN: Resolve (approve + extend) or reject a subscription extension request
router.post('/subscription-requests/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const decision = String(req.body?.decision || '').toUpperCase();
    const admin_note = String(req.body?.admin_note || '').trim();
    const extension_granted_days = parseInt(req.body?.extension_granted_days, 10);

    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'decision must be APPROVE or REJECT' });
    }
    if (decision === 'REJECT' && !admin_note) {
      return res.status(400).json({ success: false, error: 'admin_note (reason) is required when rejecting' });
    }
    if (decision === 'APPROVE') {
      if (!Number.isFinite(extension_granted_days) || extension_granted_days < 1 || extension_granted_days > 365) {
        return res.status(400).json({ success: false, error: 'extension_granted_days must be between 1 and 365' });
      }
    }

    // Fetch the request
    const { data: extReq, error: fetchErr } = await supabase
      .from('subscription_extension_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!extReq) return res.status(404).json({ success: false, error: 'Request not found' });
    if (extReq.status === 'RESOLVED' || extReq.status === 'REJECTED') {
      return res.status(409).json({ success: false, error: 'Request already resolved/rejected' });
    }
    if (extReq.current_level !== 'VP') {
      return res.status(409).json({ success: false, error: 'Request has not been forwarded to admin yet' });
    }

    // State-scope check
    const adminScope = getAdminScope(req);
    if (adminScope && extReq.vendor_state && !adminScope.includes(extReq.vendor_state)) {
      return res.status(403).json({ success: false, error: 'This vendor is outside your zone' });
    }

    const resolvedAt = new Date().toISOString();
    const adminEmail = req.actor?.email || req.employee?.email || null;

    if (decision === 'APPROVE') {
      // Extend vendor's active subscription end_date
      const { data: sub, error: subErr } = await supabase
        .from('vendor_plan_subscriptions')
        .select('id, end_date')
        .eq('vendor_id', extReq.vendor_id)
        .eq('status', 'ACTIVE')
        .order('end_date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (subErr) throw subErr;
      if (!sub) {
        return res.status(404).json({ success: false, error: 'No active subscription found for this vendor' });
      }

      const currentEnd = sub.end_date ? new Date(sub.end_date) : new Date();
      currentEnd.setDate(currentEnd.getDate() + extension_granted_days);
      const newEndDate = currentEnd.toISOString();

      const { error: subUpdateErr } = await supabase
        .from('vendor_plan_subscriptions')
        .update({ end_date: newEndDate })
        .eq('id', sub.id);

      if (subUpdateErr) throw subUpdateErr;

      // Mark request resolved
      await supabase
        .from('subscription_extension_requests')
        .update({
          status: 'RESOLVED',
          current_level: 'ADMIN',
          admin_note: admin_note || null,
          resolved_by: adminEmail,
          resolved_at: resolvedAt,
          extension_granted_days,
        })
        .eq('id', id);

      await writeAuditLog({
        req,
        actor: req.actor,
        action: 'SUB_EXT_APPROVED',
        entityType: 'subscription_extension_request',
        entityId: id,
        details: { vendor_id: extReq.vendor_id, extension_granted_days, new_end_date: newEndDate },
      });

      return res.json({ success: true, message: `Subscription extended by ${extension_granted_days} days`, new_end_date: newEndDate });
    } else {
      // REJECT
      await supabase
        .from('subscription_extension_requests')
        .update({
          status: 'REJECTED',
          current_level: 'ADMIN',
          admin_note,
          resolved_by: adminEmail,
          resolved_at: resolvedAt,
        })
        .eq('id', id);

      await writeAuditLog({
        req,
        actor: req.actor,
        action: 'SUB_EXT_REJECTED',
        entityType: 'subscription_extension_request',
        entityId: id,
        details: { vendor_id: extReq.vendor_id, admin_note },
      });

      return res.json({ success: true, message: 'Extension request rejected' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to resolve extension request' });
  }
});
// --- GEOGRAPHY MANAGEMENT (States & Cities) ---

router.get('/states', async (req, res) => {
  try {
    const { data, error } = await supabase.from('states').select('*').order('name');
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/states', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const { data, error } = await supabase.from('states').insert([{ name, slug, is_active: true }]).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/states/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_active } = req.body;
    let updates = { is_active };
    if (name) {
      updates.name = name;
      updates.slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    }
    const { data, error } = await supabase.from('states').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/states/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('states').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/cities', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cities').select('*, states(name)').order('name');
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/cities', async (req, res) => {
  try {
    const { state_id, name } = req.body;
    if (!name || !state_id) return res.status(400).json({ success: false, error: 'State ID and Name are required' });
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const { data, error } = await supabase.from('cities').insert([{ state_id, name, slug, is_active: true }]).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/cities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_active } = req.body;
    let updates = { is_active };
    if (name) {
      updates.name = name;
      updates.slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    }
    const { data, error } = await supabase.from('cities').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/cities/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('cities').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ GET /users — list all platform users (admin-scoped)
router.get('/users', async (req, res) => {
  try {
    const { role, search, limit = 100, offset = 0 } = req.query;
    let query = supabase
      .from('users')
      .select('id, email, full_name, phone, role, created_at, is_active')
      .order('created_at', { ascending: false })
      .range(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(limit) || 100, 500) - 1);

    if (role) query = query.eq('role', String(role).toUpperCase());
    if (search) {
      const s = String(search).trim();
      query = query.or(`email.ilike.%${s}%,full_name.ilike.%${s}%`);
    }

    const { data: users, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, users: users || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ GET /users/:id — get single user
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, phone, role, created_at, is_active')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    return res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ GET /products — list products (optionally by vendor)
router.get('/products', async (req, res) => {
  try {
    const { vendorId, limit = 100, offset = 0 } = req.query;
    let query = supabase
      .from('products')
      .select('id, name, vendor_id, status, created_at, price, images, micro_category_id')
      .order('created_at', { ascending: false })
      .range(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(limit) || 100, 500) - 1);

    if (vendorId) query = query.eq('vendor_id', vendorId);

    const { data: products, error } = await query;
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, products: products || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ POST /vendors/:vendorId/assign — assign employee to vendor
router.post('/vendors/:vendorId/assign', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { employee_id } = req.body || {};

    if (!employee_id) return res.status(400).json({ success: false, error: 'employee_id is required' });

    const { data: vendor, error: vendorErr } = await supabase
      .from('vendors')
      .select('id, company_name, assigned_to')
      .eq('id', vendorId)
      .maybeSingle();

    if (vendorErr) return res.status(500).json({ success: false, error: vendorErr.message });
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    const { data: updated, error: updateErr } = await supabase
      .from('vendors')
      .update({ assigned_to: employee_id, updated_at: new Date().toISOString() })
      .eq('id', vendorId)
      .select('id, company_name, assigned_to')
      .maybeSingle();

    if (updateErr) return res.status(500).json({ success: false, error: updateErr.message });

    await writeAuditLog({
      actor_id: req.employee?.id || null,
      actor_role: req.employee?.role || 'ADMIN',
      action: 'VENDOR_ASSIGNED',
      entity_type: 'vendors',
      entity_id: vendorId,
      details: { employee_id, company_name: vendor.company_name },
    }).catch(() => {});

    return res.json({ success: true, vendor: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ GET /categories/micro/:microId/meta — get micro-category metadata
router.get('/categories/micro/:microId/meta', async (req, res) => {
  try {
    const { microId } = req.params;
    const { data, error } = await supabase
      .from('micro_category_meta')
      .select('*')
      .eq('micro_category_id', microId)
      .maybeSingle();

    if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
      return res.json({ success: true, meta: null });
    }
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, meta: data || null });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ POST /categories/micro/meta — create micro-category metadata
router.post('/categories/micro/meta', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.micro_category_id) {
      return res.status(400).json({ success: false, error: 'micro_category_id is required' });
    }

    const { data, error } = await supabase
      .from('micro_category_meta')
      .insert([{ ...payload, created_at: new Date().toISOString() }])
      .select('*')
      .maybeSingle();

    if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
      return res.json({ success: true, meta: payload });
    }
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.status(201).json({ success: true, meta: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ POST /categories/micro/meta/:id — update micro-category metadata
router.post('/categories/micro/meta/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};

    const { data, error } = await supabase
      .from('micro_category_meta')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();

    if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
      return res.json({ success: true, meta: payload });
    }
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, meta: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ DELETE /categories/micro/meta/:id — delete micro-category metadata
router.delete('/categories/micro/meta/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('micro_category_meta').delete().eq('id', id);

    if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
      return res.json({ success: true });
    }
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
