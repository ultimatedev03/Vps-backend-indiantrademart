const DEFAULT_WEBP_QUALITY = Number(process.env.IMAGE_WEBP_QUALITY || 82);
const DEFAULT_AVIF_QUALITY = Number(process.env.IMAGE_AVIF_QUALITY || 50);
const DEFAULT_MAX_WIDTH = Number(process.env.IMAGE_MAX_WIDTH || 1800);
const DEFAULT_MAX_HEIGHT = Number(process.env.IMAGE_MAX_HEIGHT || 1800);

const OPTIMIZABLE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

let sharpLoader = null;

const getSharp = async () => {
  if (!sharpLoader) {
    sharpLoader = import('sharp')
      .then((mod) => mod.default || mod)
      .catch(() => null);
  }
  return sharpLoader;
};

export const isOptimizableImageMime = (contentType = '') =>
  OPTIMIZABLE_MIME.has(String(contentType || '').trim().toLowerCase());

export const replaceObjectPathExtension = (objectPath = '', extension = 'webp') => {
  const cleanExtension = String(extension || 'webp').replace(/^\./, '') || 'webp';
  const raw = String(objectPath || '').trim();
  if (!raw) return `upload.${cleanExtension}`;
  if (/\.[a-z0-9]{2,8}$/i.test(raw)) return raw.replace(/\.[a-z0-9]{2,8}$/i, `.${cleanExtension}`);
  return `${raw}.${cleanExtension}`;
};

const clampQuality = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
};

export async function buildOptimizedImageUpload({ buffer, contentType, objectPath }) {
  const mime = String(contentType || '').trim().toLowerCase();
  if (!buffer?.length || !isOptimizableImageMime(mime)) {
    return {
      optimized: false,
      primary: { buffer, contentType, objectPath },
      variants: [],
    };
  }

  const sharp = await getSharp();
  if (!sharp) {
    return {
      optimized: false,
      primary: { buffer, contentType, objectPath },
      variants: [],
      warning: 'sharp_not_available',
    };
  }

  const resizeOptions = {
    width: DEFAULT_MAX_WIDTH,
    height: DEFAULT_MAX_HEIGHT,
    fit: 'inside',
    withoutEnlargement: true,
  };

  const webpPath = replaceObjectPathExtension(objectPath, 'webp');
  const avifPath = replaceObjectPathExtension(objectPath, 'avif');
  const basePipeline = () => sharp(buffer, { failOn: 'none' }).rotate().resize(resizeOptions);

  const webpBuffer = await basePipeline()
    .webp({
      quality: clampQuality(DEFAULT_WEBP_QUALITY, 82),
      effort: 4,
    })
    .toBuffer();

  let avifBuffer = null;
  try {
    avifBuffer = await basePipeline()
      .avif({
        quality: clampQuality(DEFAULT_AVIF_QUALITY, 50),
        effort: 4,
      })
      .toBuffer();
  } catch {
    avifBuffer = null;
  }

  return {
    optimized: true,
    primary: {
      buffer: webpBuffer,
      contentType: 'image/webp',
      objectPath: webpPath,
    },
    variants: avifBuffer?.length
      ? [
          {
            buffer: avifBuffer,
            contentType: 'image/avif',
            objectPath: avifPath,
          },
        ]
      : [],
    original: {
      buffer,
      contentType,
      objectPath,
    },
  };
}

export async function uploadImageVariants({ storage, bucket, variants = [], upsert = true }) {
  const uploaded = [];
  for (const variant of variants) {
    if (!variant?.buffer?.length || !variant?.objectPath) continue;
    const { error } = await storage.from(bucket).upload(variant.objectPath, variant.buffer, {
      contentType: variant.contentType,
      upsert,
    });
    if (!error) {
      uploaded.push({
        path: variant.objectPath,
        contentType: variant.contentType,
      });
    }
  }
  return uploaded;
}
