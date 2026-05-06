const LEAD_CONSUMPTION_STATUS_BY_CODE = {
  INVALID_INPUT: 400,
  LEAD_NOT_FOUND: 404,
  LEAD_UNAVAILABLE: 409,
  LEAD_NOT_PURCHASABLE: 409,
  LEAD_CAP_REACHED: 409,
  SUBSCRIPTION_INACTIVE: 403,
  PAID_REQUIRED: 402,
};

const INCLUDED_CONSUMPTION_TYPES = new Set(["DAILY_INCLUDED", "WEEKLY_INCLUDED"]);
const PAID_CONSUMPTION_MODES = new Set(["BUY_EXTRA", "PAID"]);
const MAX_VENDORS_PER_LEAD = 5;

const normalizeLeadConsumptionMode = (value) => {
  const mode = String(value || "").trim().toUpperCase();
  if (mode === "USE_WEEKLY") return "USE_WEEKLY";
  if (mode === "BUY_EXTRA") return "BUY_EXTRA";
  if (mode === "PAID") return "PAID";
  return "AUTO";
};

const toPositiveCount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const toPositiveAmount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
};

const toIsoUtcDayStart = (baseDate = new Date()) => {
  const date = new Date(baseDate);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};

const toIsoUtcWeekStart = (baseDate = new Date()) => {
  const date = new Date(baseDate);
  const day = date.getUTCDay(); // 0=Sun, 1=Mon
  const delta = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + delta);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};

const toDateSafe = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getPurchaseTimestamp = (row = {}) =>
  row?.purchase_datetime ||
  row?.purchase_date ||
  row?.updated_at ||
  row?.created_at ||
  null;

const isUniqueViolationError = (error) => {
  const code = String(error?.code || "").trim();
  if (code === "23505") return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("duplicate key") || message.includes("unique");
};

const isSchemaCompatibilityError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  if (!message) return false;

  if (message.includes("daily_reset_at")) return true;
  if (message.includes("weekly_reset_at")) return true;
  if (message.includes("consume_vendor_lead") && message.includes("does not exist")) return true;

  return false;
};

const buildResultEnvelope = (result = {}) => {
  if (result?.success) {
    return {
      success: true,
      payload: result,
    };
  }

  const code = String(result?.code || "CONSUMPTION_FAILED").trim().toUpperCase();
  return {
    success: false,
    statusCode: LEAD_CONSUMPTION_STATUS_BY_CODE[code] || 400,
    code,
    error: result?.error || "Lead consumption failed",
    payload: result && typeof result === "object" ? result : {},
  };
};

const readActiveSubscription = async (supabase, vendorId) => {
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from("vendor_plan_subscriptions")
    .select("id, plan_id, status, start_date, end_date")
    .eq("vendor_id", vendorId)
    .eq("status", "ACTIVE")
    .order("end_date", { ascending: false, nullsFirst: false })
    .order("start_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(error.message || "Failed to validate subscription");
  }

  const active = (rows || []).find((row) => !row?.end_date || String(row.end_date) > nowIso);
  if (!active) {
    return {
      subscription: null,
      plan: null,
      planName: "",
      limits: { daily: 0, weekly: 0, yearly: 0 },
    };
  }

  let plan = null;
  if (active.plan_id) {
    const { data: planRow, error: planError } = await supabase
      .from("vendor_plans")
      .select("id, name, daily_limit, weekly_limit, yearly_limit")
      .eq("id", active.plan_id)
      .maybeSingle();

    if (planError) {
      throw new Error(planError.message || "Failed to load subscription plan");
    }
    plan = planRow || null;
  }

  const limits = {
    daily: toPositiveCount(plan?.daily_limit),
    weekly: toPositiveCount(plan?.weekly_limit),
    yearly: 0,
  };

  return {
    subscription: active,
    plan,
    planName: String(plan?.name || "").trim(),
    limits,
  };
};

const readIncludedUsage = async (supabase, vendorId, now = new Date()) => {
  const dayStartIso = toIsoUtcDayStart(now);
  const weekStartIso = toIsoUtcWeekStart(now);

  // Only fetch included-quota purchases from this week (covers both daily & weekly).
  const { data: rows, error } = await supabase
    .from("lead_purchases")
    .select("consumption_type, purchase_datetime, purchase_date")
    .eq("vendor_id", vendorId)
    .in("consumption_type", ["DAILY_INCLUDED", "WEEKLY_INCLUDED"])
    .gte("purchase_datetime", weekStartIso);

  if (error) {
    // Fallback: purchase_datetime column may not exist on older schemas.
    const isColumnError = String(error.message || "").toLowerCase().includes("does not exist");
    if (!isColumnError) {
      throw new Error(error.message || "Failed to read lead purchase usage");
    }

    // Retry with purchase_date for legacy schemas.
    const { data: legacyRows, error: legacyError } = await supabase
      .from("lead_purchases")
      .select("consumption_type, purchase_date")
      .eq("vendor_id", vendorId)
      .in("consumption_type", ["DAILY_INCLUDED", "WEEKLY_INCLUDED"])
      .gte("purchase_date", weekStartIso);

    if (legacyError) {
      throw new Error(legacyError.message || "Failed to read lead purchase usage");
    }

    return countIncludedUsage(legacyRows, dayStartIso, weekStartIso);
  }

  return countIncludedUsage(rows, dayStartIso, weekStartIso);
};

const countIncludedUsage = (rows, dayStartIso, weekStartIso) => {
  const dayStart = new Date(dayStartIso);
  const weekStart = new Date(weekStartIso);
  const usage = { daily: 0, weekly: 0, yearly: 0 };

  (rows || []).forEach((row) => {
    const type = String(row?.consumption_type || "").trim().toUpperCase();
    if (!INCLUDED_CONSUMPTION_TYPES.has(type)) return;

    const timestamp = toDateSafe(getPurchaseTimestamp(row));
    if (!timestamp) return;

    if (timestamp >= weekStart) usage.weekly += 1;
    if (type === "DAILY_INCLUDED" && timestamp >= dayStart) usage.daily += 1;
  });

  return usage;
};

const readExistingPurchase = async (supabase, vendorId, leadId) => {
  const { data: rows, error } = await supabase
    .from("lead_purchases")
    .select("*")
    .eq("vendor_id", vendorId)
    .eq("lead_id", leadId)
    .limit(1);

  if (error) {
    throw new Error(error.message || "Failed to validate lead purchase");
  }

  return Array.isArray(rows) && rows.length ? rows[0] : null;
};

const insertPurchaseCompat = async ({
  supabase,
  vendorId,
  leadId,
  consumptionType,
  purchasePrice,
  subscriptionPlanName,
  nowIso,
}) => {
  const richPayload = {
    vendor_id: vendorId,
    lead_id: leadId,
    amount: purchasePrice,
    payment_status: "COMPLETED",
    purchase_date: nowIso,
    consumption_type: consumptionType,
    purchase_price: purchasePrice,
    purchase_datetime: nowIso,
    subscription_plan_name: subscriptionPlanName || "",
    lead_status: "ACTIVE",
    updated_at: nowIso,
  };

  const richInsert = await supabase.from("lead_purchases").insert([richPayload]).select("*").limit(1);
  if (!richInsert.error) {
    const inserted = Array.isArray(richInsert.data) && richInsert.data.length ? richInsert.data[0] : null;
    if (inserted) return inserted;
  } else if (isUniqueViolationError(richInsert.error)) {
    const existing = await readExistingPurchase(supabase, vendorId, leadId);
    if (existing) return existing;
  }

  if (!richInsert.error) {
    throw new Error("Failed to record lead purchase");
  }

  const errorMessage = String(richInsert.error.message || "").toLowerCase();
  if (!errorMessage.includes("column") || !errorMessage.includes("does not exist")) {
    throw new Error(richInsert.error.message || "Failed to record lead purchase");
  }

  const legacyPayload = {
    vendor_id: vendorId,
    lead_id: leadId,
    amount: purchasePrice,
    payment_status: "COMPLETED",
    purchase_date: nowIso,
  };

  const legacyInsert = await supabase
    .from("lead_purchases")
    .insert([legacyPayload])
    .select("*")
    .limit(1);

  if (!legacyInsert.error) {
    const inserted = Array.isArray(legacyInsert.data) && legacyInsert.data.length ? legacyInsert.data[0] : null;
    if (inserted) return inserted;
    throw new Error("Failed to record lead purchase");
  }

  if (isUniqueViolationError(legacyInsert.error)) {
    const existing = await readExistingPurchase(supabase, vendorId, leadId);
    if (existing) return existing;
  }

  throw new Error(legacyInsert.error.message || "Failed to record lead purchase");
};

const syncQuotaSnapshot = async ({
  supabase,
  vendorId,
  planId,
  limits,
  usage,
  nowIso,
}) => {
  try {
    const payload = {
      plan_id: planId || null,
      daily_limit: limits.daily,
      weekly_limit: limits.weekly,
      yearly_limit: 0,
      daily_used: usage.daily,
      weekly_used: usage.weekly,
      yearly_used: 0,
      updated_at: nowIso,
    };

    const { data: quotaRow, error: quotaReadError } = await supabase
      .from("vendor_lead_quota")
      .select("*")
      .eq("vendor_id", vendorId)
      .maybeSingle();

    if (quotaReadError && String(quotaReadError.code || "") !== "PGRST116") {
      return;
    }

    if (quotaRow) {
      await supabase.from("vendor_lead_quota").update(payload).eq("vendor_id", vendorId);
      return;
    }

    await supabase
      .from("vendor_lead_quota")
      .insert([{ vendor_id: vendorId, ...payload }]);
  } catch {
    // Quota snapshot update is best-effort for legacy DB compatibility.
  }
};

const consumeLeadForVendorLegacy = async ({
  supabase,
  vendorId,
  leadId,
  mode = "AUTO",
  purchasePrice = 0,
}) => {
  if (!vendorId || !leadId) {
    return {
      success: false,
      code: "INVALID_INPUT",
      error: "vendor_id and lead_id are required",
    };
  }

  const normalizedMode = normalizeLeadConsumptionMode(mode);
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (leadError) {
    throw new Error(leadError.message || "Failed to fetch lead");
  }
  if (!lead) {
    return {
      success: false,
      code: "LEAD_NOT_FOUND",
      error: "Lead not found",
    };
  }

  const leadStatus = String(lead?.status || "").trim().toUpperCase();
  if (leadStatus && !["AVAILABLE", "PURCHASED"].includes(leadStatus)) {
    return {
      success: false,
      code: "LEAD_UNAVAILABLE",
      error: "Lead no longer available",
    };
  }

  if (lead?.vendor_id && String(lead.vendor_id) !== String(vendorId)) {
    return {
      success: false,
      code: "LEAD_NOT_PURCHASABLE",
      error: "This lead is not purchasable",
    };
  }

  const subscriptionData = await readActiveSubscription(supabase, vendorId);
  const { subscription, limits, planName } = subscriptionData;

  if (!subscription) {
    return {
      success: false,
      code: "SUBSCRIPTION_INACTIVE",
      error: "No active subscription plan",
      moved_to_my_leads: false,
    };
  }

  const usage = await readIncludedUsage(supabase, vendorId, now);
  let dailyRemaining = Math.max(0, limits.daily - usage.daily);
  let weeklyRemaining = Math.max(0, limits.weekly - usage.weekly);

  const existingPurchase = await readExistingPurchase(supabase, vendorId, leadId);
  if (existingPurchase) {
    return {
      success: true,
      existing_purchase: true,
      consumption_type: String(existingPurchase?.consumption_type || "PAID_EXTRA").toUpperCase(),
      remaining: {
        daily: dailyRemaining,
        weekly: weeklyRemaining,
        yearly: 0,
      },
      moved_to_my_leads: true,
      purchase_datetime:
        existingPurchase?.purchase_datetime ||
        existingPurchase?.purchase_date ||
        nowIso,
      plan_name:
        existingPurchase?.subscription_plan_name ||
        planName ||
        "",
      subscription_plan_name:
        existingPurchase?.subscription_plan_name ||
        planName ||
        "",
      lead_status: existingPurchase?.lead_status || "ACTIVE",
      purchase: existingPurchase,
    };
  }

  const { count: leadPurchaseCount, error: countError } = await supabase
    .from("lead_purchases")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId);

  if (countError) {
    throw new Error(countError.message || "Failed to validate lead capacity");
  }

  if ((leadPurchaseCount || 0) >= MAX_VENDORS_PER_LEAD) {
    return {
      success: false,
      code: "LEAD_CAP_REACHED",
      error: `This lead has reached maximum ${MAX_VENDORS_PER_LEAD} vendors limit`,
    };
  }

  const wantsPaid = PAID_CONSUMPTION_MODES.has(normalizedMode);
  let consumptionType = null;

  if (dailyRemaining > 0) {
    consumptionType = wantsPaid ? "PAID_EXTRA" : "DAILY_INCLUDED";
  } else if (weeklyRemaining > 0) {
    consumptionType = wantsPaid ? "PAID_EXTRA" : "WEEKLY_INCLUDED";
  } else {
    if (!wantsPaid) {
      return {
        success: false,
        code: "PAID_REQUIRED",
        error: "Included quota exhausted. Paid consumption required.",
        remaining: {
          daily: dailyRemaining,
          weekly: weeklyRemaining,
          yearly: 0,
        },
        subscription_plan_name: planName || "",
        moved_to_my_leads: false,
      };
    }
    consumptionType = "PAID_EXTRA";
  }

  const effectivePurchasePrice = consumptionType === "PAID_EXTRA"
    ? toPositiveAmount(purchasePrice)
    : 0;

  const purchaseRow = await insertPurchaseCompat({
    supabase,
    vendorId,
    leadId,
    consumptionType,
    purchasePrice: effectivePurchasePrice,
    subscriptionPlanName: planName,
    nowIso,
  });

  if (consumptionType === "DAILY_INCLUDED") {
    usage.daily += 1;
    usage.weekly += 1;
  } else if (consumptionType === "WEEKLY_INCLUDED") {
    usage.weekly += 1;
  }

  dailyRemaining = Math.max(0, limits.daily - usage.daily);
  weeklyRemaining = Math.max(0, limits.weekly - usage.weekly);

  await syncQuotaSnapshot({
    supabase,
    vendorId,
    planId: subscription?.plan_id || null,
    limits,
    usage,
    nowIso,
  });

  await supabase
    .from("leads")
    .update({ status: "PURCHASED" })
    .eq("id", leadId);

  return {
    success: true,
    existing_purchase: false,
    consumption_type: consumptionType,
    remaining: {
      daily: dailyRemaining,
      weekly: weeklyRemaining,
      yearly: 0,
    },
    moved_to_my_leads: true,
    purchase_datetime:
      purchaseRow?.purchase_datetime ||
      purchaseRow?.purchase_date ||
      nowIso,
    plan_name: planName || "",
    subscription_plan_name: planName || "",
    lead_status: purchaseRow?.lead_status || "ACTIVE",
    purchase: purchaseRow || null,
  };
};

export async function consumeLeadForVendorWithCompat({
  supabase,
  vendorId,
  leadId,
  mode = "AUTO",
  purchasePrice = 0,
}) {
  const normalizedMode = normalizeLeadConsumptionMode(mode);
  const safePrice = toPositiveAmount(purchasePrice);

  // Lead flow now uses daily + weekly quota only.
  // Prefer the JS compatibility path so behavior stays consistent
  // even if an older database RPC still enforces yearly limits.
  const fallbackResult = await consumeLeadForVendorLegacy({
    supabase,
    vendorId,
    leadId,
    mode: normalizedMode,
    purchasePrice: safePrice,
  });

  return buildResultEnvelope(fallbackResult);
}
