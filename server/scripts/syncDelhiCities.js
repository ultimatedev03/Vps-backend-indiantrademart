import { randomUUID } from 'crypto';
import mysql from 'mysql2/promise';
import { mysqlConfig } from '../lib/mysqlPool.js';

const DELHI_CITY_NAMES = Object.freeze([
  'Aali',
  'Ali Pur',
  'Asola',
  'Aya Nagar',
  'Babar Pur',
  'Bakhtawar Pur',
  'Bakkar Wala',
  'Bankauli',
  'Bankner',
  'Bapraula',
  'Baqiabad',
  'Barwala',
  'Bawana',
  'Begum Pur',
  'Bhalswa Jahangir Pur',
  'Bhati',
  'Bhor Garh',
  'Burari',
  'Chandan Hola',
  'Chattar Pur',
  'Chhawala (Chhawla)',
  'Chilla Saroda Bangar',
  'Chilla Saroda Khadar',
  'Dallo Pura',
  'Darya Pur Kalan',
  'Dayal Pur',
  'Delhi',
  'Delhi Cantonment',
  'Deoli',
  'Dera Mandi',
  'Dindar Pur',
  'Fateh Pur Beri',
  'Gharoli',
  'Gharonda Neemka Bangar (Patparganj)',
  'Gheora',
  'Ghitorni',
  'Gokal Pur',
  'Hastsal',
  'Ibrahim Pur',
  'Jaffar Pur Kalan',
  'Jaffrabad',
  'Jait Pur',
  'Jharoda Kalan',
  'Jharoda Majra Burari',
  'Jiwan Pur (Johri Pur)',
  'Jona Pur',
  'Kair',
  'Kamal Pur Majra Burari',
  'Kanjhawala',
  'Kapas Hera',
  'Karala',
  'Karawal Nagar',
  'Khajoori Khas',
  'Khan Pur Dhani',
  'Khera',
  'Khera Kalan',
  'Khera Khurd',
  'Kirari Suleman Nagar',
  'Kondli',
  'Kotla Mahigiran',
  'Kusum Pur',
  'Lad Pur',
  'Libas Pur',
  'Maidan Garhi',
  'Malik Pur Kohi (Rang Puri)',
  'Mandoli',
  'Mir Pur Turk',
  'Mithe Pur',
  'Mitraon',
  'Mohammad Pur Majri',
  'Molar Band',
  'Moradabad Pahari',
  'Mubarak Pur Dabas',
  'Mukand Pur',
  'Mukhmel Pur',
  'Mundka',
  'Mustafabad',
  'Nangli Sakrawati',
  'Nangloi Jat',
  'Neb Sarai',
  'New Delhi',
  'Nilothi',
  'Nithari',
  'Pehlad Pur Bangar',
  'Pooth Kalan',
  'Pooth Khurd',
  'Pul Pehlad',
  'Qadi Pur',
  'Quammruddin Nagar',
  'Qutab Garh',
  'Raja Pur Khurd',
  'Rajokri',
  'Raj Pur Khurd',
  'Rani Khera',
  'Roshan Pura (Dichaon Khurd)',
  'Sadat Pur Gujran',
  'Sahibabad Daulat Pur',
  'Saidabad',
  'Saidul Azaib',
  'Sambhalka',
  'Shafi Pur Ranhola',
  'Shakar Pur Baramad',
  'Siras Pur',
  'Sultan Pur',
  'Sultan Pur Majra',
  'Taj Pul',
  'Tigri',
  'Tikri Kalan',
  'Tikri Khurd',
  'Tilang Pur Kotla',
  'Tukhmir Pur',
  'Ujwa',
  'Ziauddin Pur',
]);

const slugify = (value = '') =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

const uniqueDelhiCities = () => {
  const seen = new Set();
  return DELHI_CITY_NAMES.map((name) => ({ name, slug: slugify(name) })).filter((city) => {
    if (!city.slug || seen.has(city.slug)) return false;
    seen.add(city.slug);
    return true;
  });
};

async function resolveDelhiStateId(connection) {
  const [rows] = await connection.execute(
    `SELECT id
       FROM states
      WHERE slug = 'delhi' OR LOWER(name) = 'delhi'
      ORDER BY is_active DESC, created_at ASC
      LIMIT 1`
  );

  if (rows.length) {
    await connection.execute(
      `UPDATE states
          SET name = 'Delhi',
              slug = 'delhi',
              is_active = 1,
              updated_at = NOW()
        WHERE id = ?`,
      [rows[0].id]
    );
    return rows[0].id;
  }

  const stateId = randomUUID();
  await connection.execute(
    `INSERT INTO states (id, name, slug, is_active, region_code, created_at, updated_at)
     VALUES (?, 'Delhi', 'delhi', 1, 'NORTH', NOW(), NOW())`,
    [stateId]
  );
  return stateId;
}

export async function syncDelhiCities(existingConnection = null) {
  const ownsConnection = !existingConnection;
  const connection =
    existingConnection ||
    (await mysql.createConnection({
      ...mysqlConfig,
      multipleStatements: false,
    }));

  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const stateId = await resolveDelhiStateId(connection);
    const canonicalCityIds = [];

    for (const city of uniqueDelhiCities()) {
      const [matches] = await connection.execute(
        `SELECT id
           FROM cities
          WHERE state_id = ?
            AND (slug = ? OR LOWER(name) = ?)
          ORDER BY is_active DESC, created_at ASC`,
        [stateId, city.slug, city.name.toLowerCase()]
      );

      const cityId = matches[0]?.id || randomUUID();
      if (matches.length) {
        await connection.execute(
          `UPDATE cities
              SET name = ?,
                  slug = ?,
                  is_active = 1,
                  updated_at = NOW()
            WHERE id = ?`,
          [city.name, city.slug, cityId]
        );
      } else {
        await connection.execute(
          `INSERT INTO cities (id, state_id, name, slug, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, NOW(), NOW())`,
          [cityId, stateId, city.name, city.slug]
        );
      }

      canonicalCityIds.push(cityId);

      const duplicateIds = matches.slice(1).map((row) => row.id);
      if (duplicateIds.length) {
        await connection.execute(
          `UPDATE cities
              SET is_active = 0,
                  updated_at = NOW()
            WHERE id IN (${duplicateIds.map(() => '?').join(', ')})`,
          duplicateIds
        );
      }
    }

    const [inactiveResult] = await connection.execute(
      `UPDATE cities
          SET is_active = 0,
              updated_at = NOW()
        WHERE state_id = ?
          AND id NOT IN (${canonicalCityIds.map(() => '?').join(', ')})`,
      [stateId, ...canonicalCityIds]
    );

    const [summaryRows] = await connection.execute(
      `SELECT COUNT(*) AS active_count
         FROM cities
        WHERE state_id = ?
          AND is_active = 1`,
      [stateId]
    );

    await connection.commit();
    transactionStarted = false;

    const activeCount = Number(summaryRows[0]?.active_count || 0);
    console.log(
      `Delhi city catalog synced: ${activeCount} active cities, ${Number(inactiveResult.affectedRows || 0)} old rows inactive`
    );

    return { stateId, activeCount, inactiveRows: Number(inactiveResult.affectedRows || 0) };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    if (ownsConnection) await connection.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('syncDelhiCities.js')) {
  syncDelhiCities().catch((error) => {
    console.error('syncDelhiCities failed:', error?.message || error);
    process.exit(1);
  });
}
