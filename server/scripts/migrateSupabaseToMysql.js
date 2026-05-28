import mysql from 'mysql2/promise';
import { db } from '../lib/dbClient.js';
import { mysqlConfig } from '../lib/mysqlPool.js';
import { setupMysqlSchema } from './setupMysqlSchema.js';

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const PAGE_SIZE = Math.max(100, Math.min(Number(process.env.MIGRATION_PAGE_SIZE || 1000), 5000));
const MAX_INSERT_PLACEHOLDERS = 60000;
const TRUNCATE_TARGET = /^(1|true|yes)$/i.test(String(process.env.MIGRATION_TRUNCATE || ''));
const SYNC_SCHEMA = !/^(0|false|no)$/i.test(String(process.env.MIGRATION_SYNC_SCHEMA || 'true'));

const SKIP_TABLES = new Set(
  String(process.env.MIGRATION_SKIP_TABLES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quoteMysqlIdent = (value) => `\`${String(value || '').replace(/`/g, '``')}\``;

async function fetchSupabaseJson(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getSupabaseTableDefinitions() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Accept: 'application/openapi+json',
    },
  });
  if (!res.ok) throw new Error(`Failed to load Supabase metadata: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const definitions = json.definitions || json.components?.schemas || {};
  return Object.keys(definitions)
    .filter((name) => definitions[name]?.properties)
    .sort()
    .map((name) => ({
      name,
      properties: definitions[name]?.properties || {},
      required: new Set(definitions[name]?.required || []),
    }));
}

const mysqlTypeForOpenApiProperty = (columnName, property = {}) => {
  const type = Array.isArray(property.type) ? property.type.find((item) => item !== 'null') : property.type;
  const format = String(property.format || '').toLowerCase();
  const maxLength = Number(property.maxLength || property.max_length || 0);

  if (format === 'uuid') return 'CHAR(36)';
  if (type === 'boolean') return 'TINYINT(1)';
  if (type === 'integer') return format === 'int64' ? 'BIGINT' : 'INT';
  if (type === 'number') return 'DOUBLE';
  if (type === 'array' || type === 'object') return 'JSON';
  if (format === 'date-time' || format === 'timestamp') return 'DATETIME(6)';
  if (format === 'date') return 'DATE';
  if (format === 'time') return 'TIME';
  if (format === 'binary' || format === 'byte') return 'LONGBLOB';

  if (String(columnName || '') === 'id' || String(columnName || '').endsWith('_id')) {
    if (!maxLength || maxLength <= 191) return `VARCHAR(${maxLength || 191})`;
  }

  if (type === 'string') {
    if (maxLength && maxLength <= 1000) return `VARCHAR(${Math.max(1, maxLength)})`;
    return 'LONGTEXT';
  }

  return 'LONGTEXT';
};

const toMysqlValue = (value) => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

async function getMysqlColumns(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map((row) => row.COLUMN_NAME);
}

async function getMysqlTableSet(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME`
  );
  return new Set(rows.map((row) => row.TABLE_NAME));
}

async function ensureTargetSchema(connection, tableDefinitions) {
  if (!SYNC_SCHEMA) return;

  console.log('Syncing MySQL schema with Supabase REST metadata...');
  const existingTables = await getMysqlTableSet(connection);

  for (const table of tableDefinitions) {
    if (SKIP_TABLES.has(table.name)) continue;

    const columns = Object.entries(table.properties || {});
    if (!columns.length) {
      console.warn(`- ${table.name}: no columns found in Supabase metadata`);
      continue;
    }

    const primaryKey = table.properties.id ? 'id' : null;
    const targetTable = quoteMysqlIdent(table.name);

    if (!existingTables.has(table.name)) {
      const definitions = columns.map(([columnName, property]) =>
        [
          quoteMysqlIdent(columnName),
          mysqlTypeForOpenApiProperty(columnName, property),
          columnName === primaryKey ? 'NOT NULL' : 'NULL',
        ]
          .filter(Boolean)
          .join(' ')
      );
      if (primaryKey) definitions.push(`PRIMARY KEY (${quoteMysqlIdent(primaryKey)})`);

      await connection.query(
        `CREATE TABLE ${targetTable} (
          ${definitions.join(',\n          ')}
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
      );
      existingTables.add(table.name);
      console.log(`- ${table.name}: created MySQL table from Supabase metadata`);
      continue;
    }

    const existingColumns = new Set(await getMysqlColumns(connection, table.name));
    for (const [columnName, property] of columns) {
      if (existingColumns.has(columnName)) continue;
      const definition = [
        quoteMysqlIdent(columnName),
        mysqlTypeForOpenApiProperty(columnName, property),
        'NULL',
      ].join(' ');
      // eslint-disable-next-line no-await-in-loop
      await connection.query(`ALTER TABLE ${targetTable} ADD COLUMN ${definition}`);
      console.log(`- ${table.name}.${columnName}: added missing MySQL column`);
    }
  }
}

async function truncateTargetTables(connection, tables) {
  if (!TRUNCATE_TARGET) return;

  console.log('Target truncate enabled; clearing matched MySQL tables before import.');
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [...tables].reverse()) {
    if (SKIP_TABLES.has(table.name)) continue;
    // eslint-disable-next-line no-await-in-loop
    await connection.query(`TRUNCATE TABLE ${quoteMysqlIdent(table.name)}`);
  }
}

async function insertRows(connection, table, rows) {
  if (!rows.length) return 0;
  const columns = await getMysqlColumns(connection, table);
  const validColumnSet = new Set(columns);
  const incomingColumns = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row || {}).filter((key) => validColumnSet.has(key))))
  );

  if (!incomingColumns.length) return 0;

  const maxRowsPerInsert = Math.max(1, Math.floor(MAX_INSERT_PLACEHOLDERS / incomingColumns.length));
  if (rows.length > maxRowsPerInsert) {
    let inserted = 0;
    for (let index = 0; index < rows.length; index += maxRowsPerInsert) {
      // eslint-disable-next-line no-await-in-loop
      inserted += await insertRows(connection, table, rows.slice(index, index + maxRowsPerInsert));
    }
    return inserted;
  }

  const escapedTable = `\`${table.replace(/`/g, '``')}\``;
  const escapedColumns = incomingColumns.map((column) => `\`${column.replace(/`/g, '``')}\``);
  const placeholders = rows
    .map(() => `(${incomingColumns.map(() => '?').join(', ')})`)
    .join(', ');
  const values = rows.flatMap((row) => incomingColumns.map((column) => toMysqlValue(row[column])));
  const updateColumns = incomingColumns.filter((column) => column !== 'id');
  const updateSql = (updateColumns.length ? updateColumns : incomingColumns)
    .map((column) => `\`${column.replace(/`/g, '``')}\` = VALUES(\`${column.replace(/`/g, '``')}\`)`)
    .join(', ');

  await connection.execute(
    `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')})
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE ${updateSql}`,
    values
  );
  return rows.length;
}

async function copyTable(connection, table) {
  if (SKIP_TABLES.has(table)) {
    console.log(`- ${table}: skipped`);
    return;
  }

  let copied = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let rows;
    try {
      rows = await fetchSupabaseJson(
        `/rest/v1/${encodeURIComponent(table)}?select=*&limit=${PAGE_SIZE}&offset=${offset}`
      );
    } catch (error) {
      console.warn(`- ${table}: skipped (${error.message})`);
      return;
    }

    if (!Array.isArray(rows) || rows.length === 0) break;
    await insertRows(connection, table, rows);
    copied += rows.length;
    process.stdout.write(`\r- ${table}: ${copied}`);
    if (rows.length < PAGE_SIZE) break;
    await sleep(50);
  }
  process.stdout.write(`\r- ${table}: ${copied}\n`);
}

async function run() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the one-time import');
  }

  await setupMysqlSchema();
  await db.clearSchemaCache?.();
  const tableDefinitions = await getSupabaseTableDefinitions();
  const connection = await mysql.createConnection(mysqlConfig);

  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await ensureTargetSchema(connection, tableDefinitions);
    const mysqlTables = await getMysqlTableSet(connection);
    const matchedTables = tableDefinitions.filter((table) => mysqlTables.has(table.name));
    const missingTables = tableDefinitions.filter((table) => !mysqlTables.has(table.name));

    if (missingTables.length) {
      console.warn(
        `Skipping ${missingTables.length} source tables not present in MySQL: ${missingTables
          .map((table) => table.name)
          .slice(0, 20)
          .join(', ')}${missingTables.length > 20 ? ', ...' : ''}`
      );
    }

    await truncateTargetTables(connection, matchedTables);

    for (const table of matchedTables) {
      // eslint-disable-next-line no-await-in-loop
      await copyTable(connection, table.name);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }

  console.log('Supabase to MySQL migration complete.');
}

run().catch((error) => {
  console.error('migrateSupabaseToMysql failed:', error?.message || error);
  process.exit(1);
});
