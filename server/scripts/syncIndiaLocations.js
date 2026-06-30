import { randomUUID } from 'crypto';
import mysql from 'mysql2/promise';
import { mysqlConfig } from '../lib/mysqlPool.js';

const cleanName = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const slugify = (value) =>
  cleanName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 191);

const chunk = (rows, size = 500) => {
  const groups = [];
  for (let index = 0; index < rows.length; index += size) groups.push(rows.slice(index, index + size));
  return groups;
};

const uniqueNamedRows = (rows = [], nameKey, codeKey) => {
  const bySlug = new Map();
  rows.forEach((row) => {
    const name = cleanName(row?.[nameKey]);
    const slug = slugify(name);
    if (!name || !slug || bySlug.has(slug)) return;
    bySlug.set(slug, { name, slug, sourceCode: cleanName(row?.[codeKey]) || null });
  });
  return Array.from(bySlug.values());
};

async function insertRows(connection, table, columns, rows) {
  for (const batch of chunk(rows)) {
    if (!batch.length) continue;
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await connection.execute(
      `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES ${placeholders}`,
      batch.flatMap((row) => columns.map((column) => row[column] ?? null))
    );
  }
}

async function loadMap(connection, table, parentColumn, parentId) {
  const [rows] = await connection.execute(
    `SELECT id, slug FROM \`${table}\` WHERE \`${parentColumn}\` = ?`,
    [parentId]
  );
  return new Map(rows.map((row) => [String(row.slug || ''), String(row.id)]));
}

async function ensureStates(connection) {
  const [rawStates] = await connection.query(
    `SELECT DISTINCT state_code, state_name
       FROM geo_postal_raw
      WHERE NULLIF(TRIM(state_name), '') IS NOT NULL
      ORDER BY state_name`
  );
  const sourceStates = uniqueNamedRows(rawStates, 'state_name', 'state_code');
  const [existingRows] = await connection.query('SELECT id, slug FROM states');
  const existing = new Map(existingRows.map((row) => [String(row.slug || ''), String(row.id)]));
  const inserts = sourceStates
    .filter((state) => !existing.has(state.slug))
    .map((state) => ({
      id: randomUUID(),
      name: state.name,
      slug: state.slug,
      is_active: 1,
      supplier_count: 0,
    }));
  await insertRows(connection, 'states', ['id', 'name', 'slug', 'is_active', 'supplier_count'], inserts);
  const [allRows] = await connection.query('SELECT id, slug FROM states');
  return {
    sourceStates,
    stateBySlug: new Map(allRows.map((row) => [String(row.slug || ''), String(row.id)])),
    inserted: inserts.length,
  };
}

async function ensureDistricts(connection, stateId, stateName) {
  const [rawRows] = await connection.execute(
    `SELECT DISTINCT district_code, district_name
       FROM geo_postal_raw
      WHERE TRIM(state_name) = ?
        AND NULLIF(TRIM(district_name), '') IS NOT NULL
      ORDER BY district_name`,
    [stateName]
  );
  const sourceRows = uniqueNamedRows(rawRows, 'district_name', 'district_code');
  const existing = await loadMap(connection, 'districts', 'state_id', stateId);
  const inserts = sourceRows
    .filter((district) => !existing.has(district.slug))
    .map((district) => ({
      id: randomUUID(),
      state_id: stateId,
      name: district.name,
      slug: district.slug,
      is_active: 1,
      supplier_count: 0,
    }));
  await insertRows(
    connection,
    'districts',
    ['id', 'state_id', 'name', 'slug', 'is_active', 'supplier_count'],
    inserts
  );
  return { sourceRows, districtBySlug: await loadMap(connection, 'districts', 'state_id', stateId), inserted: inserts.length };
}

async function ensureCities(connection, stateId, stateName, districtId, districtName) {
  const [rawRows] = await connection.execute(
    `SELECT city_name
       FROM (
         SELECT DISTINCT TRIM(village_name) AS city_name
           FROM geo_postal_raw
          WHERE TRIM(state_name) = ? AND TRIM(district_name) = ?
            AND NULLIF(TRIM(village_name), '') IS NOT NULL
         UNION
         SELECT DISTINCT TRIM(subdistrict_name) AS city_name
           FROM geo_postal_raw
          WHERE TRIM(state_name) = ? AND TRIM(district_name) = ?
            AND NULLIF(TRIM(subdistrict_name), '') IS NOT NULL
       ) location_names
      ORDER BY city_name`,
    [stateName, districtName, stateName, districtName]
  );
  const sourceRows = uniqueNamedRows(rawRows, 'city_name', 'unused');
  const [existingRows] = await connection.execute(
    `SELECT id, slug, district_id FROM cities WHERE state_id = ?`,
    [stateId]
  );
  const exactDistrictCities = new Map(
    existingRows
      .filter((row) => String(row.district_id || '') === String(districtId))
      .map((row) => [String(row.slug || ''), row])
  );
  const unassignedCities = new Map(
    existingRows
      .filter((row) => !row.district_id)
      .map((row) => [String(row.slug || ''), row])
  );

  let reassigned = 0;
  for (const city of sourceRows) {
    if (exactDistrictCities.has(city.slug)) continue;
    const legacyCity = unassignedCities.get(city.slug);
    if (!legacyCity) continue;
    await connection.execute(
      `UPDATE cities SET district_id = ?, is_active = 1, updated_at = NOW() WHERE id = ?`,
      [districtId, legacyCity.id]
    );
    exactDistrictCities.set(city.slug, { ...legacyCity, district_id: districtId });
    unassignedCities.delete(city.slug);
    reassigned += 1;
  }

  const inserts = sourceRows
    .filter((city) => !exactDistrictCities.has(city.slug))
    .map((city) => ({
      id: randomUUID(),
      state_id: stateId,
      district_id: districtId,
      name: city.name,
      slug: city.slug,
      is_active: 1,
      supplier_count: 0,
    }));
  await insertRows(
    connection,
    'cities',
    ['id', 'state_id', 'district_id', 'name', 'slug', 'is_active', 'supplier_count'],
    inserts
  );
  return { inserted: inserts.length, reassigned };
}

export async function syncIndiaLocations(existingConnection = null) {
  const ownsConnection = !existingConnection;
  const connection = existingConnection || await mysql.createConnection({ ...mysqlConfig, multipleStatements: false });
  const summary = { states: 0, districts: 0, cities: 0, reassignedCities: 0 };

  try {
    const [countRows] = await connection.query('SELECT COUNT(*) AS count FROM geo_postal_raw');
    const sourceCount = Number(countRows?.[0]?.count || 0);
    if (!sourceCount) {
      throw new Error(
        'geo_postal_raw is empty. Import the official LGD/postal hierarchy first, then run db:sync:india-locations.'
      );
    }

    const states = await ensureStates(connection);
    summary.states += states.inserted;
    for (const state of states.sourceStates) {
      const stateId = states.stateBySlug.get(state.slug);
      if (!stateId) continue;
      const districts = await ensureDistricts(connection, stateId, state.name);
      summary.districts += districts.inserted;
      for (const district of districts.sourceRows) {
        const districtId = districts.districtBySlug.get(district.slug);
        if (!districtId) continue;
        const cityResult = await ensureCities(connection, stateId, state.name, districtId, district.name);
        summary.cities += cityResult.inserted;
        summary.reassignedCities += cityResult.reassigned;
      }
    }
    console.log(`India location hierarchy synced: ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    if (ownsConnection) await connection.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('syncIndiaLocations.js')) {
  syncIndiaLocations().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
