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

async function main() {
  console.log(`Seeding ${VENDOR_PLAN_CATALOG.length} vendor plans...`);
  const results = [];
  for (const plan of VENDOR_PLAN_CATALOG) {
    // eslint-disable-next-line no-await-in-loop
    const result = await upsertPlan(plan);
    results.push(result);
    console.log(`${result.action.toUpperCase()}: ${result.plan.name} (${result.plan.price})`);
  }

  const created = results.filter((row) => row.action === 'created').length;
  const updated = results.filter((row) => row.action === 'updated').length;
  console.log(`Done. Created: ${created}, Updated: ${updated}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
