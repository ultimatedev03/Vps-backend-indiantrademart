import mysql from 'mysql2/promise';
import pg from 'pg';
import { mysqlConfig } from '../lib/mysqlPool.js';
import { setupMysqlSchema } from './setupMysqlSchema.js';

const { Client } = pg;

const POSTGRES_URL =
  process.env.SUPABASE_DB_URL ||
  process.env.SUPABASE_POSTGRES_URL ||
  process.env.POSTGRES_URL ||
  process.env.PG_CONNECTION_STRING ||
  '';

const PAGE_SIZE = Math.max(100, Math.min(Number(process.env.MIGRATION_PAGE_SIZE || 1000), 5000));
const MAX_INSERT_PLACEHOLDERS = 60000;
const SOURCE_SCHEMA = process.env.MIGRATION_SOURCE_SCHEMA || 'public';
const TARGET_SCHEMA = process.env.MYSQL_DATABASE || mysqlConfig.database || 'indiantrademart';
const TRUNCATE_TARGET = /^(1|true|yes)$/i.test(String(process.env.MIGRATION_TRUNCATE || ''));
const SYNC_SCHEMA = !/^(0|false|no)$/i.test(String(process.env.MIGRATION_SYNC_SCHEMA || 'true'));

const listFromEnv = (name) =>
  new Set(
    String(process.env[name] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

const ONLY_TABLES = listFromEnv('MIGRATION_ONLY_TABLES');
const SKIP_TABLES = listFromEnv('MIGRATION_SKIP_TABLES');

const quoteMysqlIdent = (value) => `\`${String(value || '').replace(/`/g, '``')}\``;
const quotePgIdent = (value) => `"${String(value || '').replace(/"/g, '""')}"`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatDateTime = (value, dateOnly = false) => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const iso = value.toISOString();
  if (dateOnly) return iso.slice(0, 10);
  return iso.slice(0, 19).replace('T', ' ');
};

const isJsonType = (column) => column?.dataType === 'json';
const isDateType = (column) => ['date', 'datetime', 'timestamp'].includes(column?.dataType);

const toMysqlValue = (value, column) => {
  if (value === undefined || value === null) return null;

  if (isJsonType(column)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    return formatDateTime(value, column?.dataType === 'date');
  }

  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value) || (typeof value === 'object' && !Buffer.isBuffer(value))) {
    return JSON.stringify(value);
  }

  if (
    typeof value === 'string' &&
    ['tinyint', 'int', 'bigint', 'decimal', 'float', 'double'].includes(column?.dataType)
  ) {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed) ? 1 : 0;
  }

  return value;
};

async function getPostgresClient() {
  if (!POSTGRES_URL) {
    throw new Error(
      'Set SUPABASE_DB_URL, SUPABASE_POSTGRES_URL, POSTGRES_URL, or PG_CONNECTION_STRING before running this import'
    );
  }

  const client = new Client({
    connectionString: POSTGRES_URL,
    ssl: /supabase\.co|sslmode=require/i.test(POSTGRES_URL) ? { rejectUnauthorized: false } : undefined,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 120000),
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 120000),
  });
  await client.connect();
  return client;
}

async function getSourceTables(pgClient) {
  const { rows } = await pgClient.query(
    `SELECT table_name, table_type
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY CASE WHEN table_type = 'BASE TABLE' THEN 0 ELSE 1 END, table_name`,
    [SOURCE_SCHEMA]
  );

  return rows
    .map((row) => ({ name: row.table_name, type: row.table_type }))
    .filter((table) => (ONLY_TABLES.size ? ONLY_TABLES.has(table.name) : true))
    .filter((table) => !SKIP_TABLES.has(table.name));
}

async function getSourceColumns(pgClient, table) {
  const { rows } = await pgClient.query(
    `SELECT column_name,
            data_type,
            udt_name,
            is_nullable,
            column_default,
            character_maximum_length,
            numeric_precision,
            numeric_scale,
            datetime_precision
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [SOURCE_SCHEMA, table]
  );
  return rows;
}

async function getSourcePrimaryKeys(pgClient, table) {
  const { rows } = await pgClient.query(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1
        AND c.relname = $2
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [SOURCE_SCHEMA, table]
  );
  return rows.map((row) => row.attname);
}

const boundedPrecision = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

const datetimeSuffix = (column) => {
  const precision = boundedPrecision(column.datetime_precision, 0, 0, 6);
  return precision ? `(${precision})` : '';
};

const mysqlTypeForPgColumn = (column, primaryKeySet = new Set()) => {
  const dataType = String(column.data_type || '').toLowerCase();
  const udtName = String(column.udt_name || '').toLowerCase();
  const isPrimaryKey = primaryKeySet.has(column.column_name);
  const charLength = Number(column.character_maximum_length || 0);
  const keyVarchar = () =>
    charLength && charLength <= 191 ? `VARCHAR(${Math.max(1, charLength)})` : 'VARCHAR(191)';

  if (dataType === 'uuid' || udtName === 'uuid') return 'CHAR(36)';
  if (dataType === 'boolean' || udtName === 'bool') return 'TINYINT(1)';
  if (dataType === 'smallint' || udtName === 'int2') return 'SMALLINT';
  if (dataType === 'integer' || udtName === 'int4') return 'INT';
  if (dataType === 'bigint' || udtName === 'int8') return 'BIGINT';
  if (dataType === 'real' || udtName === 'float4') return 'FLOAT';
  if (dataType === 'double precision' || udtName === 'float8') return 'DOUBLE';

  if (dataType === 'numeric' || dataType === 'decimal') {
    const precision = boundedPrecision(column.numeric_precision, 30, 1, 65);
    const scale = boundedPrecision(column.numeric_scale, 10, 0, Math.min(30, precision));
    return `DECIMAL(${precision},${scale})`;
  }

  if (dataType === 'date') return 'DATE';
  if (dataType === 'timestamp without time zone' || dataType === 'timestamp with time zone') {
    return `DATETIME${datetimeSuffix(column)}`;
  }
  if (dataType === 'time without time zone') return `TIME${datetimeSuffix(column)}`;
  if (dataType === 'time with time zone') return 'VARCHAR(32)';

  if (dataType === 'character' || dataType === 'char') {
    const length = charLength ? Math.min(Math.max(1, charLength), 255) : 1;
    return `CHAR(${length})`;
  }
  if (dataType === 'character varying' || dataType === 'varchar') {
    if (isPrimaryKey) return keyVarchar();
    if (charLength && charLength <= 1000) return `VARCHAR(${Math.max(1, charLength)})`;
    return 'TEXT';
  }
  if (dataType === 'text') return isPrimaryKey ? keyVarchar() : 'LONGTEXT';

  if (dataType === 'json' || dataType === 'jsonb') return 'JSON';
  if (dataType === 'ARRAY'.toLowerCase() || udtName.startsWith('_')) return 'JSON';
  if (dataType === 'bytea') return 'LONGBLOB';
  if (dataType === 'USER-DEFINED'.toLowerCase()) return isPrimaryKey ? keyVarchar() : 'VARCHAR(191)';
  if (['inet', 'cidr', 'macaddr', 'macaddr8', 'interval'].includes(dataType || udtName)) return 'VARCHAR(191)';

  return isPrimaryKey ? keyVarchar() : 'LONGTEXT';
};

const isSerialDefault = (column) =>
  /nextval\(/i.test(String(column.column_default || '')) &&
  ['smallint', 'integer', 'bigint'].includes(String(column.data_type || '').toLowerCase());

const mysqlColumnDefinition = (column, primaryKeySet, singlePrimaryKey = false) => {
  const isPrimaryKey = primaryKeySet.has(column.column_name);
  const autoIncrement = isPrimaryKey && singlePrimaryKey && isSerialDefault(column);
  return [
    quoteMysqlIdent(column.column_name),
    mysqlTypeForPgColumn(column, primaryKeySet),
    isPrimaryKey ? 'NOT NULL' : 'NULL',
    autoIncrement ? 'AUTO_INCREMENT' : '',
  ]
    .filter(Boolean)
    .join(' ');
};

async function getMysqlTableSet(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME`
  );
  return new Set(rows.map((row) => row.TABLE_NAME));
}

async function getMysqlColumnSet(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function ensureMysqlTableForSource(pgClient, mysqlConnection, table, existingTables) {
  const columns = await getSourceColumns(pgClient, table.name);
  if (!columns.length) {
    console.warn(`- ${table.name}: no columns found in source metadata`);
    return;
  }

  const primaryKeys = await getSourcePrimaryKeys(pgClient, table.name);
  const primaryKeySet = new Set(primaryKeys);
  const singlePrimaryKey = primaryKeys.length === 1;
  const targetTable = quoteMysqlIdent(table.name);

  if (!existingTables.has(table.name)) {
    const definitions = columns.map((column) => mysqlColumnDefinition(column, primaryKeySet, singlePrimaryKey));
    if (primaryKeys.length) {
      definitions.push(`PRIMARY KEY (${primaryKeys.map(quoteMysqlIdent).join(', ')})`);
    }

    await mysqlConnection.query(
      `CREATE TABLE ${targetTable} (
        ${definitions.join(',\n        ')}
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    existingTables.add(table.name);
    console.log(`- ${table.name}: created MySQL table from Postgres metadata`);
    return;
  }

  const existingColumns = await getMysqlColumnSet(mysqlConnection, table.name);
  const missingColumns = columns.filter((column) => !existingColumns.has(column.column_name));
  for (const column of missingColumns) {
    const definition = mysqlColumnDefinition(column, new Set(), false);
    // eslint-disable-next-line no-await-in-loop
    await mysqlConnection.query(`ALTER TABLE ${targetTable} ADD COLUMN ${definition}`);
    console.log(`- ${table.name}.${column.column_name}: added missing MySQL column`);
  }
}

async function ensureTargetSchema(pgClient, mysqlConnection, sourceTables) {
  if (!SYNC_SCHEMA) return;

  console.log('Syncing MySQL schema with Postgres metadata...');
  const existingTables = await getMysqlTableSet(mysqlConnection);
  for (const table of sourceTables) {
    // eslint-disable-next-line no-await-in-loop
    await ensureMysqlTableForSource(pgClient, mysqlConnection, table, existingTables);
  }
}

async function getSourceOrderColumns(pgClient, table) {
  const { rows } = await pgClient.query(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1
        AND c.relname = $2
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [SOURCE_SCHEMA, table]
  );

  if (rows.length) return rows.map((row) => row.attname);

  const fallback = await pgClient.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      LIMIT 1`,
    [SOURCE_SCHEMA, table]
  );
  return fallback.rows.map((row) => row.column_name);
}

async function getMysqlTables(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME`,
    [TARGET_SCHEMA]
  );
  return new Set(rows.map((row) => row.TABLE_NAME));
}

async function getMysqlColumns(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );

  return rows.map((row) => ({
    name: row.COLUMN_NAME,
    dataType: String(row.DATA_TYPE || '').toLowerCase(),
    columnType: String(row.COLUMN_TYPE || '').toLowerCase(),
  }));
}

async function insertRows(connection, table, rows, columnMap) {
  if (!rows.length) return 0;

  const validColumnSet = new Set(columnMap.keys());
  const incomingColumns = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row || {}).filter((key) => validColumnSet.has(key))))
  );

  if (!incomingColumns.length) return 0;

  const maxRowsPerInsert = Math.max(1, Math.floor(MAX_INSERT_PLACEHOLDERS / incomingColumns.length));
  if (rows.length > maxRowsPerInsert) {
    let inserted = 0;
    for (let index = 0; index < rows.length; index += maxRowsPerInsert) {
      // eslint-disable-next-line no-await-in-loop
      inserted += await insertRows(
        connection,
        table,
        rows.slice(index, index + maxRowsPerInsert),
        columnMap
      );
    }
    return inserted;
  }

  const escapedTable = quoteMysqlIdent(table);
  const escapedColumns = incomingColumns.map(quoteMysqlIdent);
  const placeholders = rows.map(() => `(${incomingColumns.map(() => '?').join(', ')})`).join(', ');
  const values = rows.flatMap((row) =>
    incomingColumns.map((column) => toMysqlValue(row[column], columnMap.get(column)))
  );
  const updateColumns = incomingColumns.filter((column) => column !== 'id');
  const updateSql = (updateColumns.length ? updateColumns : incomingColumns)
    .map((column) => `${quoteMysqlIdent(column)} = VALUES(${quoteMysqlIdent(column)})`)
    .join(', ');

  await connection.execute(
    `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')})
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE ${updateSql}`,
    values
  );

  return rows.length;
}

async function truncateTargetTables(connection, tables) {
  if (!TRUNCATE_TARGET) return;

  console.log('Target truncate enabled; clearing matched MySQL tables before import.');
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [...tables].reverse()) {
    // eslint-disable-next-line no-await-in-loop
    await connection.query(`TRUNCATE TABLE ${quoteMysqlIdent(table.name)}`);
  }
}

async function copyTable(pgClient, mysqlConnection, table) {
  const columns = await getMysqlColumns(mysqlConnection, table.name);
  const columnMap = new Map(columns.map((column) => [column.name, column]));
  if (!columns.length) {
    console.warn(`- ${table.name}: skipped (no matching MySQL columns)`);
    return { copied: 0, skipped: true };
  }

  const orderColumns = await getSourceOrderColumns(pgClient, table.name);
  const orderBy = orderColumns.length
    ? ` ORDER BY ${orderColumns.map((column) => quotePgIdent(column)).join(', ')}`
    : '';
  const sql = `SELECT * FROM ${quotePgIdent(SOURCE_SCHEMA)}.${quotePgIdent(table.name)}${orderBy} LIMIT $1 OFFSET $2`;

  let copied = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { rows } = await pgClient.query(sql, [PAGE_SIZE, offset]);
    if (!rows.length) break;

    await insertRows(mysqlConnection, table.name, rows, columnMap);
    copied += rows.length;
    process.stdout.write(`\r- ${table.name}: ${copied}`);

    if (rows.length < PAGE_SIZE) break;
    await sleep(25);
  }

  process.stdout.write(`\r- ${table.name}: ${copied}\n`);
  return { copied, skipped: false };
}

async function run() {
  await setupMysqlSchema();

  const pgClient = await getPostgresClient();
  const mysqlConnection = await mysql.createConnection(mysqlConfig);

  try {
    await mysqlConnection.query('SET FOREIGN_KEY_CHECKS = 0');

    const sourceTables = await getSourceTables(pgClient);
    await ensureTargetSchema(pgClient, mysqlConnection, sourceTables);

    const mysqlTables = await getMysqlTables(mysqlConnection);
    const matchedTables = sourceTables.filter((table) => mysqlTables.has(table.name));
    const missingTables = sourceTables.filter((table) => !mysqlTables.has(table.name));

    if (!matchedTables.length) {
      throw new Error(`No matching MySQL tables found for Postgres schema "${SOURCE_SCHEMA}"`);
    }

    if (missingTables.length) {
      console.warn(
        `Skipping ${missingTables.length} source tables not present in MySQL: ${missingTables
          .map((table) => table.name)
          .slice(0, 20)
          .join(', ')}${missingTables.length > 20 ? ', ...' : ''}`
      );
    }

    await truncateTargetTables(mysqlConnection, matchedTables);

    let totalRows = 0;
    for (const table of matchedTables) {
      // eslint-disable-next-line no-await-in-loop
      const result = await copyTable(pgClient, mysqlConnection, table);
      totalRows += result.copied || 0;
    }

    await mysqlConnection.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`Postgres to MySQL migration complete. Tables: ${matchedTables.length}, rows: ${totalRows}.`);
  } finally {
    await pgClient.end().catch(() => {});
    await mysqlConnection.end().catch(() => {});
  }
}

run().catch((error) => {
  console.error('migratePostgresToMysql failed:', error?.message || error);
  process.exit(1);
});
