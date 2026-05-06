import { supabase } from '../lib/supabaseClient.js';
import { normalizeRole } from '../lib/auth.js';
import { requireAuth } from './requireAuth.js';

export function requireEmployeeRoles(allowedRoles = []) {
  const allowed = (allowedRoles || []).map(normalizeRole).filter(Boolean);
  const baseAuth = requireAuth();

  return async (req, res, next) => {
    baseAuth(req, res, async () => {
      try {
        const authUser = req.user;
        if (!authUser?.id) {
          return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { data: employee, error: empError } = await supabase
          .from('employees')
          .select('*')
          .or(
            [
              `user_id.eq.${authUser.id}`,
              authUser.email ? `email.eq.${authUser.email}` : null,
            ]
              .filter(Boolean)
              .join(',')
          )
          .maybeSingle();

        if (empError) {
          return res.status(500).json({ success: false, error: empError.message });
        }

        if (!employee) {
          return res.status(403).json({ success: false, error: 'Employee profile not found' });
        }

        const role = normalizeRole(employee.role);
        const status = normalizeRole(employee.status || 'ACTIVE');

        if (status !== 'ACTIVE') {
          return res.status(403).json({ success: false, error: 'Employee account is not active' });
        }

        if (allowed.length > 0 && !allowed.includes(role)) {
          return res.status(403).json({ success: false, error: 'Insufficient role permissions' });
        }

        if (!employee.user_id && authUser.id) {
          await supabase.from('employees').update({ user_id: authUser.id }).eq('id', employee.id);
        }

        req.employee = employee;
        req.actor = {
          id: authUser.id,
          type: 'EMPLOYEE',
          role,
          email: authUser.email || employee.email || null,
        };

        return next();
      } catch (error) {
        console.error('[Auth] Employee role check failed:', error?.message || error);
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
    });
  };
}
