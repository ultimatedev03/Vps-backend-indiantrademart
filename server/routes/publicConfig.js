import express from 'express';
import { supabase } from '../lib/supabaseClient.js';

const router = express.Router();

const MAINTENANCE_KEY = 'maintenance_mode';

const defaultPublicConfig = {
  maintenance_mode: false,
  maintenance_message: '',
  public_notice_enabled: false,
  public_notice_message: '',
  public_notice_variant: 'info',
};

const toPublicConfig = (row = null) => ({
  maintenance_mode: row?.maintenance_mode === true,
  maintenance_message: row?.maintenance_message || '',
  public_notice_enabled: row?.public_notice_enabled === true,
  public_notice_message: row?.public_notice_message || '',
  public_notice_variant: row?.public_notice_variant || 'info',
});

router.get('/system-config', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('maintenance_mode, maintenance_message, public_notice_enabled, public_notice_message, public_notice_variant')
      .eq('config_key', MAINTENANCE_KEY)
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      config: data ? toPublicConfig(data) : defaultPublicConfig,
    });
  } catch (error) {
    console.error('[publicConfig] system-config fetch failed:', error);
    res.status(200).json({
      success: true,
      degraded: true,
      config: defaultPublicConfig,
    });
  }
});

router.get('/page-status', async (req, res) => {
  try {
    const route = String(req.query.route || '').trim();
    let query = supabase
      .from('page_status')
      .select('page_route, is_blanked, error_message, updated_at')
      .order('updated_at', { ascending: false });

    if (route) {
      query = query.eq('page_route', route).limit(1);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      success: true,
      statuses: Array.isArray(data) ? data : [],
    });
  } catch (error) {
    console.error('[publicConfig] page-status fetch failed:', error);
    res.status(200).json({
      success: true,
      degraded: true,
      statuses: [],
    });
  }
});

export default router;
