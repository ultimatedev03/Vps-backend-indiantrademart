import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const here = fileURLToPath(import.meta.url);
const backendDir = path.resolve(path.dirname(here), '..', '..');
const outputPath = path.resolve(
  process.argv[2] || process.env.CITYPOPULATION_GEO_CSV || path.join(backendDir, 'data', 'geo-postal-raw-citypopulation.csv')
);

const INDIA_INDEX_URL = 'https://www.citypopulation.de/en/india/';
const VILLAGE_INDEX_URL = new URL('villages/', INDIA_INDEX_URL).toString();
const sourceFile = path.basename(outputPath);
const includeVillages = process.env.CITYPOPULATION_INCLUDE_VILLAGES === '1';

const requestText = (url, redirectCount = 0) =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'IndianTradeMart location sync/1.0 (+https://indiantrademart.com)',
          Accept: 'text/html,text/plain,*/*',
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectCount > 5) return reject(new Error(`Too many redirects for ${url}`));
          return resolve(requestText(new URL(res.headers.location, url).toString(), redirectCount + 1));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      }
    );

    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', reject);
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeHtml = (value = '') =>
  String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const stripTags = (html = '') =>
  decodeHtml(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

const cleanName = (value = '') =>
  stripTags(value)
    .replace(/\s*→\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const stripAlternativeName = (value = '') =>
  cleanName(value)
    .replace(/\s*\[[^\]]+\]\s*/g, ' ')
    .replace(/\s*\([^)]{1,80}\)\s*/g, ' ')
    .replace(/\s*←\s*.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const codeify = (value = '') =>
  stripAlternativeName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

const csvEscape = (value = '') => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const parseCells = (rowHtml = '') => {
  const matches = [...rowHtml.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)];
  return matches.map((match) => ({
    attrs: match[1] || '',
    text: cleanName(match[2]),
  }));
};

const isPopulationCell = (value = '') => /^[.\d,\s-]+$/.test(String(value || '').trim());

const statusIsAdministrative = (status = '') =>
  /^(Republic|Union Territory|State|District)$/i.test(cleanName(status));

const statusIsSubdistrict = (status = '') =>
  /^(CD Block|Circle|Mandal|Subdistrict|Sub-District|Taluk|Tehsil)(\s*\(.*\))?$/i.test(cleanName(status));

const statusIsLocality = (status = '') => {
  const normalized = cleanName(status);
  if (/^Village$/i.test(normalized)) return includeVillages;
  return /^(Census Town|City|Industrial Township|Municipality|Municipal Corporation|Municipal Council|Nagar Panchayat|Notified Area|Outgrowth|Outgrowth Ward|Town|Township|Ward)$/i.test(
    normalized
  );
};

const discoverDistrictPages = async () => {
  const html = await requestText(VILLAGE_INDEX_URL);
  const sections = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>([\s\S]*?)(?=<h1\b|<\/body>)/gi)];
  const byUrl = new Map();

  sections.forEach((section) => {
    const stateName = stripAlternativeName(section[1]);
    if (!stateName || /^India$/i.test(stateName)) return;

    for (const link of section[2].matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = link[1] || '';
      if (!href || href.startsWith('/') || href.startsWith('#') || /^javascript:/i.test(href)) continue;

      const districtName = stripAlternativeName(link[2]);
      if (!districtName) continue;

      const url = new URL(href, VILLAGE_INDEX_URL).toString();
      if (!/\/en\/india\/villages\/[^/]+\/$/i.test(new URL(url).pathname)) continue;
      byUrl.set(url, { url, stateName, districtName });
    }
  });

  return Array.from(byUrl.values()).sort(
    (a, b) => a.stateName.localeCompare(b.stateName) || a.districtName.localeCompare(b.districtName)
  );
};

const discoverStateAdminPages = async () => {
  const html = await requestText(INDIA_INDEX_URL);
  const byUrl = new Map();
  let currentStateName = '';

  for (const token of html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (token[1]) {
      currentStateName = stripAlternativeName(token[1]);
      continue;
    }

    const href = token[2] || '';
    const text = cleanName(token[3] || '');
    if (!currentStateName || !/^(Districts|Subdistricts)$/i.test(text) || !/admin/i.test(href)) continue;

    const url = new URL(href, INDIA_INDEX_URL).toString();
    if (!/\/en\/india\/.*admin/i.test(new URL(url).pathname)) continue;
    byUrl.set(url, { url, stateName: currentStateName, type: text.toLowerCase() });
  }

  return Array.from(byUrl.values()).sort((a, b) => a.stateName.localeCompare(b.stateName) || a.type.localeCompare(b.type));
};

const baseRow = (stateName, districtName, sourceOverrides = {}) => {
  const stateCode = codeify(stateName);
  const districtCode = `${stateCode}-${codeify(districtName)}`;
  return {
    state_code: stateCode,
    state_name: stateName,
    district_code: districtCode,
    district_name: districtName,
    subdistrict_code: '',
    subdistrict_name: '',
    village_code: '',
    village_name: '',
    pincode: '',
    source_file: sourceFile,
    ...sourceOverrides,
  };
};

const parseStateAdminPage = (html, page) => {
  const stateName = page.stateName;
  const rows = [];
  const seen = new Set();
  let currentDistrictName = '';

  const pushRow = (row) => {
    const key = [row.state_name, row.district_name, row.subdistrict_name, row.village_name]
      .map((value) => String(value || '').toLowerCase())
      .join('::');
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = parseCells(match[1]);
    const texts = cells.map((cell) => cell.text);
    if (texts.length < 2) continue;

    const [name, status] = texts;
    const cleanStatus = cleanName(status);
    if (!name || !cleanStatus) continue;

    if (/^District$/i.test(cleanStatus)) {
      currentDistrictName = stripAlternativeName(name);
      if (currentDistrictName) pushRow(baseRow(stateName, currentDistrictName));
      continue;
    }

    if (!statusIsSubdistrict(cleanStatus) || !currentDistrictName) continue;

    const subdistrictName = stripAlternativeName(name);
    if (!subdistrictName) continue;
    const districtCode = `${codeify(stateName)}-${codeify(currentDistrictName)}`;
    pushRow(
      baseRow(stateName, currentDistrictName, {
        subdistrict_code: `${districtCode}-${codeify(subdistrictName)}`,
        subdistrict_name: subdistrictName,
      })
    );
  }

  return rows;
};

const parseDistrictPage = (html, page) => {
  const stateName = page.stateName;
  const districtName = page.districtName;
  if (!stateName || !districtName) throw new Error(`Unable to parse location from ${page.url}`);

  const stateCode = codeify(stateName);
  const districtCode = `${stateCode}-${codeify(districtName)}`;
  const rows = [];
  const seen = new Set();

  const pushRow = (row) => {
    const key = [row.state_name, row.district_name, row.subdistrict_name, row.village_name]
      .map((value) => String(value || '').toLowerCase())
      .join('::');
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  pushRow(baseRow(stateName, districtName));

  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = match[1];
    const cells = parseCells(rowHtml);
    const texts = cells.map((cell) => cell.text);
    if (texts.length < 2) continue;

    const [name, status] = texts;
    const cleanStatus = cleanName(status);
    if (!name || !cleanStatus || statusIsAdministrative(cleanStatus)) continue;

    if (statusIsSubdistrict(cleanStatus)) {
      const subdistrictName = stripAlternativeName(name);
      if (!subdistrictName) continue;
      pushRow({
        state_code: stateCode,
        state_name: stateName,
        district_code: districtCode,
        district_name: districtName,
        subdistrict_code: `${districtCode}-${codeify(subdistrictName)}`,
        subdistrict_name: subdistrictName,
        village_code: '',
        village_name: '',
        pincode: '',
        source_file: sourceFile,
      });
      continue;
    }

    if (!statusIsLocality(cleanStatus)) continue;

    const cityName = stripAlternativeName(name);
    if (!cityName) continue;

    const areaCell = cells.find((cell) => /class=["'][^"']*\bradm\b/i.test(cell.attrs));
    const subdistrictName = areaCell?.text && !isPopulationCell(areaCell.text) ? stripAlternativeName(areaCell.text) : '';

    pushRow({
      state_code: stateCode,
      state_name: stateName,
      district_code: districtCode,
      district_name: districtName,
      subdistrict_code: subdistrictName ? `${districtCode}-${codeify(subdistrictName)}` : '',
      subdistrict_name: subdistrictName,
      village_code: `${districtCode}-${codeify(cityName)}`,
      village_name: cityName,
      pincode: '',
      source_file: sourceFile,
    });
  }

  return rows;
};

const buildCsv = async () => {
  const statePages = await discoverStateAdminPages();
  const districtPages = await discoverDistrictPages();
  if (!statePages.length && !districtPages.length) throw new Error('No CityPopulation India pages discovered.');

  const allRows = [];
  for (const [index, page] of statePages.entries()) {
    const html = await requestText(page.url);
    const rows = parseStateAdminPage(html, page);
    allRows.push(...rows);
    console.log(`state ${index + 1}/${statePages.length}: ${page.stateName} -> ${rows.length} rows`);
    await sleep(250);
  }

  for (const [index, page] of districtPages.entries()) {
    const html = await requestText(page.url);
    const rows = parseDistrictPage(html, page);
    allRows.push(...rows);
    console.log(`district ${index + 1}/${districtPages.length}: ${page.stateName} / ${page.districtName} -> ${rows.length} rows`);
    await sleep(250);
  }

  const headers = [
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

  const csv = [
    headers.join(','),
    ...allRows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${csv}\n`, 'utf8');
  console.log(
    `Created ${outputPath} with ${allRows.length} rows from ${statePages.length} state admin pages and ${districtPages.length} district pages. Include villages: ${includeVillages ? 'yes' : 'no'}`
  );
};

if (process.argv[1] && process.argv[1].endsWith('buildCityPopulationGeoCsv.js')) {
  buildCsv().catch((error) => {
    console.error('CityPopulation CSV build failed:', error?.message || error);
    process.exit(1);
  });
}
