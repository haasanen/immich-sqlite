// SQLite equivalents of Kysely's postgres json helpers that work with
// selectAll() and nested helper calls. Postgres helpers build json_agg over
// the subquery row; Kysely's own sqlite helpers refuse selectAll. We compile
// the inner builder to SQL, inline its parameters as literals (self-contained
// fragment — immune to placeholder reordering), and build json_object from the
// column list; nested helper fragments (marked) are composed with json_set so
// they embed as parsed JSON, not strings.
// SQL-text helper shim: regex-dispatch over compiled SQL with intentional
// non-literal replacement values; stylistic rewrite rules do not apply.
/* eslint-disable unicorn/no-unsafe-string-replacement, no-useless-escape,
   unicorn/no-array-callback-reference, no-useless-assignment */
import { schemaFromCode } from '@immich/sql-tools';
import { DefaultQueryCompiler, type RawBuilder, sql } from 'kysely';
import 'src/schema/index.js';
import 'src/schema/tables/asset-av.table.js';
import 'src/schema/tables/workflow-log.table.js';

export const SQLJSON_MARK = '/*sqljson*/';

type AnyBuilder = { toOperationNode: () => unknown };

// compile standalone subquery ASTs without an executor (helpers receive
// builders wired to the Noop executor). Placeholders come out as $N; we
// inline them as literals below so fragments are self-contained.
const compiler = new (
  DefaultQueryCompiler as unknown as new () => {
    compileQuery: (node: unknown, queryId: string) => { sql: string; parameters?: readonly unknown[] };
  }
)();

const compileNode = (qb: AnyBuilder): { sql: string; parameters?: readonly unknown[] } =>
  compiler.compileQuery(qb.toOperationNode(), 'immich-sqlite-json');

const quoteLit = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return quoteLit(v.toISOString());
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return quoteLit(JSON.stringify(v));
  return `'${String(v).replaceAll("'", "''")}'`;
};

const inlineParams = (qb: AnyBuilder): string => {
  const { sql: text, parameters = [] } = compileNode(qb);
  return text.replaceAll(/\$(\d+)/g, (_, n) => quoteLit(parameters[Number(n) - 1]));
};

const unquote = (s: string) => s.replaceAll('""', '"').replaceAll(/^"|"$/g, '');

// split a select-list on commas at depth 0 (quotes/parens respected)
const splitTopLevel = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    switch (c) {
      case '"': {
        inStr = true;
        break;
      }
      case '(': {
        depth++;
        break;
      }
      case ')': {
        depth--;
        break;
      }
      default: {
        if (c === ',' && depth === 0) {
          out.push(s.slice(start, i));
          start = i + 1;
        }
      }
    }
  }
  out.push(s.slice(start));
  return out;
};

type ParsedSelect =
  | { kind: 'col'; col: string }
  | { kind: 'star'; table: string }
  | { kind: 'aliased'; expr: string; alias: string }
  | { kind: 'raw'; expr: string };

let tableColumns: Map<string, string[]> | null = null;
let tableColumnTypes: Map<string, Map<string, string>> | undefined;
const columnTypesOf = (table: string): Map<string, string> => {
  if (!tableColumnTypes) {
    tableColumnTypes = new Map();
    const schema = schemaFromCode() as unknown as {
      tables: { name: string; columns: { name: string; type?: unknown }[] }[];
    };
    for (const t of schema.tables) {
      const m = new Map<string, string>();
      for (const c of t.columns) {
        const ty = c.type;
        const name =
          typeof ty === 'string' ? ty : ty && typeof ty === 'object' && 'name' in ty ? String((ty as any).name) : '';
        m.set(c.name, name);
      }
      tableColumnTypes.set(t.name, m);
    }
  }
  return tableColumnTypes.get(table) ?? new Map();
};

const hasTopLevelOrder = (rest: string): boolean => {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /^order\s+by\b/i.test(rest.slice(i))) {
      return true;
    }
  }
  return false;
};

const hasTopLevelLimit = (sqlText: string): boolean => {
  let depth = 0;
  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /^limit\b/i.test(sqlText.slice(i)) && /\s/.test(sqlText[i - 1] ?? ' ')) return true;
  }
  return false;
};

export const columnsOf = (table: string): string[] => {
  if (!tableColumns) {
    tableColumns = new Map();
    const schema = schemaFromCode() as unknown as {
      tables: { name: string; columns: { name: string }[] }[];
    };
    for (const t of schema.tables) {
      tableColumns.set(
        t.name,
        t.columns.map((c) => c.name),
      );
    }
  }
  const cols = tableColumns.get(table);
  if (!cols) throw new Error(`sqlite json helper: unknown table for star expansion: ${table}`);
  return cols;
};

// Star over a CTE/derived-table alias: trace the WITH chain in the compiled
// statement to a real table (X as (select ... from "T")) and use that table's
// columns. immich's paginated CTEs (page/people) wrap a real table's columns.
const allFromTables = (stmt: string): string[] => {
  const out: string[] = [];
  const re = /(?:from|join)\s+"([a-z_]+)"(?:\s+as\s+"([a-z_]+)")?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt))) {
    // an aliased table reference shadows the real name: use the alias
    const t = (m[2] ?? m[1] ?? '').replaceAll('"', '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

const resolveStarColumns = (table: string, stmt: string, depth = 0): string[] => {
  try {
    return columnsOf(table);
  } catch {
    if (depth > 3) throw new Error(`sqlite json helper: cannot resolve columns for ${table}`);
    const m = stmt.match(new RegExp(`"${table}"\s+as\s*\(\s*select\s+([\s\S]*?)\bfrom\s+"([\w_]+)"`, 'i'));
    if (!m) throw new Error(`sqlite json helper: cannot resolve columns for ${table}`);
    const upstream = m[2];
    if (upstream === table) throw new Error(`sqlite json helper: circular CTE ${table}`);
    const baseCols = resolveStarColumns(upstream, stmt, depth + 1);
    // CTEs like people = select "person".*, "faces"."faceCount" ... add joined columns
    const extras: string[] = [];
    for (const item of splitTopLevel(m[1])) {
      const t = item.trim();
      if (/\*\s*$/.test(t)) continue;
      const q = t.match(/^("[\w_]+")\."([\w_]+)"(?:\s+as\s+"([^"]+)")?$/i);
      if (q) extras.push(q[3] ?? q[2]);
    }
    const res = [...new Set([...baseCols, ...extras])];
    if (process.env.SQLJSON_DEBUG)
      console.error(`STAR_TRACE ${table} -> base=${upstream} extras=${extras.join(',')} n=${res.length}`);
    return res;
  }
};

const parseItem = (rawItem: string): ParsedSelect => {
  const item = rawItem.trim();
  const m = item.match(/\bas\s+"([^"]+)"\s*$/i);
  if (m) {
    const alias = m[1];
    const expr = item.slice(0, m.index).trim();
    return { kind: 'aliased', expr, alias };
  }
  const bare = item.match(/^("[\w_]+"\.)?"([\w_]+)"$/);
  if (bare) return { kind: 'col', col: bare[1] ? `${bare[1].slice(1, -2)}.${bare[2]}` : bare[2] };
  const star = item.match(/^("[\w_]+")?\.?\*$/);
  if (star) return { kind: 'star', table: star[1] ? unquote(star[1]) : '' };
  return { kind: 'raw', expr: item };
};

const buildObjectExpr = (selectList: string, fromClause: string, stmt: string): string => {
  const items = splitTopLevel(selectList).map(parseItem);
  let table = fromClause.match(/\bfrom\s+("[\w_]+")(?:\s+as\s+("[\w_]+"))?/i);
  if (!table) {
    // `from (select 1) as "dummy"` (PG lateral-context relations, e.g.
    // withVideoStream): every select item is explicitly qualified against
    // tables from the enclosing query, which SQLite resolves via subquery
    // correlation. Accept the derived-table FROM and keep refs verbatim.
    table = /\bfrom\s+\(/i.test(fromClause) ? fromClause.match(/\bfrom\s+\([^)]*\)\s*(?:as\s+("[\w_]+"))?/i) : null;
    if (!table) {
      throw new Error(`sqlite json helper: cannot parse from clause: ${fromClause.slice(0, 80)}`);
    }
  }
  const tableRef = table[2] ?? table[1];
  const realTable = unquote(table[1]);
  // alias shadowing: `from "user" as "sharedBy"` removes the bare "user" name
  // from scope (unless it also appears unaliased elsewhere in the statement)
  if (table[2]) {
    const alias = unquote(table[2]);
    const bareRe = new RegExp(String.raw`(from|join)\s+"${realTable}"(?!\s+as\s+"${alias}")`, 'i');
    if (!bareRe.test(fromClause) && !bareRe.test(stmt.replace(fromClause, ''))) {
      selectList = selectList.replaceAll(`"${realTable}".`, `"${alias}".`);
    }
  }
  const aliasName = table[2] ? unquote(table[2]) : realTable;
  const expanded: ParsedSelect[] = [];
  for (const i of items) {
    if (i.kind === 'star') {
      const fromTables = [...new Set([...allFromTables(stmt), realTable, aliasName].filter(Boolean) as string[])];
      const candidates = i.table ? [i.table, ...fromTables] : [aliasName, ...fromTables];
      let cols: string[] | null = null;
      let resolvedTable: string | null = null;
      let lastErr: unknown = null;
      for (const cand of candidates) {
        try {
          cols = resolveStarColumns(cand, stmt);
          resolvedTable = cand;
          if (process.env.SQLJSON_DEBUG)
            console.error(`STAR_CANDIDATE ${cand} n=${cols.length} hasFaceCount=${cols.includes('faceCount')}`);
          break;
        } catch (error) {
          lastErr = error;
        }
      }
      if (!cols) throw lastErr;
      for (const c of cols)
        expanded.push({ kind: 'col', col: resolvedTable === tableRef ? c : `${resolvedTable}.${c}` });
    } else {
      expanded.push(i);
    }
  }
  const plain = expanded.filter((i) => i.kind === 'col' || i.kind === 'aliased');
  const composed: ParsedSelect[] = expanded.filter((i) => i.kind === 'raw');
  const aliasedNested: (ParsedSelect & { kind: 'aliased' })[] = [];

  let expr: string | null = null;
  if (plain.length > 0) {
    const args: string[] = [];
    for (const i of plain as (ParsedSelect & { kind: 'col' | 'aliased' })[]) {
      if (i.kind === 'col') {
        const dot = i.col.indexOf('.');
        if (dot > 0) {
          const t = i.col.slice(0, dot);
          const c = i.col.slice(dot + 1);
          args.push(sql_lit(c), boolAwareVal([t, realTable], t, c));
        } else {
          const bareCandidates = table[2] ? [tableRef, ...allFromTables(stmt)] : [realTable, ...allFromTables(stmt)];
          if (process.env.SQLJSON_DEBUG)
            console.error('BARE_CALL>>', JSON.stringify(bareCandidates), i.col, 'FROM>>', fromClause.slice(0, 60));
          args.push(sql_lit(i.col), bareAwareVal(bareCandidates, i.col));
        }
      } else {
        if (i.expr.includes(SQLJSON_MARK) || /select\s/i.test(i.expr)) {
          // an aliased subquery/nested helper: compose it with json_set below
          aliasedNested.push(i);
          continue;
        }
        args.push(sql_lit(i.alias), i.expr);
      }
    }
    if (args.length > 0) expr = `json_object(${args.join(', ')})`;
  }
  const allComposed = [
    ...composed,
    ...aliasedNested.map((i) => ({ kind: 'raw' as const, expr: `${i.expr} as "${i.alias}"` })),
  ];
  if (allComposed.length === 0) {
    if (!expr) throw new Error('sqlite json helper: no selectable columns');
    return expr;
  }
  if (!expr) expr = `json_object()`;
  for (const i of allComposed as (ParsedSelect & { kind: 'raw' })[]) {
    const alias = i.expr.match(/\bas\s+"([^"]+)"\s*$/i)?.[1];
    if (!alias) throw new Error(`sqlite json helper: uncomposable select item: ${i.expr.slice(0, 60)}`);
    let exprText = i.expr.replace(/\s+as\s+"[^"]+"\s*$/i, '').trim();
    exprText = exprText.replace(SQLJSON_MARK, '').trim();
    expr = `json_set(${expr}, '$.${alias}', (${exprText}))`;
  }
  return expr;
};

const sql_lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

const splitSql = (stmt: string): { selectList: string; rest: string } => {
  const m = stmt.match(/^select\s+/i);
  if (!m) throw new Error(`sqlite json helper: not a select: ${stmt.slice(0, 60)}`);
  const after = stmt.slice(m[0].length);
  // find the depth-0 FROM (nested selects in the select list contain their own)
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    switch (c) {
      case '"': {
        inStr = true;
        break;
      }
      case '(': {
        depth++;
        break;
      }
      case ')': {
        depth--;
        break;
      }
      default: {
        if (depth === 0 && /^from\b/i.test(after.slice(i))) {
          const prev = i > 0 ? after[i - 1] : ' ';
          if (/[\s)]/.test(prev)) return { selectList: after.slice(0, i), rest: after.slice(i) };
        }
      }
    }
  }
  throw new Error('sqlite json helper: no from clause');
};

export function sqliteJsonArrayFrom(qb: AnyBuilder) {
  // no native fast path: Kysely's own helper emits raw 0/1 for booleans,
  // breaking strict === false comparisons against Postgres JSON booleans.
  // the generic rewriter below bool-wraps columns via the schema.
  const stmt = inlineParams(qb);
  if (process.env.SQLJSON_DEBUG) console.error('STMT>>', stmt, '<<');
  const { selectList, rest } = splitSql(stmt);
  const obj = buildObjectExpr(selectList, rest, stmt);
  const nestedCount = splitTopLevel(selectList).length;
  if (hasTopLevelLimit(rest) || hasTopLevelOrder(rest)) {
    // apply limit/order to the row source, then aggregate: json_group_array
    // would otherwise aggregate in scan order and the outer clause is a no-op
    // on the single aggregate row. A star selectList ("asset".*) counts as one
    // item but expands to many columns inside obj, so it needs the wrap too.
    void nestedCount;
    return sql.raw(`${SQLJSON_MARK}(select json_group_array(jo) from (select ${obj} as jo ${rest}))`);
  }
  return sql.raw(`${SQLJSON_MARK}(select json_group_array(${obj}) ${rest})`);
}

export function sqliteJsonObjectFrom(qb: AnyBuilder) {
  {
    const stmt = inlineParams(qb);
    const { selectList, rest } = splitSql(stmt);
    const obj = buildObjectExpr(selectList, rest, stmt);
    // the builder may already carry .limit(1); adding a second one is a syntax error
    const tail = hasTopLevelLimit(rest) ? rest : `${rest} limit 1`;
    return sql.raw(`${SQLJSON_MARK}(select ${obj} ${tail})`);
  }
}

/** json_object over an aliased subquery row, with optional nested JSON columns. */
export function sqliteJsonObjectFromAlias(
  alias: string,
  baseTable: string,
  extra: Record<string, unknown> = {},
): RawBuilder<unknown> {
  let q: any = sql.raw('json_object(');
  let first = true;
  const types = columnTypesOf(baseTable);
  for (const c of columnsOf(baseTable)) {
    const t = types.get(c) ?? '';
    const valueExpr = /bytea|vector/.test(t)
      ? String.raw`('\x' || hex("${alias}"."${c}"))`
      : /bool/i.test(t)
        ? `(case when jbool("${alias}"."${c}") is null then null else json(case when jbool("${alias}"."${c}")=1 then 'true' else 'false' end) end)`
        : `jval("${alias}"."${c}")`;
    const frag = sql.raw(`'${c}', ${valueExpr}`);
    q = first ? sql`${q}${frag}` : sql`${q}, ${frag}`;
    first = false;
  }
  for (const [k, v] of Object.entries(extra)) {
    q = first
      ? sql`${q}${sql.raw(`'${k}', `)}${sql`json(${v as any})`}`
      : sql`${q}, ${sql.raw(`'${k}', `)}${sql`json(${v as any})`}`;
    first = false;
  }
  return sql`${q}${sql.raw(')')}`;
}

/** Build a SQLite JSON object for a whole table row (PostgreSQL composite value
 *  equivalent). Returns NULL when the guard column is NULL (left-join miss). */
const bareAwareVal = (candidates: string[], col: string): string => {
  for (const t of candidates) {
    try {
      const types = columnTypesOf(t);
      if (types.has(col)) {
        if (/bool/i.test(types.get(col) ?? '')) {
          return `(case when jbool("${t}"."${col}") is null then null else json(case when jbool("${t}"."${col}")=1 then 'true' else 'false' end) end)`;
        }
        return `jval("${t}"."${col}")`;
      }
    } catch {
      /* unknown table candidate; keep probing */
    }
  }
  return `jval("${col}")`;
};

const boolAwareVal = (typeCandidates: string[], outputQualifier: string, col: string): string => {
  // type lookup may probe any FROM/JOIN table, but the emitted qualifier must
  // stay whatever the SQL itself uses (aliases shadow their base table name)
  let isBool = false;
  for (const t of typeCandidates) {
    try {
      const types = columnTypesOf(t);
      if (types.has(col)) {
        isBool = /bool/i.test(types.get(col) ?? '');
        break;
      }
    } catch {
      /* unknown table candidate; keep probing */
    }
  }
  if (isBool) {
    return `(case when jbool(${outputQualifier}."${col}") is null then null else json(case when jbool(${outputQualifier}."${col}")=1 then 'true' else 'false' end) end)`;
  }
  return `jval(${outputQualifier}."${col}")`;
};

export function sqliteRowObjectSql(table: string, guardColumn: string, schemaTable?: string): string {
  const cols = columnsOf(schemaTable ?? table);
  const types = columnTypesOf(schemaTable ?? table);
  const parts: string[] = [];
  for (const c of cols) {
    const t = types.get(c) ?? '';
    const v = /bytea|vector/.test(t)
      ? String.raw`('\x' || hex("${table}"."${c}"))`
      : /bool/i.test(t)
        ? `(case when jbool("${table}"."${c}") is null then null else json(case when jbool("${table}"."${c}")=1 then 'true' else 'false' end) end)`
        : `jval("${table}"."${c}")`;
    parts.push(`'${c}', ${v}`);
  }
  return `case when "${table}"."${guardColumn}" is null then null else json_object(${parts.join(', ')}) end`;
}

export function sqliteRowObject(table: string, guardColumn: string): RawBuilder<unknown> {
  return sql.raw(sqliteRowObjectSql(table, guardColumn));
}
