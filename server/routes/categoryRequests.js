import express from 'express';
import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabaseClient.js';
import { notifyUser, notifyRole } from '../lib/notify.js';
import { requireEmployeeRoles } from '../middleware/requireEmployeeRoles.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { normalizeEmail } from '../lib/auth.js';

const router = express.Router();

const nowIso = () => new Date().toISOString();

const normalizeStatus = (status) => String(status || '').trim().toUpperCase();

const makeTaskId = () => {
  if (typeof randomUUID === 'function') return randomUUID();
  return `catreq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const isActiveEmployee = (emp) => {
  const st = String(emp?.status || '').trim().toUpperCase();
  return !st || st === 'ACTIVE';
};

const pickRandom = (arr) => {
  if (!arr?.length) return null;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx] || null;
};

const resolveEmployeeUserId = async (emp) => {
  if (!emp || emp.user_id || !emp.email) return emp;
  try {
    const email = normalizeEmail(emp.email);
    if (!email) return emp;
    const { data: publicUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (!publicUser?.id) return emp;
    await supabase.from('employees').update({ user_id: publicUser.id }).eq('id', emp.id);
    return { ...emp, user_id: publicUser.id };
  } catch {
    return emp;
  }
};

const TASK_TYPE = 'CATEGORY_REQUEST';
const VALID_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'UNASSIGNED'];

// Vendor creates a category request -> assign to active data-entry and notify
router.post('/', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const authUser = req.user;

    const groupName = String(req.body?.group_name || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!groupName) {
      return res.status(400).json({ success: false, error: 'Group name is required' });
    }

    const { data: vendor, error: vErr } = await supabase
      .from('vendors')
      .select('id, company_name, user_id')
      .eq('user_id', authUser.id)
      .maybeSingle();

    if (vErr) {
      return res.status(500).json({ success: false, error: vErr.message });
    }
    if (!vendor) {
      return res.status(403).json({ success: false, error: 'Vendor profile not found' });
    }

    const { data: employees, error: eErr } = await supabase
      .from('employees')
      .select('id, user_id, full_name, email, status, role')
      .in('role', ['DATA_ENTRY', 'DATAENTRY']);

    if (eErr) {
      return res.status(500).json({ success: false, error: eErr.message });
    }

    const resolvedEmployees = await Promise.all((employees || []).map(resolveEmployeeUserId));

    const activeEmployees = resolvedEmployees
      .filter((e) => e?.user_id)
      .filter(isActiveEmployee);

    const assignee = pickRandom(activeEmployees);
    const assigneeName = assignee?.full_name || assignee?.email || null;
    const taskStatus = assignee ? 'ASSIGNED' : 'UNASSIGNED';

    // Create a support ticket record as audit trail (optional, but keeps legacy behavior)
    const ticketPayload = {
      subject: `Category request: ${groupName}`,
      description: note || 'Vendor requested a custom category/group that does not exist yet.',
      category: 'Category Request',
      priority: 'Medium',
      status: 'OPEN',
      vendor_id: vendor.id,
      created_at: nowIso(),
      attachments: {
        task_type: TASK_TYPE,
        task_status: taskStatus,
        group_name: groupName,
        note: note || null,
        vendor_id: vendor.id,
        vendor_name: vendor.company_name || null,
        created_by_user_id: authUser.id,
        assigned_to_user_id: assignee?.user_id || null,
        assigned_to_name: assigneeName,
      },
    };

    const { data: ticket } = await supabase
      .from('support_tickets')
      .insert([ticketPayload])
      .select()
      .maybeSingle();

    const taskId = ticket?.id || makeTaskId();
    const ticketLink = `/employee/dataentry/categories?category_request=${taskId}`;

    const baseMessage = [
      `Category request: ${groupName}`,
      `Vendor: ${vendor.company_name || 'Vendor'}`,
      note ? `Note: ${note}` : null,
      `Status: ${taskStatus}`,
      `Ticket: ${taskId}`,
    ].filter(Boolean).join(' | ');

    if (assignee?.user_id) {
      await notifyUser({
        user_id: assignee.user_id,
        type: TASK_TYPE,
        title: 'Category request assigned',
        message: baseMessage,
        link: ticketLink,
      });
    } else {
      // Fallback: notify all data-entry if no active assignee found
      await notifyRole('DATA_ENTRY', {
        type: TASK_TYPE,
        title: 'Category request (unassigned)',
        message: baseMessage,
        link: ticketLink,
      });
      await notifyRole('DATAENTRY', {
        type: TASK_TYPE,
        title: 'Category request (unassigned)',
        message: baseMessage,
        link: ticketLink,
      });
    }

    const adminTitle = assigneeName
      ? `Category request assigned to ${assigneeName}`
      : 'Category request (unassigned)';

    await notifyRole('ADMIN', {
      type: TASK_TYPE,
      title: adminTitle,
      message: `${baseMessage}${assigneeName ? ` | Assigned: ${assigneeName}` : ''}`,
      link: `/admin/dashboard?category_request=${taskId}`,
    });

    await notifyRole('SUPERADMIN', {
      type: TASK_TYPE,
      title: adminTitle,
      message: `${baseMessage}${assigneeName ? ` | Assigned: ${assigneeName}` : ''}`,
      link: `/admin/dashboard?category_request=${taskId}`,
    });

    return res.json({
      success: true,
      task_id: taskId,
      assigned_to: assignee?.user_id || null,
      assigned_name: assigneeName,
      ticket_id: ticket?.id || null,
      status: taskStatus,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error?.message || 'Failed to create category request' });
  }
});

// Update task status (data-entry or admin)
router.patch('/:taskId/status', requireEmployeeRoles(['DATA_ENTRY', 'ADMIN', 'SUPERADMIN']), async (req, res) => {
  try {
    const taskId = String(req.params?.taskId || '').trim();
    if (!taskId) return res.status(400).json({ success: false, error: 'Missing task id' });

    const nextStatus = normalizeStatus(req.body?.status);
    if (!VALID_STATUSES.includes(nextStatus)) {
      return res.status(400).json({ success: false, error: `Invalid status. Use: ${VALID_STATUSES.join(', ')}` });
    }

    const { data: ticket, error: tErr } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', taskId)
      .maybeSingle();

    if (tErr) {
      return res.status(500).json({ success: false, error: tErr.message });
    }
    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    // Data-entry can only update their own assigned task
    const actorRole = String(req.actor?.role || '').toUpperCase();
    const actorId = req.actor?.id || null;

    let canUpdate = true;
    let shouldClaim = false;
    if (actorRole === 'DATA_ENTRY') {
      const metaRaw = ticket?.attachments;
      const meta = metaRaw && typeof metaRaw === 'object' ? metaRaw : {};
      const assignedTo = meta?.assigned_to_user_id || null;
      const isAssigned = assignedTo && assignedTo === actorId;
      const isUnassigned = !assignedTo;

      if (!isAssigned && isUnassigned) {
        shouldClaim = true;
      } else if (!isAssigned) {
        canUpdate = false;
      }

      if (!canUpdate) {
        return res.status(403).json({ success: false, error: 'Not assigned to this task' });
      }
    }

    const statusAt = nowIso();
    const metaRaw = ticket?.attachments;
    const meta = metaRaw && typeof metaRaw === 'object' ? metaRaw : {};
    const updatedMeta = {
      ...meta,
      task_status: nextStatus,
      task_status_at: statusAt,
      task_status_by: actorId,
      task_status_by_role: actorRole || null,
      ...(shouldClaim
        ? {
            assigned_to_user_id: actorId,
            assigned_to_name: req.employee?.full_name || req.employee?.email || meta.assigned_to_name || null,
          }
        : {}),
    };

    const statusMap = {
      ASSIGNED: 'OPEN',
      IN_PROGRESS: 'IN_PROGRESS',
      DONE: 'CLOSED',
      CANCELLED: 'CLOSED',
      UNASSIGNED: 'OPEN',
    };
    const ticketStatus = statusMap[nextStatus] || 'OPEN';

    const { data: updatedTicket, error: updErr } = await supabase
      .from('support_tickets')
      .update({
        status: ticketStatus,
        attachments: updatedMeta,
      })
      .eq('id', taskId)
      .select()
      .maybeSingle();

    if (updErr) {
      return res.status(500).json({ success: false, error: updErr.message });
    }

    const groupName = updatedMeta?.group_name || ticket?.subject || 'Category request';
    const vendorName = updatedMeta?.vendor_name || 'Vendor';
    const assigneeName = updatedMeta?.assigned_to_name || null;
    const statusMessage = [
      `Category request update: ${groupName}`,
      `Vendor: ${vendorName}`,
      `Status: ${nextStatus}`,
      assigneeName ? `Assigned: ${assigneeName}` : null,
      `Ticket: ${taskId}`,
    ].filter(Boolean).join(' | ');

    await notifyRole('ADMIN', {
      type: TASK_TYPE,
      title: `Category request ${nextStatus}`,
      message: statusMessage,
      link: `/admin/dashboard?category_request=${taskId}`,
    });
    await notifyRole('SUPERADMIN', {
      type: TASK_TYPE,
      title: `Category request ${nextStatus}`,
      message: statusMessage,
      link: `/admin/dashboard?category_request=${taskId}`,
    });

    if (updatedMeta?.assigned_to_user_id) {
      await notifyUser({
        user_id: updatedMeta.assigned_to_user_id,
        type: TASK_TYPE,
        title: `Category request ${nextStatus}`,
        message: statusMessage,
        link: `/employee/dataentry/categories?category_request=${taskId}`,
      });
    }

    return res.json({ success: true, task_id: taskId, status: nextStatus, ticket: updatedTicket || null });
  } catch (error) {
    return res.status(500).json({ success: false, error: error?.message || 'Failed to update task' });
  }
});

export default router;
