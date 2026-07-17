import { mysqlQuery } from '../lib/mysqlPool.js';

export const normalizePageSeoPath = (value = '/') => {
  const raw = String(value || '/').trim();
  let pathname = raw;
  try {
    pathname = raw.startsWith('http://') || raw.startsWith('https://') ? new URL(raw).pathname : raw;
  } catch {
    pathname = raw;
  }
  const normalized = `/${pathname.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : normalized.toLowerCase();
};

export async function findPageSeoOverride(value) {
  const path = normalizePageSeoPath(value);
  const rows = await mysqlQuery(
    `SELECT id,
            path,
            page_name,
            meta_title,
            meta_description,
            h1,
            canonical_url,
            meta_keywords,
            schema_kind,
            date_modified,
            updated_at
       FROM page_seo_overrides
      WHERE path = ?
        AND is_active = 1
      LIMIT 1`,
    [path]
  );
  return rows?.[0] || null;
}
