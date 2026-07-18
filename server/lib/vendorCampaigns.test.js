import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCampaignEffectiveStatus,
  isCampaignTargetedToVendor,
  normalizeCampaignRow,
  parseJsonArray,
} from './vendorCampaigns.js';

test('parseJsonArray accepts JSON arrays and rejects invalid values', () => {
  assert.deepEqual(parseJsonArray('["vendor-1", "vendor-2"]'), ['vendor-1', 'vendor-2']);
  assert.deepEqual(parseJsonArray('not-json'), []);
  assert.deepEqual(parseJsonArray({ vendor: 'vendor-1' }), []);
});

test('selected campaign targets only configured vendors', () => {
  const campaign = {
    target_type: 'SELECTED',
    target_vendor_ids: '["vendor-1", "vendor-2"]',
  };

  assert.equal(isCampaignTargetedToVendor(campaign, { id: 'vendor-2' }), true);
  assert.equal(isCampaignTargetedToVendor(campaign, { vendor_id: 'VENDOR-1' }), true);
  assert.equal(isCampaignTargetedToVendor(campaign, { id: 'vendor-3' }), false);
});

test('all-vendor campaign is applicable without a target list', () => {
  assert.equal(isCampaignTargetedToVendor({ target_type: 'ALL' }, { id: 'vendor-9' }), true);
});

test('campaign effective status follows activity and schedule', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');

  assert.equal(getCampaignEffectiveStatus({ is_active: false }, now), 'PAUSED');
  assert.equal(getCampaignEffectiveStatus({ is_active: true, deleted_at: now }, now), 'DELETED');
  assert.equal(getCampaignEffectiveStatus({
    is_active: true,
    starts_at: '2026-07-18T13:00:00.000Z',
    ends_at: '2026-07-19T13:00:00.000Z',
  }, now), 'SCHEDULED');
  assert.equal(getCampaignEffectiveStatus({
    is_active: true,
    starts_at: '2026-07-17T13:00:00.000Z',
    ends_at: '2026-07-18T11:00:00.000Z',
  }, now), 'EXPIRED');
  assert.equal(getCampaignEffectiveStatus({
    is_active: true,
    starts_at: '2026-07-18T11:00:00.000Z',
    ends_at: '2026-07-18T13:00:00.000Z',
  }, now), 'ACTIVE');
});

test('normalizeCampaignRow converts JSON and numeric database values', () => {
  const normalized = normalizeCampaignRow({
    target_vendor_ids: '["vendor-1", "", "vendor-2"]',
    is_active: 1,
    dismissible: 0,
    priority: '75',
    discount_value: '12.50',
    impressions: '8',
  });

  assert.deepEqual(normalized.target_vendor_ids, ['vendor-1', 'vendor-2']);
  assert.equal(normalized.is_active, true);
  assert.equal(normalized.dismissible, false);
  assert.equal(normalized.priority, 75);
  assert.equal(normalized.discount_value, 12.5);
  assert.equal(normalized.impressions, 8);
});
