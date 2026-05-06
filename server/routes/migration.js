import { logger } from '../utils/logger.js';
import express from 'express';
import { supabase } from '../lib/supabaseClient.js';

const router = express.Router();

// Helper function to generate vendor ID
function generateVendorId(ownerName = '', companyName = '', phone = '') {
  // First 4 letters of owner name (uppercase), padded with X if needed
  let part1 = ownerName
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4)
    .padEnd(4, 'X');

  // First 4 letters of company name (uppercase), padded with Z if needed
  let part2 = companyName
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4)
    .padEnd(4, 'Z');

  // Last 2 digits of phone number, or 2 random digits if not available
  let part3 = phone 
    ? phone.replace(/\D/g, '').slice(-2).padStart(2, '0') 
    : Math.floor(Math.random() * 100).toString().padStart(2, '0');

  // 2 random digits
  const part4 = Math.floor(Math.random() * 100).toString().padStart(2, '0');

  return `${part1}-V-${part2}-${part3}${part4}`;
}

// POST /api/migration/vendor-ids/migrate-single - Migrate a single vendor
router.post('/vendor-ids/migrate-single', async (req, res) => {
  try {
    const { vendorId } = req.body;

    if (!vendorId) {
      return res.status(400).json({ error: 'Vendor ID is required' });
    }

    // Get vendor data
    const { data: vendor, error: vendorError } = await supabase
      .from('vendors')
      .select('id, owner_name, company_name, phone, vendor_id')
      .eq('id', vendorId)
      .single();

    if (vendorError || !vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // Check if already migrated
    if (vendor.vendor_id && vendor.vendor_id.includes('-V-')) {
      return res.status(200).json({
        success: true,
        message: 'Already migrated',
        vendorId: vendor.vendor_id,
        skipped: true
      });
    }

    // Generate vendor ID
    let newVendorId = generateVendorId(vendor.owner_name, vendor.company_name, vendor.phone);
    let attempts = 0;
    let isUnique = false;

    // Ensure uniqueness
    while (!isUnique && attempts < 10) {
      const { data: existing } = await supabase
        .from('vendors')
        .select('id')
        .eq('vendor_id', newVendorId)
        .maybeSingle();

      if (!existing) {
        isUnique = true;
      } else {
        newVendorId = generateVendorId(vendor.owner_name, vendor.company_name, vendor.phone);
        attempts++;
      }
    }

    if (!isUnique) {
      return res.status(500).json({ error: 'Could not generate unique vendor ID' });
    }

    // Update vendor in database
    const { error: updateError } = await supabase
      .from('vendors')
      .update({ vendor_id: newVendorId })
      .eq('id', vendorId);

    if (updateError) {
      logger.error('Update error:', updateError);
      return res.status(500).json({ error: 'Failed to update vendor: ' + updateError.message });
    }

    logger.log(`✅ Migrated vendor ${vendorId}: ${newVendorId}`);

    res.json({
      success: true,
      message: 'Vendor migrated successfully',
      vendorId: newVendorId
    });

  } catch (error) {
    logger.error('Migration error:', error);
    res.status(500).json({ error: error.message || 'Migration failed' });
  }
});

// POST /api/migration/vendor-ids/migrate-all - Migrate all pending vendors
router.post('/vendor-ids/migrate-all', async (req, res) => {
  try {
    // Get all vendors without proper vendor_id
    const { data: vendors, error: vendorsError } = await supabase
      .from('vendors')
      .select('id, owner_name, company_name, phone, vendor_id')
      .order('created_at', { ascending: false });

    if (vendorsError) {
      return res.status(500).json({ error: 'Failed to fetch vendors: ' + vendorsError.message });
    }

    // Filter pending vendors
    const pendingVendors = (vendors || []).filter(v => !v.vendor_id || !v.vendor_id.includes('-V-'));

    if (pendingVendors.length === 0) {
      return res.json({
        success: true,
        message: 'All vendors are already migrated',
        migrated: 0,
        total: vendors?.length || 0
      });
    }

    const results = [];
    let successful = 0;
    let failed = 0;

    // Migrate each vendor
    for (const vendor of pendingVendors) {
      try {
        // Generate vendor ID
        let newVendorId = generateVendorId(vendor.owner_name, vendor.company_name, vendor.phone);
        let attempts = 0;
        let isUnique = false;

        // Ensure uniqueness
        while (!isUnique && attempts < 10) {
          const { data: existing } = await supabase
            .from('vendors')
            .select('id')
            .eq('vendor_id', newVendorId)
            .maybeSingle();

          if (!existing) {
            isUnique = true;
          } else {
            newVendorId = generateVendorId(vendor.owner_name, vendor.company_name, vendor.phone);
            attempts++;
          }
        }

        if (!isUnique) {
          throw new Error('Could not generate unique vendor ID');
        }

        // Update vendor in database
        const { error: updateError } = await supabase
          .from('vendors')
          .update({ vendor_id: newVendorId })
          .eq('id', vendor.id);

        if (updateError) throw updateError;

        logger.log(`✅ Migrated vendor ${vendor.id}: ${newVendorId}`);
        results.push({
          vendorId: vendor.id,
          status: 'success',
          newVendorId
        });
        successful++;
      } catch (error) {
        logger.error(`❌ Failed to migrate vendor ${vendor.id}:`, error);
        results.push({
          vendorId: vendor.id,
          status: 'error',
          error: error.message
        });
        failed++;
      }
    }

    res.json({
      success: true,
      message: `Migration complete: ${successful} successful, ${failed} failed`,
      migrated: successful,
      failed,
      total: pendingVendors.length,
      results
    });

  } catch (error) {
    logger.error('Batch migration error:', error);
    res.status(500).json({ error: error.message || 'Batch migration failed' });
  }
});

export default router;
