import crypto from 'crypto';

const sanitizeEnvValue = (value) => {
  if (typeof value !== 'string') return '';
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith('\'') && cleaned.endsWith('\''))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
};

const readEnv = (...keys) => {
  for (const key of keys) {
    const value = sanitizeEnvValue(process.env[key]);
    if (value) return value;
  }
  return '';
};

const getCloudinaryConfig = () => ({
  cloudName: readEnv('CLOUDINARY_CLOUD_NAME', 'VITE_CLOUDINARY_CLOUD_NAME'),
  apiKey: readEnv('CLOUDINARY_API_KEY'),
  apiSecret: readEnv('CLOUDINARY_API_SECRET'),
});

export const isCloudinaryConfigured = () => {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  return Boolean(cloudName && apiKey && apiSecret);
};

export const inferCloudinaryResourceType = (contentType = '') => {
  const mime = String(contentType || '').trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'raw';
};

const signParams = (params, apiSecret) => {
  const signatureBase = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto.createHash('sha1').update(`${signatureBase}${apiSecret}`).digest('hex');
};

const sanitizePublicIdPart = (value = '') =>
  String(value || '')
    .trim()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 180) || 'upload';

export const uploadBufferToCloudinary = async ({
  buffer,
  contentType = 'application/octet-stream',
  folder = 'uploads',
  publicId = '',
  fileName = 'upload',
  resourceType,
  tags = [],
}) => {
  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
  }
  if (!buffer?.length) throw new Error('Empty upload payload');

  const finalResourceType = resourceType || inferCloudinaryResourceType(contentType);
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder,
    overwrite: 'true',
    public_id: sanitizePublicIdPart(publicId || fileName),
    timestamp,
  };

  const tagValue = Array.isArray(tags) ? tags.filter(Boolean).join(',') : String(tags || '').trim();
  if (tagValue) params.tags = tagValue;

  const signature = signParams(params, apiSecret);
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: contentType }), fileName || 'upload');
  form.set('api_key', apiKey);
  Object.entries(params).forEach(([key, value]) => form.set(key, String(value)));
  form.set('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${finalResourceType}/upload`, {
    method: 'POST',
    body: form,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message || `Cloudinary upload failed (${response.status})`);
  }

  return {
    storageProvider: 'cloudinary',
    bucket: `cloudinary:${finalResourceType}`,
    path: payload?.public_id || params.public_id,
    publicId: payload?.public_id || params.public_id,
    publicUrl: payload?.secure_url || payload?.url || null,
    resourceType: finalResourceType,
    bytes: payload?.bytes || buffer.length,
  };
};
