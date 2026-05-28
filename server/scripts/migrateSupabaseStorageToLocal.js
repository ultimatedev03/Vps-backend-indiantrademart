import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import mysql from 'mysql2/promise';
import path, { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mysqlConfig } from '../lib/mysqlPool.js';

const here = fileURLToPath(import.meta.url);
const scriptsDir = dirname(here);
const backendDir = resolve(scriptsDir, '..', '..');
const repoRoot = resolve(backendDir, '..');

for (const envPath of [
  resolve(repoRoot, '.env.local'),
  resolve(repoRoot, '.env'),
  resolve(backendDir, '.env.local'),
  resolve(backendDir, '.env'),
  resolve(scriptsDir, '.env.local'),
  resolve(scriptsDir, '.env'),
]) {
  dotenv.config({ path: envPath });
}

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STORAGE_PAGE_SIZE = Math.max(100, Math.min(Number(process.env.STORAGE_MIGRATION_PAGE_SIZE || 1000), 1000));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(Number(process.env.STORAGE_DOWNLOAD_CONCURRENCY || 4), 12));
const PROGRESS_EVERY = Math.max(1, Number(process.env.STORAGE_PROGRESS_EVERY || 250));
const SKIP_EXISTING = !/^(0|false|no)$/i.test(String(process.env.STORAGE_SKIP_EXISTING || 'true'));
const LIST_ONLY = /^(1|true|yes)$/i.test(String(process.env.STORAGE_LIST_ONLY || ''));
const REFERENCED_ONLY = /^(1|true|yes)$/i.test(String(process.env.STORAGE_REFERENCED_ONLY || ''));
const REWRITE_STORAGE_URLS = !/^(0|false|no)$/i.test(String(process.env.MIGRATION_REWRITE_STORAGE_URLS || 'true'));
const STORAGE_BUCKETS = new Set(
  String(process.env.STORAGE_BUCKETS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const storageRoot = resolve(
  process.env.MYSQL_STORAGE_DIR || process.env.LOCAL_STORAGE_DIR || resolve(backendDir, 'uploads')
);
const storageUrlPrefix = String(process.env.PUBLIC_STORAGE_URL || '/uploads').replace(/\/+$/, '');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quoteMysqlIdent = (value) => `\`${String(value || '').replace(/`/g, '``')}\``;

const sanitizeSegment = (segment) =>
  String(segment || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '') || randomUUID())
    .join('/');

const encodePath = (value) =>
  String(value || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

const decodeStoragePath = (value) => {
  try {
    return String(value || '')
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
  } catch {
    return String(value || '');
  }
};

const localUrlFor = (bucket, objectPath) =>
  `${storageUrlPrefix}/${sanitizeSegment(bucket)}/${sanitizeSegment(objectPath)}`.replace(/([^:]\/)\/+/g, '$1');

const localPathFor = (bucket, objectPath) => {
  const safeBucket = sanitizeSegment(bucket || 'default');
  const safeObject = sanitizeSegment(objectPath || '');
  const abs = resolve(storageRoot, safeBucket, safeObject);
  const expectedRoot = resolve(storageRoot, safeBucket);
  if (!abs.startsWith(expectedRoot)) throw new Error(`Invalid storage path: ${bucket}/${objectPath}`);
  return abs;
};

function storageUrlRegex() {
  return new RegExp(
    `${escapeRegExp(SUPABASE_URL)}/storage/v1/(?:object|render/image)/(?:public|sign|authenticated)/([^\\s"'<>),?]+)(?:\\?[^\\s"'<>),]*)?`,
    'g'
  );
}

function storageObjectFromPath(rawStoragePath) {
  const storagePath = decodeStoragePath(rawStoragePath).replace(/^\/+/, '');
  const slashIndex = storagePath.indexOf('/');
  if (slashIndex <= 0) return null;

  return {
    bucket: storagePath.slice(0, slashIndex),
    objectPath: storagePath.slice(slashIndex + 1),
  };
}

function extractStorageObjects(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw || !SUPABASE_URL) return [];

  const objects = [];
  const pattern = storageUrlRegex();
  for (const match of raw.matchAll(pattern)) {
    const item = storageObjectFromPath(match[1]);
    if (item) objects.push(item);
  }
  return objects;
}

async function supabaseRequest(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running storage migration');
  }

  const res = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }

  return res;
}

async function getBuckets() {
  const res = await supabaseRequest('/storage/v1/bucket');
  const buckets = await res.json();
  return (Array.isArray(buckets) ? buckets : [])
    .map((bucket) => bucket?.id || bucket?.name)
    .filter(Boolean)
    .filter((bucket) => (STORAGE_BUCKETS.size ? STORAGE_BUCKETS.has(bucket) : true))
    .sort();
}

async function listObjects(bucket, prefix = '') {
  const objects = [];

  for (let offset = 0; ; offset += STORAGE_PAGE_SIZE) {
    const res = await supabaseRequest(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST',
      body: JSON.stringify({
        limit: STORAGE_PAGE_SIZE,
        offset,
        prefix,
        sortBy: { column: 'name', order: 'asc' },
      }),
    });
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) break;

    for (const item of items) {
      const name = String(item?.name || '').trim();
      if (!name) continue;

      const objectPath = prefix ? `${prefix.replace(/\/+$/, '')}/${name}` : name;
      const isFolder = !item?.id && !item?.updated_at && !item?.created_at && !item?.metadata;
      if (isFolder) {
        // eslint-disable-next-line no-await-in-loop
        objects.push(...(await listObjects(bucket, objectPath)));
      } else {
        objects.push(objectPath);
      }
    }

    if (items.length < STORAGE_PAGE_SIZE) break;
  }

  return objects;
}

async function downloadObject(bucket, objectPath) {
  const abs = localPathFor(bucket, objectPath);
  if (SKIP_EXISTING) {
    const existing = await fs.stat(abs).catch(() => null);
    if (existing?.isFile() && existing.size > 0) {
      return {
        key: `${bucket}/${objectPath}`,
        localUrl: localUrlFor(bucket, objectPath),
        size: 0,
        skipped: true,
      };
    }
  }

  const res = await supabaseRequest(
    `/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`
  );
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return {
    key: `${bucket}/${objectPath}`,
    localUrl: localUrlFor(bucket, objectPath),
    size: buffer.length,
  };
}

function writeProgress(message, force = false) {
  if (!force && process.stdout.isTTY === false) return;
  try {
    if (process.stdout.writable) process.stdout.write(message);
  } catch {
    // Progress output is best-effort only; downloads should continue.
  }
}

async function runConcurrent(items, worker) {
  let cursor = 0;
  let completed = 0;
  const results = [];
  const failures = [];

  async function next() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        const result = await worker(items[index], index);
        results.push(result);
        completed += 1;
        if (completed % PROGRESS_EVERY === 0 || completed === items.length) {
          writeProgress(`  downloaded ${completed}/${items.length}\n`, true);
        }
      } catch (error) {
        failures.push({ item: items[index], error });
        completed += 1;
        if (completed % PROGRESS_EVERY === 0 || completed === items.length) {
          writeProgress(`  downloaded ${completed}/${items.length}\n`, true);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, next));
  return { results, failures };
}

function replaceStorageUrls(value, urlMap) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw || !SUPABASE_URL) return raw;

  return raw.replace(storageUrlRegex(), (match, rawStoragePath) => {
    const item = storageObjectFromPath(rawStoragePath);
    if (!item) return match;
    return urlMap.get(`${item.bucket}/${item.objectPath}`) || match;
  });
}

async function getPrimaryKeys(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME, COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );

  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.TABLE_NAME) || [];
    list.push(row.COLUMN_NAME);
    map.set(row.TABLE_NAME, list);
  }
  return map;
}

async function getRewritableColumns(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND DATA_TYPE IN ('char', 'varchar', 'text', 'mediumtext', 'longtext', 'json')
      ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  return rows.map((row) => ({
    table: row.TABLE_NAME,
    column: row.COLUMN_NAME,
    dataType: String(row.DATA_TYPE || '').toLowerCase(),
  }));
}

async function collectReferencedStorageObjects() {
  const connection = await mysql.createConnection(mysqlConfig);
  try {
    const columns = await getRewritableColumns(connection);
    const likeNeedle = `%${SUPABASE_URL}/storage/v1/%`;
    const found = new Map();

    for (const item of columns) {
      const tableName = quoteMysqlIdent(item.table);
      const columnName = quoteMysqlIdent(item.column);
      const [rows] = await connection.execute(
        `SELECT ${columnName} AS __value
           FROM ${tableName}
          WHERE CAST(${columnName} AS CHAR) LIKE ?`,
        [likeNeedle]
      );

      for (const row of rows) {
        for (const object of extractStorageObjects(row.__value)) {
          found.set(`${object.bucket}/${object.objectPath}`, object);
        }
      }
    }

    return [...found.values()].sort((a, b) => `${a.bucket}/${a.objectPath}`.localeCompare(`${b.bucket}/${b.objectPath}`));
  } finally {
    await connection.end();
  }
}

async function rewriteMysqlStorageUrls(urlMap) {
  if (!REWRITE_STORAGE_URLS || !urlMap.size) return { scanned: 0, updated: 0 };

  const connection = await mysql.createConnection(mysqlConfig);
  try {
    const primaryKeys = await getPrimaryKeys(connection);
    const columns = await getRewritableColumns(connection);
    let scanned = 0;
    let updated = 0;
    const likeNeedle = `%${SUPABASE_URL}/storage/v1/%`;

    for (const item of columns) {
      const pkColumns = primaryKeys.get(item.table);
      if (!pkColumns?.length) continue;

      const pkSelect = pkColumns.map((column) => quoteMysqlIdent(column)).join(', ');
      const tableName = quoteMysqlIdent(item.table);
      const columnName = quoteMysqlIdent(item.column);
      const [rows] = await connection.execute(
        `SELECT ${pkSelect}, ${columnName} AS __value
           FROM ${tableName}
          WHERE CAST(${columnName} AS CHAR) LIKE ?`,
        [likeNeedle]
      );

      for (const row of rows) {
        scanned += 1;
        const original = row.__value;
        const originalText = typeof original === 'string' ? original : JSON.stringify(original);
        const replaced = replaceStorageUrls(original, urlMap);
        if (!replaced || replaced === originalText) continue;

        const whereSql = pkColumns.map((column) => `${quoteMysqlIdent(column)} = ?`).join(' AND ');
        const whereValues = pkColumns.map((column) => row[column]);
        // eslint-disable-next-line no-await-in-loop
        await connection.execute(`UPDATE ${tableName} SET ${columnName} = ? WHERE ${whereSql}`, [
          replaced,
          ...whereValues,
        ]);
        updated += 1;
      }
    }

    return { scanned, updated };
  } finally {
    await connection.end();
  }
}

async function run() {
  await fs.mkdir(storageRoot, { recursive: true });

  const downloaded = new Map();
  const failures = [];
  let totalBytes = 0;

  if (REFERENCED_ONLY) {
    const referencedObjects = await collectReferencedStorageObjects();
    const byBucket = new Map();
    for (const object of referencedObjects) {
      const list = byBucket.get(object.bucket) || [];
      list.push(object.objectPath);
      byBucket.set(object.bucket, list);
    }
    console.log(`Referenced Supabase storage objects found in MySQL: ${referencedObjects.length}`);

    for (const [bucket, objects] of byBucket.entries()) {
      console.log(`- ${bucket}: ${objects.length} referenced object(s)`);
      if (LIST_ONLY) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await runConcurrent(objects, (objectPath) => downloadObject(bucket, objectPath));

      for (const item of result.results) {
        if (!item) continue;
        downloaded.set(item.key, item.localUrl);
        totalBytes += item.size || 0;
      }
      failures.push(...result.failures.map((failure) => ({ bucket, ...failure })));
    }
    if (LIST_ONLY) {
      console.log('Referenced storage list-only complete.');
      return;
    }
  } else {
    const buckets = await getBuckets();
    console.log(`Supabase buckets found: ${buckets.length ? buckets.join(', ') : '(none)'}`);

    for (const bucket of buckets) {
      // eslint-disable-next-line no-await-in-loop
      const objects = await listObjects(bucket);
      console.log(`- ${bucket}: ${objects.length} object(s)`);
      if (LIST_ONLY) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await runConcurrent(objects, (objectPath) => downloadObject(bucket, objectPath));

      for (const item of result.results) {
        if (!item) continue;
        downloaded.set(item.key, item.localUrl);
        totalBytes += item.size || 0;
      }
      failures.push(...result.failures.map((failure) => ({ bucket, ...failure })));
    }

    if (LIST_ONLY) {
      console.log('Storage list-only complete.');
      return;
    }
  }

  const rewriteResult = await rewriteMysqlStorageUrls(downloaded);

  console.log(
    `Storage migration complete. Downloaded: ${downloaded.size}, failed: ${failures.length}, bytes: ${totalBytes}.`
  );
  if (REWRITE_STORAGE_URLS) {
    console.log(`Storage URL rewrite complete. Scanned rows: ${rewriteResult.scanned}, updated rows: ${rewriteResult.updated}.`);
  }
  if (failures.length) {
    console.warn(
      `Failed objects: ${failures
        .slice(0, 20)
        .map((failure) => `${failure.bucket}/${failure.item}: ${failure.error?.message || failure.error}`)
        .join('; ')}${failures.length > 20 ? '; ...' : ''}`
    );
  }
}

run().catch((error) => {
  console.error('migrateSupabaseStorageToLocal failed:', error?.message || error);
  process.exit(1);
});
