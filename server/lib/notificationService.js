import { supabase } from './supabaseClient.js';

/**
 * Send a renewal reminder notification to a vendor
 * Called when subscription is 7 days away from expiration
 */
export async function sendRenewalReminder(vendorId, planName, expiryDate) {
  try {
    // Get vendor details to find associated user
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('user_id, company_name')
      .eq('id', vendorId)
      .single();

    if (vendorError || !vendor?.user_id) {
      console.error('Error fetching vendor:', vendorError);
      return null;
    }

    const formattedDate = new Date(expiryDate).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Create notification record
    const { data: notification, error: notificationError } = await supabase
      .from('notifications')
      .insert([
        {
          user_id: vendor.user_id,
          type: 'PLAN_EXPIRING',
          title: 'Your subscription plan is expiring soon',
          message: `Your ${planName} plan for ${vendor.company_name} will expire on ${formattedDate}. Please renew your subscription to continue enjoying premium features.`,
          link: '/vendor/subscriptions',
          is_read: false
        }
      ])
      .select();

    if (notificationError) {
      console.error('Error creating renewal reminder notification:', notificationError);
      return null;
    }

    console.log(`✅ Renewal reminder sent for vendor ${vendorId} (${vendor.company_name})`);
    return notification?.[0];
  } catch (error) {
    console.error('Error sending renewal reminder:', error);
    return null;
  }
}

/**
 * Send expiration warning notification
 * Called when subscription has already expired
 */
export async function sendExpirationWarning(vendorId, planName) {
  try {
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('user_id, company_name')
      .eq('id', vendorId)
      .single();

    if (vendorError || !vendor?.user_id) {
      console.error('Error fetching vendor:', vendorError);
      return null;
    }

    const { data: notification, error: notificationError } = await supabase
      .from('notifications')
      .insert([
        {
          user_id: vendor.user_id,
          type: 'PLAN_EXPIRED',
          title: 'Your subscription plan has expired',
          message: `Your ${planName} subscription has expired. Renew now to restore access to premium features and leads.`,
          link: '/vendor/subscriptions',
          is_read: false
        }
      ])
      .select();

    if (notificationError) {
      console.error('Error creating expiration warning notification:', notificationError);
      return null;
    }

    console.log(`⚠️  Expiration warning sent for vendor ${vendorId}`);
    return notification?.[0];
  } catch (error) {
    console.error('Error sending expiration warning:', error);
    return null;
  }
}

/**
 * Send subscription activated notification
 * Called when vendor successfully activates a new plan
 */
export async function sendSubscriptionActivatedNotification(vendorId, planName, expiryDate) {
  try {
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('user_id, company_name')
      .eq('id', vendorId)
      .single();

    if (vendorError || !vendor?.user_id) {
      console.error('Error fetching vendor:', vendorError);
      return null;
    }

    const formattedDate = new Date(expiryDate).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const { data: notification, error: notificationError } = await supabase
      .from('notifications')
      .insert([
        {
          user_id: vendor.user_id,
          type: 'PLAN_ACTIVATED',
          title: 'Subscription activated successfully',
          message: `Your ${planName} plan has been activated and will be valid until ${formattedDate}. You now have access to all premium features.`,
          link: '/vendor/subscriptions',
          is_read: false
        }
      ])
      .select();

    if (notificationError) {
      console.error('Error creating activation notification:', notificationError);
      return null;
    }

    console.log(`✅ Subscription activated notification sent for vendor ${vendorId}`);
    return notification?.[0];
  } catch (error) {
    console.error('Error sending activation notification:', error);
    return null;
  }
}

/**
 * Send subscription renewed notification
 * Called when vendor renews their subscription
 */
export async function sendSubscriptionRenewedNotification(vendorId, planName, newExpiryDate) {
  try {
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('user_id, company_name')
      .eq('id', vendorId)
      .single();

    if (vendorError || !vendor?.user_id) {
      console.error('Error fetching vendor:', vendorError);
      return null;
    }

    const formattedDate = new Date(newExpiryDate).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const { data: notification, error: notificationError } = await supabase
      .from('notifications')
      .insert([
        {
          user_id: vendor.user_id,
          type: 'PLAN_RENEWED',
          title: 'Subscription renewed successfully',
          message: `Your ${planName} plan has been renewed and will be valid until ${formattedDate}.`,
          link: '/vendor/subscriptions',
          is_read: false
        }
      ])
      .select();

    if (notificationError) {
      console.error('Error creating renewal notification:', notificationError);
      return null;
    }

    console.log(`✅ Subscription renewed notification sent for vendor ${vendorId}`);
    return notification?.[0];
  } catch (error) {
    console.error('Error sending renewal notification:', error);
    return null;
  }
}

/**
 * Mark renewal notification as sent in the subscription record
 */
export async function markRenewalNotificationSent(subscriptionId) {
  try {
    const { error } = await supabase
      .from('vendor_plan_subscriptions')
      .update({
        renewal_notification_sent: true,
        renewal_notification_sent_at: new Date().toISOString()
      })
      .eq('id', subscriptionId);

    if (error) {
      console.error('Error marking renewal notification as sent:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error in markRenewalNotificationSent:', error);
    return false;
  }
}
