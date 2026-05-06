import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { notifyRole, notifyUser } from '../lib/notify.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

const nowIso = () => new Date().toISOString();

const normalizeSenderType = (v) => String(v || '').trim().toUpperCase();

const notifyAdmins = async (payload, { adminLink = null, supportLink = null } = {}) => {
  const adminPayload = {
    ...payload,
    link: adminLink || payload?.link || '/admin/tickets',
  };
  const supportPayload = {
    ...payload,
    link: supportLink || '/employee/support/dashboard',
  };

  await notifyRole('ADMIN', adminPayload);
  await notifyRole('SUPERADMIN', adminPayload);
  await notifyRole('SUPPORT', supportPayload);
};

const getTicketUsers = async (ticket) => {
  const vendorId = ticket?.vendor_id || null;
  const buyerId = ticket?.buyer_id || null;
  let vendorUserId = null;
  let vendorEmail = null;
  let buyerUserId = null;
  let buyerEmail = null;

  if (vendorId) {
    const { data } = await supabase
      .from('vendors')
      .select('user_id, email')
      .eq('id', vendorId)
      .maybeSingle();
    vendorUserId = data?.user_id || null;
    vendorEmail = data?.email || null;
  }

  if (buyerId) {
    const { data } = await supabase
      .from('buyers')
      .select('user_id, email')
      .eq('id', buyerId)
      .maybeSingle();
    buyerUserId = data?.user_id || null;
    buyerEmail = data?.email || null;
  }

  return { vendorUserId, vendorEmail, buyerUserId, buyerEmail };
};

// GET /api/support/tickets - Fetch all support tickets with filters
router.get('/tickets', async (req, res) => {
  try {
    const { status, priority, search, scope = 'ALL', page = 1, pageSize = 100 } = req.query;
    
    
    let query = supabase
      .from('support_tickets')
      .select('*, vendors(company_name, email, owner_name, vendor_id), buyers(id, full_name, email, company_name)', { count: 'exact' })
      .order('created_at', { ascending: false });
    
    // Apply status filter
    if (status && status !== 'ALL') {
      query = query.eq('status', status);
    }
    
    // Apply priority filter
    if (priority && priority !== 'ALL') {
      query = query.eq('priority', priority);
    }
    
    // Apply search filter (search across subject and description)
    if (search && search.trim()) {
      const searchTerm = search.toLowerCase();
      // Note: Supabase text search requires ilike operator
      query = query.or(`subject.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%,ticket_display_id.ilike.%${searchTerm}%`);
    }

    const scopeValue = String(scope || '').toUpperCase();
    if (scopeValue === 'VENDOR') {
      query = query.not('vendor_id', 'is', null);
    } else if (scopeValue === 'BUYER') {
      query = query.not('buyer_id', 'is', null);
    }
    
    // Apply pagination
    const offset = (page - 1) * pageSize;
    query = query.range(offset, offset + pageSize - 1);
    
    const { data: tickets, error, count } = await query;
    
    if (error) {
      logger.error('❌ Database error:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch tickets', 
        details: error.message 
      });
    }
    
    
    res.json({
      success: true,
      tickets: tickets || [],
      total: count || 0,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      totalPages: Math.ceil((count || 0) / pageSize)
    });
    
  } catch (error) {
    logger.error('❌ Error fetching tickets:', error);
    res.status(500).json({ 
      error: 'Failed to fetch support tickets', 
      details: error.message 
    });
  }
});

// GET /api/support/tickets/:id - Fetch single ticket
router.get('/tickets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    logger.log(`🔍 Fetching ticket: ${id}`);
    
    const { data: ticket, error } = await supabase
      .from('support_tickets')
      .select('*, vendors(company_name, email, owner_name, vendor_id), buyers(id, full_name, email, company_name)')
      .eq('id', id)
      .single();
    
    if (error || !ticket) {
      logger.error('❌ Ticket not found:', error);
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    res.json({
      success: true,
      ticket
    });
    
  } catch (error) {
    logger.error('❌ Error fetching ticket:', error);
    res.status(500).json({ 
      error: 'Failed to fetch ticket', 
      details: error.message 
    });
  }
});

// GET /api/support/tickets/:id/messages
router.get('/tickets/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('ticket_messages')
      .select('*')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }

    return res.json({ success: true, messages: data || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
});

// POST /api/support/tickets/:id/messages
router.post('/tickets/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, sender_type, sender_id } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const senderType = normalizeSenderType(sender_type) || 'SUPPORT';

    const { data: ticket, error: tErr } = await supabase
      .from('support_tickets')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (tErr || !ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    await supabase
      .from('support_tickets')
      .update({ last_reply_at: nowIso(), updated_at: nowIso() })
      .eq('id', id);

    const { data, error } = await supabase
      .from('ticket_messages')
      .insert([{
        ticket_id: id,
        sender_id: sender_id || null,
        sender_type: senderType,
        message: String(message || '').trim(),
        created_at: nowIso()
      }])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to send message', details: error.message });
    }

    const { vendorUserId, vendorEmail, buyerUserId, buyerEmail } = await getTicketUsers(ticket);
    const title = `Support ticket update: ${ticket.ticket_display_id || ticket.id}`;
    const linkBase = ticket.vendor_id ? '/vendor/support' : '/buyer/tickets';

    if (['SUPPORT', 'ADMIN', 'STAFF'].includes(senderType)) {
      if (vendorUserId || vendorEmail) {
        await notifyUser({
          user_id: vendorUserId,
          email: vendorEmail,
          type: 'SUPPORT_MESSAGE',
          title,
          message: String(message || '').trim(),
          link: linkBase,
        });
      }
      if (buyerUserId || buyerEmail) {
        await notifyUser({
          user_id: buyerUserId,
          email: buyerEmail,
          type: 'SUPPORT_MESSAGE',
          title,
          message: String(message || '').trim(),
          link: linkBase,
        });
      }
    } else {
      await notifyAdmins(
        {
        type: 'SUPPORT_MESSAGE',
        title,
        message: String(message || '').trim(),
      },
        {
          adminLink: '/admin/tickets',
          supportLink: ticket.vendor_id
            ? '/employee/support/tickets/vendor'
            : '/employee/support/tickets/buyer',
        }
      );
    }

    return res.json({ success: true, message: data });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

// POST /api/support/tickets - Create new support ticket
router.post('/tickets', async (req, res) => {
  try {
    const {
      subject,
      description,
      category,
      priority = 'MEDIUM',
      status = 'OPEN',
      vendor_id,
      buyer_id,
      attachments = []
    } = req.body;
    
    // Validate required fields
    if (!subject || !description) {
      return res.status(400).json({
        error: 'Missing required fields: subject and description'
      });
    }
    
    // Generate ticket display ID
    const ticketNumber = `TKT-${Date.now()}`;
    
    const ticketPayload = {
      subject: subject.trim(),
      description: description.trim(),
      category: category || 'General',
      priority: priority.toUpperCase(),
      status: status.toUpperCase(),
      vendor_id: vendor_id || null,
      buyer_id: buyer_id || null,
      ticket_display_id: ticketNumber,
      attachments: JSON.stringify(attachments),
      created_at: nowIso()
    };
    
    logger.log('📝 Creating support ticket:', ticketNumber);
    
    const { data: newTicket, error } = await supabase
      .from('support_tickets')
      .insert([ticketPayload])
      .select()
      .single();
    
    if (error) {
      logger.error('❌ Database error:', error);
      return res.status(500).json({
        error: 'Failed to create ticket',
        details: error.message
      });
    }
    
    logger.log('✅ Ticket created:', newTicket.id);

    await notifyAdmins(
      {
        type: 'SUPPORT_TICKET',
        title: `New support ticket: ${ticketNumber}`,
        message: subject.trim(),
      },
      {
        adminLink: '/admin/tickets',
        supportLink: newTicket?.vendor_id
          ? '/employee/support/tickets/vendor'
          : '/employee/support/tickets/buyer',
      }
    );

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      ticket: newTicket
    });
    
  } catch (error) {
    logger.error('❌ Error creating ticket:', error);
    res.status(500).json({
      error: 'Failed to create support ticket',
      details: error.message
    });
  }
});

// DELETE /api/support/tickets/:id - Delete ticket (vendor/buyer scoped)
router.delete('/tickets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const vendorId = String(body.vendor_id || req.query?.vendor_id || '').trim();
    const buyerId = String(body.buyer_id || req.query?.buyer_id || '').trim();

    if (!vendorId && !buyerId) {
      return res.status(400).json({
        success: false,
        error: 'vendor_id or buyer_id is required to delete ticket',
      });
    }

    let scopeQuery = supabase
      .from('support_tickets')
      .select('id')
      .eq('id', id);

    if (vendorId) scopeQuery = scopeQuery.eq('vendor_id', vendorId);
    if (buyerId) scopeQuery = scopeQuery.eq('buyer_id', buyerId);

    const { data: scopedTicket, error: scopedError } = await scopeQuery.maybeSingle();
    if (scopedError) {
      return res.status(500).json({
        success: false,
        error: 'Failed to validate ticket ownership',
        details: scopedError.message,
      });
    }

    if (!scopedTicket) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found or not allowed to delete',
      });
    }

    const { error: messageDeleteError } = await supabase
      .from('ticket_messages')
      .delete()
      .eq('ticket_id', id);

    if (messageDeleteError) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete ticket messages',
        details: messageDeleteError.message,
      });
    }

    const { data: deletedRows, error: deleteError } = await supabase
      .from('support_tickets')
      .delete()
      .eq('id', id)
      .select('id');

    if (deleteError) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete ticket',
        details: deleteError.message,
      });
    }

    if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found or already deleted',
      });
    }

    return res.json({ success: true, deleted: deletedRows[0]?.id || id });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to delete ticket',
      details: error.message,
    });
  }
});

// PATCH /api/support/tickets/:id - Update ticket
router.patch('/tickets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    logger.log(`🔄 Updating ticket ${id}:`, updates);
    
    // Sanitize updates - only allow specific fields
    const allowedFields = ['status', 'priority', 'category', 'attachments'];
    const sanitizedUpdates = {};
    
    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        sanitizedUpdates[key] = updates[key];
      }
    });
    
    if (Object.keys(sanitizedUpdates).length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update'
      });
    }
    
    const { data: updatedTicket, error } = await supabase
      .from('support_tickets')
      .update(sanitizedUpdates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) {
      logger.error('❌ Update error:', error);
      return res.status(500).json({
        error: 'Failed to update ticket',
        details: error.message
      });
    }
    
    if (!updatedTicket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    logger.log('✅ Ticket updated:', id);
    
    res.json({
      success: true,
      message: 'Ticket updated successfully',
      ticket: updatedTicket
    });
    
  } catch (error) {
    logger.error('❌ Error updating ticket:', error);
    res.status(500).json({
      error: 'Failed to update ticket',
      details: error.message
    });
  }
});

// PUT /api/support/tickets/:id/status - Update ticket status
router.put('/tickets/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    const validStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED'];
    
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }
    
    logger.log(`🔄 Updating ticket ${id} status to: ${status}`);
    
    const updatePayload = {
      status: status.toUpperCase()
    };
    
    // If resolving or closing, set resolved_at timestamp
    if (['RESOLVED', 'CLOSED'].includes(status.toUpperCase())) {
      updatePayload.resolved_at = nowIso();
    }
    
    const { data: updatedTicket, error } = await supabase
      .from('support_tickets')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();
    
    if (error) {
      logger.error('❌ Status update error:', error);
      return res.status(500).json({
        error: 'Failed to update ticket status',
        details: error.message
      });
    }
    
    if (!updatedTicket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    logger.log('✅ Ticket status updated:', id);

    if (updatedTicket) {
      const { vendorUserId, vendorEmail, buyerUserId, buyerEmail } = await getTicketUsers(updatedTicket);
      const title = `Ticket status updated: ${updatedTicket.ticket_display_id || updatedTicket.id}`;
      const message = `Status changed to ${updatePayload.status}`;
      if (vendorUserId || vendorEmail) {
        await notifyUser({
          user_id: vendorUserId,
          email: vendorEmail,
          type: 'SUPPORT_STATUS',
          title,
          message,
          link: '/vendor/support',
        });
      }
      if (buyerUserId || buyerEmail) {
        await notifyUser({
          user_id: buyerUserId,
          email: buyerEmail,
          type: 'SUPPORT_STATUS',
          title,
          message,
          link: '/buyer/tickets',
        });
      }
    }

    res.json({
      success: true,
      message: 'Ticket status updated successfully',
      ticket: updatedTicket
    });
    
  } catch (error) {
    logger.error('❌ Error updating status:', error);
    res.status(500).json({
      error: 'Failed to update ticket status',
      details: error.message
    });
  }
});

// POST /api/support/tickets/:id/notify-customer - Send bell notification to vendor/buyer
router.post('/tickets/:id/notify-customer', async (req, res) => {
  try {
    const { id } = req.params;
    const rawMessage = String(req.body?.message || '').trim();

    const { data: ticket, error: ticketError } = await supabase
      .from('support_tickets')
      .select('id, ticket_display_id, subject, description, category, vendor_id, buyer_id')
      .eq('id', id)
      .maybeSingle();

    if (ticketError || !ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const { vendorUserId, vendorEmail, buyerUserId, buyerEmail } = await getTicketUsers(ticket);
    if (!vendorUserId && !vendorEmail && !buyerUserId && !buyerEmail) {
      return res.status(400).json({ error: 'No linked vendor or buyer found for this ticket' });
    }

    const message = rawMessage || ticket.description || ticket.subject || 'Support update available';
    const title = ticket.subject
      ? `Support update: ${ticket.subject}`
      : `Support update: ${ticket.ticket_display_id || ticket.id}`;

    let sent = 0;
    if (vendorUserId || vendorEmail) {
      const vendorLink = String(ticket.category || '').toUpperCase().includes('KYC')
        ? '/vendor/profile?tab=kyc'
        : '/vendor/support';
      await notifyUser({
        user_id: vendorUserId,
        email: vendorEmail,
        type: 'SUPPORT_ALERT',
        title,
        message,
        link: vendorLink,
      });
      sent += 1;
    }
    if (buyerUserId || buyerEmail) {
      await notifyUser({
        user_id: buyerUserId,
        email: buyerEmail,
        type: 'SUPPORT_ALERT',
        title,
        message,
        link: '/buyer/tickets',
      });
      sent += 1;
    }

    return res.json({ success: true, notified: sent });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to notify customer',
      details: error.message,
    });
  }
});

// POST /api/support/tickets/:id/escalate - Notify internal Admin/Sales teams and track escalation
router.post('/tickets/:id/escalate', requireAuth({ roles: ['ADMIN', 'SUPPORT', 'SUPERADMIN', 'SALES'] }), async (req, res) => {
  try {
    const { id } = req.params;
    const actorRole = normalizeSenderType(req.actor?.role || req.user?.role);
    const targetRole = normalizeSenderType(req.body?.targetRole || req.body?.target_role);
    const rawMessage = String(req.body?.message || '').trim();
    const targetLabels = {
      ADMIN: 'Admin',
      SUPPORT: 'Support',
      SALES: 'Sales',
    };

    if (!['ADMIN', 'SUPPORT', 'SALES'].includes(targetRole)) {
      return res.status(400).json({ error: 'targetRole must be ADMIN, SUPPORT or SALES' });
    }

    if (actorRole === targetRole && ['ADMIN', 'SUPPORT', 'SALES'].includes(actorRole)) {
      return res.status(409).json({ error: `Cannot escalate a ticket to the same ${targetLabels[targetRole] || 'team'}.` });
    }

    const { data: ticket, error: ticketError } = await supabase
      .from('support_tickets')
      .select('id, ticket_display_id, subject, description, vendor_id, buyer_id')
      .eq('id', id)
      .maybeSingle();

    if (ticketError || !ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const entityLabel = ticket.vendor_id ? 'Vendor' : ticket.buyer_id ? 'Buyer' : 'Customer';
    const targetLabel = targetLabels[targetRole] || 'Internal Team';
    const message =
      rawMessage ||
      `Support escalated this ${entityLabel.toLowerCase()} issue to ${targetLabel} for review.`;
    const auditMessage = `[Escalated to ${targetLabel}] ${message}`;

    const { error: messageError } = await supabase
      .from('ticket_messages')
      .insert([{
        ticket_id: id,
        sender_id: null,
        sender_type: 'SUPPORT',
        message: auditMessage,
        created_at: nowIso(),
      }]);

    if (messageError) {
      return res.status(500).json({ error: 'Failed to record escalation', details: messageError.message });
    }

    await supabase
      .from('support_tickets')
      .update({ last_reply_at: nowIso(), updated_at: nowIso() })
      .eq('id', id);

    const title = `${targetLabel} escalation: ${ticket.ticket_display_id || ticket.id}`;
    const notificationMessage = [
      `${entityLabel} issue escalated from ${actorRole === 'ADMIN' ? 'Admin' : 'Support'}.`,
      ticket.subject ? `Subject: ${ticket.subject}.` : null,
      `Note: ${message}`,
    ]
      .filter(Boolean)
      .join(' ');

    if (targetRole === 'ADMIN') {
      await notifyRole('ADMIN', {
        type: 'SUPPORT_ESCALATION',
        title,
        message: notificationMessage,
        link: '/admin/tickets',
      });
      await notifyRole('SUPERADMIN', {
        type: 'SUPPORT_ESCALATION',
        title,
        message: notificationMessage,
        link: '/admin/tickets',
      });
    } else if (targetRole === 'SUPPORT') {
      await notifyRole('SUPPORT', {
        type: 'SUPPORT_ESCALATION',
        title,
        message: notificationMessage,
        link: ticket.vendor_id
          ? '/employee/support/tickets/vendor'
          : '/employee/support/tickets/buyer',
      });
    } else {
      await notifyRole('SALES', {
        type: 'SUPPORT_ESCALATION',
        title,
        message: notificationMessage,
        link: `/employee/sales/dashboard?ticket=${encodeURIComponent(ticket.id)}`,
      });
    }

    return res.json({
      success: true,
      ticketId: ticket.id,
      targetRole,
      message: auditMessage,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to escalate ticket',
      details: error.message,
    });
  }
});

// GET /api/support/stats - Get ticket statistics
router.get('/stats', async (req, res) => {
  try {
    logger.log('📊 Fetching ticket statistics');
    
    // Get count by status
    const { data: tickets, error } = await supabase
      .from('support_tickets')
      .select('status, priority');
    
    if (error) {
      logger.error('❌ Stats fetch error:', error);
      return res.status(500).json({
        error: 'Failed to fetch statistics',
        details: error.message
      });
    }
    
    const stats = {
      totalTickets: tickets?.length || 0,
      openTickets: 0,
      inProgressTickets: 0,
      resolvedTickets: 0,
      closedTickets: 0,
      highPriorityTickets: 0,
      mediumPriorityTickets: 0,
      lowPriorityTickets: 0,
      resolutionRate: 0
    };
    
    if (tickets && tickets.length > 0) {
      tickets.forEach(ticket => {
        // Count by status
        switch (ticket.status) {
          case 'OPEN':
            stats.openTickets++;
            break;
          case 'IN_PROGRESS':
            stats.inProgressTickets++;
            break;
          case 'RESOLVED':
            stats.resolvedTickets++;
            break;
          case 'CLOSED':
            stats.closedTickets++;
            break;
        }
        
        // Count by priority
        switch (ticket.priority) {
          case 'HIGH':
          case 'URGENT':
            stats.highPriorityTickets++;
            break;
          case 'MEDIUM':
            stats.mediumPriorityTickets++;
            break;
          case 'LOW':
            stats.lowPriorityTickets++;
            break;
        }
      });
      
      // Calculate resolution rate
      const resolved = stats.resolvedTickets + stats.closedTickets;
      stats.resolutionRate = stats.totalTickets > 0 
        ? Math.round((resolved / stats.totalTickets) * 100) 
        : 0;
    }
    
    logger.log('✅ Statistics calculated');
    
    res.json({
      success: true,
      stats
    });
    
  } catch (error) {
    logger.error('❌ Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      details: error.message
    });
  }
});

// GET /api/support/vendor/:vendorId - Get vendor's tickets
router.get('/vendor/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { status, priority } = req.query;
    
    logger.log(`🔍 Fetching tickets for vendor: ${vendorId}`);
    
    let query = supabase
      .from('support_tickets')
      .select('*')
      .eq('vendor_id', vendorId)
      .order('created_at', { ascending: false });
    
    if (status && status !== 'ALL') {
      query = query.eq('status', status);
    }
    
    if (priority && priority !== 'ALL') {
      query = query.eq('priority', priority);
    }
    
    const { data: tickets, error } = await query;
    
    if (error) {
      logger.error('❌ Database error:', error);
      return res.status(500).json({
        error: 'Failed to fetch vendor tickets',
        details: error.message
      });
    }
    
    res.json({
      success: true,
      tickets: tickets || [],
      total: tickets?.length || 0
    });
    
  } catch (error) {
    logger.error('❌ Error fetching vendor tickets:', error);
    res.status(500).json({
      error: 'Failed to fetch vendor tickets',
      details: error.message
    });
  }
});

// GET /api/support/buyer/:buyerId - Get buyer's tickets
router.get('/buyer/:buyerId', async (req, res) => {
  try {
    const { buyerId } = req.params;
    const { status, priority } = req.query;
    
    logger.log(`🔍 Fetching tickets for buyer: ${buyerId}`);
    
    let query = supabase
      .from('support_tickets')
      .select('*')
      .eq('buyer_id', buyerId)
      .order('created_at', { ascending: false });
    
    if (status && status !== 'ALL') {
      query = query.eq('status', status);
    }
    
    if (priority && priority !== 'ALL') {
      query = query.eq('priority', priority);
    }
    
    const { data: tickets, error } = await query;
    
    if (error) {
      logger.error('❌ Database error:', error);
      return res.status(500).json({
        error: 'Failed to fetch buyer tickets',
        details: error.message
      });
    }
    
    res.json({
      success: true,
      tickets: tickets || [],
      total: tickets?.length || 0
    });
    
  } catch (error) {
    logger.error('❌ Error fetching buyer tickets:', error);
    res.status(500).json({
      error: 'Failed to fetch buyer tickets',
      details: error.message
    });
  }
});

export default router;
