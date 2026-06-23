import { randomUUID } from 'crypto';
import { db } from '../lib/dbClient.js';
import { normalizePlanFeatures, VENDOR_PLAN_CATALOG } from '../lib/vendorPlanCatalog.js';

const nowIso = () => new Date().toISOString();

const buildPayload = (plan) => ({
  name: plan.name,
  description: plan.description || '',
  price: Number(plan.price || 0),
  daily_limit: Math.max(0, Number(plan.daily_limit || 0)),
  weekly_limit: Math.max(0, Number(plan.weekly_limit || 0)),
  yearly_limit: Math.max(0, Number(plan.yearly_limit || 0)),
  duration_days: Math.max(1, Number(plan.duration_days || 365)),
  is_active: plan.is_active !== false,
  features: normalizePlanFeatures(plan.features || {}),
});

async function upsertPlan(plan) {
  const payload = buildPayload(plan);
  const { data: existing, error: findError } = await db
    .from('vendor_plans')
    .select('id, name')
    .eq('name', payload.name)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to find plan ${payload.name}: ${findError.message}`);
  }

  if (existing?.id) {
    const { data, error } = await db
      .from('vendor_plans')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`Failed to update plan ${payload.name}: ${error.message}`);
    return { action: 'updated', plan: data || { id: existing.id, ...payload } };
  }

  const insertPayload = {
    id: randomUUID(),
    ...payload,
    created_at: nowIso(),
  };
  const { data, error } = await db
    .from('vendor_plans')
    .insert([insertPayload])
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`Failed to create plan ${payload.name}: ${error.message}`);
  return { action: 'created', plan: data || insertPayload };
}

async function syncActiveQuotaForPlan(plan) {
  if (!plan?.id) return 0;

  const { data: subscriptions, error: subError } = await db
    .from('vendor_plan_subscriptions')
    .select('vendor_id')
    .eq('plan_id', plan.id)
    .eq('status', 'ACTIVE');

  if (subError) {
    throw new Error(`Failed to load subscriptions for ${plan.name}: ${subError.message}`);
  }

  const vendorIds = Array.from(new Set((subscriptions || []).map((row) => row?.vendor_id).filter(Boolean)));
  if (!vendorIds.length) return 0;

  const { error: quotaError } = await db
    .from('vendor_lead_quota')
    .update({
      plan_id: plan.id,
      daily_limit: Number(plan.daily_limit || 0),
      weekly_limit: Number(plan.weekly_limit || 0),
      yearly_limit: Number(plan.yearly_limit || 0),
      updated_at: nowIso(),
    })
    .in('vendor_id', vendorIds);

  if (quotaError) {
    throw new Error(`Failed to sync quota for ${plan.name}: ${quotaError.message}`);
  }

  return vendorIds.length;
}

async function main() {
  console.log(`Seeding ${VENDOR_PLAN_CATALOG.length} vendor plans...`);
  const results = [];
  const activeCatalogNames = VENDOR_PLAN_CATALOG.map((plan) => plan.name);
  for (const plan of VENDOR_PLAN_CATALOG) {
    // eslint-disable-next-line no-await-in-loop
    const result = await upsertPlan(plan);
    results.push(result);
    console.log(`${result.action.toUpperCase()}: ${result.plan.name} (${result.plan.price})`);
  }

  if (process.env.KEEP_OLD_VENDOR_PLANS !== 'true') {
    const activeNameSet = new Set(activeCatalogNames);
    const { data: oldPlans, error: oldPlansError } = await db
      .from('vendor_plans')
      .select('id, name, is_active')
      .eq('is_active', true);

    if (oldPlansError) {
      throw new Error(`Failed to inspect old plans: ${oldPlansError.message}`);
    }

    const oldCatalogPlans = (oldPlans || [])
      .filter((plan) => !activeNameSet.has(String(plan?.name || '').trim()))
      .filter((plan) => plan?.id);

    let hardDeletedOld = 0;
    let hiddenOld = 0;
    for (const oldPlan of oldCatalogPlans) {
      // eslint-disable-next-line no-await-in-loop
      const [{ count: subscriptionCount }, { count: paymentCount }] = await Promise.all([
        db.from('vendor_plan_subscriptions').select('id', { head: true, count: 'exact' }).eq('plan_id', oldPlan.id),
        db.from('vendor_payments').select('id', { head: true, count: 'exact' }).eq('plan_id', oldPlan.id),
      ]);

      if ((subscriptionCount || 0) > 0 || (paymentCount || 0) > 0) {
        // eslint-disable-next-line no-await-in-loop
        const { error: deactivateError } = await db
          .from('vendor_plans')
          .update({ is_active: false })
          .eq('id', oldPlan.id);
        if (deactivateError) {
          throw new Error(`Failed to deactivate old plan ${oldPlan.name}: ${deactivateError.message}`);
        }
        hiddenOld += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const { error: deleteError } = await db.from('vendor_plans').delete().eq('id', oldPlan.id);
      if (deleteError) {
        // eslint-disable-next-line no-await-in-loop
        const { error: deactivateError } = await db
          .from('vendor_plans')
          .update({ is_active: false })
          .eq('id', oldPlan.id);
        if (deactivateError) {
          throw new Error(`Failed to remove old plan ${oldPlan.name}: ${deleteError.message}`);
        }
        hiddenOld += 1;
      } else {
        hardDeletedOld += 1;
      }
    }

    if (oldCatalogPlans.length) {
      console.log(`CLEANED_OLD: ${hardDeletedOld} deleted, ${hiddenOld} hidden`);
    }
  }

  const created = results.filter((row) => row.action === 'created').length;
  const updated = results.filter((row) => row.action === 'updated').length;
  let quotaSynced = 0;
  for (const result of results) {
    // eslint-disable-next-line no-await-in-loop
    quotaSynced += await syncActiveQuotaForPlan(result.plan);
  }
  console.log(`Done. Created: ${created}, Updated: ${updated}`);
  console.log(`Quota snapshots synced for active subscriptions: ${quotaSynced}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
