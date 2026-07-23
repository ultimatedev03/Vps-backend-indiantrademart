import { getMysqlPool, mysqlQuery } from '../lib/mysqlPool.js';

export async function setupPageSeoOverrides() {
  await mysqlQuery(`
    CREATE TABLE IF NOT EXISTS page_seo_overrides (
      id CHAR(36) NOT NULL,
      path VARCHAR(512) NOT NULL,
      page_name VARCHAR(255) NOT NULL,
      meta_title VARCHAR(255) NOT NULL,
      meta_description TEXT NOT NULL,
      h1 VARCHAR(512) NOT NULL,
      canonical_url TEXT NOT NULL,
      meta_keywords TEXT NULL,
      schema_kind VARCHAR(64) NOT NULL DEFAULT 'web-page',
      schema_types TEXT NULL,
      schema_json LONGTEXT NULL,
      date_modified DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_page_seo_overrides_path (path),
      KEY idx_page_seo_overrides_active_updated (is_active, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const missingColumns = [
    { name: 'schema_types', definition: 'TEXT NULL AFTER schema_kind' },
    { name: 'schema_json', definition: 'LONGTEXT NULL AFTER schema_types' },
  ];

  for (const column of missingColumns) {
    const existing = await mysqlQuery(
      `SELECT 1
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'page_seo_overrides'
          AND COLUMN_NAME = ?
        LIMIT 1`,
      [column.name]
    );
    if (existing.length) continue;
    await mysqlQuery(
      `ALTER TABLE page_seo_overrides ADD COLUMN \`${column.name}\` ${column.definition}`
    );
  }

  const rows = await mysqlQuery(
    'SELECT COUNT(*) AS record_count FROM page_seo_overrides WHERE is_active = 1'
  );
  console.log(`Page SEO table ready. Active records: ${Number(rows?.[0]?.record_count || 0)}`);
}

setupPageSeoOverrides()
  .catch((error) => {
    console.error('Page SEO table setup failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => getMysqlPool().end());
