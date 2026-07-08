import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import { getMysqlPool, mysqlQuery } from '../lib/mysqlPool.js';

const args = process.argv.slice(2);
const inputPath = args.find((arg) => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const createMissing = !args.includes('--no-create');

if (!inputPath) {
  console.error('Usage: node server/scripts/importCategoryKeywords.js <keywords.tsv> [--dry-run] [--no-create]');
  process.exit(1);
}

const slugify = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);

const normalizeName = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');

const normalizeKeywords = (value = '') => {
  const seen = new Set();
  const keywords = [];
  for (const raw of String(value).split(',')) {
    const keyword = raw.trim().replace(/\s+/g, ' ');
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }
  return keywords.join(', ');
};

const splitRow = (line) => {
  const columns = String(line).split(/\t+/);
  while (columns.length < 4) columns.push('');
  return columns.map((column) => column.trim());
};

const parseInput = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  const rows = [];
  let currentHead = null;

  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    const [serial, headName, subName, keywords] = splitRow(rawLine);
    if (index === 0 && /head\s+catogery/i.test(line)) continue;

    const cleanKeywords = normalizeKeywords(keywords);
    if (headName) {
      currentHead = headName.trim();
      rows.push({
        type: 'head',
        serial,
        headName: currentHead,
        keywords: cleanKeywords,
        line: index + 1,
      });
      continue;
    }

    if (subName) {
      rows.push({
        type: 'sub',
        serial,
        headName: currentHead,
        subName: subName.trim(),
        keywords: cleanKeywords,
        line: index + 1,
      });
    }
  }

  return rows;
};

const uniqueSlug = (baseSlug, usedSlugs) => {
  const base = baseSlug || 'category';
  let slug = base;
  let suffix = 2;
  while (usedSlugs.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  usedSlugs.add(slug);
  return slug;
};

const buildIndexes = async () => {
  const [heads, subs] = await Promise.all([
    mysqlQuery('SELECT id, name, slug FROM head_categories'),
    mysqlQuery('SELECT id, head_category_id, name, slug FROM sub_categories'),
  ]);

  const headsByName = new Map();
  const headsBySlug = new Map();
  const headSlugs = new Set();
  for (const head of heads) {
    headsByName.set(normalizeName(head.name), head);
    headsBySlug.set(String(head.slug || ''), head);
    if (head.slug) headSlugs.add(head.slug);
  }

  const subsByHeadAndName = new Map();
  const subsByHeadAndSlug = new Map();
  const subsByName = new Map();
  const subSlugs = new Set();
  for (const sub of subs) {
    const nameKey = normalizeName(sub.name);
    const scopedNameKey = `${sub.head_category_id}:${nameKey}`;
    const scopedSlugKey = `${sub.head_category_id}:${sub.slug || ''}`;
    subsByHeadAndName.set(scopedNameKey, sub);
    subsByHeadAndSlug.set(scopedSlugKey, sub);
    if (!subsByName.has(nameKey)) subsByName.set(nameKey, []);
    subsByName.get(nameKey).push(sub);
    if (sub.slug) subSlugs.add(sub.slug);
  }

  return {
    headsByName,
    headsBySlug,
    headSlugs,
    subsByHeadAndName,
    subsByHeadAndSlug,
    subsByName,
    subSlugs,
  };
};

const insertHead = async (name, keywords, indexes) => {
  const id = randomUUID();
  const slug = uniqueSlug(slugify(name), indexes.headSlugs);
  if (!dryRun) {
    await mysqlQuery(
      'INSERT INTO head_categories (id, name, slug, is_active, keywords, created_at, updated_at) VALUES (?, ?, ?, 1, ?, NOW(), NOW())',
      [id, name, slug, keywords],
    );
  }
  const row = { id, name, slug };
  indexes.headsByName.set(normalizeName(name), row);
  indexes.headsBySlug.set(slug, row);
  return row;
};

const insertSub = async (headId, name, keywords, indexes) => {
  const id = randomUUID();
  const slug = uniqueSlug(slugify(name), indexes.subSlugs);
  if (!dryRun) {
    await mysqlQuery(
      'INSERT INTO sub_categories (id, head_category_id, name, slug, is_active, keywords, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, NOW(), NOW())',
      [id, headId, name, slug, keywords],
    );
  }
  const row = { id, head_category_id: headId, name, slug };
  indexes.subsByHeadAndName.set(`${headId}:${normalizeName(name)}`, row);
  indexes.subsByHeadAndSlug.set(`${headId}:${slug}`, row);
  if (!indexes.subsByName.has(normalizeName(name))) indexes.subsByName.set(normalizeName(name), []);
  indexes.subsByName.get(normalizeName(name)).push(row);
  return row;
};

const run = async () => {
  const rows = await parseInput(inputPath);
  const indexes = await buildIndexes();
  const stats = {
    parsedHeads: 0,
    parsedSubs: 0,
    updatedHeads: 0,
    createdHeads: 0,
    updatedSubs: 0,
    createdSubs: 0,
    skipped: 0,
  };
  const skipped = [];

  for (const row of rows) {
    if (!row.keywords) {
      stats.skipped += 1;
      skipped.push({ line: row.line, reason: 'empty keywords', name: row.headName || row.subName });
      continue;
    }

    if (row.type === 'head') {
      stats.parsedHeads += 1;
      const nameKey = normalizeName(row.headName);
      const slugKey = slugify(row.headName);
      let head = indexes.headsByName.get(nameKey) || indexes.headsBySlug.get(slugKey);
      if (!head && createMissing) {
        head = await insertHead(row.headName, row.keywords, indexes);
        stats.createdHeads += 1;
      } else if (head) {
        if (!dryRun) {
          await mysqlQuery('UPDATE head_categories SET keywords = ?, is_active = 1, updated_at = NOW() WHERE id = ?', [
            row.keywords,
            head.id,
          ]);
        }
        stats.updatedHeads += 1;
      } else {
        stats.skipped += 1;
        skipped.push({ line: row.line, reason: 'head not found', name: row.headName });
      }
      continue;
    }

    stats.parsedSubs += 1;
    const headKey = normalizeName(row.headName);
    const head = indexes.headsByName.get(headKey) || indexes.headsBySlug.get(slugify(row.headName));
    if (!head) {
      stats.skipped += 1;
      skipped.push({ line: row.line, reason: 'parent head not found', name: row.subName, head: row.headName });
      continue;
    }

    const subKey = normalizeName(row.subName);
    const subSlug = slugify(row.subName);
    let sub =
      indexes.subsByHeadAndName.get(`${head.id}:${subKey}`) ||
      indexes.subsByHeadAndSlug.get(`${head.id}:${subSlug}`);
    const globalSubs = indexes.subsByName.get(subKey) || [];
    if (!sub && globalSubs.length === 1) sub = globalSubs[0];

    if (!sub && createMissing) {
      await insertSub(head.id, row.subName, row.keywords, indexes);
      stats.createdSubs += 1;
    } else if (sub) {
      if (!dryRun) {
        await mysqlQuery('UPDATE sub_categories SET keywords = ?, is_active = 1, updated_at = NOW() WHERE id = ?', [
          row.keywords,
          sub.id,
        ]);
      }
      stats.updatedSubs += 1;
    } else {
      stats.skipped += 1;
      skipped.push({ line: row.line, reason: 'sub not found', name: row.subName, head: row.headName });
    }
  }

  console.log(JSON.stringify({ dryRun, createMissing, stats, skipped: skipped.slice(0, 25) }, null, 2));
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getMysqlPool().end();
  });
