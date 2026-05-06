import { supabase } from './supabaseClient.js';

function getIpAddress(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  if (forwardedFor && typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = req?.headers?.['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    return realIp.trim();
  }

  return (
    req?.ip ||
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    null
  );
}

function normalizeActor(actor) {
  if (!actor) return null;
  return {
    id: actor.id || null,
    type: actor.type || 'UNKNOWN',
    role: actor.role || null,
    email: actor.email || null,
  };
}

/**
 * Centralized audit logger.
 * We store actor metadata inside details so Super Admin can see
 * who performed the action even when user_id is not a public.users row.
 */
export async function writeAuditLog({
  req,
  actor = null,
  action,
  entityType,
  entityId = null,
  details = {},
}) {
  if (!action || !entityType) return;

  const safeActor = normalizeActor(actor);
  const actorDetails = safeActor
    ? {
        actor_id: safeActor.id,
        actor_type: safeActor.type,
        actor_role: safeActor.role,
        actor_email: safeActor.email,
      }
    : {};

  const payload = {
    user_id: safeActor?.id || null,
    action: String(action),
    entity_type: String(entityType),
    entity_id: entityId ? String(entityId) : null,
    details: {
      ...actorDetails,
      ...details,
    },
    ip_address: getIpAddress(req),
    created_at: new Date().toISOString(),
  };

  try {
    await supabase.from('audit_logs').insert([payload]);
  } catch (error) {
    // Audit failures should never break business flows.
    // Keep this noisy for debugging but non-fatal.
    console.error('[Audit] Failed to write audit log:', error?.message || error);
  }
}

