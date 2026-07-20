import test from 'node:test';
import assert from 'node:assert/strict';
import { findMonthlyTrialUsage } from './monthlyTrialUsage.js';

function createClient(resultsByTable) {
  const queries = [];

  return {
    queries,
    from(table) {
      const query = { table, filters: [], orders: [] };
      queries.push(query);

      const builder = {
        select(columns) {
          query.columns = columns;
          return builder;
        },
        eq(column, value) {
          query.filters.push({ operation: 'eq', column, value });
          return builder;
        },
        in(column, value) {
          query.filters.push({ operation: 'in', column, value });
          return builder;
        },
        order(column, options) {
          query.orders.push({ column, options });
          return builder;
        },
        limit(value) {
          query.limit = value;
          return Promise.resolve(resultsByTable[table] || { data: [], error: null });
        },
      };

      return builder;
    },
  };
}

test('monthly trial history uses the canonical subscription and payment timestamps', async () => {
  const client = createClient({
    vendor_plan_subscriptions: { data: [], error: null },
    vendor_payments: {
      data: [{ id: 'payment-1', payment_date: '2026-07-20T05:00:00.000Z' }],
      error: null,
    },
  });

  const usage = await findMonthlyTrialUsage(client, 'vendor-1');

  assert.equal(usage.source, 'PAYMENT');
  assert.equal(client.queries[0].orders[0].column, 'start_date');
  assert.equal(client.queries[1].orders[0].column, 'payment_date');
  assert.doesNotMatch(client.queries[0].columns, /created_at/);
  assert.doesNotMatch(client.queries[1].columns, /created_at/);
});

test('existing monthly subscription prevents a redundant payment lookup', async () => {
  const client = createClient({
    vendor_plan_subscriptions: {
      data: [{ id: 'subscription-1', start_date: '2026-07-19T05:00:00.000Z' }],
      error: null,
    },
  });

  const usage = await findMonthlyTrialUsage(client, 'vendor-1');

  assert.equal(usage.source, 'SUBSCRIPTION');
  assert.equal(client.queries.length, 1);
});

test('monthly trial history surfaces database errors', async () => {
  const client = createClient({
    vendor_plan_subscriptions: { data: null, error: { message: 'database unavailable' } },
  });

  await assert.rejects(
    () => findMonthlyTrialUsage(client, 'vendor-1'),
    /database unavailable/
  );
});
