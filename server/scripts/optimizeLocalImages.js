import fs from 'fs/promises';
import path from 'path';
import { db } from '../lib/dbClient.js';
import {
  buildOptimizedImageUpload,
  replaceObjectPathExtension,
} from '../lib/imageOptimization.js';
import { storageRoot, storageUrlPrefix } from '../lib/localStorage.js';

const WRITE = String(process.env.OPTIMIZE_IMAGES_WRITE || '').toLowerCase() === 'true';
const LIMIT = Math.max(1, Number(process.env.OPTIMIZE_IMAGES_LIMIT || 500));
const BATCH_SIZE = Math.min(500, Math.max(1, Number(process.env.OPTIMIZE_IMAGES_BATCH_SIZE || 100)));
const SITE_URL = String(process.env.SITE_URL || process.env.VITE_SITE_URL || 'https://indiantrademart.com').replace(/\/+$/, '');

const TARGETS = [
  { table: 'product_images', column: 'image_url' },
  { table: 'head_categories', column: 'image_url' },
  { table: 'sub_categories', column: 'image_url' },
  { table: 'micro_categories', column: 'image_url' },
  { table: 'vendors', column: 'avatar_url' },
  { table: 'vendors', column: 'banner_url' },
  { table: 'buyers', column: 'avatar_url' },
];

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const toLocalUpload = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw || raw.endsWith('.webp') || raw.endsWith('.avif')) return null;

  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      const allowedHosts = new Set([
        new URL(SITE_URL).host,
        'indiantrademart.com',
        'www.indiantrademart.com',
      ]);
      if (!allowedHosts.has(url.host)) return null;
      pathname = url.pathname;
    }
  } catch {
    return null;
  }

  const prefix = `${storageUrlPrefix}/`;
  if (!pathname.startsWith(prefix)) return null;

  const relative = pathname.slice(prefix.length).replace(/^\/+/, '');
  const ext = path.extname(relative).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) return null;

  const absolute = path.resolve(storageRoot, relative);
  if (!absolute.startsWith(path.resolve(storageRoot))) return null;

  return {
    relative,
    absolute,
    mime,
    webpRelative: replaceObjectPathExtension(relative, 'webp'),
    avifRelative: replaceObjectPathExtension(relative, 'avif'),
  };
};

const publicUrlForRelative = (relative) =>
  `${storageUrlPrefix}/${relative}`.replace(/([^:]\/)\/+/g, '$1');

const optimizeLocalFile = async (local, { write = false } = {}) => {
  const source = await fs.readFile(local.absolute);
  const optimized = await buildOptimizedImageUpload({
    buffer: source,
    contentType: local.mime,
    objectPath: local.relative,
  });

  if (!optimized.optimized) {
    return { optimized: false, reason: optimized.warning || 'not_optimized' };
  }

  if (write) {
    const primaryAbs = path.resolve(storageRoot, optimized.primary.objectPath);
    await fs.mkdir(path.dirname(primaryAbs), { recursive: true });
    await fs.writeFile(primaryAbs, optimized.primary.buffer);

    for (const variant of optimized.variants || []) {
      const variantAbs = path.resolve(storageRoot, variant.objectPath);
      await fs.mkdir(path.dirname(variantAbs), { recursive: true });
      await fs.writeFile(variantAbs, variant.buffer);
    }
  }

  return {
    optimized: true,
    url: publicUrlForRelative(optimized.primary.objectPath),
    variants: optimized.variants?.map((variant) => publicUrlForRelative(variant.objectPath)) || [],
  };
};

const fetchRows = async ({ table, column, from, to }) => {
  const { data, error } = await db
    .from(table)
    .select(`id, ${column}`)
    .range(from, to);

  if (error) throw new Error(`${table}.${column}: ${error.message || 'fetch failed'}`);
  return data || [];
};

const runTarget = async (target, state) => {
  for (let from = 0; state.scanned < LIMIT; from += BATCH_SIZE) {
    const rows = await fetchRows({
      ...target,
      from,
      to: from + BATCH_SIZE - 1,
    });
    if (!rows.length) break;

    for (const row of rows) {
      if (state.scanned >= LIMIT) return;
      state.scanned += 1;

      const currentUrl = row?.[target.column];
      const local = toLocalUpload(currentUrl);
      if (!local) {
        state.skipped += 1;
        continue;
      }

      try {
        const result = await optimizeLocalFile(local, { write: WRITE });
        if (!result.optimized) {
          state.skipped += 1;
          continue;
        }

        state.converted += 1;
        console.log(
          `[ImageOptimize] ${target.table}.${target.column} ${row.id}: ${currentUrl} -> ${result.url}`
        );

        if (WRITE) {
          const { error } = await db
            .from(target.table)
            .update({ [target.column]: result.url })
            .eq('id', row.id);
          if (error) throw new Error(error.message || 'DB update failed');
          state.updated += 1;
        }
      } catch (error) {
        state.failed += 1;
        console.warn(`[ImageOptimize] failed ${target.table}.${target.column} ${row.id}: ${error.message}`);
      }
    }

    if (rows.length < BATCH_SIZE) break;
  }
};

const main = async () => {
  const state = { scanned: 0, converted: 0, updated: 0, skipped: 0, failed: 0 };
  console.log(
    `[ImageOptimize] mode=${WRITE ? 'write' : 'dry-run'} limit=${LIMIT} storage=${storageRoot}`
  );

  for (const target of TARGETS) {
    if (state.scanned >= LIMIT) break;
    await runTarget(target, state);
  }

  console.log(`[ImageOptimize] done ${JSON.stringify(state)}`);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[ImageOptimize] fatal: ${error.message}`);
    process.exit(1);
  });
