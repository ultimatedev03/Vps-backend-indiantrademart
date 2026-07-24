import { createHash, randomUUID } from 'node:crypto';
import { mysqlQuery, withMysqlConnection } from './mysqlPool.js';

export const BULK_PLAN_SCOPES = Object.freeze({
  EXPIRED_LATEST_PLAN: 'EXPIRED_LATEST_PLAN',
  ACTIVE_PLAN: 'ACTIVE_PLAN',
});

const MAX_BULK_VENDORS = 20_000;
const WRITE_CHUNK_SIZE = 250;
const DEFAULT_SAMPLE_LIMIT = 20;

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const normalizeId = (value) => String(value || '').trim();

export const normalizeBulkPlanScope = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (Object.values(BULK_PLAN_SCOPES).includes(normalized)) return normalized;
  throw httpError(400, 'scope must be EXPIRED_LATEST_PLAN or ACTIVE_PLAN');
};

const normalizeDurationDays = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    const normalizedFallback = Math.floor(Number(fallback || 365));
    return Math.min(3660, Math.max(1, normalizedFallback || 365));
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3660) {
    throw httpError(400, 'duration_days must be between 1 and 3660');
  }
  return Math.floor(parsed);
};

const queryRows = async (connection, sql, params = []) => {
  if (!connection) return mysqlQuery(sql, params);
  const [rows] = await connection.query(sql, params);
  return rows;
};

const loadPlans = async (connection, sourcePlanId, targetPlanId, { lock = false } = {}) => {
  const ids = Array.from(new Set([sourcePlanId, targetPlanId].map(normalizeId).filter(Boolean)));
  if (ids.length < 1) throw httpError(400, 'source_plan_id and target_plan_id are required');

  const placeholders = ids.map(() => '?').join(',');
  const rows = await queryRows(
    connection,
    `SELECT id, name, description, price, daily_limit, weekly_limit, yearly_limit,
            duration_days, is_active
       FROM vendor_plans
      WHERE id IN (${placeholders})
      ${lock ? 'FOR UPDATE' : ''}`,
    ids
  );
  const plans = new Map((rows || []).map((plan) => [String(plan.id), plan]));
  const sourcePlan = plans.get(sourcePlanId);
  const targetPlan = plans.get(targetPlanId);

  if (!sourcePlan) throw httpError(404, 'Source subscription plan not found');
  if (!targetPlan) throw httpError(404, 'Target subscription plan not found');

  return { sourcePlan, targetPlan };
};

const rankedSubscriptionCtes = `
  WITH latest_subscriptions AS (
    SELECT s.*,
           ROW_NUMBER() OVER (
             PARTITION BY s.vendor_id
             ORDER BY COALESCE(s.start_date, s.created_at) DESC, s.created_at DESC, s.id DESC
           ) AS latest_rank
      FROM vendor_plan_subscriptions s
  ),
  active_subscriptions AS (
    SELECT s.*,
           ROW_NUMBER() OVER (
             PARTITION BY s.vendor_id
             ORDER BY COALESCE(s.start_date, s.created_at) DESC, s.created_at DESC, s.id DESC
           ) AS active_rank
      FROM vendor_plan_subscriptions s
     WHERE UPPER(COALESCE(s.status, '')) = 'ACTIVE'
       AND (s.end_date IS NULL OR s.end_date >= UTC_TIMESTAMP())
  )
`;

const candidateSelect = `
  SELECT v.id AS vendor_record_id,
         v.vendor_id AS vendor_code,
         v.user_id,
         v.company_name,
         v.owner_name,
         v.email,
         v.phone,
         source.id AS source_subscription_id,
         source.plan_id AS source_plan_id,
         source.status AS source_status,
         source.start_date AS source_start_date,
         source.end_date AS source_end_date
    FROM vendors v
`;

const loadCandidates = async (
  connection,
  { scope, sourcePlanId, limit = MAX_BULK_VENDORS + 1 }
) => {
  const normalizedScope = normalizeBulkPlanScope(scope);
  const safeSourcePlanId = normalizeId(sourcePlanId);
  if (!safeSourcePlanId) throw httpError(400, 'source_plan_id is required');

  let sql;
  if (normalizedScope === BULK_PLAN_SCOPES.EXPIRED_LATEST_PLAN) {
    sql = `
      ${rankedSubscriptionCtes}
      ${candidateSelect}
      JOIN latest_subscriptions source
        ON source.vendor_id = v.id
       AND source.latest_rank = 1
      LEFT JOIN active_subscriptions active
        ON active.vendor_id = v.id
       AND active.active_rank = 1
      WHERE source.plan_id = ?
        AND source.end_date IS NOT NULL
        AND source.end_date < UTC_TIMESTAMP()
        AND active.id IS NULL
      ORDER BY v.id
      LIMIT ?
    `;
  } else {
    sql = `
      ${rankedSubscriptionCtes}
      ${candidateSelect}
      JOIN active_subscriptions source
        ON source.vendor_id = v.id
       AND source.active_rank = 1
      WHERE source.plan_id = ?
      ORDER BY v.id
      LIMIT ?
    `;
  }

  return queryRows(connection, sql, [safeSourcePlanId, limit]);
};

const buildSelectionHash = ({
  scope,
  sourcePlanId,
  targetPlanId,
  durationDays,
  candidates,
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        scope,
        source_plan_id: sourcePlanId,
        target_plan_id: targetPlanId,
        duration_days: durationDays,
        vendor_ids: (candidates || []).map((row) => String(row.vendor_record_id)).sort(),
      })
    )
    .digest('hex');

const loadSourceHistoryCount = async (connection, sourcePlanId) => {
  const rows = await queryRows(
    connection,
    `SELECT COUNT(DISTINCT vendor_id) AS source_history_count
       FROM vendor_plan_subscriptions
      WHERE plan_id = ?`,
    [sourcePlanId]
  );
  return Number(rows?.[0]?.source_history_count || 0);
};

const buildPreview = async (
  connection,
  {
    scope,
    sourcePlanId,
    targetPlanId,
    durationDays: requestedDurationDays,
    sampleLimit = DEFAULT_SAMPLE_LIMIT,
    lockPlans = false,
  }
) => {
  const normalizedScope = normalizeBulkPlanScope(scope);
  const safeSourcePlanId = normalizeId(sourcePlanId);
  const safeTargetPlanId = normalizeId(targetPlanId);
  if (!safeSourcePlanId || !safeTargetPlanId) {
    throw httpError(400, 'source_plan_id and target_plan_id are required');
  }

  const { sourcePlan, targetPlan } = await loadPlans(
    connection,
    safeSourcePlanId,
    safeTargetPlanId,
    { lock: lockPlans }
  );
  const durationDays = normalizeDurationDays(requestedDurationDays, targetPlan.duration_days);
  const candidates = await loadCandidates(connection, {
    scope: normalizedScope,
    sourcePlanId: safeSourcePlanId,
  });

  if (candidates.length > MAX_BULK_VENDORS) {
    throw httpError(
      413,
      `Bulk operation is limited to ${MAX_BULK_VENDORS.toLocaleString('en-IN')} vendors at a time`
    );
  }

  const sourceHistoryCount = await loadSourceHistoryCount(connection, safeSourcePlanId);
  const selectionHash = buildSelectionHash({
    scope: normalizedScope,
    sourcePlanId: safeSourcePlanId,
    targetPlanId: safeTargetPlanId,
    durationDays,
    candidates,
  });

  return {
    scope: normalizedScope,
    source_plan: sourcePlan,
    target_plan: targetPlan,
    duration_days: durationDays,
    eligible_count: candidates.length,
    source_history_count: sourceHistoryCount,
    unchanged_source_history_count: Math.max(0, sourceHistoryCount - candidates.length),
    selection_hash: selectionHash,
    candidates,
    sample: candidates.slice(0, Math.min(50, Math.max(1, Number(sampleLimit) || DEFAULT_SAMPLE_LIMIT))),
  };
};

export const previewBulkVendorPlanActivation = async (input = {}) =>
  buildPreview(null, {
    scope: input.scope,
    sourcePlanId: input.source_plan_id || input.sourcePlanId,
    targetPlanId: input.target_plan_id || input.targetPlanId,
    durationDays: input.duration_days ?? input.durationDays,
    sampleLimit: input.sample_limit ?? input.sampleLimit,
  });

const chunkRows = (rows, size = WRITE_CHUNK_SIZE) => {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
};

const lockEligibleVendorState = async (connection, candidates) => {
  for (const chunk of chunkRows(candidates)) {
    const vendorIds = chunk.map((row) => row.vendor_record_id);
    const placeholders = vendorIds.map(() => '?').join(',');
    await connection.query(
      `SELECT id
         FROM vendors
        WHERE id IN (${placeholders})
        ORDER BY id
        FOR UPDATE`,
      vendorIds
    );
    await connection.query(
      `SELECT id
         FROM vendor_plan_subscriptions
        WHERE vendor_id IN (${placeholders})
        ORDER BY vendor_id, id
        FOR UPDATE`,
      vendorIds
    );
  }
};

const deactivateCurrentSubscriptions = async (connection, candidates) => {
  for (const chunk of chunkRows(candidates)) {
    const vendorIds = chunk.map((row) => row.vendor_record_id);
    const placeholders = vendorIds.map(() => '?').join(',');
    await connection.query(
      `UPDATE vendor_plan_subscriptions
          SET status = 'INACTIVE'
        WHERE vendor_id IN (${placeholders})
          AND UPPER(COALESCE(status, '')) = 'ACTIVE'`,
      vendorIds
    );
  }
};

const insertSubscriptions = async (
  connection,
  candidates,
  { targetPlanId, startDate, endDate, durationDays }
) => {
  const subscriptionIds = [];
  for (const chunk of chunkRows(candidates)) {
    const values = [];
    const params = [];
    for (const candidate of chunk) {
      const subscriptionId = randomUUID();
      subscriptionIds.push(subscriptionId);
      values.push("(?, ?, ?, ?, ?, 'ACTIVE', ?, 0, 0)");
      params.push(
        subscriptionId,
        candidate.vendor_record_id,
        targetPlanId,
        startDate,
        endDate,
        durationDays
      );
    }
    await connection.query(
      `INSERT INTO vendor_plan_subscriptions
        (id, vendor_id, plan_id, start_date, end_date, status, plan_duration_days,
         auto_renewal_enabled, renewal_notification_sent)
       VALUES ${values.join(',')}`,
      params
    );
  }
  return subscriptionIds;
};

const resetLeadQuotas = async (
  connection,
  candidates,
  { targetPlan, targetPlanId, startDate }
) => {
  for (const chunk of chunkRows(candidates)) {
    const values = [];
    const params = [];
    for (const candidate of chunk) {
      values.push('(?, ?, ?, 0, ?, 0, ?, 0, ?, ?, ?)');
      params.push(
        randomUUID(),
        candidate.vendor_record_id,
        targetPlanId,
        Math.max(0, Math.floor(Number(targetPlan.daily_limit || 0))),
        Math.max(0, Math.floor(Number(targetPlan.weekly_limit || 0))),
        Math.max(0, Math.floor(Number(targetPlan.yearly_limit || 0))),
        startDate,
        startDate
      );
    }
    await connection.query(
      `INSERT INTO vendor_lead_quota
        (id, vendor_id, plan_id, daily_used, daily_limit, weekly_used, weekly_limit,
         yearly_used, yearly_limit, last_reset_date, updated_at)
       VALUES ${values.join(',')}
       ON DUPLICATE KEY UPDATE
         plan_id = VALUES(plan_id),
         daily_used = 0,
         daily_limit = VALUES(daily_limit),
         weekly_used = 0,
         weekly_limit = VALUES(weekly_limit),
         yearly_used = 0,
         yearly_limit = VALUES(yearly_limit),
         last_reset_date = VALUES(last_reset_date),
         updated_at = VALUES(updated_at)`,
      params
    );
  }
};

const insertPlanNotifications = async (
  connection,
  candidates,
  { targetPlan, endDate }
) => {
  const recipients = Array.from(
    new Map(
      candidates
        .filter((candidate) => normalizeId(candidate.user_id))
        .map((candidate) => [normalizeId(candidate.user_id), candidate])
    ).values()
  );

  for (const chunk of chunkRows(recipients)) {
    const values = [];
    const params = [];
    for (const candidate of chunk) {
      values.push("(?, ?, 'PLAN_ACTIVATED', ?, ?, '/vendor/subscriptions', 0, ?)");
      params.push(
        randomUUID(),
        normalizeId(candidate.user_id),
        `${targetPlan.name || 'Subscription'} activated`,
        `Your ${targetPlan.name || 'subscription'} plan is active until ${endDate.toLocaleDateString(
          'en-IN'
        )}.`,
        new Date()
      );
    }
    await connection.query(
      `INSERT INTO notifications
        (id, user_id, type, title, message, link, is_read, created_at)
       VALUES ${values.join(',')}`,
      params
    );
  }

  return recipients.length;
};

export const applyBulkVendorPlanActivation = async (input = {}) => {
  const expectedSelectionHash = normalizeId(input.preview_hash || input.previewHash);
  if (!expectedSelectionHash) {
    throw httpError(400, 'preview_hash is required; preview the operation before applying it');
  }
  if (input.confirmation !== 'APPLY_BULK_PLAN') {
    throw httpError(400, 'Bulk plan confirmation is required');
  }

  return withMysqlConnection(async (connection) => {
    await connection.beginTransaction();
    try {
      const initialPreview = await buildPreview(connection, {
        scope: input.scope,
        sourcePlanId: input.source_plan_id || input.sourcePlanId,
        targetPlanId: input.target_plan_id || input.targetPlanId,
        durationDays: input.duration_days ?? input.durationDays,
        lockPlans: true,
      });

      if (!initialPreview.eligible_count) {
        throw httpError(409, 'No vendors currently match this bulk plan scope');
      }
      if (initialPreview.selection_hash !== expectedSelectionHash) {
        throw httpError(409, 'Vendor eligibility changed after preview. Preview again before applying.');
      }

      await lockEligibleVendorState(connection, initialPreview.candidates);

      const finalCandidates = await loadCandidates(connection, {
        scope: initialPreview.scope,
        sourcePlanId: initialPreview.source_plan.id,
      });
      const finalSelectionHash = buildSelectionHash({
        scope: initialPreview.scope,
        sourcePlanId: String(initialPreview.source_plan.id),
        targetPlanId: String(initialPreview.target_plan.id),
        durationDays: initialPreview.duration_days,
        candidates: finalCandidates,
      });

      if (finalSelectionHash !== expectedSelectionHash) {
        throw httpError(409, 'Vendor eligibility changed while applying. No plans were changed; preview again.');
      }

      const startDate = new Date();
      const endDate = new Date(
        startDate.getTime() + initialPreview.duration_days * 24 * 60 * 60 * 1000
      );

      await deactivateCurrentSubscriptions(connection, finalCandidates);
      const subscriptionIds = await insertSubscriptions(connection, finalCandidates, {
        targetPlanId: String(initialPreview.target_plan.id),
        startDate,
        endDate,
        durationDays: initialPreview.duration_days,
      });
      await resetLeadQuotas(connection, finalCandidates, {
        targetPlan: initialPreview.target_plan,
        targetPlanId: String(initialPreview.target_plan.id),
        startDate,
      });
      const notifiedCount = await insertPlanNotifications(connection, finalCandidates, {
        targetPlan: initialPreview.target_plan,
        endDate,
      });

      await connection.commit();

      return {
        scope: initialPreview.scope,
        source_plan: initialPreview.source_plan,
        target_plan: initialPreview.target_plan,
        duration_days: initialPreview.duration_days,
        activated_count: finalCandidates.length,
        started_at: startDate.toISOString(),
        ends_at: endDate.toISOString(),
        selection_hash: finalSelectionHash,
        candidates: finalCandidates,
        subscription_ids: subscriptionIds,
        notified_count: notifiedCount,
      };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    }
  });
};
