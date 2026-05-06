import cron from 'node-cron';
import { supabase } from './supabaseClient.js';
import {
  sendRenewalReminder,
  markRenewalNotificationSent,
  sendExpirationWarning,
} from './notificationService.js';

// Supabase client is centralized in supabaseClient.js with robust env loading and dev fallback.

/**
 * Check subscriptions expiring in 7 days and send renewal reminders
 * Runs daily at 2 AM UTC
 */
function checkExpiringSubscriptions() {
  return cron.schedule(
    '0 2 * * *',
    async () => {
      console.log('🔍 Starting subscription expiration check...');

      try {
        const today = new Date();
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const sevenDaysFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

        // ✅ Subscriptions expiring between tomorrow and 7 days from now
        // ✅ and renewal notification not sent
        const { data: expiringSubscriptions, error } = await supabase
          .from('vendor_plan_subscriptions')
          .select(
            `
              id,
              vendor_id,
              end_date,
              status,
              plan_id,
              renewal_notification_sent,
              vendor_plans!inner(name)
            `
          )
          .eq('status', 'ACTIVE')
          .eq('renewal_notification_sent', false)
          .gte('end_date', tomorrow.toISOString())
          .lte('end_date', sevenDaysFromNow.toISOString());

        if (error) {
          console.error('❌ Error fetching expiring subscriptions:', error);
          return;
        }

        if (!expiringSubscriptions || expiringSubscriptions.length === 0) {
          console.log('✅ No subscriptions expiring in 7 days');
          return;
        }

        console.log(`📌 Found ${expiringSubscriptions.length} subscriptions expiring in 7 days`);

        for (const subscription of expiringSubscriptions) {
          try {
            const planName = subscription.vendor_plans?.name || 'Your subscription';
            const expiryDate = subscription.end_date;

            await sendRenewalReminder(subscription.vendor_id, planName, expiryDate);
            await markRenewalNotificationSent(subscription.id);

            console.log(`✅ Reminder sent for subscription: ${subscription.id}`);
          } catch (innerErr) {
            console.error(`❌ Failed processing subscription ${subscription.id}:`, innerErr);
          }
        }

        console.log(`✅ Sent ${expiringSubscriptions.length} renewal reminder notifications`);
      } catch (err) {
        console.error('❌ Error in checkExpiringSubscriptions:', err);
      }
    },
    { scheduled: true }
  );
}

/**
 * Check for already expired subscriptions and send warnings
 * Runs daily at 3 AM UTC
 */
function checkExpiredSubscriptions() {
  return cron.schedule(
    '0 3 * * *',
    async () => {
      console.log('⏰ Starting expired subscription check...');

      try {
        const now = new Date();

        // ✅ Subscriptions already expired but still ACTIVE
        const { data: expiredSubscriptions, error } = await supabase
          .from('vendor_plan_subscriptions')
          .select(
            `
              id,
              vendor_id,
              end_date,
              status,
              plan_id,
              vendor_plans!inner(name)
            `
          )
          .eq('status', 'ACTIVE')
          .lt('end_date', now.toISOString());

        if (error) {
          console.error('❌ Error fetching expired subscriptions:', error);
          return;
        }

        if (!expiredSubscriptions || expiredSubscriptions.length === 0) {
          console.log('✅ No expired subscriptions found');
          return;
        }

        console.log(`📌 Found ${expiredSubscriptions.length} expired subscriptions`);

        for (const subscription of expiredSubscriptions) {
          try {
            const planName = subscription.vendor_plans?.name || 'Your subscription';

            // Notify
            await sendExpirationWarning(subscription.vendor_id, planName);

            // Mark subscription EXPIRED
            const { error: updateError } = await supabase
              .from('vendor_plan_subscriptions')
              .update({ status: 'EXPIRED' })
              .eq('id', subscription.id);

            if (updateError) {
              console.error(`❌ Error updating subscription ${subscription.id}:`, updateError);
              continue;
            }

            // Disable quotas
            await updateVendorLeadQuotaOnExpiry(subscription.vendor_id);

            console.log(`✅ Marked expired & quota reset for subscription: ${subscription.id}`);
          } catch (innerErr) {
            console.error(`❌ Failed processing expired subscription ${subscription.id}:`, innerErr);
          }
        }

        console.log(`✅ Processed ${expiredSubscriptions.length} expired subscriptions`);
      } catch (err) {
        console.error('❌ Error in checkExpiredSubscriptions:', err);
      }
    },
    { scheduled: true }
  );
}

/**
 * Disable lead access when subscription expires
 */
async function updateVendorLeadQuotaOnExpiry(vendorId) {
  try {
    const { error } = await supabase
      .from('vendor_lead_quota')
      .update({
        daily_used: 0,
        daily_limit: 0,
        weekly_used: 0,
        weekly_limit: 0,
        yearly_used: 0,
        yearly_limit: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('vendor_id', vendorId);

    if (error) {
      console.error(`❌ Error updating quota for vendor ${vendorId}:`, error);
      return false;
    }

    console.log(`✅ Lead quota reset for vendor ${vendorId}`);
    return true;
  } catch (err) {
    console.error('❌ Error in updateVendorLeadQuotaOnExpiry:', err);
    return false;
  }
}

/**
 * Initialize subscription cron jobs
 */
export function initializeSubscriptionCronJobs() {
  try {
    console.log('🚀 Initializing subscription cron jobs...');

    checkExpiringSubscriptions();
    checkExpiredSubscriptions();

    console.log('✅ Subscription cron jobs initialized');
    console.log('   - Expiring subscriptions check: Daily at 2 AM UTC');
    console.log('   - Expired subscriptions check: Daily at 3 AM UTC');
  } catch (err) {
    console.error('❌ Error initializing subscription cron jobs:', err);
  }
}

/**
 * Summary for admin monitoring
 */
export async function getSubscriptionExpirationSummary() {
  try {
    const today = new Date();
    const sevenDaysFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    const { count: expiringSoonCount } = await supabase
      .from('vendor_plan_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ACTIVE')
      .gte('end_date', today.toISOString())
      .lte('end_date', sevenDaysFromNow.toISOString());

    const { count: expiringMonthCount } = await supabase
      .from('vendor_plan_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ACTIVE')
      .gte('end_date', today.toISOString())
      .lte('end_date', thirtyDaysFromNow.toISOString());

    const { count: expiredCount } = await supabase
      .from('vendor_plan_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'EXPIRED');

    return {
      expiring_in_7_days: expiringSoonCount || 0,
      expiring_in_30_days: expiringMonthCount || 0,
      already_expired: expiredCount || 0,
    };
  } catch (err) {
    console.error('❌ Error getting subscription expiration summary:', err);
    return {
      expiring_in_7_days: 0,
      expiring_in_30_days: 0,
      already_expired: 0,
    };
  }
}
