import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = fileURLToPath(import.meta.url);
const libDir = dirname(here);
const serverDir = resolve(libDir, '..');
const backendDir = resolve(serverDir, '..');

export const storageRoot = resolve(
  process.env.MYSQL_STORAGE_DIR || process.env.LOCAL_STORAGE_DIR || resolve(backendDir, 'uploads')
);

export const storageUrlPrefix = String(process.env.PUBLIC_STORAGE_URL || '/uploads').replace(/\/+$/, '');

const sanitizeSegment = (segment) =>
  String(segment || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '') || randomUUID())
    .join('/');

const resolveObjectPath = (bucket, objectPath) => {
  const safeBucket = sanitizeSegment(bucket || 'default');
  const safeObject = sanitizeSegment(objectPath || randomUUID());
  const abs = resolve(storageRoot, safeBucket, safeObject);
  const expectedRoot = resolve(storageRoot, safeBucket);
  if (!abs.startsWith(expectedRoot)) {
    throw new Error('Invalid storage path');
  }
  return { abs, safeBucket, safeObject };
};

const publicUrlFor = (bucket, objectPath) => {
  const safeBucket = sanitizeSegment(bucket || 'default');
  const safeObject = sanitizeSegment(objectPath || '');
  return `${storageUrlPrefix}/${safeBucket}/${safeObject}`.replace(/([^:]\/)\/+/g, '$1');
};

export async function ensureStorageRoot() {
  await fs.mkdir(storageRoot, { recursive: true });
}

export const localStorage = {
  async createBucket(bucket) {
    const { abs } = resolveObjectPath(bucket, '.bucket');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    return { data: { name: sanitizeSegment(bucket) }, error: null };
  },

  from(bucket) {
    return {
      async upload(objectPath, body, options = {}) {
        try {
          const { abs, safeObject } = resolveObjectPath(bucket, objectPath);
          if (!options?.upsert) {
            try {
              await fs.access(abs);
              return { data: null, error: { message: 'File already exists' } };
            } catch {
              // File does not exist; continue.
            }
          }

          const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, buffer);

          return {
            data: {
              path: safeObject,
              fullPath: `${sanitizeSegment(bucket)}/${safeObject}`,
              contentType: options?.contentType || null,
            },
            error: null,
          };
        } catch (error) {
          return { data: null, error: { message: error.message || 'Upload failed' } };
        }
      },

      getPublicUrl(objectPath) {
        return {
          data: {
            publicUrl: publicUrlFor(bucket, objectPath),
          },
          error: null,
        };
      },

      async createSignedUrl(objectPath) {
        return {
          data: {
            signedUrl: publicUrlFor(bucket, objectPath),
          },
          error: null,
        };
      },

      async list(folder = '', options = {}) {
        try {
          const { abs } = resolveObjectPath(bucket, folder || '.');
          const dir = folder ? abs : path.dirname(abs);
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          const limit = Number(options?.limit || entries.length || 100);
          const data = entries.slice(0, limit).map((entry) => ({
            name: entry.name,
            id: entry.name,
            updated_at: null,
            created_at: null,
            last_accessed_at: null,
            metadata: null,
          }));
          return { data, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message || 'List failed' } };
        }
      },
    };
  },
};
