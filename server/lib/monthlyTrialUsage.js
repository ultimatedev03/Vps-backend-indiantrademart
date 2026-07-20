export async function findMonthlyTrialUsage(client, vendorId) {
  const { data: subscriptionRows, error: subscriptionError } = await client
    .from('vendor_plan_subscriptions')
    .select('id, plan_id, billing_cycle, status, start_date, end_date')
    .eq('vendor_id', vendorId)
    .eq('billing_cycle', 'MONTHLY')
    .order('start_date', { ascending: true })
    .limit(1);

  if (subscriptionError) {
    throw new Error(subscriptionError.message || 'Failed to validate monthly trial history');
  }

  if (subscriptionRows?.[0]) {
    return { source: 'SUBSCRIPTION', ...subscriptionRows[0] };
  }

  const { data: paymentRows, error: paymentError } = await client
    .from('vendor_payments')
    .select('id, plan_id, subscription_id, billing_cycle, status, payment_date')
    .eq('vendor_id', vendorId)
    .eq('billing_cycle', 'MONTHLY')
    .in('status', ['COMPLETED', 'SUCCESS', 'PAID'])
    .order('payment_date', { ascending: true })
    .limit(1);

  if (paymentError) {
    throw new Error(paymentError.message || 'Failed to validate monthly payment history');
  }

  return paymentRows?.[0] ? { source: 'PAYMENT', ...paymentRows[0] } : null;
}
