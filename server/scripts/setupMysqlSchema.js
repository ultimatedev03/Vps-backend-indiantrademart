import fs from 'fs/promises';
import mysql from 'mysql2/promise';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mysqlConfig } from '../lib/mysqlPool.js';

const here = fileURLToPath(import.meta.url);
const scriptsDir = dirname(here);
const backendDir = resolve(scriptsDir, '..', '..');
const schemaPath = resolve(backendDir, 'database', 'mysql', 'schema.sql');

const quoteIdent = (value) => `\`${String(value || '').replace(/`/g, '``')}\``;

const mysqlCompatColumns = [
  { table: 'geo_divisions', column: 'division_key', definition: 'VARCHAR(191) NULL' },
  { table: 'geo_division_pincodes', column: 'pincode', definition: 'VARCHAR(32) NULL' },
  { table: 'vendor_referral_wallet_ledger', column: 'reference_key', definition: 'VARCHAR(191) NULL' },
];

const uniqueIndexes = [
  { table: 'admin_users', name: 'uq_admin_users_email', columns: ['email'] },
  { table: 'buyers', name: 'uq_buyers_user_id', columns: ['user_id'] },
  { table: 'chat_blocks', name: 'uq_chat_blocks_pair', columns: ['blocker_user_id', 'blocked_user_id'] },
  { table: 'employees', name: 'uq_employees_user_id', columns: ['user_id'] },
  { table: 'geo_division_pincodes', name: 'uq_geo_division_pincodes_division_pincode', columns: ['division_id', 'pincode'] },
  { table: 'geo_divisions', name: 'uq_geo_divisions_division_key', columns: ['division_key'] },
  { table: 'referral_plan_rules', name: 'uq_referral_plan_rules_plan_id', columns: ['plan_id'] },
  { table: 'superadmin_users', name: 'uq_superadmin_users_email', columns: ['email'] },
  { table: 'users', name: 'uq_users_email', columns: ['email'] },
  { table: 'vendor_lead_quota', name: 'uq_vendor_lead_quota_vendor_id', columns: ['vendor_id'] },
  { table: 'vendor_preferences', name: 'uq_vendor_preferences_vendor_id', columns: ['vendor_id'] },
  { table: 'vendor_referral_profiles', name: 'uq_vendor_referral_profiles_referral_code', columns: ['referral_code'] },
  { table: 'vendor_referral_wallet_ledger', name: 'uq_vendor_referral_wallet_ledger_reference_key', columns: ['reference_key'] },
  { table: 'vendors', name: 'uq_vendors_vendor_id', columns: ['vendor_id'] },
];

const obsoleteIndexes = [
  { table: 'vendors', name: 'uq_vendors_user_id' },
];

async function ensureCompatibilitySchema(connection) {
  for (const item of mysqlCompatColumns) {
    await connection.query(
      `ALTER TABLE ${quoteIdent(item.table)} MODIFY ${quoteIdent(item.column)} ${item.definition}`
    );
  }

  for (const item of obsoleteIndexes) {
    const [existing] = await connection.query(
      `SELECT 1
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND INDEX_NAME = ?
        LIMIT 1`,
      [item.table, item.name]
    );
    if (!existing.length) continue;

    await connection.query(`ALTER TABLE ${quoteIdent(item.table)} DROP INDEX ${quoteIdent(item.name)}`);
  }

  for (const item of uniqueIndexes) {
    const [existing] = await connection.query(
      `SELECT 1
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND INDEX_NAME = ?
        LIMIT 1`,
      [item.table, item.name]
    );
    if (existing.length) continue;

    await connection.query(
      `ALTER TABLE ${quoteIdent(item.table)}
        ADD UNIQUE KEY ${quoteIdent(item.name)} (${item.columns.map(quoteIdent).join(', ')})`
    );
  }
}

export async function setupMysqlSchema() {
  const database = process.env.MYSQL_DATABASE || mysqlConfig.database || 'indiantrademart';
  const serverConnection = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    multipleStatements: true,
  });

  await serverConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await serverConnection.end();

  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const dbConnection = await mysql.createConnection({
    ...mysqlConfig,
    database,
    multipleStatements: true,
  });

  await dbConnection.query(schemaSql);
  await ensureCompatibilitySchema(dbConnection);
  await dbConnection.end();

  console.log(`MySQL schema ready: ${database}`);
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  setupMysqlSchema().catch((error) => {
    console.error('setupMysqlSchema failed:', error?.message || error);
    process.exit(1);
  });
}
