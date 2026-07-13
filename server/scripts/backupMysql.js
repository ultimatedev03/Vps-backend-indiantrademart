import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { hostname } from 'os';
import { basename, resolve } from 'path';
import { pipeline } from 'stream/promises';
import { Writable } from 'stream';
import { createGunzip, createGzip } from 'zlib';
import { spawn } from 'child_process';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mysqlConfig } from '../lib/mysqlPool.js';

const backupDir = resolve(process.env.DB_BACKUP_DIR || './backups/mysql');
const retentionDays = Math.min(365, Math.max(1, Number(process.env.DB_BACKUP_RETENTION_DAYS) || 30));
const lockPath = resolve(backupDir, '.backup.lock');

const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const safeName = (value) => String(value || 'database').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

async function acquireLock() {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700).catch(() => {});

  try {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return handle;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > 12 * 60 * 60 * 1000) {
      await rm(lockPath, { force: true });
      return acquireLock();
    }
    throw new Error(`A database backup is already running (${lockPath})`);
  }
}

async function waitForProcess(child, stderrChunks) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0) return resolvePromise();
      const detail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(-4000);
      return rejectPromise(new Error(`mysqldump failed (${code ?? signal ?? 'unknown'}): ${detail}`));
    });
  });
}

async function createBackup(outputPath) {
  const args = [
    '--single-transaction',
    '--quick',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    `--host=${mysqlConfig.host}`,
    `--port=${mysqlConfig.port}`,
    `--user=${mysqlConfig.user}`,
    '--databases',
    mysqlConfig.database,
  ];
  const dump = spawn(process.env.MYSQLDUMP_BIN || 'mysqldump', args, {
    env: { ...process.env, MYSQL_PWD: mysqlConfig.password || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderrChunks = [];
  dump.stderr.on('data', (chunk) => {
    if (stderrChunks.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderrChunks.push(chunk);
  });

  await Promise.all([
    pipeline(dump.stdout, createGzip({ level: 9 }), createWriteStream(outputPath, { mode: 0o600 })),
    waitForProcess(dump, stderrChunks),
  ]);
}

async function verifyGzip(filePath) {
  await pipeline(
    createReadStream(filePath),
    createGunzip(),
    new Writable({ write(_chunk, _encoding, callback) { callback(); } })
  );
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

const offsiteConfig = () => ({
  endpoint: String(process.env.DB_BACKUP_S3_ENDPOINT || '').trim(),
  region: String(process.env.DB_BACKUP_S3_REGION || 'auto').trim(),
  bucket: String(process.env.DB_BACKUP_S3_BUCKET || '').trim(),
  accessKeyId: String(process.env.DB_BACKUP_S3_ACCESS_KEY_ID || '').trim(),
  secretAccessKey: String(process.env.DB_BACKUP_S3_SECRET_ACCESS_KEY || '').trim(),
  prefix: String(process.env.DB_BACKUP_S3_PREFIX || 'mysql').replace(/^\/+|\/+$/g, ''),
});

async function uploadOffsite(filePath, metadataPath, checksumPath) {
  const config = offsiteConfig();
  const supplied = [config.endpoint, config.bucket, config.accessKeyId, config.secretAccessKey].filter(Boolean).length;
  if (supplied === 0) return { enabled: false, reason: 'not_configured' };
  if (supplied < 4) return { enabled: false, reason: 'incomplete_configuration' };

  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const upload = async (path, contentType) => {
    const key = `${config.prefix}/${basename(path)}`;
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: createReadStream(path),
      ContentType: contentType,
      ServerSideEncryption: process.env.DB_BACKUP_S3_SERVER_SIDE_ENCRYPTION || undefined,
    }));
    return key;
  };

  const keys = await Promise.all([
    upload(filePath, 'application/gzip'),
    upload(metadataPath, 'application/json'),
    upload(checksumPath, 'text/plain'),
  ]);
  return { enabled: true, bucket: config.bucket, keys };
}

async function pruneOldBackups(currentFile) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = await readdir(backupDir, { withFileTypes: true });
  let deleted = 0;

  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.sql.gz') || entry.name === basename(currentFile)) continue;
    const filePath = resolve(backupDir, entry.name);
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs >= cutoff) continue;
    await Promise.all([
      rm(filePath, { force: true }),
      rm(`${filePath}.sha256`, { force: true }),
      rm(`${filePath}.json`, { force: true }),
    ]);
    deleted += 1;
  }

  return deleted;
}

let lockHandle;
let partialPath;

try {
  lockHandle = await acquireLock();
  const fileName = `${safeName(mysqlConfig.database)}-${timestamp()}.sql.gz`;
  const finalPath = resolve(backupDir, fileName);
  partialPath = `${finalPath}.partial`;

  await createBackup(partialPath);
  await verifyGzip(partialPath);
  await rename(partialPath, finalPath);
  await chmod(finalPath, 0o600).catch(() => {});

  const checksum = await sha256(finalPath);
  const fileStat = await stat(finalPath);
  const metadata = {
    database: mysqlConfig.database,
    database_host: mysqlConfig.host,
    backup_host: hostname(),
    created_at: new Date().toISOString(),
    file: fileName,
    bytes: fileStat.size,
    sha256: checksum,
    compressed: true,
    method: 'mysqldump-single-transaction',
  };
  const metadataPath = `${finalPath}.json`;
  const checksumPath = `${finalPath}.sha256`;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await writeFile(checksumPath, `${checksum}  ${fileName}\n`, { mode: 0o600 });

  const offsite = await uploadOffsite(finalPath, metadataPath, checksumPath);
  const pruned = await pruneOldBackups(finalPath);
  console.log(JSON.stringify({ success: true, backup: metadata, offsite, retention_days: retentionDays, pruned }));
} catch (error) {
  if (partialPath) await rm(partialPath, { force: true }).catch(() => {});
  console.error(`Database backup failed: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  if (lockHandle) await lockHandle.close().catch(() => {});
  await rm(lockPath, { force: true }).catch(() => {});
}
