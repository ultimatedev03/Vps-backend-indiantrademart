import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import mysql from 'mysql2/promise';
import { mysqlConfig } from '../lib/mysqlPool.js';
import { syncIndiaLocations } from './syncIndiaLocations.js';

const requiredHeaders = [
  'state_code',
  'state_name',
  'district_code',
  'district_name',
  'subdistrict_code',
  'subdistrict_name',
  'village_code',
  'village_name',
  'pincode',
  'source_file',
];

const parseCsvLine = (line) => {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
};

const parseCsv = (content) => {
  const lines = String(content || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = cells[index] || null;
      return row;
    }, {});
  });
};

const chunk = (rows, size = 500) => {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
};

const importGeoPostalRawCsv = async () => {
  const csvPath = path.resolve(process.argv[2] || process.env.GEO_POSTAL_CSV || 'data/geo-postal-raw-delhi-seed.csv');
  const sourceName = path.basename(csvPath);
  const content = await fs.readFile(csvPath, 'utf8');
  const rows = parseCsv(content)
    .filter((row) => row.state_name && row.district_name)
    .map((row) => ({
      ...row,
      source_file: row.source_file || sourceName,
    }));

  if (!rows.length) throw new Error(`No usable rows found in ${csvPath}`);

  const connection = await mysql.createConnection({ ...mysqlConfig, multipleStatements: false });
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM geo_postal_raw WHERE source_file = ?', [sourceName]);

    const columns = [
      'id',
      'state_code',
      'state_name',
      'district_code',
      'district_name',
      'subdistrict_code',
      'subdistrict_name',
      'village_code',
      'village_name',
      'pincode',
      'source_file',
    ];

    for (const batch of chunk(rows)) {
      const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      await connection.execute(
        `INSERT INTO geo_postal_raw (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES ${placeholders}`,
        batch.flatMap((row) => columns.map((column) => (column === 'id' ? randomUUID() : row[column] || null)))
      );
    }

    await connection.commit();
    console.log(`Imported ${rows.length} geo rows from ${sourceName}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }

  await syncIndiaLocations();
};

if (process.argv[1] && process.argv[1].endsWith('importGeoPostalRawCsv.js')) {
  importGeoPostalRawCsv().catch((error) => {
    console.error('Geo CSV import failed:', error?.message || error);
    process.exit(1);
  });
}
