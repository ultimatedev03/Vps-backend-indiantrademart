import fs from 'fs/promises';
import mysql from 'mysql2/promise';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mysqlConfig } from '../lib/mysqlPool.js';
import { syncDelhiCities } from './syncDelhiCities.js';
import { syncIndiaLocations } from './syncIndiaLocations.js';

const here = fileURLToPath(import.meta.url);
const scriptsDir = dirname(here);
const backendDir = resolve(scriptsDir, '..', '..');
const schemaPath = resolve(backendDir, 'database', 'mysql', 'schema.sql');

const quoteIdent = (value) => `\`${String(value || '').replace(/`/g, '``')}\``;

const mysqlCompatColumns = [
  { table: 'geo_divisions', column: 'division_key', definition: 'VARCHAR(191) NULL' },
  { table: 'geo_division_pincodes', column: 'pincode', definition: 'VARCHAR(32) NULL' },
  { table: 'vendor_referral_wallet_ledger', column: 'reference_key', definition: 'VARCHAR(191) NULL' },
  { table: 'behavioral_hourly_aggregates', column: 'demand_key', definition: 'VARCHAR(191) NOT NULL' },
  { table: 'behavioral_demand_scores', column: 'demand_key', definition: 'VARCHAR(191) NOT NULL' },
  { table: 'behavioral_forecasts', column: 'demand_key', definition: 'VARCHAR(191) NOT NULL' },
];

const mysqlMissingColumns = [
  { table: 'cities', column: 'district_id', definition: 'CHAR(36) NULL' },
  { table: 'employees', column: 'sales_code', definition: 'VARCHAR(191) NULL' },
  { table: 'leads', column: 'assigned_to', definition: 'CHAR(36) NULL' },
  { table: 'leads', column: 'assigned_sales_user_id', definition: 'CHAR(36) NULL' },
  { table: 'leads', column: 'sales_note', definition: 'TEXT NULL' },
  { table: 'leads', column: 'last_follow_up_at', definition: 'DATETIME NULL' },
  { table: 'leads', column: 'next_follow_up_at', definition: 'DATETIME NULL' },
  { table: 'leads', column: 'visitor_id', definition: 'VARCHAR(191) NULL' },
  { table: 'leads', column: 'visitor_session_id', definition: 'VARCHAR(191) NULL' },
  { table: 'leads', column: 'lead_origin', definition: 'VARCHAR(191) NULL' },
  { table: 'leads', column: 'landing_page', definition: 'TEXT NULL' },
  { table: 'leads', column: 'page_url', definition: 'TEXT NULL' },
  { table: 'leads', column: 'referrer', definition: 'TEXT NULL' },
  { table: 'leads', column: 'user_agent', definition: 'TEXT NULL' },
  { table: 'leads', column: 'consent_source', definition: 'VARCHAR(191) NULL' },
  { table: 'head_categories', column: 'meta_tags', definition: 'TEXT NULL' },
  { table: 'head_categories', column: 'keywords', definition: 'TEXT NULL' },
  { table: 'sub_categories', column: 'meta_tags', definition: 'TEXT NULL' },
  { table: 'sub_categories', column: 'keywords', definition: 'TEXT NULL' },
  { table: 'sales_vendor_engagements', column: 'lead_id', definition: 'CHAR(36) NULL' },
  { table: 'sales_vendor_engagements', column: 'plan_id', definition: 'CHAR(36) NULL' },
  { table: 'sales_vendor_engagements', column: 'sales_code', definition: 'VARCHAR(191) NULL' },
  { table: 'sales_vendor_engagements', column: 'plan_share_url', definition: 'TEXT NULL' },
  { table: 'sales_vendor_engagements', column: 'channel', definition: 'VARCHAR(191) NULL' },
  { table: 'vendor_payments', column: 'sales_code', definition: 'VARCHAR(191) NULL' },
  { table: 'vendor_payments', column: 'sales_user_id', definition: 'CHAR(36) NULL' },
  { table: 'vendor_payments', column: 'sales_engagement_id', definition: 'CHAR(36) NULL' },
  { table: 'vendor_payments', column: 'billing_cycle', definition: "VARCHAR(32) NOT NULL DEFAULT 'YEARLY'" },
  { table: 'vendor_payments', column: 'plan_duration_days', definition: 'INT NULL' },
  { table: 'vendor_plan_subscriptions', column: 'sales_code', definition: 'VARCHAR(191) NULL' },
  { table: 'vendor_plan_subscriptions', column: 'sales_user_id', definition: 'CHAR(36) NULL' },
  { table: 'vendor_plan_subscriptions', column: 'billing_cycle', definition: "VARCHAR(32) NOT NULL DEFAULT 'YEARLY'" },
  { table: 'vendor_preferences', column: 'preferred_districts', definition: 'JSON NULL' },
  { table: 'vendors', column: 'district_id', definition: 'CHAR(36) NULL' },
  { table: 'vendors', column: 'all_india_visibility', definition: 'TINYINT(1) NOT NULL DEFAULT 0' },
  { table: 'vendors', column: 'profile_template_override', definition: "VARCHAR(32) NOT NULL DEFAULT 'AUTO'" },
  { table: 'vendors', column: 'portfolio_settings', definition: 'JSON NULL' },
  { table: 'website_visitor_events', column: 'visitor_name', definition: 'TEXT NULL' },
  { table: 'website_visitor_events', column: 'visitor_email', definition: 'VARCHAR(191) NULL' },
  { table: 'website_visitor_events', column: 'visitor_phone', definition: 'VARCHAR(64) NULL' },
  { table: 'website_visitor_events', column: 'visitor_company', definition: 'TEXT NULL' },
  { table: 'website_visitor_events', column: 'visitor_contact_source', definition: 'VARCHAR(191) NULL' },
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

const missingIndexes = [
  { table: 'cities', name: 'idx_cities_district_id', columns: ['district_id'] },
  { table: 'cities', name: 'idx_cities_state_district_slug', columns: ['state_id', 'district_id', 'slug'] },
  { table: 'districts', name: 'idx_districts_state_id', columns: ['state_id'] },
  { table: 'districts', name: 'idx_districts_state_slug', columns: ['state_id', 'slug'] },
  { table: 'districts', name: 'idx_districts_slug', columns: ['slug'] },
  { table: 'districts', name: 'idx_districts_created_at', columns: ['created_at'] },
  { table: 'employees', name: 'uq_employees_sales_code', columns: ['sales_code'], unique: true },
  { table: 'leads', name: 'idx_leads_assigned_to', columns: ['assigned_to'] },
  { table: 'leads', name: 'idx_leads_assigned_sales_user_id', columns: ['assigned_sales_user_id'] },
  { table: 'leads', name: 'idx_leads_next_follow_up_at', columns: ['next_follow_up_at'] },
  { table: 'leads', name: 'idx_leads_visitor_id', columns: ['visitor_id'] },
  { table: 'leads', name: 'idx_leads_lead_origin', columns: ['lead_origin'] },
  { table: 'leads', name: 'idx_leads_created_id', columns: ['created_at', 'id'] },
  { table: 'leads', name: 'idx_leads_status_created', columns: ['status', 'created_at'] },
  { table: 'leads', name: 'idx_leads_buyer_user_created', columns: ['buyer_user_id', 'created_at'] },
  { table: 'leads', name: 'idx_leads_vendor_created', columns: ['vendor_id', 'created_at'] },
  { table: 'leads', name: 'ft_leads_search', columns: ['title', 'product_name', 'category', 'description', 'message', 'product_interest'], fulltext: true },
  { table: 'products', name: 'idx_products_status_created_id', columns: ['status', 'created_at', 'id'] },
  { table: 'products', name: 'idx_products_status_micro_created', columns: ['status', 'micro_category_id', 'created_at'] },
  { table: 'products', name: 'idx_products_status_vendor_created', columns: ['status', 'vendor_id', 'created_at'] },
  { table: 'products', name: 'idx_products_status_head_sub', columns: ['status', 'head_category_id', 'sub_category_id'] },
  { table: 'products', name: 'ft_products_search', columns: ['name', 'description', 'category', 'category_path', 'category_slug'], fulltext: true },
  { table: 'sales_vendor_engagements', name: 'idx_sales_vendor_engagements_lead_id', columns: ['lead_id'] },
  { table: 'sales_vendor_engagements', name: 'idx_sales_vendor_engagements_plan_id', columns: ['plan_id'] },
  { table: 'sales_vendor_engagements', name: 'idx_sales_vendor_engagements_sales_code', columns: ['sales_code'] },
  { table: 'sales_vendor_engagements', name: 'idx_sales_vendor_engagements_next_follow_up_at', columns: ['next_follow_up_at'] },
  { table: 'sales_vendor_engagements', name: 'idx_sales_vendor_engagements_sales_due', columns: ['sales_user_id', 'next_follow_up_at', 'status'] },
  { table: 'system_config', name: 'idx_system_config_key_updated', columns: ['config_key', 'updated_at'] },
  { table: 'vendor_payments', name: 'idx_vendor_payments_sales_code', columns: ['sales_code'] },
  { table: 'vendor_payments', name: 'idx_vendor_payments_sales_user_id', columns: ['sales_user_id'] },
  { table: 'vendor_payments', name: 'idx_vendor_payments_payment_date', columns: ['payment_date'] },
  { table: 'vendor_payments', name: 'idx_vendor_payments_sales_payment_date', columns: ['sales_user_id', 'payment_date'] },
  { table: 'vendor_plan_subscriptions', name: 'idx_vendor_plan_subscriptions_sales_code', columns: ['sales_code'] },
  { table: 'vendor_plan_subscriptions', name: 'idx_vendor_plan_subscriptions_sales_user_id', columns: ['sales_user_id'] },
  { table: 'vendor_plan_subscriptions', name: 'idx_vendor_plan_subscriptions_active_vendor', columns: ['vendor_id', 'status', 'end_date'] },
  { table: 'vendors', name: 'idx_vendors_active_created', columns: ['is_active', 'created_at'] },
  { table: 'vendors', name: 'idx_vendors_active_location', columns: ['is_active', 'state_id', 'city_id'] },
  { table: 'vendors', name: 'idx_vendors_active_district', columns: ['is_active', 'district_id'] },
  { table: 'vendors', name: 'idx_vendors_active_slug', columns: ['is_active', 'slug'] },
  { table: 'vendors', name: 'idx_vendors_active_all_india', columns: ['is_active', 'all_india_visibility'] },
  { table: 'vendors', name: 'ft_vendors_search', columns: ['company_name', 'owner_name', 'city', 'state', 'business_description', 'primary_business_type'], fulltext: true },
  { table: 'website_visitor_events', name: 'idx_website_visitor_events_search_created', columns: ['event_type', 'created_at'] },
  { table: 'website_visitor_events', name: 'idx_website_visitor_events_visitor_search', columns: ['visitor_id', 'created_at'] },
  { table: 'website_visitor_events', name: 'ft_website_visitor_events_search', columns: ['search_query', 'category', 'entity_name'], fulltext: true },
];

const obsoleteIndexes = [
  { table: 'vendors', name: 'uq_vendors_user_id' },
];

async function ensureCompatibilitySchema(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent('districts')} (
      ${quoteIdent('id')} CHAR(36) NOT NULL,
      ${quoteIdent('state_id')} CHAR(36) NULL,
      ${quoteIdent('name')} TEXT NULL,
      ${quoteIdent('slug')} VARCHAR(191) NULL,
      ${quoteIdent('is_active')} TINYINT(1) DEFAULT 0,
      ${quoteIdent('created_at')} DATETIME DEFAULT CURRENT_TIMESTAMP,
      ${quoteIdent('updated_at')} DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${quoteIdent('supplier_count')} INT NULL,
      PRIMARY KEY (${quoteIdent('id')}),
      KEY ${quoteIdent('idx_districts_state_id')} (${quoteIdent('state_id')}),
      KEY ${quoteIdent('idx_districts_slug')} (${quoteIdent('slug')}),
      KEY ${quoteIdent('idx_districts_created_at')} (${quoteIdent('created_at')})
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent('dashboard_metric_snapshots')} (
      ${quoteIdent('id')} CHAR(36) NOT NULL,
      ${quoteIdent('metric_scope')} VARCHAR(64) NOT NULL,
      ${quoteIdent('scope_id')} VARCHAR(191) NOT NULL,
      ${quoteIdent('metric_key')} VARCHAR(191) NOT NULL,
      ${quoteIdent('payload')} JSON NOT NULL,
      ${quoteIdent('computed_at')} DATETIME DEFAULT CURRENT_TIMESTAMP,
      ${quoteIdent('expires_at')} DATETIME NULL,
      PRIMARY KEY (${quoteIdent('id')}),
      UNIQUE KEY ${quoteIdent('uq_dashboard_metric_scope_key')} (${quoteIdent('metric_scope')}, ${quoteIdent('scope_id')}, ${quoteIdent('metric_key')}),
      KEY ${quoteIdent('idx_dashboard_metric_scope_expires')} (${quoteIdent('metric_scope')}, ${quoteIdent('scope_id')}, ${quoteIdent('expires_at')}),
      KEY ${quoteIdent('idx_dashboard_metric_computed_at')} (${quoteIdent('computed_at')})
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const item of mysqlMissingColumns) {
    const [existing] = await connection.query(
      `SELECT 1
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1`,
      [item.table, item.column]
    );
    if (existing.length) continue;

    await connection.query(
      `ALTER TABLE ${quoteIdent(item.table)} ADD COLUMN ${quoteIdent(item.column)} ${item.definition}`
    );
  }

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

  for (const item of missingIndexes) {
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

    const keyType = item.fulltext ? 'FULLTEXT KEY' : `${item.unique ? 'UNIQUE ' : ''}KEY`;
    await connection.query(
      `ALTER TABLE ${quoteIdent(item.table)}
        ADD ${keyType} ${quoteIdent(item.name)} (${item.columns.map(quoteIdent).join(', ')})`
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
  await syncDelhiCities(dbConnection);

  const [rawLocationRows] = await dbConnection.query('SELECT COUNT(*) AS count FROM geo_postal_raw');
  const rawLocationCount = Number(rawLocationRows?.[0]?.count || 0);
  if (rawLocationCount > 0) {
    await syncIndiaLocations(dbConnection);
  } else {
    console.log('India location sync skipped: geo_postal_raw is empty.');
  }

  await dbConnection.end();

  console.log(`MySQL schema ready: ${database}`);
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  setupMysqlSchema().catch((error) => {
    console.error('setupMysqlSchema failed:', error?.message || error);
    process.exit(1);
  });
}
