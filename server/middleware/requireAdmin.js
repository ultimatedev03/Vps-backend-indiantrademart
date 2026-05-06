import { supabase } from '../lib/supabaseClient.js';
import { normalizeRole } from '../lib/auth.js';
import { requireAuth } from './requireAuth.js';

export const requireAdmin = async (req, res, next) => {
  const baseAuth = requireAuth();
  baseAuth(req, res, async () => {
    try {
      const authUser = req.user;
      if (!authUser?.id) return res.status(401).json({ error: 'Unauthorized' });

      const { data: emp } = await supabase
        .from('employees')
        .select('role,status,email')
        .or(
          [
            `user_id.eq.${authUser.id}`,
            authUser.email ? `email.eq.${authUser.email}` : null,
          ]
            .filter(Boolean)
            .join(',')
        )
        .maybeSingle();

      if (!emp) return res.status(403).json({ error: 'Forbidden' });

      const role = normalizeRole(emp.role);
      const status = normalizeRole(emp.status || 'ACTIVE');

      if (status !== 'ACTIVE' || !['ADMIN', 'SUPERADMIN'].includes(role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      req.adminUser = authUser;
      req.actor = {
        id: authUser.id,
        type: 'EMPLOYEE',
        role,
        email: authUser.email || emp.email || null,
      };

      if (!emp.user_id && authUser.id) {
        await supabase.from('employees').update({ user_id: authUser.id }).eq('email', emp.email);
      }

      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  });
};
