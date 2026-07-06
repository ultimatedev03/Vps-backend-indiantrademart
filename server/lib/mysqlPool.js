import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = fileURLToPath(import.meta.url);
const libDir = dirname(here);
const serverDir = resolve(libDir, '..');
const backendDir = resolve(serverDir, '..');
const repoRoot = resolve(backendDir, '..');

const envCandidates = [
  resolve(repoRoot, '.env.local'),
  resolve(repoRoot, '.env'),
  resolve(backendDir, '.env.local'),
  resolve(backendDir, '.env'),
  resolve(serverDir, '.env.local'),
  resolve(serverDir, '.env'),
];

for (const envPath of envCandidates) {
  dotenv.config({ path: envPath });
}

const parseMysqlUrl = (rawUrl = '') => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      database: decodeURIComponent(url.pathname.replace(/^\/+/, '') || ''),
    };
  } catch {
    return null;
  }
};

const urlConfig = parseMysqlUrl(process.env.MYSQL_URL || process.env.DATABASE_URL || '');

export const mysqlConfig = {
  host: process.env.MYSQL_HOST || urlConfig?.host || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || urlConfig?.port || 3306),
  user: process.env.MYSQL_USER || urlConfig?.user || 'root',
  password: process.env.MYSQL_PASSWORD ?? urlConfig?.password ?? '',
  database: process.env.MYSQL_DATABASE || urlConfig?.database || 'indiantrademart',
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: false,
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  multipleStatements: false,
};

let pool;

export function getMysqlPool() {
  if (!pool) {
    pool = mysql.createPool(mysqlConfig);
  }
  return pool;
}

export async function mysqlQuery(sql, params = []) {
  // Use text protocol for app-wide dynamic SQL so MySQL does not accumulate
  // server-side prepared statements until max_prepared_stmt_count is exhausted.
  const [rows] = await getMysqlPool().query(sql, params);
  return rows;
}

export async function withMysqlConnection(fn) {
  const connection = await getMysqlPool().getConnection();
  try {
    return await fn(connection);
  } finally {
    connection.release();
  }
}

export const quoteIdent = (identifier) => {
  const value = String(identifier || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `\`${value}\``;
};

export const quotePath = (path) =>
  String(path || '')
    .split('.')
    .map((part) => quoteIdent(part))
    .join('.');

export async function assertMysqlConnection() {
  await mysqlQuery('SELECT 1 AS ok');
  return true;
}
