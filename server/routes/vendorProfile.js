import { logger } from '../utils/logger.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabaseClient.js';
import { inferCloudinaryResourceType, isCloudinaryConfigured, uploadBufferToCloudinary } from '../lib/cloudinaryUpload.js';
import { normalizeEmail } from '../lib/auth.js';
import { optionalAuth, requireAuth } from '../middleware/requireAuth.js';
import { notifyRole, notifyUser } from '../lib/notify.js';
import { consumeLeadForVendorWithCompat } from '../lib/leadConsumptionCompat.js';

const router = express.Router();

const FALLBACK_IMAGE =
  'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=300&q=80';
const FALLBACK_SERVICE_IMAGE =
  'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?auto=format&fit=crop&w=800&q=80';
const ALLOWED_UPLOAD_BUCKETS = new Set(['avatars', 'product-images', 'product-media']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const GENERIC_IMAGE_MIN_BYTES = 10 * 1024;
const PRODUCT_IMAGE_MIN_BYTES = 50 * 1024;
const PRODUCT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const KYC_DOC_MIN_BYTES = 100 * 1024;
const KYC_DOC_MAX_BYTES = 5 * 1024 * 1024;
const KYC_ALLOWED_DOC_TYPES = new Set(['GST', 'PAN', 'AADHAR', 'BANK']);
const KYC_ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const KYC_APPROVED_STATUSES = new Set(['APPROVED', 'VERIFIED']);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const _cacheDash = new Map();
const _cacheLead = new Map();
const _cacheRecent = new Map();
const _cacheSupport = new Map();
const _cacheVendorMe = new Map();
const _cacheRecentLeads = new Map();
const _nowMs = () => Date.now();
const _getCached = (m, k) => {
  const e = m.get(k);
  return e && e.exp > _nowMs() ? e.val : null;
};
const _setCached = (m, k, v, ttl) => {
  const base = Math.max(0, Number(ttl) || 0);
  const jitter = Math.floor(base * (0.8 + Math.random() * 0.4));
  m.set(k, { val: v, exp: _nowMs() + jitter });
};

// ── Lead system constants ──
const MAX_VENDORS_PER_LEAD = 5;
const MARKETPLACE_LEAD_LIMIT = 500;
const MARKETPLACE_LEAD_MAX_AGE_DAYS = 30;
const LEAD_EXPIRY_DAYS = 30;

const isValidId = (v) => typeof v === 'string' && v.trim().length > 0;
const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuidLike = (value = '') => UUID_LIKE_RE.test(String(value || '').trim());
const isMissingColumnError = (error) =>
  error?.code === '42703' || /column .* does not exist/i.test(String(error?.message || ''));

const parseDataUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('data:')) {
    const match = raw.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    return { mime: match[1], base64: match[2] };
  }
  return { mime: null, base64: raw };
};

const sanitizeFilename = (name) =>
  String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 120) || 'upload';

const buildUploadPath = ({ vendorId, originalName, contentType }) => {
  const safeName = sanitizeFilename(originalName || '');
  const extFromMime = MIME_EXT[contentType] || '';
  const hasExt = safeName.includes('.');
  const base = hasExt ? safeName.replace(/\.[^/.]+$/, '') : safeName;
  const ext = hasExt ? safeName.split('.').pop() : (extFromMime || 'bin');
  const fileName = `${base || 'upload'}.${ext}`;
  return `${vendorId}/${Date.now()}-${randomUUID()}-${fileName}`;
};

const isBucketMissingError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('bucket not found') || (msg.includes('bucket') && msg.includes('not found'));
};

const normalizeKycStatus = (value = '') => String(value || '').trim().toUpperCase();

const kycDocumentsAreLocked = (vendor = null) =>
  KYC_APPROVED_STATUSES.has(normalizeKycStatus(vendor?.kyc_status));

const sendLockedKycResponse = (res) =>
  res.status(409).json({
    success: false,
    error: 'KYC is already approved. Re-upload is disabled.',
  });

const getUploadBucketCandidates = (bucket) => {
  if (bucket === 'product-images') return ['product-images', 'product-media', 'avatars'];
  if (bucket === 'product-media') return ['product-media', 'product-images', 'avatars'];
  return [bucket];
};

const VENDOR_UPDATE_BLOCK = new Set([
  'id',
  'user_id',
  'created_at',
  'updated_at',
  'role',
  'aud',
  'app_metadata',
  'user_metadata',
  'confirmed_at',
  'email_confirmed_at',
  'last_sign_in_at',
  'phone_confirmed_at',
  'identities',
  'factors',
  'is_anonymous',
]);

const sanitizeVendorUpdates = (updates = {}) => {
  const cleaned = {};
  Object.entries(updates || {}).forEach(([key, value]) => {
    if (VENDOR_UPDATE_BLOCK.has(key)) return;
    if (value === undefined) return;
    cleaned[key] = value;
  });
  return cleaned;
};

const hasMeaningfulVendorField = (...values) =>
  values.some((value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    return String(value).trim() !== '';
  });

const calculateVendorProfileCompletion = (vendor = {}) => {
  const fieldGroups = [
    ['company_name'],
    ['owner_name'],
    ['phone'],
    ['email'],
    ['address', 'registered_address'],
    ['gst_number'],
    ['state', 'state_id'],
    ['city', 'city_id'],
    ['website_url'],
    ['profile_image', 'avatar_url'],
    ['primary_business_type'],
    ['year_of_establishment'],
  ];

  const filledFields = fieldGroups.filter((group) =>
    hasMeaningfulVendorField(...group.map((field) => vendor?.[field]))
  ).length;

  return Math.round((filledFields / fieldGroups.length) * 100);
};

const buildVendorResponse = (vendor = null) => {
  if (!vendor) return null;

  const storedProfileCompletion = Number(vendor?.profile_completion);
  const derivedProfileCompletion = calculateVendorProfileCompletion(vendor);

  return {
    ...vendor,
    vendor_id: String(vendor?.vendor_id || '').trim() || String(vendor?.id || '').trim() || null,
    profile_completion: Number.isFinite(storedProfileCompletion)
      ? Math.max(storedProfileCompletion, derivedProfileCompletion)
      : derivedProfileCompletion,
  };
};

const clearVendorCacheEntries = (vendorId = '') => {
  const normalizedVendorId = String(vendorId || '').trim();
  if (!normalizedVendorId) return;

  [_cacheDash, _cacheLead, _cacheRecent, _cacheSupport, _cacheVendorMe, _cacheRecentLeads].forEach((cacheMap) => {
    for (const key of cacheMap.keys()) {
      if (String(key || '').includes(normalizedVendorId)) {
        cacheMap.delete(key);
      }
    }
  });
};

const PAN_NUMBER_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAR_NUMBER_RE = /^\d{12}$/;
const IFSC_CODE_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const INDIAN_PHONE_RE = /^[6-9]\d{9}$/;
const GST_NUMBER_RE = /^\d{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;
const TAN_NUMBER_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const IEC_CODE_RE = /^[A-Z0-9]{10}$/;
const CIN_NUMBER_RE = /^[A-Z0-9]{21}$/;
const LLPIN_NUMBER_RE = /^[A-Z0-9]{8}$/;
const ACCOUNT_HOLDER_NAME_RE = /^[A-Za-z][A-Za-z\s.'-]*$/;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const normalizeOptionalText = (value, maxLength = 160) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
};

const normalizePanNumber = (value = '') =>
  String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

const normalizeAadharNumber = (value = '') =>
  String(value || '').replace(/\D/g, '').slice(0, 12);

const normalizeIfscCode = (value = '') =>
  String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11);

const normalizeIndianPhone = (value = '') => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length > 10) {
    digits = digits.slice(2);
  }
  if (digits.length > 10) {
    digits = digits.slice(-10);
  }
  return digits;
};

const normalizeCodeValue = (value = '', maxLength = 32) =>
  String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, maxLength);

const normalizeAccountHolderName = (value = '') =>
  String(value || '')
    .replace(/[^A-Za-z\s.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

const normalizeWebsiteUrl = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let parsed;

  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('Website URL must be a valid http/https URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Website URL must be a valid http/https URL.');
  }

  return parsed.toString();
};

const normalizeYearOfEstablishment = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const digits = String(value).replace(/\D/g, '').slice(0, 4);
  const year = Number(digits);
  const currentYear = new Date().getFullYear();

  if (!digits || !Number.isInteger(year) || year < 1900 || year > currentYear) {
    throw new Error(`Year of establishment must be between 1900 and ${currentYear}.`);
  }

  return year;
};

const resolveRegistrationNumbers = (value = '') => {
  const normalizedValue = normalizeCodeValue(value, 21);

  if (!normalizedValue) {
    return {
      cinNumber: null,
      llpinNumber: null,
    };
  }

  if (CIN_NUMBER_RE.test(normalizedValue)) {
    return {
      cinNumber: normalizedValue,
      llpinNumber: null,
    };
  }

  if (LLPIN_NUMBER_RE.test(normalizedValue)) {
    return {
      // Store LLPIN in cin_number because llpin_number is not present in the current schema.
      cinNumber: normalizedValue,
      llpinNumber: null,
    };
  }

  throw new Error('CIN/LLPIN number must be a valid 21-character CIN or 8-character LLPIN.');
};

const validateVendorIdentityFields = (updates = {}) => {
  const normalized = { ...updates };
  const rawPanNumber = hasOwn(updates, 'pan_number') ? updates.pan_number : updates.panNumber;
  const rawAadharNumber = hasOwn(updates, 'aadhar_number') ? updates.aadhar_number : updates.aadharNumber;
  const rawPhone = hasOwn(updates, 'phone') ? updates.phone : undefined;
  const rawGstNumber = hasOwn(updates, 'gst_number') ? updates.gst_number : updates.gstNumber;
  const rawWebsiteUrl = hasOwn(updates, 'website_url') ? updates.website_url : updates.websiteUrl;
  const rawCinNumber = hasOwn(updates, 'cin_number') ? updates.cin_number : updates.cinNumber;
  const rawLlpinNumber = hasOwn(updates, 'llpin_number') ? updates.llpin_number : updates.llpinNumber;
  const rawTanNumber = hasOwn(updates, 'tan_number') ? updates.tan_number : updates.tanNumber;
  const rawIecCode = hasOwn(updates, 'iec_code') ? updates.iec_code : updates.iecCode;
  const rawYearOfEstablishment = hasOwn(updates, 'year_of_establishment')
    ? updates.year_of_establishment
    : updates.yearOfEstablishment;

  if (rawPanNumber !== undefined) {
    const panNumber = normalizePanNumber(rawPanNumber);
    if (String(rawPanNumber ?? '').trim() && !PAN_NUMBER_RE.test(panNumber)) {
      throw new Error('PAN number must be in format ABCDE1234F.');
    }
    normalized.pan_number = panNumber || null;
    delete normalized.panNumber;
  }

  if (rawAadharNumber !== undefined) {
    const aadharNumber = normalizeAadharNumber(rawAadharNumber);
    if (String(rawAadharNumber ?? '').trim() && !AADHAR_NUMBER_RE.test(aadharNumber)) {
      throw new Error('Aadhar number must contain exactly 12 digits.');
    }
    normalized.aadhar_number = aadharNumber || null;
    delete normalized.aadharNumber;
  }

  if (rawPhone !== undefined) {
    const phone = normalizeIndianPhone(rawPhone);
    if (String(rawPhone ?? '').trim() && !INDIAN_PHONE_RE.test(phone)) {
      throw new Error('Mobile number must be a valid 10-digit Indian number.');
    }
    normalized.phone = phone || null;
  }

  if (rawGstNumber !== undefined) {
    const gstNumber = normalizeCodeValue(rawGstNumber, 15);
    if (String(rawGstNumber ?? '').trim() && !GST_NUMBER_RE.test(gstNumber)) {
      throw new Error('GST number must be a valid 15-character GSTIN.');
    }
    normalized.gst_number = gstNumber || null;
    delete normalized.gstNumber;
  }

  if (rawWebsiteUrl !== undefined) {
    normalized.website_url = normalizeWebsiteUrl(rawWebsiteUrl);
    delete normalized.websiteUrl;
  }

  if (rawCinNumber !== undefined || rawLlpinNumber !== undefined) {
    const registrationNumbers = resolveRegistrationNumbers(rawCinNumber ?? rawLlpinNumber ?? '');
    normalized.cin_number = registrationNumbers.cinNumber;
    delete normalized.llpin_number;
    delete normalized.cinNumber;
    delete normalized.llpinNumber;
  }

  if (rawTanNumber !== undefined) {
    const tanNumber = normalizeCodeValue(rawTanNumber, 10);
    if (String(rawTanNumber ?? '').trim() && !TAN_NUMBER_RE.test(tanNumber)) {
      throw new Error('TAN number must be in format ABCD12345F.');
    }
    normalized.tan_number = tanNumber || null;
    delete normalized.tanNumber;
  }

  if (rawIecCode !== undefined) {
    const iecCode = normalizeCodeValue(rawIecCode, 10);
    if (String(rawIecCode ?? '').trim() && !IEC_CODE_RE.test(iecCode)) {
      throw new Error('IEC code must contain exactly 10 alphanumeric characters.');
    }
    normalized.iec_code = iecCode || null;
    delete normalized.iecCode;
  }

  if (rawYearOfEstablishment !== undefined) {
    normalized.year_of_establishment = normalizeYearOfEstablishment(rawYearOfEstablishment);
    delete normalized.yearOfEstablishment;
  }

  return normalized;
};

const normalizeVendorBankDetailsPayload = (payload = {}, { requireCoreFields = false, partial = false } = {}) => {
  const normalized = {};

  if (!partial || hasOwn(payload, 'account_holder') || hasOwn(payload, 'accountHolder')) {
    const rawAccountHolder = payload.account_holder ?? payload.accountHolder;
    const accountHolder = normalizeAccountHolderName(rawAccountHolder);
    if (String(rawAccountHolder ?? '').trim() && (!accountHolder || !ACCOUNT_HOLDER_NAME_RE.test(accountHolder))) {
      throw new Error('Account holder name must contain only letters and spaces.');
    }
    normalized.account_holder = accountHolder || null;
  }

  if (!partial || hasOwn(payload, 'bank_name') || hasOwn(payload, 'bankName')) {
    normalized.bank_name = normalizeOptionalText(payload.bank_name ?? payload.bankName, 120);
  }

  if (!partial || hasOwn(payload, 'branch_name') || hasOwn(payload, 'branchName')) {
    normalized.branch_name = normalizeOptionalText(payload.branch_name ?? payload.branchName, 120);
  }

  if (!partial || hasOwn(payload, 'account_number') || hasOwn(payload, 'accountNumber')) {
    const accountNumber = String(payload.account_number ?? payload.accountNumber ?? '').replace(/\D/g, '').slice(0, 30);
    if (requireCoreFields && !accountNumber) {
      throw new Error('Account number is required.');
    }
    if (accountNumber && accountNumber.length < 6) {
      throw new Error('Account number must contain at least 6 digits.');
    }
    normalized.account_number = accountNumber || null;
  }

  if (!partial || hasOwn(payload, 'ifsc_code') || hasOwn(payload, 'ifscCode')) {
    const ifscCode = normalizeIfscCode(payload.ifsc_code ?? payload.ifscCode ?? '');
    if (requireCoreFields && !ifscCode) {
      throw new Error('IFSC code is required.');
    }
    if (ifscCode && !IFSC_CODE_RE.test(ifscCode)) {
      throw new Error('IFSC code must be in format ABCD0123456.');
    }
    normalized.ifsc_code = ifscCode || null;
  }

  if (!partial || hasOwn(payload, 'is_primary') || hasOwn(payload, 'isPrimary')) {
    normalized.is_primary = payload.is_primary === true || payload.isPrimary === true;
  }

  return normalized;
};

async function resolveVendorForUser(user) {
  const userId = user?.id || null;
  const email = normalizeEmail(user?.email || '');

  let vendor = null;
  if (userId) {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    vendor = data || null;
  }

  if (!vendor && email) {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .ilike('email', email)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    vendor = data || null;
  }

  if (vendor && userId && vendor.user_id !== userId) {
    await supabase
      .from('vendors')
      .update({ user_id: userId })
      .eq('id', vendor.id);
    vendor.user_id = userId;
  }

  return vendor;
}

async function resolveVendorIdsForUser(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = normalizeEmail(user?.email || '');
  const vendorIds = new Set();

  if (userId) {
    const { data: byUserRows, error: byUserError } = await supabase
      .from('vendors')
      .select('id')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (byUserError) throw new Error(byUserError.message || 'Failed to resolve vendor profile');
    (byUserRows || []).forEach((row) => {
      const id = String(row?.id || '').trim();
      if (id) vendorIds.add(id);
    });
  }

  if (email) {
    const { data: byEmailRows, error: byEmailError } = await supabase
      .from('vendors')
      .select('id')
      .ilike('email', email)
      .order('updated_at', { ascending: false });

    if (byEmailError) throw new Error(byEmailError.message || 'Failed to resolve vendor profile');
    (byEmailRows || []).forEach((row) => {
      const id = String(row?.id || '').trim();
      if (id) vendorIds.add(id);
    });
  }

  return Array.from(vendorIds);
}

async function resolveActiveSubscriptionForVendor(vendorId) {
  const normalizedVendorId = String(vendorId || '').trim();
  if (!normalizedVendorId) return null;

  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from('vendor_plan_subscriptions')
    .select('id, vendor_id, plan_id, status, start_date, end_date')
    .eq('vendor_id', normalizedVendorId)
    .eq('status', 'ACTIVE')
    .order('end_date', { ascending: false, nullsFirst: false })
    .order('start_date', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(10);

  if (error) {
    if (isMissingRelationError(error, 'vendor_plan_subscriptions')) {
      return null;
    }
    throw new Error(error.message || 'Failed to validate subscription');
  }

  return (rows || []).find((row) => !row?.end_date || String(row.end_date) > nowIso) || null;
}

async function resolveBuyerId(userId) {
  if (!userId) return null;
  const { data: buyer } = await supabase
    .from('buyers')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  return buyer?.id || null;
}

async function resolveBuyerProfileForUser(user = {}) {
  const userId = String(user?.id || '').trim();
  const email = normalizeEmail(user?.email || '');

  if (userId) {
    const { data: byUserId } = await supabase
      .from('buyers')
      .select('id, full_name, company_name, email, phone, whatsapp')
      .eq('user_id', userId)
      .maybeSingle();
    if (byUserId) return byUserId;
  }

  if (email) {
    const { data: byEmail, error: byEmailError } = await supabase
      .from('buyers')
      .select('id, full_name, company_name, email, phone, whatsapp')
      .ilike('email', email)
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);
    if (!byEmailError && Array.isArray(byEmail) && byEmail[0]) return byEmail[0];
  }

  return null;
}

async function resolveLocationNames({ stateId = '', cityId = '' } = {}) {
  const normalizedStateId = String(stateId || '').trim();
  const normalizedCityId = String(cityId || '').trim();

  let stateName = null;
  let cityName = null;

  if (normalizedStateId) {
    const { data: stateRow } = await supabase
      .from('states')
      .select('name')
      .eq('id', normalizedStateId)
      .maybeSingle();
    stateName = nonEmptyText(stateRow?.name, 120);
  }

  if (normalizedCityId) {
    const { data: cityRow } = await supabase
      .from('cities')
      .select('name')
      .eq('id', normalizedCityId)
      .maybeSingle();
    cityName = nonEmptyText(cityRow?.name, 120);
  }

  return { stateName, cityName };
}

async function fetchVendorByPublicSlug(slug) {
  const normalizedSlug = String(slug || '').trim().toLowerCase();
  if (!normalizedSlug) return { vendor: null, error: null };

  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('slug', normalizedSlug)
    .maybeSingle();

  if (error && isMissingColumnError(error)) {
    return { vendor: null, error: null };
  }

  return { vendor: data || null, error };
}

async function fetchVendorById(vendorId) {
  const normalizedId = String(vendorId || '').trim();
  if (!normalizedId) return { vendor: null, error: null };

  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('id', normalizedId)
    .maybeSingle();

  return { vendor: data || null, error };
}

async function resolvePublicVendorRecord(identifier) {
  const normalized = String(identifier || '').trim();
  if (!normalized) return { vendor: null, error: null };

  const resolvers = isUuidLike(normalized)
    ? [
        () => fetchVendorById(normalized),
        () => fetchVendorByPublicSlug(normalized),
      ]
    : [
        () => fetchVendorByPublicSlug(normalized),
        () => fetchVendorById(normalized),
      ];

  for (const resolveVendor of resolvers) {
    const result = await resolveVendor();
    if (result?.error) return result;
    if (result?.vendor) return result;
  }

  return { vendor: null, error: null };
}

const nonEmptyText = (value, maxLen = 500) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, maxLen);
};

const parseBudget = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const numeric = Number(String(value).replace(/[, ]+/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .trim();

const dedupe = (arr = []) => Array.from(new Set((arr || []).filter(Boolean)));

const fuzzyMatch = (left, right) => {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
};

const extractLeadCityState = (lead = {}) => {
  const city = String(lead?.city || lead?.city_name || '').trim();
  const state = String(lead?.state || lead?.state_name || '').trim();
  if (city || state) return { city, state };

  const location = String(lead?.location || '').trim();
  if (!location) return { city: '', state: '' };

  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0], state: parts.slice(1).join(', ') };
  if (parts.length === 1) return { city: parts[0], state: '' };
  return { city: '', state: '' };
};

const buildLeadTokens = (lead = {}) =>
  dedupe(
    [
      lead?.title,
      lead?.product_name,
      lead?.product_interest,
      lead?.category,
      lead?.category_name,
      lead?.head_category,
      lead?.sub_category,
      lead?.service_name,
      lead?.requirement_title,
      lead?.description,
      lead?.message,
    ].map(normalizeText)
  );

const matchesAnyTextSet = (tokens = [], set = new Set()) => {
  if (!set || set.size === 0) return true;
  for (const token of tokens) {
    for (const item of set) {
      if (fuzzyMatch(token, item)) return true;
    }
  }
  return false;
};

async function loadMarketplaceFilterContext(vendorId) {
  const context = {
    autoLeadFilter: true,
    minBudget: null,
    maxBudget: null,
    categorySet: new Set(),
    citySet: new Set(),
    stateSet: new Set(),
  };

  const { data: prefs } = await supabase
    .from('vendor_preferences')
    .select('preferred_micro_categories, preferred_states, preferred_cities, auto_lead_filter, min_budget, max_budget')
    .eq('vendor_id', vendorId)
    .maybeSingle();

  context.autoLeadFilter = prefs?.auto_lead_filter !== false;

  const minBudgetNum = Number(prefs?.min_budget);
  const maxBudgetNum = Number(prefs?.max_budget);
  context.minBudget = Number.isFinite(minBudgetNum) ? minBudgetNum : null;
  context.maxBudget = Number.isFinite(maxBudgetNum) ? maxBudgetNum : null;

  const prefCategoryIds = dedupe((prefs?.preferred_micro_categories || []).map(String));
  const prefStateIds = dedupe((prefs?.preferred_states || []).map(String));
  const prefCityIds = dedupe((prefs?.preferred_cities || []).map(String));

  if (prefCategoryIds.length) {
    const [microRes, subRes, headRes] = await Promise.all([
      supabase.from('micro_categories').select('id, name').in('id', prefCategoryIds),
      supabase.from('sub_categories').select('id, name').in('id', prefCategoryIds),
      supabase.from('head_categories').select('id, name').in('id', prefCategoryIds),
    ]);

    [...(microRes?.data || []), ...(subRes?.data || []), ...(headRes?.data || [])].forEach((row) => {
      const value = normalizeText(row?.name);
      if (value) context.categorySet.add(value);
    });
  }

  if (prefStateIds.length) {
    const { data: states } = await supabase
      .from('states')
      .select('id, name')
      .in('id', prefStateIds);
    (states || []).forEach((row) => {
      const value = normalizeText(row?.name);
      if (value) context.stateSet.add(value);
    });
  }

  if (prefCityIds.length) {
    const { data: cities } = await supabase
      .from('cities')
      .select('id, name')
      .in('id', prefCityIds);
    (cities || []).forEach((row) => {
      const value = normalizeText(row?.name);
      if (value) context.citySet.add(value);
    });
  }

  const { data: products } = await supabase
    .from('products')
    .select('name, category_other')
    .eq('vendor_id', vendorId)
    .eq('status', 'ACTIVE');

  (products || []).forEach((row) => {
    const name = normalizeText(row?.name);
    const categoryOther = normalizeText(row?.category_other);
    if (name) context.categorySet.add(name);
    if (categoryOther) context.categorySet.add(categoryOther);
  });

  return context;
}

function applyMarketplaceFilters(leads = [], context) {
  const rows = Array.isArray(leads) ? leads : [];
  if (!rows.length) return [];

  const shouldAuto = context?.autoLeadFilter !== false;
  if (!shouldAuto) return rows;

  const hasCategoryFilter = (context?.categorySet?.size || 0) > 0;
  const hasCityFilter = (context?.citySet?.size || 0) > 0;
  const hasStateFilter = (context?.stateSet?.size || 0) > 0;
  const hasMinBudget = Number.isFinite(context?.minBudget);
  const hasMaxBudget = Number.isFinite(context?.maxBudget);

  const shouldFilterCategory = hasCategoryFilter;
  const shouldFilterLocation = hasCityFilter || hasStateFilter;
  const shouldFilterBudget = hasMinBudget || hasMaxBudget;

  if (!shouldFilterCategory && !shouldFilterLocation && !shouldFilterBudget) {
    return rows;
  }

  return rows.filter((lead) => {
    if (shouldFilterCategory) {
      const tokens = buildLeadTokens(lead);
      if (!matchesAnyTextSet(tokens, context.categorySet)) return false;
    }

    if (shouldFilterLocation) {
      const { city, state } = extractLeadCityState(lead);
      const cityText = normalizeText(city);
      const stateText = normalizeText(state);
      const locationText = normalizeText(lead?.location);

      const cityMatch = !hasCityFilter
        ? true
        : matchesAnyTextSet([cityText, locationText], context.citySet);
      const stateMatch = !hasStateFilter
        ? true
        : matchesAnyTextSet([stateText, locationText], context.stateSet);

      if (!cityMatch || !stateMatch) return false;
    }

    if (shouldFilterBudget) {
      const budget = Number.parseFloat(lead?.budget);
      if (Number.isFinite(context.minBudget) && Number.isFinite(budget) && budget < context.minBudget) {
        return false;
      }
      if (Number.isFinite(context.maxBudget) && Number.isFinite(budget) && budget > context.maxBudget) {
        return false;
      }
    }

    return true;
  });
}

const omitKeys = (obj, keys = []) =>
  Object.fromEntries(
    Object.entries(obj || {}).filter(([key, value]) => !keys.includes(key) && value !== undefined)
  );

const getMissingColumnFromInsertError = (error) => {
  const raw = `${error?.message || ''} ${error?.details || ''}`;
  const quotedMatch = raw.match(/column\s+"([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return String(quotedMatch[1] || '').trim();
  }
  const schemaCacheMatch = raw.match(/could not find the ['"]([^'"]+)['"] column/i);
  if (schemaCacheMatch?.[1]) {
    return String(schemaCacheMatch[1] || '').trim();
  }
  const code = String(error?.code || '').toUpperCase();
  if (code !== '42703' && code !== 'PGRST204') return '';
  const match = raw.match(/column\s+([^ .]+)\s+/i);
  return String(match?.[1] || '').trim();
};

const makeInsertPayloadSignature = (payload = {}) =>
  JSON.stringify(
    Object.keys(payload || {})
      .sort()
      .reduce((acc, key) => {
        acc[key] = payload[key];
        return acc;
      }, {})
  );

async function insertWithOptionalColumns({
  table,
  payload,
  select = '*',
  fallbackDropSets = [],
}) {
  const attempts = [];
  const seen = new Set();

  const enqueue = (candidate) => {
    const cleaned = omitKeys(candidate, []);
    if (!Object.keys(cleaned).length) return;
    const signature = makeInsertPayloadSignature(cleaned);
    if (seen.has(signature)) return;
    seen.add(signature);
    attempts.push(cleaned);
  };

  enqueue(payload);
  (fallbackDropSets || []).forEach((keys) => enqueue(omitKeys(payload, keys)));

  let lastError = null;

  while (attempts.length > 0) {
    const candidate = attempts.shift();
    const { data, error } = await supabase
      .from(table)
      .insert([candidate])
      .select(select)
      .maybeSingle();

    if (!error) return data;

    lastError = error;
    const missingColumn = getMissingColumnFromInsertError(error);
    if (missingColumn && Object.prototype.hasOwnProperty.call(candidate, missingColumn)) {
      enqueue(omitKeys(candidate, [missingColumn]));
    }
  }

  throw lastError || new Error(`Failed to insert ${table}`);
}

async function attachBuyerMetaToProposals(rows = [], options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const normalizeEmailValue = (value) => String(value || '').trim().toLowerCase();
  const normalizeNameValue = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const looksLikeHandleName = (value) => {
    const name = normalizeNameValue(value);
    if (!name) return true;
    if (name.includes('@')) return true;
    if (!/[a-zA-Z]/.test(name)) return true;
    if (!name.includes(' ') && /\d/.test(name)) return true;
    return false;
  };
  const toBuyerData = (buyer = {}) => ({
    id: buyer?.id || null,
    user_id: buyer?.user_id || null,
    full_name: buyer?.full_name || buyer?.company_name || null,
    company_name: buyer?.company_name || null,
    email: buyer?.email || null,
    phone: buyer?.phone || buyer?.mobile_number || buyer?.mobile || null,
    avatar_url: buyer?.avatar_url || null,
    is_active: typeof buyer?.is_active === 'boolean' ? buyer.is_active : null,
  });
  const scoreBuyerData = (data = {}) => {
    const fullName = normalizeNameValue(data?.full_name);
    let score = 0;
    if (fullName && !looksLikeHandleName(fullName)) score += 100;
    else if (fullName) score += 10;
    if (normalizeNameValue(data?.company_name)) score += 20;
    if (normalizeEmailValue(data?.email)) score += 5;
    if (normalizeNameValue(data?.phone)) score += 3;
    if (normalizeNameValue(data?.avatar_url)) score += 2;
    return score;
  };
  const parseTs = (value) => {
    if (!value) return 0;
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : 0;
  };
  const upsertBestCandidate = (map, key, data, tsValue) => {
    const mapKey = String(key || '').trim();
    if (!mapKey) return;
    const normalizedData = data || {};
    const next = {
      data: normalizedData,
      score: scoreBuyerData(normalizedData),
      ts: parseTs(tsValue),
    };
    const prev = map.get(mapKey);
    if (!prev || next.score > prev.score || (next.score === prev.score && next.ts > prev.ts)) {
      map.set(mapKey, next);
    }
  };
  const getCandidateData = (map, key) => map.get(String(key || '').trim())?.data || null;
  const isPlaceholderName = (value) => {
    const normalized = normalizeNameValue(value).toLowerCase();
    return (
      normalized === 'buyer' ||
      normalized === 'customer' ||
      normalized === 'unknown' ||
      normalized === 'unknown buyer'
    );
  };
  const pickFirstText = (...values) => {
    for (const value of values) {
      const text = nonEmptyText(value, 500);
      if (text) return text;
    }
    return null;
  };
  const pickPreferredPersonName = (...values) => {
    let fallback = null;
    for (const value of values) {
      const text = nonEmptyText(value, 160);
      if (!text) continue;
      if (!fallback) fallback = text;
      if (!isPlaceholderName(text)) return text;
    }
    return fallback;
  };
  const pickFirstBoolean = (...values) => {
    for (const value of values) {
      if (typeof value === 'boolean') return value;
    }
    return null;
  };

  const buyerIds = Array.from(
    new Set(
      list
        .map((row) => String(row?.buyer_id || '').trim())
        .filter(Boolean)
    )
  );
  const buyerEmails = Array.from(
    new Set(
      list
        .map((row) => normalizeEmailValue(row?.buyer_email))
        .filter(Boolean)
    )
  );

  const buyerMapById = new Map();
  const buyerMapByEmail = new Map();
  const userNameByEmail = new Map();
  const hydrateBuyerMapByEmails = async (emailKeys = []) => {
    const keys = Array.from(new Set((emailKeys || []).map(normalizeEmailValue).filter(Boolean)));
    if (!keys.length) return;

    const { data: buyersByEmail, error: buyerByEmailError } = await supabase
      .from('buyers')
      .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active, updated_at, created_at')
      .in('email', keys)
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (!buyerByEmailError && Array.isArray(buyersByEmail)) {
      buyersByEmail.forEach((buyer) => {
        const emailKey = normalizeEmailValue(buyer?.email);
        if (!emailKey) return;
        const normalized = toBuyerData(buyer);
        const rowTs = buyer?.updated_at || buyer?.created_at || null;
        upsertBestCandidate(buyerMapByEmail, emailKey, normalized, rowTs);
      });
    }

    const unresolvedEmailKeys = keys.filter((email) => !buyerMapByEmail.has(email));
    if (!unresolvedEmailKeys.length) return;

    const fallbackRows = await Promise.all(
      unresolvedEmailKeys.map(async (emailKey) => {
        const { data: buyerByEmail, error } = await supabase
          .from('buyers')
          .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active, updated_at, created_at')
          .ilike('email', emailKey)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error || !buyerByEmail) return null;
        return buyerByEmail;
      })
    );

    fallbackRows.filter(Boolean).forEach((buyer) => {
      const emailKey = normalizeEmailValue(buyer?.email);
      if (!emailKey) return;
      upsertBestCandidate(
        buyerMapByEmail,
        emailKey,
        toBuyerData(buyer),
        buyer?.updated_at || buyer?.created_at || null
      );
    });
  };
  const hydrateUserNameByEmails = async (emailKeys = []) => {
    const keys = Array.from(new Set((emailKeys || []).map(normalizeEmailValue).filter(Boolean)));
    if (!keys.length) return;

    const { data: usersByEmail, error: usersByEmailError } = await supabase
      .from('users')
      .select('id, email, full_name, updated_at, created_at')
      .in('email', keys)
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (!usersByEmailError && Array.isArray(usersByEmail)) {
      usersByEmail.forEach((userRow) => {
        const emailKey = normalizeEmailValue(userRow?.email);
        if (!emailKey || userNameByEmail.has(emailKey)) return;
        const fullName = nonEmptyText(userRow?.full_name, 160);
        if (fullName) userNameByEmail.set(emailKey, fullName);
      });
    }

    const unresolvedEmailKeys = keys.filter((email) => !userNameByEmail.has(email));
    if (!unresolvedEmailKeys.length) return;

    const fallbackRows = await Promise.all(
      unresolvedEmailKeys.map(async (emailKey) => {
        const { data: userByEmail, error } = await supabase
          .from('users')
          .select('id, email, full_name, updated_at, created_at')
          .ilike('email', emailKey)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error || !userByEmail) return null;
        return userByEmail;
      })
    );

    fallbackRows.filter(Boolean).forEach((userRow) => {
      const emailKey = normalizeEmailValue(userRow?.email);
      if (!emailKey || userNameByEmail.has(emailKey)) return;
      const fullName = nonEmptyText(userRow?.full_name, 160);
      if (fullName) userNameByEmail.set(emailKey, fullName);
    });
  };
  if (buyerIds.length) {
    const { data: buyers, error } = await supabase
      .from('buyers')
      .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active, updated_at, created_at')
      .in('id', buyerIds);

    if (!error && Array.isArray(buyers)) {
      buyers.forEach((buyer) => {
        const normalized = toBuyerData(buyer);
        const rowTs = buyer?.updated_at || buyer?.created_at || null;
        buyerMapById.set(String(buyer.id), normalized);
        const emailKey = normalizeEmailValue(buyer?.email);
        upsertBestCandidate(buyerMapByEmail, emailKey, normalized, rowTs);
      });
    }
  }

  await hydrateBuyerMapByEmails(buyerEmails);
  await hydrateUserNameByEmails(buyerEmails);

  const proposalIds = Array.from(
    new Set(
      list
        .map((row) => String(row?.id || '').trim())
        .filter(Boolean)
    )
  );
  const activeVendorUserId = String(options?.vendorUserId || '').trim();
  const optionVendorIds = Array.isArray(options?.vendorIds) ? options.vendorIds : [];
  const vendorIds = Array.from(
    new Set(
      [...optionVendorIds, ...list.map((row) => row?.vendor_id)]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

  const vendorUserMap = new Map();
  if (vendorIds.length) {
    const { data: vendors, error: vendorError } = await supabase
      .from('vendors')
      .select('id, user_id')
      .in('id', vendorIds);

    if (!vendorError && Array.isArray(vendors)) {
      vendors.forEach((vendor) => {
        const key = String(vendor?.id || '').trim();
        if (!key) return;
        vendorUserMap.set(key, String(vendor?.user_id || '').trim());
      });
    }
  }

  const proposalBuyerCandidateUserIds = new Map();
  if (proposalIds.length) {
    const proposalVendorUserMap = new Map();
    list.forEach((row) => {
      const proposalKey = String(row?.id || '').trim();
      const vendorKey = String(row?.vendor_id || '').trim();
      if (!proposalKey || !vendorKey) return;
      const vendorUserId = String(vendorUserMap.get(vendorKey) || '').trim();
      if (vendorUserId) {
        proposalVendorUserMap.set(proposalKey, vendorUserId);
      }
    });

    const { data: proposalMessages, error: messageError } = await supabase
      .from('proposal_messages')
      .select('proposal_id, sender_id, created_at')
      .in('proposal_id', proposalIds)
      .order('created_at', { ascending: false });

    if (!messageError && Array.isArray(proposalMessages)) {
      proposalMessages.forEach((message) => {
        const proposalKey = String(message?.proposal_id || '').trim();
        const senderId = String(message?.sender_id || '').trim();
        if (!proposalKey || !senderId) return;
        const vendorUserId = String(proposalVendorUserMap.get(proposalKey) || '').trim();
        if (vendorUserId && senderId === vendorUserId) return;
        if (activeVendorUserId && senderId === activeVendorUserId) return;

        if (!proposalBuyerCandidateUserIds.has(proposalKey)) {
          proposalBuyerCandidateUserIds.set(proposalKey, []);
        }
        const candidateIds = proposalBuyerCandidateUserIds.get(proposalKey);
        if (!candidateIds.includes(senderId)) {
          candidateIds.push(senderId);
        }
      });
    }
  }

  const buyerUserIds = Array.from(
    new Set(
      Array.from(proposalBuyerCandidateUserIds.values())
        .flatMap((ids) => (Array.isArray(ids) ? ids : []))
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

  const buyerMapByUserId = new Map();
  if (buyerUserIds.length) {
    const { data: buyersByUserId, error: buyerUserError } = await supabase
      .from('buyers')
      .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active, updated_at, created_at')
      .in('user_id', buyerUserIds)
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (!buyerUserError && Array.isArray(buyersByUserId)) {
      buyersByUserId.forEach((buyer) => {
        const userKey = String(buyer?.user_id || '').trim();
        if (!userKey) return;
        upsertBestCandidate(
          buyerMapByUserId,
          userKey,
          toBuyerData(buyer),
          buyer?.updated_at || buyer?.created_at || null
        );
      });
    }
  }

  const unresolvedBuyerUserIds = buyerUserIds.filter((id) => !buyerMapByUserId.has(String(id)));
  if (unresolvedBuyerUserIds.length) {
    const { data: usersById, error: usersByIdError } = await supabase
      .from('users')
      .select('id, email, updated_at, created_at')
      .in('id', unresolvedBuyerUserIds);

    if (!usersByIdError && Array.isArray(usersById) && usersById.length) {
      const userEmailMap = new Map();
      usersById.forEach((row) => {
        const userId = String(row?.id || '').trim();
        const emailKey = normalizeEmailValue(row?.email);
        if (!userId || !emailKey) return;
        userEmailMap.set(userId, emailKey);
      });

      const userEmailKeys = Array.from(new Set(Array.from(userEmailMap.values()).filter(Boolean)));
      if (userEmailKeys.length) {
        const { data: buyersFromUserEmails, error: buyersFromUserEmailsError } = await supabase
          .from('buyers')
          .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active, updated_at, created_at')
          .in('email', userEmailKeys)
          .order('updated_at', { ascending: false })
          .order('created_at', { ascending: false });

        if (!buyersFromUserEmailsError && Array.isArray(buyersFromUserEmails)) {
          const emailCandidateMap = new Map();
          buyersFromUserEmails.forEach((buyer) => {
            const emailKey = normalizeEmailValue(buyer?.email);
            if (!emailKey) return;
            upsertBestCandidate(
              emailCandidateMap,
              emailKey,
              toBuyerData(buyer),
              buyer?.updated_at || buyer?.created_at || null
            );
          });

          userEmailMap.forEach((emailKey, userId) => {
            const candidate = getCandidateData(emailCandidateMap, emailKey);
            if (!candidate) return;
            upsertBestCandidate(
              buyerMapByUserId,
              userId,
              candidate,
              usersById.find((row) => String(row?.id || '').trim() === userId)?.updated_at || null
            );
          });
        }
      }
    }
  }

  const proposalBuyerUserMap = new Map();
  proposalBuyerCandidateUserIds.forEach((candidateIds, proposalKey) => {
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) return;

    let selected = '';
    for (const senderId of candidateIds) {
      if (getCandidateData(buyerMapByUserId, senderId)) {
        selected = senderId;
        break;
      }
    }
    if (!selected) {
      selected = String(candidateIds[0] || '').trim();
    }
    if (selected) {
      proposalBuyerUserMap.set(proposalKey, selected);
    }
  });

  const leadBuyerMap = new Map();
  if (proposalIds.length) {
    const { data: leads, error: leadError } = await supabase
      .from('leads')
      .select('id, proposal_id, buyer_id, buyer_name, buyer_email, buyer_phone, company_name, city, state, location, created_at')
      .in('proposal_id', proposalIds)
      .order('created_at', { ascending: false });

    if (!leadError && Array.isArray(leads)) {
      leads.forEach((lead) => {
        const key = String(lead?.proposal_id || '').trim();
        if (!key || leadBuyerMap.has(key)) return;

        const city = String(lead?.city || '').trim();
        const state = String(lead?.state || '').trim();
        const location =
          city && state
            ? `${city}, ${state}`
            : city || state || String(lead?.location || '').trim() || null;

        leadBuyerMap.set(key, {
          lead_id: lead?.id || null,
          buyer_id: lead?.buyer_id || null,
          full_name: lead?.buyer_name || null,
          company_name: lead?.company_name || null,
          email: lead?.buyer_email || null,
          phone: lead?.buyer_phone || null,
          location,
        });
      });
    }
  }

  const leadBuyerIds = Array.from(
    new Set(
      Array.from(leadBuyerMap.values())
        .map((row) => String(row?.buyer_id || '').trim())
        .filter(Boolean)
    )
  );
  if (leadBuyerIds.length) {
    const { data: leadBuyerRows, error: leadBuyerRowsError } = await supabase
      .from('buyers')
      .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active, updated_at, created_at')
      .in('id', leadBuyerIds);

    if (!leadBuyerRowsError && Array.isArray(leadBuyerRows)) {
      leadBuyerRows.forEach((buyer) => {
        const buyerId = String(buyer?.id || '').trim();
        const normalized = toBuyerData(buyer);
        const rowTs = buyer?.updated_at || buyer?.created_at || null;
        if (buyerId) buyerMapById.set(buyerId, normalized);
        const emailKey = normalizeEmailValue(buyer?.email);
        if (emailKey) upsertBestCandidate(buyerMapByEmail, emailKey, normalized, rowTs);
      });
    }
  }

  const leadBuyerEmails = Array.from(
    new Set(
      Array.from(leadBuyerMap.values())
        .map((row) => normalizeEmailValue(row?.email))
        .filter(Boolean)
      )
  );
  await hydrateBuyerMapByEmails(leadBuyerEmails);
  await hydrateUserNameByEmails(leadBuyerEmails);

  const leadIdsForUnlock = Array.from(
    new Set(
      Array.from(leadBuyerMap.values())
        .map((row) => String(row?.lead_id || '').trim())
        .filter(Boolean)
    )
  );
  const purchasedLeadIdSet = new Set();
  if (leadIdsForUnlock.length && vendorIds.length) {
    const { data: purchases, error: purchasesError } = await supabase
      .from('lead_purchases')
      .select('lead_id')
      .in('lead_id', leadIdsForUnlock)
      .in('vendor_id', vendorIds);

    if (!purchasesError && Array.isArray(purchases)) {
      purchases.forEach((purchase) => {
        const leadId = String(purchase?.lead_id || '').trim();
        if (leadId) purchasedLeadIdSet.add(leadId);
      });
    }
  }

  return list.map((row) => {
    const proposalKey = String(row?.id || '').trim();
    const leadMeta = leadBuyerMap.get(proposalKey) || {};
    const leadId = String(leadMeta?.lead_id || '').trim();
    const isContactUnlocked = Boolean(leadId && purchasedLeadIdSet.has(leadId));

    return {
      ...row,
      lead_id: row?.lead_id || leadId || null,
      is_contact_unlocked: isContactUnlocked,
      details_unlocked: isContactUnlocked,
      buyers: (() => {
      const idKey = String(row?.buyer_id || '').trim();
      const rowEmailKey = normalizeEmailValue(row?.buyer_email);
      const leadEmailKey = normalizeEmailValue(leadMeta?.email);
      const proposalBuyerUserId = String(proposalBuyerUserMap.get(proposalKey) || '').trim();

      const rowBuyer = {
        full_name: row?.buyer_name || null,
        company_name: row?.company_name || null,
        email: row?.buyer_email || null,
        phone: row?.buyer_phone || null,
      };
      const byId = buyerMapById.get(idKey) || {};
      const byUserId = getCandidateData(buyerMapByUserId, proposalBuyerUserId) || {};
      const byLeadEmail = getCandidateData(buyerMapByEmail, leadEmailKey) || {};
      const byRowEmail = getCandidateData(buyerMapByEmail, rowEmailKey) || {};
      const userNameByLeadEmail = nonEmptyText(userNameByEmail.get(leadEmailKey), 160);
      const userNameByRowEmail = nonEmptyText(userNameByEmail.get(rowEmailKey), 160);
      const merged = {
        user_id: pickFirstText(
          byUserId?.user_id,
          byId?.user_id,
          byLeadEmail?.user_id,
          byRowEmail?.user_id,
          proposalBuyerUserId
        ),
        full_name: pickPreferredPersonName(
          byUserId?.full_name,
          byId?.full_name,
          byLeadEmail?.full_name,
          byRowEmail?.full_name,
          userNameByLeadEmail,
          userNameByRowEmail,
          leadMeta?.full_name,
          rowBuyer?.full_name
        ),
        company_name: pickFirstText(
          byUserId?.company_name,
          byId?.company_name,
          byLeadEmail?.company_name,
          byRowEmail?.company_name,
          leadMeta?.company_name,
          rowBuyer?.company_name
        ),
        email: pickFirstText(
          byUserId?.email,
          byId?.email,
          byLeadEmail?.email,
          byRowEmail?.email,
          leadMeta?.email,
          rowBuyer?.email
        ),
        phone: pickFirstText(
          byUserId?.phone,
          byId?.phone,
          byLeadEmail?.phone,
          byRowEmail?.phone,
          leadMeta?.phone,
          rowBuyer?.phone
        ),
        avatar_url: pickFirstText(
          byUserId?.avatar_url,
          byId?.avatar_url,
          byLeadEmail?.avatar_url,
          byRowEmail?.avatar_url
        ),
        is_active: pickFirstBoolean(
          byUserId?.is_active,
          byId?.is_active,
          byLeadEmail?.is_active,
          byRowEmail?.is_active
        ),
        location: pickFirstText(leadMeta?.location),
      };

      const hasAnyValue = Object.values(merged).some(
        (value) => value !== null && value !== undefined && String(value).trim() !== ''
      );

      return hasAnyValue ? merged : null;
      })(),
    };
  });
}

async function insertNotification(payload = {}) {
  if (!payload?.user_id) return;

  let { error } = await supabase.from('notifications').insert([payload]);
  if (error && String(error?.message || '').toLowerCase().includes('reference_id')) {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.reference_id;
    ({ error } = await supabase.from('notifications').insert([fallbackPayload]));
  }
  if (error) throw error;
}

const normalizeConsumptionType = (value) => String(value || '').trim().toUpperCase();

const buildQuotaExhaustedAlerts = ({ remaining, consumptionType }) => {
  const type = normalizeConsumptionType(consumptionType);
  const daily = Math.max(0, Number(remaining?.daily || 0));
  const weekly = Math.max(0, Number(remaining?.weekly || 0));
  const included = type === 'DAILY_INCLUDED' || type === 'WEEKLY_INCLUDED';
  const alerts = [];

  if (type === 'DAILY_INCLUDED' && daily <= 0) {
    alerts.push({
      type: 'LEAD_DAILY_EXHAUSTED',
      title: 'Daily Lead Quota Exhausted',
      message: 'Daily included leads are exhausted. Use weekly quota or buy extra leads.',
    });
  }
  if (included && weekly <= 0) {
    alerts.push({
      type: 'LEAD_WEEKLY_EXHAUSTED',
      title: 'Weekly Lead Quota Exhausted',
      message: 'Weekly included leads are exhausted. Buy extra leads to continue.',
    });
  }

  return alerts;
};

async function notifyQuotaExhausted({ userId, remaining, consumptionType }) {
  if (!userId) return;

  const alerts = buildQuotaExhaustedAlerts({ remaining, consumptionType });
  if (!alerts.length) return;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();

  for (const alert of alerts) {
    try {
      const { count, error: countError } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', alert.type)
        .gte('created_at', dayStartIso);

      if (countError) {
        logger.warn('Failed to check quota notification dedupe:', countError?.message || countError);
        continue;
      }
      if ((count || 0) > 0) continue;

      await insertNotification({
        user_id: userId,
        type: alert.type,
        title: alert.title,
        message: alert.message,
        link: '/vendor/leads',
        is_read: false,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn('Failed to send quota exhausted notification:', error?.message || error);
    }
  }
}

const normalizeLeadConsumptionMode = (value) => {
  const mode = String(value || '').trim().toUpperCase();
  if (mode === 'USE_WEEKLY') return 'USE_WEEKLY';
  if (mode === 'BUY_EXTRA') return 'BUY_EXTRA';
  if (mode === 'PAID') return 'PAID';
  return 'AUTO';
};

const parseLeadPriceNumber = (value, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
  const parsed = Number(cleaned);
  if (Number.isFinite(parsed)) return Math.max(0, parsed);
  return Math.max(0, Number(fallback) || 0);
};

const safeDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const addDays = (dateValue, days) => {
  const base = safeDate(dateValue);
  if (!base) return null;
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const buildLeadExpiryDate = (lead = {}) => {
  const explicitExpiry = safeDate(lead?.expires_at);
  if (explicitExpiry) return explicitExpiry;
  return addDays(lead?.created_at, LEAD_EXPIRY_DAYS);
};

const buildLeadExpiryMeta = (lead = {}, now = new Date()) => {
  const expiryDate = buildLeadExpiryDate(lead);
  const status = String(lead?.status || '').trim().toUpperCase();
  const isTerminal = ['CLOSED', 'CONVERTED'].includes(status);
  const isExpired = Boolean(expiryDate && expiryDate.getTime() <= now.getTime() && !isTerminal);
  const expiresInDays = expiryDate
    ? Math.max(0, Math.ceil((expiryDate.getTime() - now.getTime()) / 86400000))
    : null;

  return {
    expires_at: expiryDate?.toISOString() || lead?.expires_at || null,
    is_expired: isExpired,
    expires_in_days: expiresInDays,
  };
};

const attachLeadExpiryMeta = (lead = {}, now = new Date()) => ({
  ...lead,
  ...buildLeadExpiryMeta(lead, now),
});

const isLeadExpired = (lead = {}, now = new Date()) => buildLeadExpiryMeta(lead, now).is_expired;

const normalizeJsonObject = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
};

const getPlanExtraLeadPrice = (plan = {}) => {
  const features = normalizeJsonObject(plan?.features);
  const pricing = normalizeJsonObject(features?.pricing);
  const value = Number(pricing?.extra_lead_price ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
};

const VENDOR_LEAD_STATUS_VALUES = ['ACTIVE', 'VIEWED', 'CLOSED'];
const VENDOR_LEAD_STATUS_SET = new Set(VENDOR_LEAD_STATUS_VALUES);

const normalizeVendorLeadStatus = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!VENDOR_LEAD_STATUS_SET.has(normalized)) return null;
  return normalized;
};

const normalizeLeadStatusNote = (value, maxLen = 800) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, maxLen);
};

const isMissingRelationError = (error, relationName) => {
  const msg = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const normalizedRelation = String(relationName || '').toLowerCase();
  if (code === '42P01') return true;
  if (!normalizedRelation) return false;
  return (
    (msg.includes('relation') && msg.includes(normalizedRelation) && msg.includes('does not exist')) ||
    (msg.includes('table') && msg.includes(normalizedRelation) && msg.includes('not found')) ||
    (msg.includes(normalizedRelation) && msg.includes('schema cache'))
  );
};

const inferFallbackLeadStatus = (lead = {}) => {
  const normalized = String(lead?.status || '').trim().toUpperCase();
  if (normalized === 'CLOSED') return 'CLOSED';
  if (normalized === 'VIEWED') return 'VIEWED';
  return 'ACTIVE';
};

async function resolveVendorLeadAccess({ vendorId, leadId }) {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .maybeSingle();

  if (leadError) throw new Error(leadError.message || 'Failed to fetch lead');
  if (!lead) return { lead: null, purchase: null, isDirect: false, isVisibleMarketplaceLead: false };

  const isDirect = String(lead?.vendor_id || '').trim() === String(vendorId || '').trim();

  const { data: purchaseRows, error: purchaseError } = await supabase
    .from('lead_purchases')
    .select(
      'id, purchase_date, purchase_datetime, amount, purchase_price, payment_status, consumption_type, lead_status, subscription_plan_name'
    )
    .eq('vendor_id', vendorId)
    .eq('lead_id', leadId)
    .order('purchase_datetime', { ascending: false })
    .limit(1);

  if (purchaseError) throw new Error(purchaseError.message || 'Failed to validate lead purchase');
  const purchase = Array.isArray(purchaseRows) && purchaseRows.length ? purchaseRows[0] : null;

  let isVisibleMarketplaceLead = false;
  if (!isDirect && !purchase) {
    const leadStatus = String(lead?.status || '').toUpperCase();
    const isMarketplace =
      !lead?.vendor_id &&
      ['AVAILABLE', 'PURCHASED'].includes(leadStatus) &&
      !isLeadExpired(lead);
    if (isMarketplace) {
      const { count: purchaseCount, error: countError } = await supabase
        .from('lead_purchases')
        .select('id', { count: 'exact', head: true })
        .eq('lead_id', leadId);

      if (countError) {
        throw new Error(countError.message || 'Failed to validate lead capacity');
      }
      isVisibleMarketplaceLead = (purchaseCount || 0) < MAX_VENDORS_PER_LEAD;
    }
  }

  return { lead, purchase, isDirect, isVisibleMarketplaceLead };
}

async function consumeLeadForVendor({ vendorId, leadId, mode = 'AUTO', purchasePrice = 0 }) {
  return consumeLeadForVendorWithCompat({
    supabase,
    vendorId,
    leadId,
    mode,
    purchasePrice,
  });
}

// ✅ Current vendor profile (auth-required)
router.get('/me', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    const ck = `me:${vendor.id}`;
    const hit = _getCached(_cacheVendorMe, ck);
    if (hit) return res.json(hit);
    const payload = { success: true, vendor };
    _setCached(_cacheVendorMe, ck, payload, 30000);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Update vendor profile (auth-required, bypasses RLS)
router.put('/me', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    let payload;
    try {
      payload = validateVendorIdentityFields(sanitizeVendorUpdates(req.body || {}));
    } catch (validationError) {
      return res.status(400).json({ success: false, error: validationError.message });
    }
    payload.profile_completion = calculateVendorProfileCompletion({ ...vendor, ...payload });
    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('vendors')
      .update(payload)
      .eq('id', vendor.id)
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });

    clearVendorCacheEntries(vendor.id);
    return res.json({ success: true, vendor: buildVendorResponse(data || { ...vendor, ...payload }) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/me/banks', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { data, error } = await supabase
      .from('vendor_bank_details')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, banks: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/me/banks/:bankId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { bankId } = req.params;
    if (!isValidId(bankId)) {
      return res.status(400).json({ success: false, error: 'Invalid bank detail id' });
    }

    const { data, error } = await supabase
      .from('vendor_bank_details')
      .select('*')
      .eq('id', bankId)
      .eq('vendor_id', vendor.id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Bank detail not found' });
    return res.json({ success: true, bank: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/me/banks', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    let payload;
    try {
      payload = normalizeVendorBankDetailsPayload(req.body || {}, { requireCoreFields: true });
    } catch (validationError) {
      return res.status(400).json({ success: false, error: validationError.message });
    }

    const { count, error: countError } = await supabase
      .from('vendor_bank_details')
      .select('id', { count: 'exact', head: true })
      .eq('vendor_id', vendor.id);

    if (countError) return res.status(500).json({ success: false, error: countError.message });

    const shouldSetPrimary = payload.is_primary === true || !count;
    if (shouldSetPrimary) {
      const { error: resetError } = await supabase
        .from('vendor_bank_details')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('vendor_id', vendor.id);
      if (resetError) return res.status(500).json({ success: false, error: resetError.message });
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('vendor_bank_details')
      .insert([{
        vendor_id: vendor.id,
        ...payload,
        is_primary: shouldSetPrimary,
        created_at: nowIso,
        updated_at: nowIso,
      }])
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, bank: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/me/banks/:bankId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { bankId } = req.params;
    if (!isValidId(bankId)) {
      return res.status(400).json({ success: false, error: 'Invalid bank detail id' });
    }

    const { data: existingBank, error: existingError } = await supabase
      .from('vendor_bank_details')
      .select('*')
      .eq('id', bankId)
      .eq('vendor_id', vendor.id)
      .maybeSingle();

    if (existingError) return res.status(500).json({ success: false, error: existingError.message });
    if (!existingBank) return res.status(404).json({ success: false, error: 'Bank detail not found' });

    let payload;
    try {
      payload = normalizeVendorBankDetailsPayload(req.body || {}, { partial: true });
    } catch (validationError) {
      return res.status(400).json({ success: false, error: validationError.message });
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ success: false, error: 'No bank details were provided to update.' });
    }

    if (payload.is_primary === true) {
      const { error: resetError } = await supabase
        .from('vendor_bank_details')
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq('vendor_id', vendor.id)
        .neq('id', bankId);
      if (resetError) return res.status(500).json({ success: false, error: resetError.message });
    }

    const { data, error } = await supabase
      .from('vendor_bank_details')
      .update({
        ...payload,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bankId)
      .eq('vendor_id', vendor.id)
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, bank: data || { ...existingBank, ...payload } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/me/banks/:bankId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { bankId } = req.params;
    if (!isValidId(bankId)) {
      return res.status(400).json({ success: false, error: 'Invalid bank detail id' });
    }

    const { data: existingBank, error: existingError } = await supabase
      .from('vendor_bank_details')
      .select('id, is_primary')
      .eq('id', bankId)
      .eq('vendor_id', vendor.id)
      .maybeSingle();

    if (existingError) return res.status(500).json({ success: false, error: existingError.message });
    if (!existingBank) return res.status(404).json({ success: false, error: 'Bank detail not found' });

    const { error: deleteError } = await supabase
      .from('vendor_bank_details')
      .delete()
      .eq('id', bankId)
      .eq('vendor_id', vendor.id);

    if (deleteError) return res.status(500).json({ success: false, error: deleteError.message });

    if (existingBank.is_primary) {
      const { data: fallbackBank, error: fallbackError } = await supabase
        .from('vendor_bank_details')
        .select('id')
        .eq('vendor_id', vendor.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fallbackError) return res.status(500).json({ success: false, error: fallbackError.message });

      if (fallbackBank?.id) {
        const { error: resetPrimaryError } = await supabase
          .from('vendor_bank_details')
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq('id', fallbackBank.id)
          .eq('vendor_id', vendor.id);
        if (resetPrimaryError) return res.status(500).json({ success: false, error: resetPrimaryError.message });
      }
    }

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Upload image/media to Cloudinary when configured (auth-required, keeps Supabase fallback for dev)
router.post('/me/upload', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const bucket = String(req.body?.bucket || 'avatars').trim() || 'avatars';
    if (!ALLOWED_UPLOAD_BUCKETS.has(bucket)) {
      return res.status(400).json({ success: false, error: 'Invalid upload bucket' });
    }

    const dataUrl = String(req.body?.data_url || req.body?.dataUrl || '').trim();
    const originalName = String(req.body?.file_name || req.body?.fileName || '').trim();
    const explicitType = String(req.body?.content_type || req.body?.contentType || '').trim();

    if (!dataUrl) {
      return res.status(400).json({ success: false, error: 'data_url is required' });
    }

    const parsed = parseDataUrl(dataUrl);
    if (!parsed?.base64) {
      return res.status(400).json({ success: false, error: 'Invalid base64 payload' });
    }

    const contentType = explicitType || parsed.mime || 'application/octet-stream';
    const uploadPurpose = String(req.body?.upload_purpose || req.body?.uploadPurpose || '').trim().toUpperCase();
    const isImage = contentType.startsWith('image/');
    const isVideo = bucket === 'product-media' && contentType.startsWith('video/');
    const isPdf = contentType === 'application/pdf';
    const isGeneralDocument =
      uploadPurpose === 'GENERAL_DOCUMENT' &&
      (
        isPdf ||
        contentType === 'application/msword' ||
        contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    if (uploadPurpose === 'KYC_DOCUMENT' && kycDocumentsAreLocked(vendor)) {
      return sendLockedKycResponse(res);
    }
    const isAllowed =
      bucket === 'product-images'
        ? isImage
        : (isImage || isPdf || isVideo || isGeneralDocument);

    if (!isAllowed) {
      return res.status(400).json({ success: false, error: 'Unsupported file type' });
    }

    const buffer = Buffer.from(parsed.base64, 'base64');
    if (!buffer?.length) {
      return res.status(400).json({ success: false, error: 'Empty upload payload' });
    }
    if (isImage && bucket !== 'product-images' && uploadPurpose !== 'KYC_DOCUMENT' && buffer.length < GENERIC_IMAGE_MIN_BYTES) {
      return res.status(400).json({ success: false, error: 'Image too small (minimum 10KB)' });
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ success: false, error: 'File too large (max 10MB)' });
    }
    if (bucket === 'product-images') {
      if (buffer.length < PRODUCT_IMAGE_MIN_BYTES) {
        return res.status(400).json({ success: false, error: 'Image too small (minimum 50KB)' });
      }
      if (buffer.length > PRODUCT_IMAGE_MAX_BYTES) {
        return res.status(413).json({ success: false, error: 'Image too large (maximum 1MB)' });
      }
    }
    if (uploadPurpose === 'KYC_DOCUMENT') {
      if (!KYC_ALLOWED_MIME.has(contentType)) {
        return res.status(400).json({
          success: false,
          error: 'KYC accepts only JPG/PNG images',
        });
      }
      if (buffer.length < KYC_DOC_MIN_BYTES) {
        return res.status(400).json({
          success: false,
          error: 'KYC image too small (minimum 100KB)',
        });
      }
      if (buffer.length > KYC_DOC_MAX_BYTES) {
        return res.status(413).json({
          success: false,
          error: 'KYC image too large (maximum 5MB)',
        });
      }
    }

    const objectPath = buildUploadPath({
      vendorId: vendor.id,
      originalName,
      contentType,
    });

    if (isCloudinaryConfigured()) {
      const uploadFolder =
        uploadPurpose === 'KYC_DOCUMENT'
          ? `vendor-kyc/${vendor.id}`
          : bucket === 'product-images'
            ? `product-images/${vendor.id}`
            : bucket === 'product-media'
              ? `product-media/${vendor.id}`
              : `vendor-uploads/${vendor.id}`;
      const uploaded = await uploadBufferToCloudinary({
        buffer,
        contentType,
        folder: uploadFolder,
        publicId: objectPath,
        fileName: objectPath.split('/').pop(),
        resourceType: inferCloudinaryResourceType(contentType),
        tags: [
          'vendor-upload',
          bucket,
          uploadPurpose ? uploadPurpose.toLowerCase() : '',
          req.body?.document_type || req.body?.documentType || '',
        ],
      });

      return res.json({
        success: true,
        bucket: uploaded.bucket,
        path: uploaded.path,
        publicUrl: uploaded.publicUrl,
        storage: uploaded.storageProvider,
      });
    }

    const bucketCandidates = getUploadBucketCandidates(bucket);
    let uploadedBucket = null;
    let lastUploadError = null;

    for (const candidateBucket of bucketCandidates) {
      const { error: uploadError } = await supabase.storage
        .from(candidateBucket)
        .upload(objectPath, buffer, {
          contentType,
          upsert: true,
        });

      if (!uploadError) {
        uploadedBucket = candidateBucket;
        break;
      }

      lastUploadError = uploadError;
      if (!isBucketMissingError(uploadError)) {
        break;
      }
    }

    if (!uploadedBucket) {
      return res.status(500).json({ success: false, error: lastUploadError?.message || 'Upload failed' });
    }

    const { data } = supabase.storage.from(uploadedBucket).getPublicUrl(objectPath);
    return res.json({
      success: true,
      bucket: uploadedBucket,
      path: objectPath,
      publicUrl: data?.publicUrl || null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Submit KYC for verification (auth-required)
router.post('/me/kyc/submit', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    if (kycDocumentsAreLocked(vendor)) {
      return sendLockedKycResponse(res);
    }

    const { data, error } = await supabase
      .from('vendors')
      .update({ kyc_status: 'SUBMITTED', updated_at: new Date().toISOString() })
      .eq('id', vendor.id)
      .select('*')
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });

    clearVendorCacheEntries(vendor.id);

    await notifyRole('ADMIN', {
      type: 'KYC_SUBMITTED',
      title: 'Vendor submitted KYC',
      message: `Vendor "${vendor.company_name || vendor.id}" submitted KYC for review.`,
      link: '/admin/kyc',
    });
    await notifyRole('SUPERADMIN', {
      type: 'KYC_SUBMITTED',
      title: 'Vendor submitted KYC',
      message: `Vendor "${vendor.company_name || vendor.id}" submitted KYC for review.`,
      link: '/admin/kyc',
    });
    await notifyRole('DATA_ENTRY', {
      type: 'KYC_SUBMITTED',
      title: 'Vendor submitted KYC',
      message: `Vendor "${vendor.company_name || vendor.id}" submitted KYC for review.`,
      link: '/employee/dataentry/kyc-review',
    });
    await notifyRole('SUPPORT', {
      type: 'KYC_SUBMITTED',
      title: 'Vendor submitted KYC',
      message: `Vendor "${vendor.company_name || vendor.id}" submitted KYC for review.`,
      link: '/employee/support/kyc-review',
    });
    await notifyUser({
      user_id: vendor.user_id || req.user?.id || null,
      email: vendor.email || req.user?.email || null,
      type: 'KYC_SUBMITTED',
      title: 'KYC Submitted',
      message: 'Your KYC documents were submitted successfully. Verification is in progress.',
      link: '/vendor/profile?tab=kyc',
    });

    return res.json({ success: true, vendor: buildVendorResponse(data || { ...vendor, kyc_status: 'SUBMITTED' }) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Vendor documents (auth-required)
router.get('/me/documents', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    let query = supabase
      .from('vendor_documents')
      .select('*')
      .eq('vendor_id', vendor.id);

    if (req.query?.type) query = query.eq('document_type', String(req.query.type));
    if (req.query?.status) query = query.eq('verification_status', String(req.query.status));

    const { data, error } = await query.order('uploaded_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, documents: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/me/documents/:docId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { docId } = req.params;
    if (!isValidId(docId)) {
      return res.status(400).json({ success: false, error: 'Invalid document id' });
    }

    const { data, error } = await supabase
      .from('vendor_documents')
      .select('*')
      .eq('id', docId)
      .eq('vendor_id', vendor.id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Document not found' });
    return res.json({ success: true, document: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/me/documents', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    if (kycDocumentsAreLocked(vendor)) {
      return sendLockedKycResponse(res);
    }

    const document_type = String(req.body?.document_type || '').trim().toUpperCase();
    const document_url = String(req.body?.document_url || '').trim();
    const original_name = String(req.body?.original_name || '').trim() || null;

    if (!document_type || !document_url) {
      return res.status(400).json({ success: false, error: 'document_type and document_url are required' });
    }
    if (!KYC_ALLOWED_DOC_TYPES.has(document_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid document type. Allowed: GST, PAN, AADHAR, BANK',
      });
    }

    const { data: existingDocs, error: existingDocsError } = await supabase
      .from('vendor_documents')
      .select('id, document_type')
      .eq('vendor_id', vendor.id);

    if (existingDocsError) {
      return res.status(500).json({ success: false, error: existingDocsError.message });
    }

    const sameType = (existingDocs || []).find(
      (row) => String(row?.document_type || '').toUpperCase() === document_type
    );

    let data = null;
    let error = null;

    if (sameType?.id) {
      const updateRes = await supabase
        .from('vendor_documents')
        .update({
          document_type,
          document_url,
          original_name,
          uploaded_at: new Date().toISOString(),
          verification_status: 'PENDING',
        })
        .eq('id', sameType.id)
        .eq('vendor_id', vendor.id)
        .select('*')
        .maybeSingle();
      data = updateRes.data;
      error = updateRes.error;
    } else {
      if ((existingDocs || []).length >= 4) {
        return res.status(400).json({
          success: false,
          error: 'Only 4 KYC documents are allowed (GST, PAN, AADHAR, BANK)',
        });
      }

      const insertRes = await supabase
        .from('vendor_documents')
        .insert([{
          vendor_id: vendor.id,
          document_type,
          document_url,
          original_name,
          uploaded_at: new Date().toISOString(),
          verification_status: 'PENDING',
        }])
        .select('*')
        .maybeSingle();
      data = insertRes.data;
      error = insertRes.error;
    }

    if (error) return res.status(500).json({ success: false, error: error.message });

    await notifyRole('ADMIN', {
      type: 'KYC_DOCUMENT_UPLOADED',
      title: 'Vendor uploaded KYC document',
      message: `Vendor "${vendor.company_name || vendor.id}" uploaded ${document_type} document for KYC.`,
      link: '/admin/kyc',
    });
    await notifyRole('SUPERADMIN', {
      type: 'KYC_DOCUMENT_UPLOADED',
      title: 'Vendor uploaded KYC document',
      message: `Vendor "${vendor.company_name || vendor.id}" uploaded ${document_type} document for KYC.`,
      link: '/admin/kyc',
    });
    await notifyRole('SUPPORT', {
      type: 'KYC_DOCUMENT_UPLOADED',
      title: 'Vendor uploaded KYC document',
      message: `Vendor "${vendor.company_name || vendor.id}" uploaded ${document_type} document for KYC.`,
      link: '/employee/support/kyc-review',
    });
    await notifyRole('DATA_ENTRY', {
      type: 'KYC_DOCUMENT_UPLOADED',
      title: 'Vendor uploaded KYC document',
      message: `Vendor "${vendor.company_name || vendor.id}" uploaded ${document_type} document for KYC.`,
      link: '/employee/dataentry/kyc-review',
    });

    clearVendorCacheEntries(vendor.id);
    return res.json({ success: true, document: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/me/documents/:docId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    if (kycDocumentsAreLocked(vendor)) {
      return sendLockedKycResponse(res);
    }

    const { docId } = req.params;
    if (!isValidId(docId)) {
      return res.status(400).json({ success: false, error: 'Invalid document id' });
    }

    const { error } = await supabase
      .from('vendor_documents')
      .delete()
      .eq('id', docId)
      .eq('vendor_id', vendor.id);

    if (error) return res.status(500).json({ success: false, error: error.message });
    clearVendorCacheEntries(vendor.id);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/me/documents', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    if (kycDocumentsAreLocked(vendor)) {
      return sendLockedKycResponse(res);
    }

    const docType = String(req.query?.type || '').trim();
    if (!docType) {
      return res.status(400).json({ success: false, error: 'type query param is required' });
    }

    const { error } = await supabase
      .from('vendor_documents')
      .delete()
      .eq('vendor_id', vendor.id)
      .eq('document_type', docType);

    if (error) return res.status(500).json({ success: false, error: error.message });
    clearVendorCacheEntries(vendor.id);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Vendor My Leads (auth-required, bypasses RLS)
router.get('/me/marketplace-leads', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    const now = new Date();

    const activeSubscriptions = await Promise.all(
      vendorIds.map(async (vendorId) => ({
        vendorId,
        subscription: await resolveActiveSubscriptionForVendor(vendorId),
      }))
    );
    const activeVendorEntry = activeSubscriptions.find((entry) => entry?.subscription);
    if (!activeVendorEntry?.subscription) {
      return res.json({
        success: true,
        leads: [],
        subscription_required: true,
        message: 'Active subscription required to access marketplace leads.',
      });
    }

    const maxAgeIso = new Date(Date.now() - MARKETPLACE_LEAD_MAX_AGE_DAYS * 86400000).toISOString();

    const { data: marketplaceRows, error: rowsError } = await supabase
      .from('leads')
      .select('*')
      .in('status', ['AVAILABLE', 'PURCHASED'])
      .or('vendor_id.is.null,source.eq.MARKETPLACE,source.is.null')
      .gte('created_at', maxAgeIso)
      .order('created_at', { ascending: false })
      .limit(MARKETPLACE_LEAD_LIMIT);

    if (rowsError) {
      return res.status(500).json({ success: false, error: rowsError.message || 'Failed to fetch marketplace leads' });
    }

    const allRows = Array.isArray(marketplaceRows) ? marketplaceRows : [];
    if (!allRows.length) return res.json({ success: true, leads: [] });

    const allLeadIds = dedupe(allRows.map((row) => String(row?.id || '')).filter(Boolean));

    const [myPurchasesRes, allPurchasesRes, filterContext] = await Promise.all([
      supabase
        .from('lead_purchases')
        .select('lead_id')
        .in('vendor_id', vendorIds),
      supabase
        .from('lead_purchases')
        .select('lead_id')
        .in('lead_id', allLeadIds),
      loadMarketplaceFilterContext(activeVendorEntry.vendorId),
    ]);

    if (myPurchasesRes?.error) {
      return res.status(500).json({ success: false, error: myPurchasesRes.error.message || 'Failed to fetch vendor purchases' });
    }
    if (allPurchasesRes?.error) {
      return res.status(500).json({ success: false, error: allPurchasesRes.error.message || 'Failed to fetch purchase counts' });
    }

    const myPurchasedLeadIds = new Set(
      (myPurchasesRes.data || []).map((row) => String(row?.lead_id || '')).filter(Boolean)
    );
    const purchaseCountByLead = new Map();
    (allPurchasesRes.data || []).forEach((row) => {
      const id = String(row?.lead_id || '').trim();
      if (!id) return;
      purchaseCountByLead.set(id, (purchaseCountByLead.get(id) || 0) + 1);
    });

    const eligibleRows = allRows.filter((row) => {
      const id = String(row?.id || '').trim();
      if (!id) return false;
      if (myPurchasedLeadIds.has(id)) return false;
      if ((purchaseCountByLead.get(id) || 0) >= MAX_VENDORS_PER_LEAD) return false;
      return true;
    });

    if (!eligibleRows.length) return res.json({ success: true, leads: [] });

    const filteredRows = applyMarketplaceFilters(eligibleRows, filterContext);
    const usedPreferenceMatches = filteredRows.length > 0 && filteredRows.length < eligibleRows.length;
    const fellBackToEligibleRows = filteredRows.length === 0 && eligibleRows.length > 0;
    const finalRows = filteredRows.length ? filteredRows : eligibleRows;
    const filterScope = usedPreferenceMatches
      ? 'matched'
      : fellBackToEligibleRows
        ? 'fallback'
        : 'all';
    const filterMessage =
      filterScope === 'matched'
        ? `Showing ${filteredRows.length} preference-matched leads out of ${eligibleRows.length} eligible leads.`
        : filterScope === 'fallback'
          ? `No saved preference matches found, so all ${eligibleRows.length} eligible leads are shown.`
          : `Showing all ${eligibleRows.length} eligible leads.`;

    return res.json({
      success: true,
      leads: finalRows.map((row) => attachLeadExpiryMeta(row, now)),
      filter_applied: filterScope !== 'all',
      filter_scope: filterScope,
      filter_message: filterMessage,
      filter_match_count: filteredRows.length,
      total_eligible: eligibleRows.length,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load marketplace leads' });
  }
});

router.post('/me/leads/:leadId/purchase', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Invalid lead id' });
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .maybeSingle();

    if (leadError) {
      return res.status(500).json({ success: false, error: leadError.message || 'Failed to fetch lead' });
    }
    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    const mode = normalizeLeadConsumptionMode(req.body?.mode);
    const fallbackAmount = parseLeadPriceNumber(lead?.price, 0);
    const requestedAmount = parseLeadPriceNumber(req.body?.amount, fallbackAmount);

    if (mode === 'BUY_EXTRA' || mode === 'PAID') {
      return res.status(402).json({
        success: false,
        code: 'PAID_REQUIRED',
        error: 'Paid extra lead purchase must be completed via payment gateway.',
      });
    }

    const consumeResult = await consumeLeadForVendor({
      vendorId: vendor.id,
      leadId,
      mode,
      purchasePrice: requestedAmount,
    });

    if (!consumeResult.success) {
      return res.status(consumeResult.statusCode).json({
        success: false,
        code: consumeResult.code,
        error: consumeResult.error,
        ...(consumeResult.payload || {}),
      });
    }

    const payload = consumeResult.payload || {};
    const purchaseRow = payload?.purchase && typeof payload.purchase === 'object'
      ? payload.purchase
      : null;
    const purchaseDatetime =
      purchaseRow?.purchase_datetime ||
      purchaseRow?.purchase_date ||
      payload?.purchase_datetime ||
      new Date().toISOString();
    const wasExistingPurchase = Boolean(payload?.existing_purchase);
    const responseConsumptionType =
      payload?.consumption_type ||
      purchaseRow?.consumption_type ||
      'PAID_EXTRA';
    const remaining = payload?.remaining || { daily: 0, weekly: 0 };

    try {
      const vendorUserId = vendor?.user_id || null;
      if (vendorUserId && !wasExistingPurchase) {
        await insertNotification({
          user_id: vendorUserId,
          type: 'LEAD_PURCHASED',
          title: 'Lead purchased',
          message: `You purchased a lead${lead?.product_name ? ` for ${lead.product_name}` : ''}. Contact details are now available.`,
          link: '/vendor/leads',
          reference_id: purchaseRow?.id || leadId,
          is_read: false,
          created_at: new Date().toISOString(),
        });
        await notifyQuotaExhausted({
          userId: vendorUserId,
          remaining,
          consumptionType: responseConsumptionType,
        });
      }
    } catch (notifError) {
      logger.warn('Lead purchase notification failed:', notifError?.message || notifError);
    }

    try {
      if (!wasExistingPurchase && purchaseRow?.id) {
        const purchaseStatus =
          normalizeVendorLeadStatus(payload?.lead_status || purchaseRow?.lead_status) || 'ACTIVE';
        const { error: historyError } = await supabase.from('lead_status_history').insert([
          {
            lead_id: leadId,
            vendor_id: vendor.id,
            lead_purchase_id: purchaseRow.id,
            status: purchaseStatus,
            note: 'Lead purchased',
            source: 'PURCHASE',
            created_by: req.user?.id || null,
            created_at: purchaseDatetime,
          },
        ]);
        if (historyError && !isMissingRelationError(historyError, 'lead_status_history')) {
          logger.warn('Lead purchase history insert failed:', historyError?.message || historyError);
        }
      }
    } catch (historyInsertError) {
      logger.warn('Lead purchase history insert failed:', historyInsertError?.message || historyInsertError);
    }

    return res.status(wasExistingPurchase ? 200 : 201).json({
      success: true,
      existing_purchase: wasExistingPurchase,
      consumption_type: responseConsumptionType,
      remaining,
      moved_to_my_leads: true,
      purchase_datetime: purchaseDatetime,
      plan_name: payload?.plan_name || payload?.subscription_plan_name || purchaseRow?.subscription_plan_name || null,
      subscription_plan_name: payload?.subscription_plan_name || payload?.plan_name || purchaseRow?.subscription_plan_name || null,
      lead_status: payload?.lead_status || purchaseRow?.lead_status || 'ACTIVE',
      purchase: purchaseRow,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to purchase lead' });
  }
});

router.get('/me/leads/:leadId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Invalid lead id' });
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .maybeSingle();

    if (leadError) {
      return res.status(500).json({ success: false, error: leadError.message || 'Failed to fetch lead' });
    }
    if (!lead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const isDirect = String(lead?.vendor_id || '').trim() === String(vendor.id || '').trim();

    const { data: purchaseRows, error: purchaseError } = await supabase
      .from('lead_purchases')
      .select(
        'id, purchase_date, purchase_datetime, amount, purchase_price, payment_status, consumption_type, lead_status, subscription_plan_name'
      )
      .eq('vendor_id', vendor.id)
      .eq('lead_id', leadId)
      .order('purchase_datetime', { ascending: false })
      .limit(1);

    if (purchaseError) {
      return res.status(500).json({ success: false, error: purchaseError.message || 'Failed to validate lead purchase' });
    }

    const purchase = Array.isArray(purchaseRows) && purchaseRows.length ? purchaseRows[0] : null;

    let isVisibleMarketplaceLead = false;
    if (!isDirect && !purchase) {
      const leadStatus = String(lead?.status || '').toUpperCase();
      const isMarketplace = !lead?.vendor_id && ['AVAILABLE', 'PURCHASED'].includes(leadStatus);
      if (isMarketplace) {
        const { count: purchaseCount, error: countError } = await supabase
          .from('lead_purchases')
          .select('id', { count: 'exact', head: true })
          .eq('lead_id', leadId);

        if (countError) {
          return res.status(500).json({ success: false, error: countError.message || 'Failed to validate lead capacity' });
        }

        isVisibleMarketplaceLead = (purchaseCount || 0) < MAX_VENDORS_PER_LEAD;
      }
    }

    if (!isDirect && !purchase && !isVisibleMarketplaceLead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const source = isDirect ? 'Direct' : purchase ? 'Purchased' : 'Marketplace';
    const normalizedPurchaseDatetime =
      purchase?.purchase_datetime ||
      purchase?.purchase_date ||
      lead?.created_at ||
      null;
    const normalizeLeadBuyerEmail = (value) => String(value || '').trim().toLowerCase();
    const pickLeadBuyerText = (...values) => {
      for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
      }
      return null;
    };
    const mapLeadBuyerMeta = (buyer = {}) => ({
      id: String(buyer?.id || '').trim() || null,
      user_id: String(buyer?.user_id || '').trim() || null,
      full_name: pickLeadBuyerText(buyer?.full_name, buyer?.company_name),
      company_name: pickLeadBuyerText(buyer?.company_name),
      email: normalizeLeadBuyerEmail(buyer?.email) || null,
      phone: pickLeadBuyerText(buyer?.phone, buyer?.mobile_number, buyer?.mobile),
      avatar_url: pickLeadBuyerText(buyer?.avatar_url),
      is_active: typeof buyer?.is_active === 'boolean' ? buyer.is_active : null,
    });

    let buyerMeta = null;
    const leadBuyerId = String(lead?.buyer_id || '').trim();
    const leadBuyerEmail = normalizeLeadBuyerEmail(lead?.buyer_email);

    if (leadBuyerId) {
      const { data: buyerById, error: buyerByIdError } = await supabase
        .from('buyers')
        .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active')
        .eq('id', leadBuyerId)
        .maybeSingle();

      if (!buyerByIdError && buyerById) {
        buyerMeta = mapLeadBuyerMeta(buyerById);
      }
    }

    if (!buyerMeta && leadBuyerEmail) {
      const { data: buyerByEmail, error: buyerByEmailError } = await supabase
        .from('buyers')
        .select('id, user_id, full_name, company_name, email, phone, avatar_url, is_active')
        .ilike('email', leadBuyerEmail)
        .maybeSingle();

      if (!buyerByEmailError && buyerByEmail) {
        buyerMeta = mapLeadBuyerMeta(buyerByEmail);
      }
    }

    const responseLead = {
      ...attachLeadExpiryMeta(lead),
      buyer_id: buyerMeta?.id || lead?.buyer_id || null,
      buyer_user_id: buyerMeta?.user_id || lead?.buyer_user_id || null,
      buyer_name: pickLeadBuyerText(buyerMeta?.full_name, lead?.buyer_name),
      buyer_email: buyerMeta?.email || leadBuyerEmail || null,
      buyer_phone: pickLeadBuyerText(buyerMeta?.phone, lead?.buyer_phone),
      company_name: pickLeadBuyerText(buyerMeta?.company_name, lead?.company_name),
      buyer_registered: Boolean(
        buyerMeta?.id ||
        buyerMeta?.user_id ||
        String(lead?.buyer_id || '').trim() ||
        String(lead?.buyer_user_id || '').trim()
      ),
      is_registered_buyer: Boolean(
        buyerMeta?.id ||
        buyerMeta?.user_id ||
        String(lead?.buyer_id || '').trim() ||
        String(lead?.buyer_user_id || '').trim()
      ),
      buyers: buyerMeta,
      source,
      purchase_date: normalizedPurchaseDatetime,
      purchase_datetime: normalizedPurchaseDatetime,
      lead_purchase_id: purchase?.id || null,
      purchase_amount: purchase?.purchase_price ?? purchase?.amount ?? null,
      payment_status: purchase?.payment_status || null,
      consumption_type: purchase?.consumption_type || null,
      lead_status: purchase?.lead_status || null,
      subscription_plan_name: purchase?.subscription_plan_name || null,
      plan_name: purchase?.subscription_plan_name || null,
      is_contact_unlocked: Boolean(isDirect || purchase),
      details_unlocked: Boolean(isDirect || purchase),
    };

    return res.json({ success: true, lead: responseLead });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to fetch lead' });
  }
});

router.get('/me/leads/:leadId/contacts', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Invalid lead id' });
    }

    const { lead, purchase, isDirect, isVisibleMarketplaceLead } = await resolveVendorLeadAccess({
      vendorId: vendor.id,
      leadId,
    });

    if (!lead || (!isDirect && !purchase && !isVisibleMarketplaceLead)) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!isDirect && !purchase) {
      return res.status(403).json({ success: false, error: 'You have not purchased this lead' });
    }

    const { data: contacts, error: contactsError } = await supabase
      .from('lead_contacts')
      .select('*')
      .eq('vendor_id', vendor.id)
      .eq('lead_id', leadId)
      .order('contact_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (contactsError) {
      return res.status(500).json({ success: false, error: contactsError.message || 'Failed to load lead contacts' });
    }

    return res.json({ success: true, contacts: contacts || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load lead contacts' });
  }
});

router.post('/me/leads/:leadId/contacts', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Invalid lead id' });
    }

    const contactType = String(req.body?.contact_type || req.body?.contactType || '')
      .trim()
      .toUpperCase();
    const allowedTypes = new Set(['CALL', 'WHATSAPP', 'EMAIL']);
    if (!allowedTypes.has(contactType)) {
      return res.status(400).json({ success: false, error: 'Invalid contact type' });
    }

    const { lead, purchase, isDirect, isVisibleMarketplaceLead } = await resolveVendorLeadAccess({
      vendorId: vendor.id,
      leadId,
    });

    if (!lead || (!isDirect && !purchase && !isVisibleMarketplaceLead)) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (!isDirect && !purchase) {
      return res.status(403).json({ success: false, error: 'You have not purchased this lead' });
    }

    const nowIso = new Date().toISOString();
    const contactPayload = {
      vendor_id: vendor.id,
      lead_id: leadId,
      contact_type: contactType,
      status: 'PENDING',
      notes: String(req.body?.notes || '').trim(),
      contact_date: nowIso,
      created_at: nowIso,
    };

    const { data: contact, error: contactError } = await supabase
      .from('lead_contacts')
      .insert([contactPayload])
      .select('*')
      .maybeSingle();

    if (contactError) {
      return res.status(500).json({ success: false, error: contactError.message || 'Failed to log lead contact' });
    }

    return res.json({ success: true, contact: contact || contactPayload });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to log lead contact' });
  }
});

router.get('/me/leads/:leadId/status-history', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Invalid lead id' });
    }

    const { lead, purchase, isDirect, isVisibleMarketplaceLead } = await resolveVendorLeadAccess({
      vendorId: vendor.id,
      leadId,
    });

    if (!lead || (!isDirect && !purchase && !isVisibleMarketplaceLead)) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    if (!isDirect && !purchase) {
      return res.status(403).json({
        success: false,
        error: 'Lead status history is available only for purchased or direct leads',
      });
    }

    const { data: historyRows, error: historyError } = await supabase
      .from('lead_status_history')
      .select('id, lead_id, vendor_id, lead_purchase_id, status, note, source, created_by, created_at')
      .eq('lead_id', leadId)
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(200);

    if (historyError) {
      if (isMissingRelationError(historyError, 'lead_status_history')) {
        return res.status(503).json({
          success: false,
          code: 'LEAD_STATUS_HISTORY_UNAVAILABLE',
          error: 'Lead status history feature is unavailable. Please run the latest migration.',
        });
      }
      return res.status(500).json({
        success: false,
        error: historyError.message || 'Failed to fetch lead status history',
      });
    }

    const latestHistoryStatus = normalizeVendorLeadStatus(historyRows?.[0]?.status);
    const currentStatus =
      normalizeVendorLeadStatus(purchase?.lead_status) ||
      latestHistoryStatus ||
      inferFallbackLeadStatus(lead);

    return res.json({
      success: true,
      lead_id: leadId,
      current_status: currentStatus,
      is_direct: isDirect,
      is_purchased: Boolean(purchase),
      history: historyRows || [],
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || 'Failed to fetch lead status history',
    });
  }
});

router.post('/me/leads/:leadId/status', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params?.leadId || '').trim();
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Invalid lead id' });
    }

    const status = normalizeVendorLeadStatus(req.body?.status);
    if (!status) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Allowed: ${VENDOR_LEAD_STATUS_VALUES.join(', ')}`,
      });
    }
    const note = normalizeLeadStatusNote(req.body?.note);

    const { lead, purchase, isDirect, isVisibleMarketplaceLead } = await resolveVendorLeadAccess({
      vendorId: vendor.id,
      leadId,
    });

    if (!lead || (!isDirect && !purchase && !isVisibleMarketplaceLead)) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    if (!isDirect && !purchase) {
      return res.status(403).json({
        success: false,
        error: 'Lead status can be updated only for purchased or direct leads',
      });
    }

    const currentKnownStatus =
      normalizeVendorLeadStatus(purchase?.lead_status) || inferFallbackLeadStatus(lead);
    if (currentKnownStatus === status && !note) {
      return res.json({
        success: true,
        lead_id: leadId,
        lead_status: status,
        current_status: status,
        purchase: purchase || null,
        history: [],
        unchanged: true,
      });
    }

    const nowIso = new Date().toISOString();
    let updatedPurchase = purchase || null;

    if (purchase?.id) {
      const { data: purchaseRow, error: purchaseUpdateError } = await supabase
        .from('lead_purchases')
        .update({ lead_status: status })
        .eq('id', purchase.id)
        .eq('vendor_id', vendor.id)
        .eq('lead_id', leadId)
        .select(
          'id, purchase_date, purchase_datetime, amount, purchase_price, payment_status, consumption_type, lead_status, subscription_plan_name'
        )
        .maybeSingle();

      if (purchaseUpdateError) {
        return res.status(500).json({
          success: false,
          error: purchaseUpdateError.message || 'Failed to update lead status',
        });
      }
      updatedPurchase = purchaseRow || updatedPurchase;
    } else if (isDirect) {
      const mappedLeadStatus = status === 'CLOSED' ? 'CLOSED' : 'AVAILABLE';
      const { error: directUpdateError } = await supabase
        .from('leads')
        .update({ status: mappedLeadStatus })
        .eq('id', leadId)
        .eq('vendor_id', vendor.id);

      if (directUpdateError) {
        return res.status(500).json({
          success: false,
          error: directUpdateError.message || 'Failed to update direct lead status',
        });
      }
    }

    const historyInsert = {
      lead_id: leadId,
      vendor_id: vendor.id,
      lead_purchase_id: updatedPurchase?.id || null,
      status,
      note,
      source: updatedPurchase?.id ? 'PURCHASE' : 'DIRECT',
      created_by: req.user?.id || null,
      created_at: nowIso,
    };

    const { data: historyRow, error: historyError } = await supabase
      .from('lead_status_history')
      .insert([historyInsert])
      .select('id, lead_id, vendor_id, lead_purchase_id, status, note, source, created_by, created_at')
      .maybeSingle();

    if (historyError) {
      if (isMissingRelationError(historyError, 'lead_status_history')) {
        return res.status(503).json({
          success: false,
          code: 'LEAD_STATUS_HISTORY_UNAVAILABLE',
          error: 'Lead status history feature is unavailable. Please run the latest migration.',
        });
      }
      return res.status(500).json({
        success: false,
        error: historyError.message || 'Failed to store lead status history',
      });
    }

    return res.json({
      success: true,
      lead_id: leadId,
      lead_status: status,
      current_status: status,
      purchase: updatedPurchase,
      history: historyRow ? [historyRow] : [],
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message || 'Failed to update lead status',
    });
  }
});

router.get('/me/leads', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const now = new Date();
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { data: purchases, error: purchaseError } = await supabase
      .from('lead_purchases')
      .select(
        'id, vendor_id, lead_id, amount, purchase_price, payment_status, purchase_date, purchase_datetime, consumption_type, lead_status, subscription_plan_name'
      )
      .in('vendor_id', vendorIds)
      .order('purchase_datetime', { ascending: false, nullsFirst: false })
      .order('purchase_date', { ascending: false });

    if (purchaseError) {
      return res.status(500).json({ success: false, error: purchaseError.message || 'Failed to fetch lead purchases' });
    }

    const purchasedIds = Array.from(
      new Set((purchases || []).map((p) => String(p?.lead_id || '')).filter(Boolean))
    );

    let purchasedLeads = [];
    if (purchasedIds.length) {
      const { data: purchasedRows, error: purchasedRowsError } = await supabase
        .from('leads')
        .select('*')
        .in('id', purchasedIds);

      if (purchasedRowsError) {
        return res.status(500).json({ success: false, error: purchasedRowsError.message || 'Failed to fetch purchased leads' });
      }

      const leadById = new Map((purchasedRows || []).map((lead) => [String(lead.id), lead]));
      purchasedLeads = (purchases || [])
        .map((purchase) => {
          const lead = leadById.get(String(purchase?.lead_id || ''));
          if (!lead) return null;
          const normalizedPurchaseDatetime =
            purchase?.purchase_datetime ||
            purchase?.purchase_date ||
            lead?.created_at ||
            null;
          return {
            ...lead,
            source: 'Purchased',
            purchase_date: normalizedPurchaseDatetime,
            purchase_datetime: normalizedPurchaseDatetime,
            lead_purchase_id: purchase?.id || null,
            purchase_amount: purchase?.purchase_price ?? purchase?.amount ?? null,
            payment_status: purchase?.payment_status || null,
            consumption_type: purchase?.consumption_type || null,
            lead_status: purchase?.lead_status || null,
            subscription_plan_name: purchase?.subscription_plan_name || null,
            plan_name: purchase?.subscription_plan_name || null,
          };
        })
        .filter(Boolean)
        .map((lead) => attachLeadExpiryMeta(lead, now));
    }

    const { data: directRows, error: directError } = await supabase
      .from('leads')
      .select('*')
      .in('vendor_id', vendorIds)
      .order('created_at', { ascending: false });

    if (directError) {
      return res.status(500).json({ success: false, error: directError.message || 'Failed to fetch direct leads' });
    }

    const purchasedLeadIdSet = new Set(purchasedLeads.map((lead) => String(lead?.id || '')).filter(Boolean));
    const directLeads = (directRows || [])
      .filter((lead) => !purchasedLeadIdSet.has(String(lead?.id || '')))
      .map((lead) => ({
        ...attachLeadExpiryMeta(lead, now),
        source: 'Direct',
        purchase_date: lead?.created_at || null,
      }));

    const combined = [...purchasedLeads, ...directLeads].sort((a, b) => {
      const aTs = new Date(a?.purchase_date || a?.created_at || 0).getTime();
      const bTs = new Date(b?.purchase_date || b?.created_at || 0).getTime();
      return bTs - aTs;
    });

    return res.json({ success: true, leads: combined });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/me/proposals', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const type = String(req.query?.type || 'received').toLowerCase();

    const { data: proposals, error } = await supabase
      .from('proposals')
      .select('*')
      .in('vendor_id', vendorIds)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch proposals' });
    }

    const enriched = await attachBuyerMetaToProposals(proposals || [], {
      vendorUserId: req.user?.id || '',
      vendorIds,
    });
    const withType = enriched.map((row) => {
      const hasBuyerEmail = Boolean(String(row?.buyer_email || '').trim());
      return {
        ...row,
        proposal_type: hasBuyerEmail ? 'sent' : 'received',
      };
    });

    const filtered =
      type === 'sent'
        ? withType.filter((row) => row.proposal_type === 'sent')
        : type === 'all'
          ? withType
          : withType.filter((row) => row.proposal_type === 'received');

    return res.json({ success: true, proposals: filtered });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/me/proposals/:proposalId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { proposalId } = req.params;
    if (!isValidId(proposalId)) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const { data: proposal, error } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', proposalId)
      .in('vendor_id', vendorIds)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found' });

    const [enriched] = await attachBuyerMetaToProposals([proposal], {
      vendorUserId: req.user?.id || '',
      vendorIds,
    });
    return res.json({ success: true, proposal: enriched || proposal });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/me/proposals/:proposalId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const { proposalId } = req.params;
    if (!isValidId(proposalId)) {
      return res.status(400).json({ success: false, error: 'Invalid proposal id' });
    }

    const { data: deletedRows, error } = await supabase
      .from('proposals')
      .delete()
      .eq('id', proposalId)
      .in('vendor_id', vendorIds)
      .select('id');

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Proposal not found or already deleted' });
    }
    return res.json({ success: true, deleted_count: deletedRows.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const { vendor, error } = await resolvePublicVendorRecord(vendorId);

    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    return res.json({ success: true, vendor });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:vendorId/products', async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const { data: products, error: pErr } = await supabase
      .from('products')
      .select('id, name, price, price_unit, images, category_other, micro_category_id, sub_category_id, head_category_id')
      .eq('vendor_id', vendorId)
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false });

    if (pErr) return res.status(500).json({ success: false, error: pErr.message });

    const microIds = Array.from(new Set((products || []).map((p) => p.micro_category_id).filter(Boolean)));
    const subIds = Array.from(new Set((products || []).map((p) => p.sub_category_id).filter(Boolean)));
    const headIds = Array.from(new Set((products || []).map((p) => p.head_category_id).filter(Boolean)));

    const [microRes, subRes, headRes] = await Promise.all([
      microIds.length
        ? supabase
            .from('micro_categories')
            .select('id, name, sub_categories(id, name, head_categories(id, name))')
            .in('id', microIds)
        : Promise.resolve({ data: [] }),
      subIds.length
        ? supabase
            .from('sub_categories')
            .select('id, name, head_categories(id, name)')
            .in('id', subIds)
        : Promise.resolve({ data: [] }),
      headIds.length
        ? supabase.from('head_categories').select('id, name').in('id', headIds)
        : Promise.resolve({ data: [] }),
    ]);

    const microLookup = {};
    (microRes?.data || []).forEach((m) => {
      microLookup[m.id] = {
        microName: m.name,
        subId: m.sub_categories?.id || null,
        subName: m.sub_categories?.name || null,
        headId: m.sub_categories?.head_categories?.id || null,
        headName: m.sub_categories?.head_categories?.name || null,
      };
    });

    const subLookup = {};
    (subRes?.data || []).forEach((s) => {
      subLookup[s.id] = {
        subName: s.name,
        headId: s.head_categories?.id || null,
        headName: s.head_categories?.name || null,
      };
    });

    const headLookup = {};
    (headRes?.data || []).forEach((h) => {
      headLookup[h.id] = h.name;
    });

    const mappedProducts = (products || []).map((p) => {
      const microInfo = microLookup[p.micro_category_id] || {};
      const subInfo = subLookup[p.sub_category_id] || {};
      const headName =
        microInfo.headName ||
        subInfo.headName ||
        headLookup[p.head_category_id] ||
        'Other Category';
      const subName =
        microInfo.subName ||
        subInfo.subName ||
        p.category_other ||
        'Other Subcategory';

      const image =
        (p.images && Array.isArray(p.images) && p.images[0]) ||
        (p.images && typeof p.images === 'string' ? p.images : FALLBACK_IMAGE);

      return {
        id: p.id,
        name: p.name,
        price: `₹${p.price}${p.price_unit ? ' / ' + p.price_unit : ''}`,
        category: p.category_other || microInfo.microName || subName || 'General',
        head_category_name: headName,
        sub_category_name: subName,
        micro_category_name: microInfo.microName || null,
        image,
      };
    });

    return res.json({ success: true, products: mappedProducts });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:vendorId/services', async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    let mappedServices = [];
    try {
      const { data: services, error } = await supabase
        .from('vendor_services')
        .select('*')
        .eq('vendor_id', vendorId);

      if (error) throw error;

      if (services?.length) {
        mappedServices = services.map((service) => ({
          id: service.id,
          name: service.name || service.service_name || service.title || 'Service',
          category: service.category || service.service_type || 'Service',
          description:
            service.description ||
            service.details ||
            service.short_description ||
            'Service details coming soon.',
          price: service.price
            ? `₹${service.price}${service.price_unit ? ' / ' + service.price_unit : ''}`
            : service.rate
              ? `₹${service.rate}`
              : 'Price on request',
          image:
            service.image ||
            service.cover_image ||
            (Array.isArray(service.images) ? service.images[0] : null) ||
            FALLBACK_SERVICE_IMAGE,
        }));
      }
    } catch {
      mappedServices = [];
    }

    return res.json({ success: true, services: mappedServices });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:vendorId/service-categories', async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const { data: prefs, error } = await supabase
      .from('vendor_preferences')
      .select('preferred_micro_categories')
      .eq('vendor_id', vendorId)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });

    const ids = prefs?.preferred_micro_categories || [];
    if (!ids?.length) return res.json({ success: true, categories: [] });

    const { data: headCats, error: headErr } = await supabase
      .from('head_categories')
      .select('id, name')
      .in('id', ids);

    if (headErr) return res.status(500).json({ success: false, error: headErr.message });

    const mapped = (headCats || []).map((h) => ({ id: h.id, name: h.name }));
    return res.json({ success: true, categories: mapped });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/:vendorId/favorite', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const buyerId = await resolveBuyerId(req.user.id);
    if (!buyerId) {
      return res.status(404).json({ success: false, error: 'Buyer profile not found' });
    }

    const { data: favRow, error } = await supabase
      .from('favorites')
      .select('id')
      .eq('buyer_id', buyerId)
      .eq('vendor_id', vendorId)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, isFavorite: !!favRow?.id });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/:vendorId/favorite', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const buyerId = await resolveBuyerId(req.user.id);
    if (!buyerId) {
      return res.status(404).json({ success: false, error: 'Buyer profile not found' });
    }

    const { error } = await supabase
      .from('favorites')
      .insert([{ buyer_id: buyerId, vendor_id: vendorId }]);

    if (error && String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.json({ success: true, isFavorite: true });
    }

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, isFavorite: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/:vendorId/favorite', requireAuth({ roles: ['BUYER'] }), async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const buyerId = await resolveBuyerId(req.user.id);
    if (!buyerId) {
      return res.status(404).json({ success: false, error: 'Buyer profile not found' });
    }

    const { error } = await supabase
      .from('favorites')
      .delete()
      .match({ buyer_id: buyerId, vendor_id: vendorId });

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, isFavorite: false });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/:vendorId/leads', optionalAuth(), async (req, res) => {
  try {
    const rawVendorId = String(req.params?.vendorId || '').trim();
    const isMarketplaceRequest = rawVendorId.toLowerCase() === 'marketplace';

    if (!isMarketplaceRequest && !isValidId(rawVendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    let vendor = null;
    if (!isMarketplaceRequest) {
      const { data: vendorRow, error: vendorError } = await supabase
        .from('vendors')
        .select('id, user_id, company_name, email')
        .eq('id', rawVendorId)
        .maybeSingle();

      if (vendorError) {
        return res.status(500).json({ success: false, error: vendorError.message });
      }
      if (!vendorRow) {
        return res.status(404).json({ success: false, error: 'Vendor not found' });
      }
      vendor = vendorRow;
    }

    const payload = req.body || {};
    const requirement = nonEmptyText(payload.description || payload.message, 5000);
    if (!requirement || requirement.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Requirement/description must be at least 10 characters',
      });
    }

    const buyerProfile = req.user ? await resolveBuyerProfileForUser(req.user) : null;

    const fallbackBuyerName = nonEmptyText(
      req.user?.email ? String(req.user.email).split('@')[0] : 'Buyer',
      120
    ) || 'Buyer';

    const buyerName = nonEmptyText(
      buyerProfile?.full_name ||
        buyerProfile?.company_name ||
        payload.buyer_name ||
        fallbackBuyerName,
      160
    );

    const buyerEmail = nonEmptyText(
      buyerProfile?.email || req.user?.email || payload.buyer_email,
      320
    );
    const buyerPhone = nonEmptyText(
      buyerProfile?.phone ||
        buyerProfile?.mobile_number ||
        buyerProfile?.mobile ||
        buyerProfile?.whatsapp ||
        payload.buyer_phone,
      60
    );
    const companyName = nonEmptyText(
      buyerProfile?.company_name || payload.company_name,
      200
    );

    if (!buyerName) {
      return res.status(400).json({ success: false, error: 'Buyer name is required' });
    }
    if (!buyerEmail) {
      return res.status(400).json({ success: false, error: 'Buyer email is required' });
    }
    if (!buyerPhone) {
      return res.status(400).json({ success: false, error: 'Buyer phone is required' });
    }

    const title = nonEmptyText(
      payload.title || payload.product_name || payload.product_interest || 'Product enquiry',
      200
    );
    const productName = nonEmptyText(payload.product_name || payload.product_interest || title, 200);
    const productInterest = nonEmptyText(
      payload.product_interest || payload.product_name || title,
      200
    );
    const category = nonEmptyText(payload.category || payload.category_name, 320);
    const categorySlug = nonEmptyText(payload.category_slug, 160);
    const microCategoryId = nonEmptyText(payload.micro_category_id, 80);
    const subCategoryId = nonEmptyText(payload.sub_category_id, 80);
    const headCategoryId = nonEmptyText(payload.head_category_id, 80);
    const stateId = nonEmptyText(payload.state_id, 80);
    const cityId = nonEmptyText(payload.city_id, 80);
    let stateName = nonEmptyText(payload.state || payload.state_name, 120);
    let cityName = nonEmptyText(payload.city || payload.city_name, 120);
    if ((!stateName && stateId) || (!cityName && cityId)) {
      const resolvedLocation = await resolveLocationNames({ stateId, cityId });
      stateName = stateName || resolvedLocation.stateName;
      cityName = cityName || resolvedLocation.cityName;
    }
    const location =
      nonEmptyText(payload.location, 200) ||
      [cityName, stateName].filter(Boolean).join(', ') ||
      null;
    const pincode = nonEmptyText(payload.pincode, 10);
    const vendorEmail = nonEmptyText(payload.vendor_email || vendor?.email, 320);
    const createdAt = new Date().toISOString();

    const proposalBasePayload = {
      vendor_id: vendor?.id || null,
      vendor_email: vendorEmail,
      buyer_id: buyerProfile?.id || null,
      buyer_email: buyerEmail ? String(buyerEmail).toLowerCase().trim() : null,
      title,
      product_name: productName,
      category,
      category_slug: categorySlug,
      micro_category_id: microCategoryId,
      sub_category_id: subCategoryId,
      head_category_id: headCategoryId,
      state_id: stateId,
      city_id: cityId,
      location,
      pincode,
      quantity: nonEmptyText(payload.quantity, 80),
      budget: parseBudget(payload.budget),
      required_by_date: nonEmptyText(payload.required_by_date, 40),
      description: requirement,
      status: 'SENT',
      created_at: createdAt,
      updated_at: createdAt,
    };

    let createdProposal = null;
    try {
      const proposalRow = await insertWithOptionalColumns({
        table: 'proposals',
        payload: proposalBasePayload,
        select: 'id, vendor_id, buyer_id, title, product_name, status, created_at',
        fallbackDropSets: [
          ['required_by_date'],
          ['required_by_date', 'buyer_email'],
          [
            'required_by_date',
            'buyer_email',
            'vendor_email',
            'category',
            'category_slug',
            'micro_category_id',
            'sub_category_id',
            'head_category_id',
            'state_id',
            'city_id',
            'location',
            'pincode',
          ],
        ],
      });

      createdProposal = proposalRow || {
        id: null,
        vendor_id: proposalBasePayload?.vendor_id || vendor?.id || null,
        buyer_id: proposalBasePayload?.buyer_id || null,
        title: proposalBasePayload?.title || null,
        product_name: proposalBasePayload?.product_name || null,
        status: proposalBasePayload?.status || 'SENT',
        created_at: proposalBasePayload?.created_at || null,
      };
    } catch (proposalInsertError) {
      if (vendor?.id) {
        return res.status(500).json({
          success: false,
          error: proposalInsertError?.message || 'Failed to create proposal',
        });
      }
      logger.warn(
        'Marketplace proposal insert failed; continuing with lead creation:',
        proposalInsertError?.message || proposalInsertError
      );
    }

    const baseLeadPayload = {
      vendor_id: vendor?.id || null,
      vendor_email: vendorEmail,
      title,
      product_name: productName,
      product_interest: productInterest,
      proposal_id: createdProposal?.id || null,
      buyer_id: buyerProfile?.id || null,
      buyer_name: buyerName,
      buyer_email: buyerEmail ? String(buyerEmail).toLowerCase().trim() : null,
      buyer_phone: buyerPhone,
      company_name: companyName,
      description: requirement,
      message: requirement,
      quantity: nonEmptyText(payload.quantity, 80),
      budget: parseBudget(payload.budget),
      category,
      category_slug: categorySlug,
      micro_category_id: microCategoryId,
      sub_category_id: subCategoryId,
      head_category_id: headCategoryId,
      location,
      state: stateName,
      city: cityName,
      state_id: stateId,
      city_id: cityId,
      pincode,
      source: vendor?.id ? 'DIRECT' : 'MARKETPLACE',
      status: 'AVAILABLE',
      created_at: createdAt,
      expires_at: addDays(createdAt, LEAD_EXPIRY_DAYS)?.toISOString() || null,
    };

    let createdLead = null;
    let lastError = null;

    try {
      const leadRow = await insertWithOptionalColumns({
        table: 'leads',
        payload: baseLeadPayload,
        select: 'id, vendor_id, title, buyer_id, buyer_name, buyer_email, created_at',
        fallbackDropSets: [
          ['location', 'category_slug', 'product_interest'],
          ['location', 'category_slug', 'product_interest', 'buyer_phone', 'company_name'],
          [
            'vendor_email',
            'location',
            'category_slug',
            'product_interest',
            'buyer_phone',
            'company_name',
            'micro_category_id',
            'sub_category_id',
            'head_category_id',
            'state_id',
            'city_id',
            'pincode',
            'source',
            'city',
            'state',
            'expires_at',
          ],
          [
            'vendor_id',
            'vendor_email',
            'location',
            'category_slug',
            'product_interest',
            'buyer_phone',
            'company_name',
            'micro_category_id',
            'sub_category_id',
            'head_category_id',
            'state_id',
            'city_id',
            'pincode',
            'source',
            'city',
            'state',
            'expires_at',
          ],
          [
            'vendor_id',
            'vendor_email',
            'proposal_id',
            'buyer_id',
            'category',
            'category_slug',
            'location',
            'micro_category_id',
            'sub_category_id',
            'head_category_id',
            'state_id',
            'city_id',
            'pincode',
            'source',
            'product_interest',
            'buyer_phone',
            'company_name',
            'city',
            'state',
            'expires_at',
          ],
        ],
      });

      createdLead = leadRow || {
        id: null,
        vendor_id: baseLeadPayload?.vendor_id || vendor?.id || null,
        title: baseLeadPayload?.title || null,
        buyer_id: baseLeadPayload?.buyer_id || null,
        buyer_name: baseLeadPayload?.buyer_name || null,
        buyer_email: baseLeadPayload?.buyer_email || null,
        created_at: baseLeadPayload?.created_at || null,
      };
    } catch (leadErr) {
      lastError = leadErr;
    }

    if (!createdLead) {
      logger.warn('Lead insert failed after proposal create:', lastError?.message || lastError);
    }

    if (vendor?.id) {
      let vendorUserId = vendor.user_id || null;
      if (!vendorUserId && vendor?.email) {
        const { data: userRow } = await supabase
          .from('users')
          .select('id')
          .eq('email', String(vendor.email).toLowerCase().trim())
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        vendorUserId = userRow?.id || null;
      }

      if (vendorUserId) {
        try {
          await insertNotification({
            user_id: vendorUserId,
            type: 'NEW_LEAD',
            title: 'New enquiry received',
            message: `${buyerName || 'A buyer'} sent an enquiry for ${title || 'your listing'}`,
            link: '/vendor/proposals?tab=received',
            reference_id: createdProposal?.id || createdLead?.id || null,
            is_read: false,
            created_at: new Date().toISOString(),
          });
        } catch (notifError) {
          logger.warn('Vendor lead notification failed:', notifError?.message || notifError);
        }
      }
    }

    return res.status(201).json({
      success: true,
      lead: attachLeadExpiryMeta(createdLead || baseLeadPayload),
      proposal: createdProposal,
    });
  } catch (e) {
    return res.status(e?.statusCode || 500).json({ success: false, error: e.message });
  }
});

router.get('/:vendorId/leads', requireAuth(), async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!isValidId(vendorId)) {
      return res.status(400).json({ success: false, error: 'Invalid vendor id' });
    }

    const buyerProfile = await resolveBuyerProfileForUser(req.user);
    if (!buyerProfile?.id) {
      return res.json({ success: true, leads: [] });
    }

    const { data: leads, error } = await supabase
      .from('leads')
      .select('*')
      .eq('vendor_id', vendorId)
      .eq('buyer_id', buyerProfile.id);

    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, leads: leads || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Phase 2 additions: backend-first routes for operations that were direct Supabase ──

router.get('/me/lead-stats', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    }

    // Short TTL cache by identity (covers most requests where single vendor)
    const vendorKey = `lead:${vendorIds.slice().sort().join(',')}`;
    const cached = _getCached(_cacheLead, vendorKey);
    if (cached) {
      return res.json({ success: true, stats: cached });
    }

    const activeSubscriptions = await Promise.all(
      vendorIds.map(async (vendorId) => ({
        vendorId,
        subscription: await resolveActiveSubscriptionForVendor(vendorId),
      }))
    );
    const activeVendorEntry = activeSubscriptions.find((entry) => entry?.subscription) || null;
    const statsVendorId = activeVendorEntry?.vendorId || vendorIds[0] || null;

    // Time anchors for count queries
    const now = new Date();
    const nowIso = now.toISOString();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();
    const todayDate = todayIso.slice(0, 10);
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    const weekDay = weekStart.getDay();
    const weekDiff = weekDay === 0 ? -6 : 1 - weekDay;
    weekStart.setDate(weekStart.getDate() + weekDiff);
    const weekIso = weekStart.toISOString();
    const weekDate = weekIso.slice(0, 10);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - LEAD_EXPIRY_DAYS);
    const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();

    const [
      purchasesTotalRes,
      dailyUsedRes,
      weeklyUsedRes,
      directRes,
      contactRes,
      quotaRes,
    ] = await Promise.all([
      // Total purchases across vendorIds (count-only)
      supabase
        .from('lead_purchases')
        .select('*', { count: 'planned', head: true })
        .in('vendor_id', vendorIds),

      // Daily included used today for the active stats vendor
      supabase
        .from('lead_purchases')
        .select('*', { count: 'planned', head: true })
        .eq('vendor_id', statsVendorId)
        .eq('consumption_type', 'DAILY_INCLUDED')
        .or(`purchase_datetime.gte.${todayIso},purchase_date.gte.${todayDate}`),

      // Weekly included used since week start for the active stats vendor
      supabase
        .from('lead_purchases')
        .select('*', { count: 'planned', head: true })
        .eq('vendor_id', statsVendorId)
        .in('consumption_type', ['DAILY_INCLUDED', 'WEEKLY_INCLUDED'])
        .or(`purchase_datetime.gte.${weekIso},purchase_date.gte.${weekDate}`),

      // Direct leads: only non-expired or terminal status, minimal columns
      supabase
        .from('leads')
        .select('id, status, created_at, expires_at')
        .in('vendor_id', vendorIds)
        .or(
          [
            'status.eq.CLOSED',
            'status.eq.CONVERTED',
            `expires_at.gt.${nowIso}`,
            `and(expires_at.is.null,created_at.gt.${thirtyDaysAgoIso})`,
          ].join(',')
        ),

      // Contacts: only lead_id column
      supabase
        .from('lead_contacts')
        .select('lead_id')
        .in('vendor_id', vendorIds),

      // Quota row for the active stats vendor
      statsVendorId
        ? supabase
            .from('vendor_lead_quota')
            .select('*')
            .eq('vendor_id', statsVendorId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    // Graceful fallbacks for absent optional tables under local/staging
    const purchasesTotal = Number(purchasesTotalRes?.count || 0);

    const directSafe = Array.isArray(directRes?.data)
      ? directRes.data
      : [];

    const contactsSafe = Array.isArray(contactRes?.data)
      ? contactRes.data
      : [];

    const quotaSafe = quotaRes?.data ?? null;

    let activePlan = null;
    if (activeVendorEntry?.subscription?.plan_id) {
      const { data: planRow, error: planError } = await supabase
        .from('vendor_plans')
        .select('id, name, daily_limit, weekly_limit, yearly_limit, features')
        .eq('id', activeVendorEntry.subscription.plan_id)
        .maybeSingle();

      if (planError) {
        if (!isMissingRelationError(planError, 'vendor_plans')) {
          return res.status(500).json({ success: false, error: planError.message || 'Failed to fetch active plan' });
        }
        activePlan = null;
      } else {
        activePlan = planRow || null;
      }
    }

    const directLeads = directSafe || [];
    const contacts = contactsSafe || [];
    const quotaRow = quotaSafe || null;

    const directLeadIds = new Set(
      directLeads
        .filter((lead) => !isLeadExpired(lead))
        .map((lead) => String(lead?.id || '').trim())
        .filter(Boolean)
    );

    const contactedLeadIds = new Set(
      contacts
        .map((row) => String(row?.lead_id || '').trim())
        .filter(Boolean)
    );
    const totalContacted = new Set([...directLeadIds, ...contactedLeadIds]).size;

    const computedDailyUsed = Number(dailyUsedRes?.count || 0);
    const computedWeeklyUsed = Number(weeklyUsedRes?.count || 0);

    const quotaDailyUsed = Number(quotaRow?.daily_used);
    const quotaWeeklyUsed = Number(quotaRow?.weekly_used);
    const dailyLimit = Math.max(
      Number.isFinite(Number(quotaRow?.daily_limit)) ? Number(quotaRow?.daily_limit) : 0,
      Number(activePlan?.daily_limit) || 0
    );
    const weeklyLimit = Math.max(
      Number.isFinite(Number(quotaRow?.weekly_limit)) ? Number(quotaRow?.weekly_limit) : 0,
      Number(activePlan?.weekly_limit) || 0
    );

    const leadStats = {
        direct: directLeadIds.size,
        totalPurchased: purchasesTotal,
        totalContacted,
        dailyUsed: Math.max(Number.isFinite(quotaDailyUsed) ? quotaDailyUsed : 0, computedDailyUsed),
        dailyLimit,
        weeklyUsed: Math.max(Number.isFinite(quotaWeeklyUsed) ? quotaWeeklyUsed : 0, computedWeeklyUsed),
        weeklyLimit,
        extraLeadPrice: getPlanExtraLeadPrice(activePlan),
        vendor_id: statsVendorId,
      };
    const ckStats = `lead:${statsVendorId}`;
    _setCached(_cacheLead, ckStats, leadStats, 30000);
    // Also cache under identity-based key for early returns on next hit
    _setCached(_cacheLead, vendorKey, leadStats, 30000);
    return res.json({ success: true, stats: leadStats });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to load lead stats' });
  }
});

// ✅ Dashboard stats (products, leads, proposals, messages count)
router.get('/me/dashboard-stats', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = buildVendorResponse(await resolveVendorForUser(req.user));
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const ck = `dash:${vendor.id}`;
    const hit = _getCached(_cacheDash, ck);
    if (hit) {
      return res.json({ success: true, stats: hit });
    }

    const [products, leads, proposals, messages] = await Promise.all([
      supabase.from('products').select('*', { count: 'planned', head: true }).eq('vendor_id', vendor.id),
      supabase.from('leads').select('*', { count: 'planned', head: true }).eq('vendor_id', vendor.id).eq('status', 'AVAILABLE'),
      supabase.from('proposals').select('*', { count: 'planned', head: true }).eq('vendor_id', vendor.id).eq('status', 'SENT'),
      supabase.from('vendor_messages').select('*', { count: 'planned', head: true }).eq('vendor_id', vendor.id),
    ]);

    const stats = {
      totalProducts: products.count || 0,
      totalLeads: (leads.count || 0) + (proposals.count || 0),
      totalMessages: messages.count || 0,
      profileCompletion: vendor.profile_completion || calculateVendorProfileCompletion(vendor),
      kycStatus: vendor.kyc_status || 'PENDING',
      trustScore: 0,
      rating: 0,
      vendorId: vendor.vendor_id || vendor.id,
    };
    _setCached(_cacheDash, ck, stats, 30000);
    return res.json({ success: true, stats });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Recent products for vendor dashboard
router.get('/me/recent-products', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const ck = `recent:${vendor.id}`;
    const hit = _getCached(_cacheRecent, ck);
    if (hit) return res.json({ success: true, products: hit });

    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) return res.status(500).json({ success: false, error: error.message });
    _setCached(_cacheRecent, ck, data || [], 30000);
    return res.json({ success: true, products: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Recent leads for vendor dashboard
router.get('/me/recent-leads', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    const ck = `recentleads:${vendor.id}`;
    const hit = _getCached(_cacheRecentLeads, ck);
    if (hit) return res.json({ success: true, leads: hit });

    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) return res.status(500).json({ success: false, error: error.message });
    _setCached(_cacheRecentLeads, ck, data || [], 30000);
    return res.json({ success: true, leads: data || [] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Support ticket stats for vendor dashboard
router.get('/me/support-stats', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const ck = `support:${vendor.id}`;
    const hit = _getCached(_cacheSupport, ck);
    if (hit) return res.json({ success: true, stats: hit });

    const [total, open] = await Promise.all([
      supabase.from('support_tickets').select('*', { count: 'planned', head: true }).eq('vendor_id', vendor.id),
      supabase.from('support_tickets').select('*', { count: 'planned', head: true }).eq('vendor_id', vendor.id).neq('status', 'CLOSED'),
    ]);

    const stats = { total: total.count || 0, open: open.count || 0 };
    _setCached(_cacheSupport, ck, stats, 30000);
    return res.json({ success: true, stats });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Delete a product (ownership-scoped)
router.delete('/me/products/:productId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const productId = String(req.params.productId || '').trim();
    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

    // Verify ownership
    const { data: product } = await supabase
      .from('products')
      .select('id, vendor_id')
      .eq('id', productId)
      .maybeSingle();

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (product.vendor_id !== vendor.id) return res.status(403).json({ success: false, error: 'Not your product' });

    const { error } = await supabase.from('products').delete().eq('id', productId);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Update product status (ownership-scoped)
router.patch('/me/products/:productId/status', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const productId = String(req.params.productId || '').trim();
    const status = String(req.body?.status || '').trim().toUpperCase();
    const validStatuses = ['ACTIVE', 'DRAFT', 'ARCHIVED'];

    if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, error: `Invalid status: ${status}` });

    const { data: product } = await supabase
      .from('products')
      .select('id, vendor_id')
      .eq('id', productId)
      .maybeSingle();

    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (product.vendor_id !== vendor.id) return res.status(403).json({ success: false, error: 'Not your product' });

    const { data, error } = await supabase
      .from('products')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, product: data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Delete a contact person (ownership-scoped)
router.delete('/me/contact-persons/:contactId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const contactId = String(req.params.contactId || '').trim();
    if (!contactId) return res.status(400).json({ success: false, error: 'Contact ID required' });

    const { data: contact } = await supabase
      .from('vendor_contact_persons')
      .select('id, vendor_id')
      .eq('id', contactId)
      .maybeSingle();

    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
    if (contact.vendor_id !== vendor.id) return res.status(403).json({ success: false, error: 'Not your contact' });

    const { error } = await supabase.from('vendor_contact_persons').delete().eq('id', contactId);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Vendor creates a lead (vendor-initiated direct lead)
router.post('/me/leads-create', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const payload = req.body || {};
    const title = nonEmptyText(payload.title || payload.product_name || 'Lead', 200);
    const productName = nonEmptyText(payload.product_name || title, 200);
    const buyerName = nonEmptyText(payload.buyer_name, 160);
    const buyerEmail = nonEmptyText(payload.buyer_email, 320);
    const buyerPhone = nonEmptyText(payload.buyer_phone, 60);
    const description = nonEmptyText(payload.description || payload.message, 5000);

    if (!buyerName) return res.status(400).json({ success: false, error: 'buyer_name is required' });
    if (!buyerEmail) return res.status(400).json({ success: false, error: 'buyer_email is required' });

    const createdAt = new Date().toISOString();
    const leadPayload = {
      vendor_id: vendor.id,
      vendor_email: vendor.email || null,
      title,
      product_name: productName,
      buyer_name: buyerName,
      buyer_email: String(buyerEmail).toLowerCase().trim(),
      buyer_phone: buyerPhone || null,
      company_name: nonEmptyText(payload.company_name, 200) || null,
      description: description || null,
      message: description || null,
      category: nonEmptyText(payload.category, 320) || null,
      category_slug: nonEmptyText(payload.category_slug, 160) || null,
      micro_category_id: nonEmptyText(payload.micro_category_id, 80) || null,
      sub_category_id: nonEmptyText(payload.sub_category_id, 80) || null,
      head_category_id: nonEmptyText(payload.head_category_id, 80) || null,
      quantity: nonEmptyText(payload.quantity, 80) || null,
      budget: parseBudget(payload.budget),
      location: nonEmptyText(payload.location, 200) || null,
      state: nonEmptyText(payload.state, 120) || null,
      city: nonEmptyText(payload.city, 120) || null,
      state_id: nonEmptyText(payload.state_id, 80) || null,
      city_id: nonEmptyText(payload.city_id, 80) || null,
      source: 'VENDOR_CREATED',
      status: 'AVAILABLE',
      created_at: createdAt,
      expires_at: addDays(createdAt, LEAD_EXPIRY_DAYS)?.toISOString() || null,
    };

    let lead = null;
    try {
      lead = await insertWithOptionalColumns({
        table: 'leads',
        payload: leadPayload,
        select: '*',
        fallbackDropSets: [['expires_at']],
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.status(201).json({ success: true, lead: attachLeadExpiryMeta(lead || leadPayload) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Update a lead (vendor-owned)
router.patch('/me/leads/:leadId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params.leadId || '').trim();
    if (!leadId) return res.status(400).json({ success: false, error: 'leadId required' });

    const { data: existing } = await supabase.from('leads').select('id, vendor_id').eq('id', leadId).maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!vendorIds.includes(existing.vendor_id)) return res.status(403).json({ success: false, error: 'Not your lead' });

    const payload = req.body || {};
    const ALLOWED = ['title', 'product_name', 'description', 'message', 'buyer_name', 'buyer_phone', 'company_name', 'category', 'quantity', 'budget', 'location', 'status', 'sales_note'];
    const updates = {};
    for (const key of ALLOWED) {
      if (payload[key] !== undefined) updates[key] = payload[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data: lead, error } = await supabase.from('leads').update(updates).eq('id', leadId).select('*').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, lead });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Delete a lead (vendor-owned direct lead only)
router.delete('/me/leads/:leadId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const leadId = String(req.params.leadId || '').trim();
    if (!leadId) return res.status(400).json({ success: false, error: 'leadId required' });

    const { data: existing } = await supabase.from('leads').select('id, vendor_id').eq('id', leadId).maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!vendorIds.includes(existing.vendor_id)) return res.status(403).json({ success: false, error: 'Not your lead' });

    const { error } = await supabase.from('leads').delete().eq('id', leadId);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Delete a lead purchase record (vendor-owned)
router.delete('/me/purchases/:purchaseId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendorIds = await resolveVendorIdsForUser(req.user);
    if (!vendorIds.length) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const purchaseId = String(req.params.purchaseId || '').trim();
    if (!purchaseId) return res.status(400).json({ success: false, error: 'purchaseId required' });

    const { data: existing } = await supabase.from('lead_purchases').select('id, vendor_id').eq('id', purchaseId).maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Purchase not found' });
    if (!vendorIds.includes(existing.vendor_id)) return res.status(403).json({ success: false, error: 'Not your purchase' });

    const { error } = await supabase.from('lead_purchases').delete().eq('id', purchaseId);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Delete a contact (alias: /me/contacts/:id → contact_persons table)
router.delete('/me/contacts/:contactId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const contactId = String(req.params.contactId || '').trim();
    if (!contactId) return res.status(400).json({ success: false, error: 'contactId required' });

    const { data: contact } = await supabase
      .from('vendor_contact_persons')
      .select('id, vendor_id')
      .eq('id', contactId)
      .maybeSingle();

    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
    if (contact.vendor_id !== vendor.id) return res.status(403).json({ success: false, error: 'Not your contact' });

    const { error } = await supabase.from('vendor_contact_persons').delete().eq('id', contactId);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ Delete a message (ownership-scoped)
router.delete('/me/messages/:messageId', requireAuth({ roles: ['VENDOR'] }), async (req, res) => {
  try {
    const vendor = await resolveVendorForUser(req.user);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor profile not found' });

    const messageId = String(req.params.messageId || '').trim();
    if (!messageId) return res.status(400).json({ success: false, error: 'Message ID required' });

    const { data: message } = await supabase
      .from('vendor_messages')
      .select('id, vendor_id')
      .eq('id', messageId)
      .maybeSingle();

    if (!message) return res.status(404).json({ success: false, error: 'Message not found' });
    if (message.vendor_id !== vendor.id) return res.status(403).json({ success: false, error: 'Not your message' });

    const { error } = await supabase.from('vendor_messages').delete().eq('id', messageId);
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
