import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { localStorage } from './localStorage.js';
import { mysqlQuery, quoteIdent } from './mysqlPool.js';

const DEFAULT_LIMIT = 1000;
const SYSTEM_TABLES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

const clampSqlInt = (value, fallback = 0, max = 10000) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(0, Math.trunc(parsed)), max);
};

const TABLE_ALIASES = {
  'public.users': 'users',
};

const normalizeTableName = (table) => {
  const raw = String(table || '').trim();
  const normalized = TABLE_ALIASES[raw] || raw.replace(/^public\./, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) || SYSTEM_TABLES.has(normalized)) {
    throw new Error(`Invalid table name: ${raw}`);
  }
  return normalized;
};

const singular = (name = '') => {
  const value = String(name || '').replace(/!inner$/, '');
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.endsWith('s')) return value.slice(0, -1);
  return value;
};

const splitTopLevel = (input = '', delimiter = ',') => {
  const out = [];
  let buffer = '';
  let depth = 0;
  let quote = '';

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      buffer += ch;
      if (ch === quote && input[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === delimiter && depth === 0) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    } else {
      buffer += ch;
    }
  }

  if (buffer.trim()) out.push(buffer.trim());
  return out;
};

const parsePrimitive = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  if (!raw || raw === 'null') return raw === 'null' ? null : '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\([^)]*\)$/.test(raw)) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((item) => parsePrimitive(item.trim()))
      .filter((item) => item !== '');
  }
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
};

const normalizeDbValue = (value) => {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value.trim())) {
    return value.trim().slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return JSON.stringify(value);
  }
  return value;
};

const normalizeReturnedValue = (value) => {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value;
};

const normalizeReturnedRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizeReturnedValue(value);
    if (typeof normalized === 'string') {
      const trimmed = normalized.trim();
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          out[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // Keep original string when it is not valid JSON.
        }
      }
    }
    out[key] = normalized;
  }
  return out;
};

const columnCache = new Map();

async function getTableColumns(table) {
  const tableName = normalizeTableName(table);
  if (columnCache.has(tableName)) return columnCache.get(tableName);

  const rows = await mysqlQuery(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  const columns = rows.map((row) => ({
    name: row.COLUMN_NAME,
    type: row.DATA_TYPE,
    key: row.COLUMN_KEY,
  }));
  columnCache.set(tableName, columns);
  return columns;
}

async function getColumnNames(table) {
  return (await getTableColumns(table)).map((column) => column.name);
}

async function getPrimaryKey(table) {
  const columns = await getTableColumns(table);
  return columns.find((column) => column.key === 'PRI')?.name || (columns.some((c) => c.name === 'id') ? 'id' : null);
}

const explicitRelations = {
  products: {
    vendors: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
    vendor: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
    micro_categories: { table: 'micro_categories', localKey: 'micro_category_id', foreignKey: 'id', many: false },
    sub_categories: { table: 'sub_categories', localKey: 'sub_category_id', foreignKey: 'id', many: false },
    head_categories: { table: 'head_categories', localKey: 'head_category_id', foreignKey: 'id', many: false },
  },
  vendors: {
    products: { table: 'products', localKey: 'id', foreignKey: 'vendor_id', many: true },
    city: { table: 'cities', localKey: 'city_id', foreignKey: 'id', many: false },
    city_ref: { table: 'cities', localKey: 'city_id', foreignKey: 'id', many: false },
    state: { table: 'states', localKey: 'state_id', foreignKey: 'id', many: false },
    state_ref: { table: 'states', localKey: 'state_id', foreignKey: 'id', many: false },
  },
  sub_categories: {
    head_categories: { table: 'head_categories', localKey: 'head_category_id', foreignKey: 'id', many: false },
    head_category: { table: 'head_categories', localKey: 'head_category_id', foreignKey: 'id', many: false },
    parent: { table: 'head_categories', localKey: 'head_category_id', foreignKey: 'id', many: false },
    micro_categories: { table: 'micro_categories', localKey: 'id', foreignKey: 'sub_category_id', many: true },
  },
  micro_categories: {
    sub_categories: { table: 'sub_categories', localKey: 'sub_category_id', foreignKey: 'id', many: false },
    sub_category: { table: 'sub_categories', localKey: 'sub_category_id', foreignKey: 'id', many: false },
    parent: { table: 'sub_categories', localKey: 'sub_category_id', foreignKey: 'id', many: false },
    products: { table: 'products', localKey: 'id', foreignKey: 'micro_category_id', many: true },
  },
  head_categories: {
    sub_categories: { table: 'sub_categories', localKey: 'id', foreignKey: 'head_category_id', many: true },
    products: { table: 'products', localKey: 'id', foreignKey: 'head_category_id', many: true },
  },
  support_tickets: {
    vendors: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
    vendor: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
  },
  vendor_plan_subscriptions: {
    plan: { table: 'vendor_plans', localKey: 'plan_id', foreignKey: 'id', many: false },
    vendor_plans: { table: 'vendor_plans', localKey: 'plan_id', foreignKey: 'id', many: false },
  },
  lead_purchases: {
    lead: { table: 'leads', localKey: 'lead_id', foreignKey: 'id', many: false },
    leads: { table: 'leads', localKey: 'lead_id', foreignKey: 'id', many: false },
  },
  proposals: {
    buyer: { table: 'buyers', localKey: 'buyer_id', foreignKey: 'id', many: false },
    buyers: { table: 'buyers', localKey: 'buyer_id', foreignKey: 'id', many: false },
    vendor: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
    vendors: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
  },
  leads: {
    buyer: { table: 'buyers', localKey: 'buyer_id', foreignKey: 'id', many: false },
    vendor: { table: 'vendors', localKey: 'vendor_id', foreignKey: 'id', many: false },
    micro_categories: { table: 'micro_categories', localKey: 'micro_category_id', foreignKey: 'id', many: false },
    sub_categories: { table: 'sub_categories', localKey: 'sub_category_id', foreignKey: 'id', many: false },
    head_categories: { table: 'head_categories', localKey: 'head_category_id', foreignKey: 'id', many: false },
  },
};

function resolveRelation(baseTable, spec) {
  const base = normalizeTableName(baseTable);
  const cleanRelation = String(spec?.relation || spec?.tableHint || '').replace(/!inner$/, '');
  const cleanAlias = String(spec?.alias || '').replace(/!inner$/, '');
  const mapped = explicitRelations[base]?.[cleanAlias] || explicitRelations[base]?.[cleanRelation];
  if (mapped) return mapped;

  const tableHint = cleanRelation.endsWith('_id') ? '' : cleanRelation;
  const relationTable = tableHint || `${cleanAlias}s`;

  if (cleanRelation.endsWith('_id')) {
    const tableByAlias = cleanAlias === 'city' || cleanAlias === 'city_ref'
      ? 'cities'
      : cleanAlias === 'state' || cleanAlias === 'state_ref'
        ? 'states'
        : `${cleanAlias}s`;
    return { table: tableByAlias, localKey: cleanRelation, foreignKey: 'id', many: false };
  }

  return {
    table: relationTable,
    localKey: `${singular(relationTable)}_id`,
    foreignKey: 'id',
    many: false,
  };
}

function parseRelationToken(token) {
  const ix = token.indexOf('(');
  if (ix < 0 || !token.endsWith(')')) return null;
  const head = token.slice(0, ix).trim();
  const body = token.slice(ix + 1, -1).trim();
  if (!head || head === 'count') return null;

  const [aliasPart, relationPart] = head.includes(':') ? head.split(':') : [head, head];
  const inner = relationPart.includes('!inner') || aliasPart.includes('!inner');
  const alias = aliasPart.replace(/!inner$/, '').trim();
  const relation = relationPart.replace(/!inner$/, '').trim();
  const children = splitTopLevel(body).map(parseRelationToken).filter(Boolean);
  const countOnly = body.trim() === 'count';

  return { alias, relation, tableHint: relation, inner, body, children, countOnly };
}

function parseSelectRelations(select = '') {
  return splitTopLevel(String(select || '*'))
    .map(parseRelationToken)
    .filter(Boolean);
}

class SqlBuilder {
  constructor(table) {
    this.table = normalizeTableName(table);
    this.baseAlias = 't0';
    this.params = [];
    this.joins = new Map();
  }

  addJoinForColumn(column) {
    const raw = String(column || '');
    if (!raw.includes('.')) return { sql: `${this.baseAlias}.${quoteIdent(raw)}` };
    const [relationName, columnName] = raw.split('.');
    const relation = resolveRelation(this.table, { alias: relationName, relation: relationName });
    const alias = `j_${relationName.replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (!this.joins.has(alias)) {
      const joinType = relation.inner ? 'INNER JOIN' : 'LEFT JOIN';
      this.joins.set(
        alias,
        `${joinType} ${quoteIdent(relation.table)} ${alias} ON ${this.baseAlias}.${quoteIdent(relation.localKey)} = ${alias}.${quoteIdent(relation.foreignKey)}`
      );
    }
    return { sql: `${alias}.${quoteIdent(columnName)}` };
  }

  compileFilter(filter) {
    const column = this.addJoinForColumn(filter.column).sql;
    const op = normalizeFilterOperator(filter.op);
    const value = parsePrimitive(filter.value);

    if (op === 'eq') {
      this.params.push(normalizeDbValue(value));
      return `${column} = ?`;
    }
    if (op === 'neq' || op === 'noteq') {
      this.params.push(normalizeDbValue(value));
      return `${column} <> ?`;
    }
    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      const map = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
      this.params.push(normalizeDbValue(value));
      return `${column} ${map[op]} ?`;
    }
    if (op === 'like' || op === 'ilike') {
      this.params.push(String(value ?? ''));
      return op === 'ilike' ? `LOWER(${column}) LIKE LOWER(?)` : `${column} LIKE ?`;
    }
    if (op === 'notlike' || op === 'notilike') {
      this.params.push(String(value ?? ''));
      return op === 'notilike' ? `LOWER(${column}) NOT LIKE LOWER(?)` : `${column} NOT LIKE ?`;
    }
    if (op === 'in') {
      const values = Array.isArray(value) ? value : String(value || '').split(',').map((item) => parsePrimitive(item));
      if (!values.length) return '1 = 0';
      this.params.push(...values.map(normalizeDbValue));
      return `${column} IN (${values.map(() => '?').join(', ')})`;
    }
    if (op === 'notin') {
      const values = Array.isArray(value) ? value : String(value || '').split(',').map((item) => parsePrimitive(item));
      if (!values.length) return '1 = 1';
      this.params.push(...values.map(normalizeDbValue));
      return `${column} NOT IN (${values.map(() => '?').join(', ')})`;
    }
    if (op === 'is') {
      if (value === null || value === 'null') return `${column} IS NULL`;
      if (value === true || value === 'true') return `${column} IS TRUE`;
      if (value === false || value === 'false') return `${column} IS FALSE`;
      this.params.push(normalizeDbValue(value));
      return `${column} IS ?`;
    }
    if (op === 'notis') {
      if (value === null || value === 'null') return `${column} IS NOT NULL`;
      this.params.push(normalizeDbValue(value));
      return `${column} IS NOT ?`;
    }
    if (op === 'notgt' || op === 'notgte' || op === 'notlt' || op === 'notlte') {
      const map = { notgt: '<=', notgte: '<', notlt: '>=', notlte: '>' };
      this.params.push(normalizeDbValue(value));
      return `${column} ${map[op]} ?`;
    }
    if (op === 'contains') {
      this.params.push(JSON.stringify(value));
      return `JSON_CONTAINS(COALESCE(${column}, JSON_ARRAY()), CAST(? AS JSON))`;
    }
    if (op === 'notcontains') {
      this.params.push(JSON.stringify(value));
      return `NOT JSON_CONTAINS(COALESCE(${column}, JSON_ARRAY()), CAST(? AS JSON))`;
    }

    throw new Error(`Unsupported filter operator: ${op}`);
  }

  compileWhere(filters = [], orGroups = []) {
    const parts = [];
    filters.forEach((filter) => {
      parts.push(this.compileFilter(filter));
    });
    orGroups.forEach((group) => {
      const options = group.map((filter) => this.compileFilter(filter));
      if (options.length) parts.push(`(${options.join(' OR ')})`);
    });
    return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  }

  compileJoins() {
    return Array.from(this.joins.values()).join(' ');
  }
}

function parseOrFilter(filterString = '') {
  return splitTopLevel(filterString).map((part) => {
    const [column, op, ...rest] = part.split('.');
    const value = rest.join('.');
    const normalizedOp = op === 'not' ? negateFilterOperator(rest[0]) : normalizeFilterOperator(op);
    const normalizedValue = op === 'not' ? rest.slice(1).join('.') : value;
    return { column, op: normalizedOp, value: normalizedValue };
  }).filter((filter) => filter.column && filter.op);
}

function normalizeFilterOperator(operator = 'eq') {
  const op = String(operator || 'eq').trim().toLowerCase();
  if (op === 'cs') return 'contains';
  if (op === 'not.eq') return 'neq';
  if (op.startsWith('not.')) return negateFilterOperator(op.slice(4));
  return op;
}

function negateFilterOperator(operator = 'eq') {
  const op = normalizeFilterOperator(operator);
  if (op === 'eq') return 'neq';
  if (op === 'neq') return 'eq';
  if (op === 'in') return 'notin';
  if (op === 'is') return 'notis';
  if (op.startsWith('not')) return op;
  return `not${op}`;
}

function parseConflictColumns(raw = '') {
  return String(raw || '')
    .split(',')
    .map((column) => column.trim())
    .filter((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column));
}

async function hydrateRelations(baseTable, rows, select) {
  const relationSpecs = parseSelectRelations(select);
  if (!relationSpecs.length || !rows?.length) return rows;

  for (const spec of relationSpecs) {
    const relation = resolveRelation(baseTable, spec);
    const parentKeys = rows.map((row) => row?.[relation.localKey]).filter((value) => value !== null && value !== undefined);
    if (!parentKeys.length && !relation.many) {
      rows.forEach((row) => {
        row[spec.alias] = null;
      });
      continue;
    }

    if (spec.countOnly) {
      const ids = rows.map((row) => row?.[relation.localKey]).filter(Boolean);
      if (!ids.length) {
        rows.forEach((row) => {
          row[spec.alias] = [{ count: 0 }];
        });
        continue;
      }
      const countRows = await mysqlQuery(
        `SELECT ${quoteIdent(relation.foreignKey)} AS fk, COUNT(*) AS count
           FROM ${quoteIdent(relation.table)}
          WHERE ${quoteIdent(relation.foreignKey)} IN (${ids.map(() => '?').join(', ')})
          GROUP BY ${quoteIdent(relation.foreignKey)}`,
        ids
      );
      const counts = new Map(countRows.map((row) => [String(row.fk), Number(row.count || 0)]));
      rows.forEach((row) => {
        row[spec.alias] = [{ count: counts.get(String(row[relation.localKey])) || 0 }];
      });
      continue;
    }

    if (relation.many) {
      const ids = rows.map((row) => row?.[relation.localKey]).filter(Boolean);
      if (!ids.length) continue;
      const children = (await mysqlQuery(
        `SELECT * FROM ${quoteIdent(relation.table)} WHERE ${quoteIdent(relation.foreignKey)} IN (${ids.map(() => '?').join(', ')})`,
        ids
      )).map(normalizeReturnedRow);
      await hydrateRelations(relation.table, children, spec.body);
      const grouped = new Map();
      children.forEach((child) => {
        const key = String(child[relation.foreignKey]);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(child);
      });
      rows.forEach((row) => {
        row[spec.alias] = grouped.get(String(row[relation.localKey])) || [];
      });
      continue;
    }

    const ids = Array.from(new Set(parentKeys.map(String)));
    const relatedRows = (await mysqlQuery(
      `SELECT * FROM ${quoteIdent(relation.table)} WHERE ${quoteIdent(relation.foreignKey)} IN (${ids.map(() => '?').join(', ')})`,
      ids
    )).map(normalizeReturnedRow);
    await hydrateRelations(relation.table, relatedRows, spec.body);
    const byId = new Map(relatedRows.map((row) => [String(row[relation.foreignKey]), row]));
    rows.forEach((row) => {
      row[spec.alias] = byId.get(String(row[relation.localKey])) || null;
    });
  }

  return rows;
}

class MysqlQueryBuilder {
  constructor(table) {
    this.table = normalizeTableName(table);
    this.operation = 'select';
    this.selectColumns = '*';
    this.selectOptions = {};
    this.filters = [];
    this.orGroups = [];
    this.orders = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.singleMode = false;
    this.maybeSingleMode = false;
    this.payload = null;
    this.upsertOptions = {};
    this.returning = false;
    this.shouldThrow = false;
  }

  select(columns = '*', options = {}) {
    this.selectColumns = columns || '*';
    this.selectOptions = options || {};
    this.returning = this.operation !== 'select';
    return this;
  }

  insert(rows) {
    this.operation = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(values) {
    this.operation = 'update';
    this.payload = values || {};
    return this;
  }

  upsert(rows, options = {}) {
    this.operation = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOptions = options || {};
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column, value) { this.filters.push({ column, op: 'eq', value }); return this; }
  neq(column, value) { this.filters.push({ column, op: 'neq', value }); return this; }
  gt(column, value) { this.filters.push({ column, op: 'gt', value }); return this; }
  gte(column, value) { this.filters.push({ column, op: 'gte', value }); return this; }
  lt(column, value) { this.filters.push({ column, op: 'lt', value }); return this; }
  lte(column, value) { this.filters.push({ column, op: 'lte', value }); return this; }
  like(column, value) { this.filters.push({ column, op: 'like', value }); return this; }
  ilike(column, value) { this.filters.push({ column, op: 'ilike', value }); return this; }
  in(column, value) { this.filters.push({ column, op: 'in', value }); return this; }
  contains(column, value) { this.filters.push({ column, op: 'contains', value }); return this; }
  is(column, value) { this.filters.push({ column, op: 'is', value }); return this; }

  filter(column, operator, value) {
    this.filters.push({ column, op: normalizeFilterOperator(operator), value });
    return this;
  }

  match(values = {}) {
    Object.entries(values || {}).forEach(([column, value]) => this.eq(column, value));
    return this;
  }

  not(column, operator, value) {
    this.filters.push({ column, op: negateFilterOperator(operator), value });
    return this;
  }

  or(filterString) {
    const group = parseOrFilter(filterString);
    if (group.length) this.orGroups.push(group);
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value) {
    this.limitValue = Math.max(0, Number(value || 0));
    return this;
  }

  range(from, to) {
    const start = Math.max(0, Number(from || 0));
    const end = Math.max(start, Number(to || start));
    this.offsetValue = start;
    this.limitValue = end - start + 1;
    return this;
  }

  single() {
    this.singleMode = true;
    this.limitValue = this.limitValue || 1;
    return this;
  }

  maybeSingle() {
    this.maybeSingleMode = true;
    this.limitValue = this.limitValue || 1;
    return this;
  }

  returns() {
    return this;
  }

  throwOnError() {
    this.shouldThrow = true;
    return this;
  }

  async execute() {
    try {
      let result = null;
      if (this.operation === 'select') result = await this.executeSelect();
      else if (this.operation === 'insert') result = await this.executeInsert(false);
      else if (this.operation === 'upsert') result = await this.executeInsert(true);
      else if (this.operation === 'update') result = await this.executeUpdate();
      else if (this.operation === 'delete') result = await this.executeDelete();
      else throw new Error(`Unsupported operation: ${this.operation}`);
      if (result?.error && this.shouldThrow) {
        const error = new Error(result.error.message || 'Database query failed');
        error.code = result.error.code;
        throw error;
      }
      return result;
    } catch (error) {
      if (this.shouldThrow) throw error;
      return { data: null, error: { message: error.message || String(error), code: error.code }, count: null };
    }
  }

  async executeSelect(extraFilters = []) {
    const builder = new SqlBuilder(this.table);
    const where = builder.compileWhere([...this.filters, ...extraFilters], this.orGroups);
    const orderParts = this.orders.map((item) => {
      const col = builder.addJoinForColumn(item.column).sql;
      return `${col} ${item.ascending ? 'ASC' : 'DESC'}`;
    });
    const orderSql = orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '';
    const limit = clampSqlInt(this.limitValue, DEFAULT_LIMIT, 10000);
    const offset = clampSqlInt(this.offsetValue, 0, 1000000);

    const joinsForWhere = builder.compileJoins();
    const countSql = `SELECT COUNT(*) AS count FROM ${quoteIdent(this.table)} ${builder.baseAlias} ${joinsForWhere} ${where}`;
    const countRows = this.selectOptions?.count ? await mysqlQuery(countSql, builder.params) : [];
    const count = countRows[0]?.count !== undefined ? Number(countRows[0].count || 0) : null;

    if (this.selectOptions?.head) {
      return { data: null, error: null, count };
    }

    const sql = `SELECT ${builder.baseAlias}.*
                   FROM ${quoteIdent(this.table)} ${builder.baseAlias}
                   ${builder.compileJoins()}
                   ${where}
                   ${orderSql}
                  LIMIT ${limit} OFFSET ${offset}`;
    const rows = (await mysqlQuery(sql, builder.params)).map(normalizeReturnedRow);
    await hydrateRelations(this.table, rows, this.selectColumns);

    if (this.singleMode || this.maybeSingleMode) {
      const row = rows[0] || null;
      if (this.singleMode && !row) {
        return { data: null, error: { message: 'Row not found', code: 'PGRST116' }, count };
      }
      return { data: row, error: null, count };
    }

    return { data: rows, error: null, count };
  }

  async selectAffectedRows(primaryKey, ids) {
    if (!primaryKey || !ids?.length) return [];
    const { data, error } = await new MysqlQueryBuilder(this.table)
      .select(this.selectColumns || '*')
      .in(primaryKey, ids)
      .executeSelect();
    if (error) throw new Error(error.message);
    return data || [];
  }

  async selectAffectedRowsByColumns(columns, rows) {
    const conflictColumns = (columns || []).filter(Boolean);
    if (!conflictColumns.length || !rows?.length) return [];

    if (conflictColumns.length === 1) {
      const column = conflictColumns[0];
      const values = rows.map((row) => row?.[column]).filter((value) => value !== undefined && value !== null);
      if (!values.length) return [];
      const { data, error } = await new MysqlQueryBuilder(this.table)
        .select(this.selectColumns || '*')
        .in(column, values)
        .executeSelect();
      if (error) throw new Error(error.message);
      return data || [];
    }

    const results = [];
    for (const row of rows) {
      let query = new MysqlQueryBuilder(this.table).select(this.selectColumns || '*');
      let valid = true;
      for (const column of conflictColumns) {
        if (row?.[column] === undefined || row?.[column] === null) {
          valid = false;
          break;
        }
        query = query.eq(column, row[column]);
      }
      if (!valid) continue;
      const { data, error } = await query.maybeSingle().executeSelect();
      if (error) throw new Error(error.message);
      if (data) results.push(data);
    }
    return results;
  }

  async executeInsert(isUpsert) {
    const rows = (this.payload || []).filter(Boolean);
    if (!rows.length) return { data: [], error: null, count: 0 };

    const columnNames = await getColumnNames(this.table);
    const hasId = columnNames.includes('id');
    const normalizedRows = rows.map((row) => {
      const next = {};
      if (hasId && !row.id) next.id = randomUUID();
      for (const [key, value] of Object.entries(row)) {
        if (columnNames.includes(key)) next[key] = value;
      }
      return next;
    });

    const allColumns = Array.from(new Set(normalizedRows.flatMap((row) => Object.keys(row))));
    if (!allColumns.length) throw new Error(`No valid columns for ${this.table}`);

    const placeholders = normalizedRows
      .map(() => `(${allColumns.map(() => '?').join(', ')})`)
      .join(', ');
    const values = normalizedRows.flatMap((row) => allColumns.map((column) => normalizeDbValue(row[column])));
    const updateColumns = allColumns.filter((column) => column !== 'id');
    const updateSql = isUpsert
      ? this.upsertOptions?.ignoreDuplicates
        ? ` ON DUPLICATE KEY UPDATE ${quoteIdent(allColumns[0])} = ${quoteIdent(allColumns[0])}`
        : ` ON DUPLICATE KEY UPDATE ${
          (updateColumns.length ? updateColumns : allColumns)
            .map((column) => `${quoteIdent(column)} = VALUES(${quoteIdent(column)})`)
            .join(', ')
        }`
      : '';

    await mysqlQuery(
      `INSERT INTO ${quoteIdent(this.table)} (${allColumns.map(quoteIdent).join(', ')}) VALUES ${placeholders}${updateSql}`,
      values
    );

    const pk = await getPrimaryKey(this.table);
    const conflictColumns = parseConflictColumns(this.upsertOptions?.onConflict).filter((column) =>
      columnNames.includes(column)
    );
    const ids = pk ? normalizedRows.map((row) => row[pk]).filter(Boolean) : [];
    const data = this.returning
      ? isUpsert && conflictColumns.length
        ? await this.selectAffectedRowsByColumns(conflictColumns, normalizedRows)
        : await this.selectAffectedRows(pk, ids)
      : normalizedRows.map(normalizeReturnedRow);
    const finalData = this.singleMode || this.maybeSingleMode ? (data[0] || null) : data;
    return { data: finalData, error: null, count: Array.isArray(data) ? data.length : (data ? 1 : 0) };
  }

  async executeUpdate() {
    const columnNames = await getColumnNames(this.table);
    const updates = Object.fromEntries(
      Object.entries(this.payload || {}).filter(([key]) => columnNames.includes(key))
    );
    if (!Object.keys(updates).length) return { data: this.maybeSingleMode ? null : [], error: null, count: 0 };

    const pk = await getPrimaryKey(this.table);
    let ids = [];
    if (pk && this.returning) {
      const before = await new MysqlQueryBuilder(this.table)
        .select(pk)
        .applySerialized({ filters: this.filters, orGroups: this.orGroups })
        .executeSelect();
      ids = (before.data || []).map((row) => row[pk]).filter(Boolean);
    }

    const builder = new SqlBuilder(this.table);
    const where = builder.compileWhere(this.filters, this.orGroups);
    const setSql = Object.keys(updates).map((column) => `${builder.baseAlias}.${quoteIdent(column)} = ?`).join(', ');
    const params = [...Object.values(updates).map(normalizeDbValue), ...builder.params];
    const result = await mysqlQuery(
      `UPDATE ${quoteIdent(this.table)} ${builder.baseAlias} ${builder.compileJoins()} SET ${setSql} ${where}`,
      params
    );
    const count = Number(result?.affectedRows || 0);
    const data = this.returning ? await this.selectAffectedRows(pk, ids) : [];
    const finalData = this.singleMode || this.maybeSingleMode ? (data[0] || null) : data;
    return { data: finalData, error: null, count };
  }

  async executeDelete() {
    const pk = await getPrimaryKey(this.table);
    let rowsBefore = [];
    if (pk && this.returning) {
      const before = await new MysqlQueryBuilder(this.table)
        .select(this.selectColumns || '*')
        .applySerialized({ filters: this.filters, orGroups: this.orGroups })
        .executeSelect();
      rowsBefore = before.data || [];
    }

    const builder = new SqlBuilder(this.table);
    const where = builder.compileWhere(this.filters, this.orGroups);
    const result = await mysqlQuery(
      `DELETE ${builder.baseAlias} FROM ${quoteIdent(this.table)} ${builder.baseAlias} ${builder.compileJoins()} ${where}`,
      builder.params
    );
    const count = Number(result?.affectedRows || 0);
    const finalData = this.singleMode || this.maybeSingleMode ? (rowsBefore[0] || null) : rowsBefore;
    return { data: finalData, error: null, count };
  }

  applySerialized(input = {}) {
    this.filters = input.filters || this.filters;
    this.orGroups = (input.orGroups || this.orGroups || []).map((group) =>
      typeof group === 'string' ? parseOrFilter(group) : group
    );
    this.orders = input.orders || this.orders;
    this.limitValue = input.limitValue ?? this.limitValue;
    this.offsetValue = input.offsetValue ?? this.offsetValue;
    this.singleMode = input.singleMode ?? this.singleMode;
    this.maybeSingleMode = input.maybeSingleMode ?? this.maybeSingleMode;
    this.selectColumns = input.selectColumns ?? this.selectColumns;
    this.selectOptions = input.selectOptions ?? this.selectOptions;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  catch(reject) {
    return this.execute().catch(reject);
  }
}

async function executeDirRankedProducts(params = {}) {
  const limit = clampSqlInt(params.p_limit, 20, 100) || 20;
  const offset = clampSqlInt(params.p_offset, 0, 1000000);
  const where = ['p.status = ?', 'COALESCE(v.is_active, 1) = 1'];
  const sqlParams = ['ACTIVE'];
  const planPrioritySql = `CASE
          WHEN LOWER(COALESCE(vp.name, '')) LIKE '%diamond%' OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%' THEN 700
          WHEN LOWER(COALESCE(vp.name, '')) LIKE '%gold%' THEN 600
          WHEN LOWER(COALESCE(vp.name, '')) LIKE '%silver%' THEN 500
          WHEN LOWER(COALESCE(vp.name, '')) LIKE '%boost%' THEN 400
          WHEN LOWER(COALESCE(vp.name, '')) LIKE '%certif%' THEN 300
          WHEN LOWER(COALESCE(vp.name, '')) LIKE '%startup%' THEN 200
          ELSE 100
        END`;
  const salesAssistedSlotPlanSql = `(
          LOWER(COALESCE(vp.name, '')) LIKE '%diamond%'
          OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%'
          OR LOWER(COALESCE(vp.name, '')) LIKE '%gold%'
          OR LOWER(COALESCE(vp.name, '')) LIKE '%silver%'
        )`;
  const preferredCategorySql = `(
          p.micro_category_id IS NOT NULL
          AND JSON_LENGTH(COALESCE(vpref.preferred_micro_categories, JSON_ARRAY())) > 0
          AND JSON_CONTAINS(COALESCE(vpref.preferred_micro_categories, JSON_ARRAY()), JSON_QUOTE(p.micro_category_id))
        )`;
  const premiumSlotSql = `(${salesAssistedSlotPlanSql} AND ${preferredCategorySql})`;
  let preferredLocationSql = `(
          JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
          OR JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
          OR JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
        )`;
  const preferredLocationParams = [];

  if (params.p_micro_id) {
    where.push('p.micro_category_id = ?');
    sqlParams.push(params.p_micro_id);
  }
  if (params.p_q) {
    where.push(`(
      LOWER(COALESCE(p.name, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(p.category, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(p.description, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(p.category_path, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(p.category_slug, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(v.company_name, '')) LIKE LOWER(?)
    )`);
    const like = `%${params.p_q}%`;
    sqlParams.push(like, like, like, like, like, like);
  }
  if (params.p_state_id) {
    where.push('v.state_id = ?');
    sqlParams.push(params.p_state_id);
    preferredLocationSql = `(
          (
            JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
            AND JSON_CONTAINS(COALESCE(vpref.preferred_states, JSON_ARRAY()), JSON_QUOTE(?))
          )
          OR (
            JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
            AND EXISTS (
              SELECT 1
                FROM JSON_TABLE(COALESCE(vpref.preferred_cities, JSON_ARRAY()), '$[*]' COLUMNS(preferred_city_id VARCHAR(64) PATH '$')) preferred_city
                JOIN cities preferred_city_row ON preferred_city_row.id = preferred_city.preferred_city_id
               WHERE preferred_city_row.state_id = ?
            )
          )
          OR (
            JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
            AND EXISTS (
              SELECT 1
                FROM JSON_TABLE(COALESCE(vpref.preferred_districts, JSON_ARRAY()), '$[*]' COLUMNS(preferred_district_id VARCHAR(64) PATH '$')) preferred_district
                JOIN districts preferred_district_row ON preferred_district_row.id = preferred_district.preferred_district_id
               WHERE preferred_district_row.state_id = ?
            )
          )
        )`;
    preferredLocationParams.push(params.p_state_id, params.p_state_id, params.p_state_id);
  }
  if (params.p_city_id) {
    where.push('v.city_id = ?');
    sqlParams.push(params.p_city_id);
    preferredLocationSql = `(
          (
            JSON_LENGTH(COALESCE(vpref.preferred_cities, JSON_ARRAY())) > 0
            AND JSON_CONTAINS(COALESCE(vpref.preferred_cities, JSON_ARRAY()), JSON_QUOTE(?))
          )
          OR (
            JSON_LENGTH(COALESCE(vpref.preferred_states, JSON_ARRAY())) > 0
            AND EXISTS (
              SELECT 1
                FROM cities selected_city
               WHERE selected_city.id = ?
                 AND JSON_CONTAINS(COALESCE(vpref.preferred_states, JSON_ARRAY()), JSON_QUOTE(selected_city.state_id))
            )
          )
          OR (
            JSON_LENGTH(COALESCE(vpref.preferred_districts, JSON_ARRAY())) > 0
            AND EXISTS (
              SELECT 1
                FROM cities selected_city
               WHERE selected_city.id = ?
                 AND JSON_CONTAINS(COALESCE(vpref.preferred_districts, JSON_ARRAY()), JSON_QUOTE(selected_city.district_id))
            )
          )
        )`;
    preferredLocationParams.length = 0;
    preferredLocationParams.push(params.p_city_id, params.p_city_id, params.p_city_id);
  }
  where.push(`(
    NOT ${salesAssistedSlotPlanSql}
    OR (
      ${preferredCategorySql}
      AND ${preferredLocationSql}
    )
  )`);
  sqlParams.push(...preferredLocationParams);

  const sort = String(params.p_sort || '');
  const slotAwarePlanOrder = 'CASE WHEN premium_slot_rank > 0 THEN vendor_plan_priority ELSE 0 END DESC';
  const sortSql = sort === 'price_asc'
    ? `p.price ASC, premium_slot_rank DESC, ${slotAwarePlanOrder}`
    : sort === 'price_desc'
      ? `p.price DESC, premium_slot_rank DESC, ${slotAwarePlanOrder}`
      : `premium_slot_rank DESC, ${slotAwarePlanOrder}, p.created_at DESC`;

  const rows = await mysqlQuery(
    `SELECT p.*,
            COALESCE(vp.name, 'TRIAL') AS vendor_plan_name,
            ${planPrioritySql} AS vendor_plan_priority,
            CASE WHEN ${premiumSlotSql} THEN 1 ELSE 0 END AS premium_slot_matched,
            CASE WHEN ${premiumSlotSql} THEN ${planPrioritySql} ELSE 0 END AS premium_slot_rank,
            CASE
              WHEN ${premiumSlotSql} AND (LOWER(COALESCE(vp.name, '')) LIKE '%diamond%' OR LOWER(COALESCE(vp.name, '')) LIKE '%dimond%') THEN 'Diamond Supplier'
              WHEN ${premiumSlotSql} AND LOWER(COALESCE(vp.name, '')) LIKE '%gold%' THEN 'Gold Supplier'
              WHEN ${premiumSlotSql} AND LOWER(COALESCE(vp.name, '')) LIKE '%silver%' THEN 'Silver Supplier'
              ELSE ''
            END AS premium_slot_label,
            COUNT(*) OVER() AS total_count
       FROM products p
       JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN vendor_plan_subscriptions vps
         ON vps.id = (
           SELECT active_vps.id
             FROM vendor_plan_subscriptions active_vps
            WHERE active_vps.vendor_id = p.vendor_id
              AND active_vps.status = 'ACTIVE'
              AND (active_vps.end_date IS NULL OR active_vps.end_date > UTC_TIMESTAMP())
            ORDER BY COALESCE(active_vps.end_date, '9999-12-31 23:59:59') DESC,
                     active_vps.created_at DESC,
                     active_vps.id DESC
            LIMIT 1
         )
      LEFT JOIN vendor_plans vp ON vp.id = vps.plan_id
      LEFT JOIN vendor_preferences vpref ON vpref.vendor_id = p.vendor_id
     WHERE ${where.join(' AND ')}
      ORDER BY ${sortSql}
      LIMIT ${limit} OFFSET ${offset}`,
    sqlParams
  );

  const normalized = rows.map(normalizeReturnedRow);
  await hydrateRelations('products', normalized, 'vendors(*)');
  return { data: normalized, error: null };
}

const makeAuthPayload = (user) => ({
  id: user?.id,
  email: user?.email,
  role: user?.role || 'USER',
  user_metadata: {
    full_name: user?.full_name,
    role: user?.role || 'USER',
  },
  app_metadata: {
    role: user?.role || 'USER',
  },
});

async function createAuthUser({ email, password, user_metadata = {}, app_metadata = {} } = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !password) {
    return { data: null, error: { message: 'Email and password are required' } };
  }

  const existing = await db.from('users').select('*').eq('email', normalizedEmail).maybeSingle();
  if (existing?.data?.id) {
    return { data: null, error: { message: 'User already registered' } };
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const role = app_metadata?.role || user_metadata?.role || 'USER';
  const fullName = user_metadata?.full_name || user_metadata?.fullName || normalizedEmail.split('@')[0];
  const phone = user_metadata?.phone || null;
  const { data, error } = await db
    .from('users')
    .insert([{ id: randomUUID(), email: normalizedEmail, password_hash: passwordHash, full_name: fullName, role, phone }])
    .select('*')
    .maybeSingle();

  if (error) return { data: null, error };
  return { data: { user: makeAuthPayload(data) }, error: null };
}

async function listAuthUsers({ page = 1, perPage = 100 } = {}) {
  const from = (Math.max(1, Number(page || 1)) - 1) * Math.max(1, Number(perPage || 100));
  const to = from + Math.max(1, Number(perPage || 100)) - 1;
  const { data, error } = await db.from('users').select('*').order('created_at', { ascending: false }).range(from, to);
  if (error) return { data: null, error };
  return { data: { users: (data || []).map(makeAuthPayload) }, error: null };
}

async function updateAuthUserById(userId, updates = {}) {
  const payload = {};
  if (updates.password) payload.password_hash = await bcrypt.hash(String(updates.password), 10);
  if (updates.email) payload.email = String(updates.email).trim().toLowerCase();
  const role = updates?.app_metadata?.role || updates?.user_metadata?.role;
  if (role) payload.role = role;
  const fullName = updates?.user_metadata?.full_name || updates?.user_metadata?.fullName;
  if (fullName) payload.full_name = fullName;
  if (!Object.keys(payload).length) {
    const current = await db.from('users').select('*').eq('id', userId).maybeSingle();
    return { data: { user: makeAuthPayload(current.data) }, error: current.error };
  }
  const { data, error } = await db.from('users').update(payload).eq('id', userId).select('*').maybeSingle();
  if (error) return { data: null, error };
  return { data: { user: makeAuthPayload(data) }, error: null };
}

async function getAuthUserById(userId) {
  const { data, error } = await db.from('users').select('*').eq('id', userId).maybeSingle();
  if (error) return { data: null, error };
  return { data: { user: data ? makeAuthPayload(data) : null }, error: null };
}

async function signInWithPassword({ email, password } = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const { data: user, error } = await db.from('users').select('*').eq('email', normalizedEmail).maybeSingle();
  if (error || !user?.password_hash) {
    return { data: null, error: { message: 'Invalid credentials' } };
  }
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) return { data: null, error: { message: 'Invalid credentials' } };
  return { data: { user: makeAuthPayload(user) }, error: null };
}

export const db = {
  from(table) {
    return new MysqlQueryBuilder(table);
  },

  async rpc(name, params = {}) {
    try {
      if (name === 'dir_ranked_products') return await executeDirRankedProducts(params);
      return { data: null, error: { message: `Unknown RPC: ${name}` } };
    } catch (error) {
      return { data: null, error: { message: error.message || String(error), code: error.code } };
    }
  },

  storage: localStorage,

  auth: {
    signInWithPassword,
    admin: {
      createUser: createAuthUser,
      listUsers: listAuthUsers,
      updateUserById: updateAuthUserById,
      getUserById: getAuthUserById,
    },
  },

  async runSerializedQuery(input = {}) {
    const builder = new MysqlQueryBuilder(input.table);
    builder.operation = input.operation || 'select';
    builder.payload = input.payload;
    builder.upsertOptions = input.upsertOptions || {};
    builder.applySerialized(input);
    return builder.execute();
  },

  clearSchemaCache() {
    columnCache.clear();
  },
};
