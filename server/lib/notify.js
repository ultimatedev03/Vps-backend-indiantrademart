import { supabase } from "./supabaseClient.js";
import { upsertPublicUser } from "./auth.js";
import { buildAuthLookupMap, loadAuthLookupCache } from "./authLookupCache.js";

const nowIso = () => new Date().toISOString();

const normalizeRole = (role) => String(role || "").trim().toUpperCase();
const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const ROLE_ALIASES = {
  ADMIN: ["ADMIN"],
  SUPERADMIN: ["SUPERADMIN", "SUPER_ADMIN"],
  SUPER_ADMIN: ["SUPERADMIN", "SUPER_ADMIN"],
  SUPPORT: ["SUPPORT"],
  SALES: ["SALES"],
  HR: ["HR"],
  FINANCE: ["FINANCE"],
  DATA_ENTRY: ["DATA_ENTRY", "DATAENTRY", "DATA ENTRY"],
  DATAENTRY: ["DATA_ENTRY", "DATAENTRY", "DATA ENTRY"],
  "DATA ENTRY": ["DATA_ENTRY", "DATAENTRY", "DATA ENTRY"],
};

const resolveRoleCandidates = (role) => {
  const normalized = normalizeRole(role);
  const aliases = ROLE_ALIASES[normalized] || [normalized];
  return Array.from(new Set(aliases.map(normalizeRole).filter(Boolean)));
};

async function getPublicUserById(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) return null;
  const { data: byId, error: byIdError } = await supabase
    .from("users")
    .select("id, email, role, full_name")
    .eq("id", safeUserId)
    .maybeSingle();
  if (byIdError) return null;
  return byId || null;
}

async function getPublicUserByEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return null;
  const { data: byEmailRows, error: byEmailError } = await supabase
    .from("users")
    .select("id, email, role, full_name")
    .ilike("email", safeEmail)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (byEmailError) return null;
  if (!Array.isArray(byEmailRows) || !byEmailRows[0]?.id) return null;
  return byEmailRows[0];
}

async function getAuthUserIdById(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) return null;
  const { data, error } = await supabase.auth.admin.getUserById(safeUserId);
  if (error || !data?.user?.id) return null;
  return String(data.user.id);
}

async function loadAuthLookupByEmail(force = false) {
  return loadAuthLookupCache({
    force,
    loader: async () => {
      const { data, error } = await supabase.auth.admin.listUsers();
      if (error) return null;
      return buildAuthLookupMap(data?.users || []);
    },
  });
}

async function getAuthUserIdByEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return null;

  const cached = await loadAuthLookupByEmail(false);
  if (cached.has(safeEmail)) return cached.get(safeEmail);

  const refreshed = await loadAuthLookupByEmail(true);
  return refreshed.has(safeEmail) ? refreshed.get(safeEmail) : null;
}

async function resolveAuthUserId({ userId, email }) {
  const byId = await getAuthUserIdById(userId);
  if (byId) return byId;

  const byEmail = await getAuthUserIdByEmail(email);
  if (byEmail) return byEmail;

  return null;
}

async function resolveIdentityFromProfiles({ userId, email }) {
  const safeUserId = String(userId || "").trim();
  const safeEmail = normalizeEmail(email);

  if (safeUserId || safeEmail) {
    const empFilters = [
      safeUserId ? `user_id.eq.${safeUserId}` : null,
      safeEmail ? `email.eq.${safeEmail}` : null,
    ]
      .filter(Boolean)
      .join(",");

    if (empFilters) {
      const { data: employee, error: empError } = await supabase
        .from("employees")
        .select("email, role, full_name")
        .or(empFilters)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!empError && employee?.email) {
        return {
          email: employee.email,
          role: normalizeRole(employee.role || "USER"),
          full_name: employee.full_name || null,
        };
      }
    }
  }

  if (safeUserId || safeEmail) {
    const vendorFilters = [
      safeUserId ? `user_id.eq.${safeUserId}` : null,
      safeEmail ? `email.eq.${safeEmail}` : null,
    ]
      .filter(Boolean)
      .join(",");

    if (vendorFilters) {
      const { data: vendor, error: vendorError } = await supabase
        .from("vendors")
        .select("email, owner_name, company_name")
        .or(vendorFilters)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!vendorError && vendor?.email) {
        return {
          email: vendor.email,
          role: "VENDOR",
          full_name: vendor.owner_name || vendor.company_name || null,
        };
      }
    }
  }

  if (safeUserId || safeEmail) {
    const buyerFilters = [
      safeUserId ? `user_id.eq.${safeUserId}` : null,
      safeEmail ? `email.eq.${safeEmail}` : null,
    ]
      .filter(Boolean)
      .join(",");

    if (buyerFilters) {
      const { data: buyer, error: buyerError } = await supabase
        .from("buyers")
        .select("email, full_name, company_name")
        .or(buyerFilters)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!buyerError && buyer?.email) {
        return {
          email: buyer.email,
          role: "BUYER",
          full_name: buyer.full_name || buyer.company_name || null,
        };
      }
    }
  }

  return {
    email: safeEmail || null,
    role: "USER",
    full_name: null,
  };
}

async function resolveUserId({ userId, email, role, fullName }) {
  const safeUserId = String(userId || "").trim();
  const safeEmail = normalizeEmail(email);

  const directAuthUserId = await resolveAuthUserId({
    userId: safeUserId || null,
    email: safeEmail || null,
  });
  if (directAuthUserId) return directAuthUserId;

  const byId = await getPublicUserById(safeUserId);
  const byEmail = await getPublicUserByEmail(safeEmail);

  const profileIdentity = await resolveIdentityFromProfiles({
    userId: safeUserId || byId?.id || byEmail?.id || null,
    email: safeEmail || byId?.email || byEmail?.email || null,
  });

  const resolvedEmail = normalizeEmail(
    safeEmail || byId?.email || byEmail?.email || profileIdentity?.email
  );
  if (!resolvedEmail) return null;

  const authUserId = await resolveAuthUserId({
    userId: safeUserId || byId?.id || byEmail?.id || null,
    email: resolvedEmail,
  });
  if (!authUserId) return null;

  try {
    await upsertPublicUser({
      id: authUserId,
      email: resolvedEmail,
      full_name:
        String(fullName || "").trim() ||
        String(profileIdentity?.full_name || "").trim() ||
        resolvedEmail.split("@")[0],
      role: normalizeRole(role || profileIdentity?.role || "USER"),
      allowPasswordUpdate: false,
    });
  } catch {
    // ignore public-user sync errors; auth id is still valid for notifications
  }

  return authUserId;
}

const buildNotification = ({ user_id, type, title, message, link }) => ({
  user_id,
  type: type || "INFO",
  title: title || "Notification",
  message: message || "",
  link: link || null,
  is_read: false,
  created_at: nowIso(),
});

export async function notifyUser(payload) {
  try {
    const userId = await resolveUserId({
      userId: payload?.user_id,
      email: payload?.email || payload?.user_email || null,
      role: payload?.role || null,
      fullName: payload?.full_name || payload?.name || null,
    });
    if (!userId) return null;
    const { data, error } = await supabase
      .from("notifications")
      .insert([buildNotification({ ...payload, user_id: userId })])
      .select()
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

export async function notifyUsers(userIds = [], payload) {
  try {
    const ids = Array.from(
      new Set((userIds || []).map((id) => String(id || "").trim()).filter(Boolean))
    );
    if (!ids.length) return [];
    const rows = ids.map((id) => buildNotification({ ...payload, user_id: id }));
    const { data, error } = await supabase
      .from("notifications")
      .insert(rows)
      .select();
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

export async function notifyRole(role, payload) {
  try {
    const roleCandidates = resolveRoleCandidates(role);
    if (!roleCandidates.length) return [];
    const { data: employees, error } = await supabase
      .from("employees")
      .select("user_id, email, status, role, full_name");
    if (error || !employees?.length) return [];
    const activeEmployees = employees.filter(
      (e) =>
        roleCandidates.includes(normalizeRole(e?.role)) &&
        (!e.status || String(e.status).toUpperCase() === "ACTIVE")
    );
    const resolvedIds = await Promise.all(
      activeEmployees.map((emp) =>
        resolveUserId({
          userId: emp?.user_id,
          email: emp?.email,
          role: emp?.role,
          fullName: emp?.full_name,
        })
      )
    );
    const activeIds = resolvedIds.filter(Boolean);
    return notifyUsers(activeIds, payload);
  } catch {
    return [];
  }
}
