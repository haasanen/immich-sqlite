// The SQL-text rewriter intentionally uses non-literal replacement values,
// dispatch chains, and escape-heavy regexes; the unicorn/no-useless-escape
// stylistic rules do not apply to this driver layer.
/* eslint-disable unicorn/no-unsafe-string-replacement, unicorn/prefer-switch,
   no-useless-escape, unicorn/prefer-else-if, unicorn/prefer-continue,
   unicorn/prefer-iterator-to-array, unicorn/consistent-function-scoping */
// SQLite driver layer for the Immich SQLite fork.
// Presents a better-sqlite3 handle to Kysely with driver-level value
// translation so repository code written against the Postgres driver keeps
// working: params (Date -> ISO text, boolean -> 0/1, array/object -> JSON)
// and row values (integer -> boolean, ISO text -> Date, JSON text -> array)
// are coerced to match what postgres.js returns. Fresh installs bootstrap
// from the generated schema.sqlite.sql (tools/gen-sqlite-schema.ts).
import { schemaFromCode } from '@immich/sql-tools';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, sql } from 'kysely';
import fs from 'node:fs';
import { SCHEMA_SQLITE } from 'src/schema/schema.sqlite.js';
import 'src/schema/index.js';
// Type-only imports elsewhere erase these modules; force decorator
// registration (asset_av tables + workflow_log). See gen-sqlite-schema.ts.
import 'src/schema/tables/asset-av.table.js';
import 'src/schema/tables/workflow-log.table.js';

export type SqliteConnectionParams = { connectionType: 'sqlite'; filename: string };

type Coercion = 'boolean' | 'date' | 'json-array' | 'none';

let coercionMap: Map<string, Coercion> | undefined;

const getCoercionMap = (): Map<string, Coercion> => {
  if (coercionMap) return coercionMap;
  coercionMap = new Map();
  const schema = schemaFromCode();
  for (const t of schema.tables) {
    for (const c of t.columns) {
      let co: Coercion | undefined;
      if (c.type === 'boolean') co = 'boolean';
      else if (['timestamp with time zone', 'timestamp', 'date'].includes(c.type)) co = 'date';
      else if (c.isArray) co = 'json-array';
      if (!co) continue;
      const existing = coercionMap.get(c.name);
      if (existing && existing !== co) {
        coercionMap.set(c.name, 'none'); // same name, conflicting types: leave raw
        continue;
      }
      coercionMap.set(c.name, co);
    }
  }
  return coercionMap;
};

// Emulates pg_trigger_depth() trigger WHEN guards. SQLite FK cascades are
// statement-internal, so nesting depth cannot be observed from scalar
// functions; instead the driver records which tables the *directly executed*
// statement writes, and audit_hop() answers how many FK-cascade hops away the
// trigger table is from that target (0 = direct statement on the table,
// 1 = one-level cascade, 99 = deeper/never).
let currentTargets: string[] = [];
const fkChildren = new Map<string, Set<string>>();

const setCurrentTargets = (sqlText: string, _handle?: BetterSqlite3.Database) => {
  if (!fkGraphBuilt) buildFkGraphFromDdl();
  const targets = new Set<string>();
  const re = /\b(?:delete\s+from|update|insert\s+into)\s+"([a-z_0-9]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText))) targets.add(m[1]);
  currentTargets = [...targets];
};

let fkGraphBuilt = false;
const buildFkGraphFromDdl = () => {
  // Parse the generated DDL directly: pragma introspection mid-bootstrap sees
  // a partially created schema and would freeze a partial graph.
  fkChildren.clear();
  const tableRe = /create table "([a-z_0-9]+)" \(([\s\S]*?)\n\);/g;
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(SCHEMA_SQLITE))) {
    const name = t[1];
    const fkRe = /references "([a-z_0-9]+)" \(/g;
    let f: RegExpExecArray | null;
    while ((f = fkRe.exec(t[2]))) {
      if (!fkChildren.has(f[1])) fkChildren.set(f[1], new Set());
      fkChildren.get(f[1])!.add(name);
    }
  }
  fkGraphBuilt = true;
};

// PG trigger semantics mapped onto SQLite:
//   - 0: direct target of the current statement.
//   - n>0: reached by n FK-cascade hops. PG FK actions never fire row
//     triggers, but immich's audit triggers for cascade children are written
//     to run at exactly those depths (guarded by WHEN), and their bodies are
//     self-guarded against missing parents. The FK-cycle guard (album_user ->
//     delete from album) keeps its original `= 0` guard so cascade passes stay
//     silent where PG would be silent.
export const auditHop = (triggerTable: string): number => {
  if (process.env.LOCK_TRACE) console.error(`AUDITHOP>> t=${triggerTable} targets=${JSON.stringify(currentTargets)}`);
  if (currentTargets.includes(triggerTable)) return 0;
  let frontier = [...currentTargets];
  const seen = new Set(frontier);
  for (let depth = 1; depth <= 5; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const child of fkChildren.get(f) ?? []) {
        if (child === triggerTable) return depth;
        if (seen.has(child)) {
          continue;
        }

        seen.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return 99;
};

const serializeParam = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return JSON.stringify(v);
  return v;
};

const coerceRow = <T>(row: T): T => {
  if (row === null || typeof row !== 'object') return row;
  const map = getCoercionMap();
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    const co = map.get(key);
    if (!co || co === 'none' || value === null) continue;
    switch (co) {
      case 'boolean': {
        if (typeof value === 'number') out[key] = value === 1;
        break;
      }
      case 'date': {
        if (typeof value === 'string') {
          const iso = value.includes('T') ? value : value.replace(' ', 'T');
          const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
          if (!Number.isNaN(d.getTime())) out[key] = d;
        }
        break;
      }
      case 'json-array': {
        if (typeof value === 'string') {
          try {
            out[key] = JSON.parse(value);
          } catch {
            /* leave as text */
          }
        }
        break;
      }
    }
  }
  return out as T;
};

export const uuidv7At = (msEpoch: unknown): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let msNum: number;
  if (typeof msEpoch === 'number' && Number.isFinite(msEpoch)) msNum = msEpoch;
  else if (msEpoch instanceof Date) msNum = msEpoch.getTime();
  else if (typeof msEpoch === 'string') {
    const parsed = Date.parse(msEpoch);
    msNum = Number.isNaN(parsed) ? Date.now() : parsed;
  } else msNum = Date.now();
  const ms = BigInt(Math.round(msNum));
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const uuidv7 = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** better-sqlite3-compatible handle with Immich value translation. */
export type ImmichSqliteHandle = {
  prepare: (sqlText: string) => {
    reader: boolean;
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => BetterSqlite3.RunResult;
    pluck: (...args: unknown[]) => unknown[];
    iterate: (...args: unknown[]) => Generator<unknown>;
  };
  raw: BetterSqlite3.Database;
  close: () => void;
};

// Kysely's sqlite driver binds parameters as a single array argument
// (stmt.run([a, b])). Serialize each element in place, keeping the array
// binding form, so no extra parameters are introduced. Direct spread calls
// (stmt.run(a, b)) are serialized per-argument.
const preparedArgs = (args: unknown[]) => {
  if (args.length === 1 && Array.isArray(args[0])) {
    return [args[0].map((a) => serializeParam(a)) as never[]] as never[];
  }
  return args.map((a) => serializeParam(a)) as never[];
};

// Structural subset of better-sqlite3's Database exposed for diagnostics;
// a nominal import here breaks declaration emit (TS4023 on export = types).
export interface SqliteRawHandle {
  prepare(sqlText: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown; raw?: unknown };
  exec(sqlText: string): void;
  pragma(name: string): unknown;
}
export const sqliteRawHandles = new Map<string, SqliteRawHandle>();

export const createSqliteHandle = (filename: string): ImmichSqliteHandle => {
  const raw = new BetterSqlite3(filename);
  sqliteRawHandles.set(filename, raw);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 15000');
  raw.function('uuidv7', () => uuidv7());
  raw.function('audit_hop', (t: string) => auditHop(t));
  raw.function('now', () => monotonicIso());
  raw.function('now_iso', () => monotonicIso());
  raw.function('clock_timestamp', () => monotonicIso());
  // PG's unaccent() strips diacritical marks. In this codebase every f_unaccent call
  // site wraps BOTH sides of an ILIKE or pg_trgm comparison (audited), and the rewritten
  // `like` is only ASCII-case-insensitive where PG's ILIKE is Unicode-aware — so this
  // fork's f_unaccent == unaccent + casefold.
  raw.function('f_unaccent', (v: unknown) => (v === null || v === undefined ? v : unaccentFold(String(v))));
  raw.function('geo_distance_m', (lat1: unknown, lon1: unknown, lat2: unknown, lon2: unknown) =>
    geoDistanceMeters(Number(lat1), Number(lon1), Number(lat2), Number(lon2)),
  );
  raw.function('make_date', (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10),
  );
  raw.function('trgm_similarity', (a: unknown, b: unknown) => trgmSimilarity(String(a ?? ''), String(b ?? '')));
  raw.function('pg_array_json', (v: unknown) => normalizeArrayLike(v));
  raw.function('jbool', (v: unknown) => (v === null || v === undefined ? null : v === 0 || v === '0' ? 0 : 1));
  const intervalMs = (v: number, unit: string): number | null => {
    const map: Record<string, number> = {
      millisecond: 1,
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
    };
    const key = unit.replace(/s$/, '').toLowerCase();
    return map[key] === undefined ? null : v * map[key]!;
  };
  const applyInterval = (dt: unknown, iv: unknown, sign: number): string | null => {
    if (dt === null || dt === undefined || iv === null || iv === undefined) {
      return null;
    }
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)s?\s*$/i.exec(String(iv));
    if (!m) {
      return null;
    }
    const value = Number(m[1]) * sign;
    const unit = m[2]!;
    const base = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(dt)) ? String(dt) + 'T00:00:00Z' : String(dt));
    if (Number.isNaN(base.getTime())) {
      return null;
    }
    const fixed = intervalMs(value, unit);
    if (fixed !== null) {
      return new Date(base.getTime() + fixed).toISOString();
    }
    const d = new Date(base);
    if (/month/i.test(unit)) {
      d.setUTCMonth(d.getUTCMonth() + value);
    } else if (/year/i.test(unit)) {
      d.setUTCFullYear(d.getUTCFullYear() + value);
    } else {
      return null;
    }
    return d.toISOString();
  };
  raw.function('add_interval', (dt: unknown, iv: unknown) => applyInterval(dt, iv, 1));
  raw.function('sub_interval', (dt: unknown, iv: unknown) => applyInterval(dt, iv, -1));
  raw.function('regexp_ci', (pattern: unknown, value: unknown) => {
    if (pattern === null || pattern === undefined || value === null || value === undefined) {
      return null;
    }
    try {
      return new RegExp(String(pattern), 'i').test(String(value)) ? 1 : 0;
    } catch {
      return 0;
    }
  });
  raw.function('regexp_replace', (s: unknown, pattern: unknown, replacement: unknown) =>
    s === null || s === undefined ? null : String(s).replace(new RegExp(String(pattern)), String(replacement)),
  );
  raw.function('jval', (v: unknown) => {
    if (Buffer.isBuffer(v)) return v.toString('base64');
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') {
      // mimic PostgreSQL json timestamp serialization (offset form, no zero fraction)
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z$/.exec(v);
      if (m) {
        const frac = m[3] && !/^0+$/.test(m[3]) ? `.${m[3]}` : '';
        return `${m[1]}${frac}+00:00`;
      }
      const naive = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?$/.exec(v);
      if (naive) {
        const frac = naive[3] && !/^0+$/.test(naive[3]) ? `.${naive[3]}` : '';
        return `${naive[1]}${frac}+00:00`;
      }
      const off = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:?\d{2})$/.exec(v);
      if (off) {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) {
          let iso = d.toISOString();
          if (iso.endsWith('.000Z')) iso = iso.slice(0, -4);
          else iso = iso.replace(/0+Z$/, 'Z').replace(/\.$/, '');
          return `${iso.slice(0, -1)}+00:00`;
        }
      }
    }
    return v;
  });
  raw.function('json_array', { varargs: true }, (...args: unknown[]) => JSON.stringify(args));
  raw.function('word_similarity', (a: unknown, b: unknown) => wordSimilarity(String(a ?? ''), String(b ?? '')));
  raw.function('vec_cosine_distance', (a: unknown, b: unknown) => vecCosineDistance(String(a ?? ''), String(b ?? '')));
  // immich_uuid_v7(ts): uuidv7 pinned to the given ISO timestamp (checkpoint ordering)
  raw.function('immich_uuid_v7', { varargs: true }, (...args: unknown[]) =>
    args.length === 0 ? uuidv7() : uuidv7At(new Date(String(args[0])).getTime()),
  );
  // Advisory locks: single-process, single-writer topology -> lock acquisition
  // is trivially immediate and always succeeds; keep SQL surface intact.
  raw.function('base64', (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return v.toString('base64');
    if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
    return Buffer.from(String(v), 'utf8').toString('base64');
  });
  raw.function('pg_try_advisory_lock', { varargs: true }, () => 1);
  raw.function('pg_advisory_lock', { varargs: true }, () => 1);
  raw.function('pg_advisory_unlock', { varargs: true }, () => 1);

  if (process.env.IMMICH_SQLITE_VEC_EXTENSION_PATH) {
    raw.loadExtension(process.env.IMMICH_SQLITE_VEC_EXTENSION_PATH);
  }

  let txDepth = 0;
  let spSeq = 0;

  return {
    close: () => raw.close(),
    prepare: (sqlText: string) => {
      let rewritten = rewritePgSql(sqlText);
      // better-sqlite3 is a single synchronous handle: emulate nested Kysely
      // transactions with SAVEPOINTs so `begin` inside a tx doesn't throw.
      const head = rewritten.trim().toLowerCase();
      switch (head) {
        case 'begin': {
          rewritten = txDepth > 0 ? `savepoint sp${++spSeq}` : rewritten;
          txDepth++;

          break;
        }
        case 'commit': {
          if (txDepth > 1) {
            rewritten = `release sp${spSeq--}`;
          }
          if (txDepth > 0) txDepth--;

          break;
        }
        case 'rollback': {
          // diagnostics (h8): any ROLLBACK discards every plain statement that
          // joined this BEGIN from other flows (single shared handle) — capture
          // the culprit stack before it does.
          console.warn(
            `[sqltrace] ROLLBACK depth=${txDepth} at=${(new Error('sqltrace').stack ?? '').split('\n').slice(2, 9).join(' | ')}`,
          );
          if (txDepth > 1) {
            rewritten = `rollback to sp${spSeq--}`;
          }
          if (txDepth > 0) txDepth--;

          break;
        }
        // No default
      }
      if (process.env.IMMICH_SQL_TRACE) console.error('SQL>>', rewritten.replaceAll(/\s+/g, ' '));
      let stmt;
      try {
        stmt = raw.prepare(rewritten);
      } catch (error) {
        if (process.env.IMMICH_SQL_FAILURE_LOG) {
          fs.appendFileSync(
            process.env.IMMICH_SQL_FAILURE_LOG,
            JSON.stringify({ prepare: true, sql: rewritten, message: (error as Error).message }) + '\n',
          );
        }
        if (process.env.IMMICH_SQLITE_DEBUG)
          console.error('PREPARE_RAW>>', sqlText, '@@@PREPARE_FAIL>>', rewritten, '<<', (error as Error).message);
        throw error;
      }
      return {
        // Kysely's sqlite driver branches on `stmt.reader` to pick all() vs
        // run(); without this passthrough every query silently returns [].
        reader: stmt.reader,
        all: (...args: unknown[]) => {
          setCurrentTargets(rewritten, raw);
          const a = preparedArgs(args);
          if (process.env.IMMICH_SQL_TRACE) console.error('ARGS>>', JSON.stringify(a).slice(0, 400));
          try {
            return (stmt.all(...a) as unknown[]).map((r) => coerceRow(r));
          } catch (error) {
            if (process.env.IMMICH_SQL_FAILURE_LOG) {
              fs.appendFileSync(
                process.env.IMMICH_SQL_FAILURE_LOG,
                JSON.stringify({ sql: rewritten, args: a, message: (error as Error).message }) + '\n',
              );
            }
            if (process.env.IMMICH_SQLITE_DEBUG)
              console.error(
                'EXEC_FAIL>>',
                rewritten,
                '>>ARGS>>',
                JSON.stringify(a).slice(0, 400),
                '<<',
                (error as Error).message,
              );
            throw error;
          }
        },
        get: (...args: unknown[]) => {
          setCurrentTargets(rewritten, raw);
          return coerceRow(stmt.get(...preparedArgs(args)));
        },
        run: (...args: unknown[]) => {
          setCurrentTargets(rewritten, raw);
          return stmt.run(...preparedArgs(args));
        },
        pluck: (...args: unknown[]) => {
          setCurrentTargets(rewritten, raw);
          return (stmt.pluck().all(...preparedArgs(args)) as unknown[]).map((r) => coerceRow(r));
        },
        iterate: (...args: unknown[]) => {
          setCurrentTargets(rewritten, raw);
          // better-sqlite3 forbids any other statement on this handle while an
          // iterate() cursor is open ("database connection is busy"), and
          // Immich services routinely run DML while a streamQuery is being
          // consumed. The handle is synchronous and in-process anyway, so
          // materialize the cursor instead of holding it open.
          const rows = stmt.all(...preparedArgs(args)) as unknown[];
          return (function* gen() {
            for (const r of rows) yield coerceRow(r);
          })();
        },
      };
    },
    raw,
  };
};

export const SCHEMA_VERSION = 6;

// Translate residual Postgres SQL idioms that survive into query text (casts
// and interval arithmetic in raw sql fragments) into SQLite equivalents.
// Scoped to the constructs enumerated below; everything else must be
// fixed at the call site, not papered over here.
const PG_CASTS =
  /::\s*(uuid\b|text\b|integer\b|bigint\b|numeric\b|real\b|float\b|double precision\b|boolean\b|jsonb\b|json\b|date\b|timestamp with time zone\b|timestamp\b|interval\b|int\b|varchar(\(\d+\))?\b)(\s*\[\s*\])*/g;
const PG_INTERVAL = /now\(\)\s*([-+])\s*interval\s*'(\d+)\s*(millisecond|second|minute|hour|day|week|month|year)s?'/gi;

// pg_trgm-compatible similarity: Jaccard over padded trigram sets
// pg_trgm `unaccent`: decompose and drop combining marks, plus curated mappings for
// non-decomposing letters found in place/person names (subset of PG's unaccent dict).
const EXTRA_FOLD: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ø: 'o',
  Ø: 'O',
  đ: 'd',
  Đ: 'D',
  ł: 'l',
  Ł: 'L',
  ħ: 'h',
  Ħ: 'H',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'TH',
  ı: 'i',
  İ: 'i',
};
export const unaccent = (s: string): string => {
  let out = '';
  for (const ch of s) {
    out += EXTRA_FOLD[ch] ?? ch;
  }
  return out.normalize('NFD').replaceAll(/\p{M}/gu, '');
};
export const unaccentFold = (s: string): string => unaccent(s).toLowerCase();

// great-circle distance in meters (haversine); replaces earthdistance's earth_distance
export const geoDistanceMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const trigrams = (s: string): Set<string> => {
  const set = new Set<string>();
  for (const word of unaccentFold(s).split(/[^a-z0-9]+/)) {
    const w = `  ${word} `;
    for (let i = 0; i + 3 <= w.length; i++) set.add(w.slice(i, i + 3));
  }
  return set;
};
// pg_trgm word_similarity(a, b): max fraction of a's trigrams explained by
// a contiguous trigram run inside a word of b.
const trigramSeq = (s: string): string[] => {
  const seq: string[] = [];
  for (const word of unaccentFold(s).split(/[^a-z0-9]+/)) {
    const w = `  ${word} `;
    for (let i = 0; i + 3 <= w.length; i++) seq.push(w.slice(i, i + 3));
  }
  return seq;
};
const wordSimNeedleCache = new Map<string, Set<string>>();
// pg_trgm word_similarity(a, b): the count of a's trigrams explained by the most
// similar single word of b, over |a|. Linear per word: this is pg_trgm's actual
// definition, not substring-run enumeration.
const wordSimilarity = (a: string, b: string): number => {
  // first argument is the search needle: identical for every row of a query, so
  // cache its trigram set (bounded LRU-ish) instead of rebuilding it per row.
  let A = wordSimNeedleCache.get(a);
  if (!A) {
    A = new Set(trigramSeq(a));
    if (wordSimNeedleCache.size > 64) wordSimNeedleCache.clear();
    wordSimNeedleCache.set(a, A);
  }
  if (A.size === 0) return 0;
  let best = 0;
  for (const word of b.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) {
      continue;
    }
    const w = `  ${word} `;
    let inter = 0;
    let seen: Set<string> | undefined;
    for (let i = 0; i + 3 <= w.length; i++) {
      const t = w.slice(i, i + 3);
      if (A.has(t) && !(seen?.has(t) ?? false)) {
        seen ??= new Set();
        seen.add(t);
        inter++;
      }
    }
    if (inter > best) {
      best = inter;
      if (best === A.size) {
        return 1;
      }
    }
  }
  return best / A.size;
};
const trgmSimilarity = (a: string, b: string): number => {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

// Normalize a SQL array parameter (JS array, JSON array text, or Postgres
// text-array literal like {a,b}) into a JSON array string for json_each.
const splitPgArrayBody = (body: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let esc = false;
  let cur = '';
  for (const ch of body) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      cur += ch;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '{') depth++;
    else if (!inQuote && ch === '}') depth--;
    if (!inQuote && ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0 || parts.length > 0) parts.push(cur);
  return parts.map((p) => {
    const t = p.trim();
    if (t === '' || t.toUpperCase() === 'NULL') return null;
    if (t.startsWith('"') && t.endsWith('"')) {
      try {
        return JSON.parse(t);
      } catch {
        return t.slice(1, -1);
      }
    }
    return t;
  });
};
const normalizeArrayLike = (v: unknown): string => {
  if (v === null || v === undefined) return '[]';
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => (x instanceof Date ? x.toISOString() : x)));
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) return t;
    if (t.startsWith('{') && t.endsWith('}')) return JSON.stringify(splitPgArrayBody(t.slice(1, -1)));
    return JSON.stringify([t]);
  }
  return JSON.stringify([v]);
};

// pgvector cosine distance (<=>) over textual "[f1,f2,...]" vectors
const parseVector = (s: string): number[] | null => {
  const t = s.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr.map(Number) : null;
  } catch {
    return null;
  }
};
const vecCosineDistance = (a: string, b: string): number => {
  const va = parseVector(a);
  const vb = parseVector(b);
  if (!va || !vb || va.length !== vb.length) return Number.MAX_SAFE_INTEGER;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// Replace `L <=> R` with vec_cosine_distance(L, R); operands are identifiers,
// function calls, parameters, or balanced-paren subqueries.
const operandLeft = (text: string, end: number): string | null => {
  let i = end;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  if (i > 0 && text[i - 1] === ')') {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (text[j] === ')') depth++;
      else if (text[j] === '(') {
        depth--;
        if (depth === 0) {
          i = j;
          while (i > 0 && /[\w]/.test(text[i - 1])) i--;
          return text.slice(i, end).trim() || null;
        }
      }
    }
    return null;
  }
  let j = i;
  while (j > 0 && /[\w".?]/.test(text[j - 1])) j--;
  return text.slice(j, i) || null;
};
const operandRight = (text: string, start: number): { text: string; end: number } | null => {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '(') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) return { text: text.slice(i, j + 1), end: j + 1 };
      }
    }
    return null;
  }
  let j = i;
  while (j < text.length && /[\w".?]/.test(text[j])) j++;
  let res = text.slice(i, j);
  let end = j;
  if (j < text.length && text[j] === '(') {
    const inner = operandRight(text, j);
    if (inner) {
      res += inner.text;
      end = inner.end;
    }
  }
  return res ? { text: res, end } : null;
};
const replaceCosineOperator = (text: string): string => {
  let guard = 0;
  while (guard++ < 100) {
    const idx = text.indexOf('<=>');
    if (idx === -1) break;
    const left = operandLeft(text, idx);
    const right = operandRight(text, idx + 3);
    if (!left || !right) break;
    const lIdx = text.lastIndexOf(left, idx);
    text = text.slice(0, lIdx) + `vec_cosine_distance(${left}, ${right.text})` + text.slice(right.end);
  }
  return text;
};

const replaceDateCasts = (text: string): string => {
  let outText = text;
  for (;;) {
    const m = /::\s*date\b(?!\s*\[)/i.exec(outText);
    if (!m) break;
    const left = operandLeft(outText, m.index);
    if (!left) {
      outText = outText.slice(0, m.index) + outText.slice(m.index + m[0].length);
      continue;
    }
    const lIdx = outText.lastIndexOf(left, m.index);
    outText = outText.slice(0, lIdx) + `substr(${left}, 1, 10)` + outText.slice(m.index + m[0].length);
  }
  return outText;
};

// date_part('unit', x) -> strftime equivalent; operand scanned with balanced
// parens so nested expressions like (a || b) survive intact.
const DATE_PART_MAP: Record<string, string> = {
  year: '%Y',
  month: '%m',
  day: '%d',
  hour: '%H',
  minute: '%M',
  second: '%S',
  epoch: '%s',
  dow: '%w',
};
const replaceIntervalArithmetic = (text: string): string => {
  // `expr ± expr::interval` -> add_interval/sub_interval(expr, expr)
  const intervalRe = /(::interval\b)/y;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if ((c === '+' || c === '-') && /\s/.test(text[i - 1] ?? ' ')) {
      // right side: simple operand then ::interval
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k]!)) {
        k++;
      }
      const ro = /(\?|'[^']*'|json_array\([^)]*\)|"[^"]+"(?:\."[^"]+")?)/y;
      const rm = ro.exec(text.slice(k));
      if (rm) {
        const after = k + rm[0].length;
        intervalRe.lastIndex = 0;
        const cast = text.slice(after).match(/^\s*::interval\b/);
        if (cast) {
          const left = operandLeft(out, out.length);
          if (left) {
            const trimmed = out.trimEnd();
            out = trimmed.slice(0, trimmed.length - left.length);
            out += `${c === '+' ? 'add_interval' : 'sub_interval'}(${left}, ${rm[0]})`;
            i = after + cast[0].length;
            continue;
          }
        }
      }
    }
    out += c;
    i++;
  }
  return out;
};

const replaceIlikeOperator = (text: string): string => {
  // PostgreSQL `a ILIKE b` -> SQLite `a LIKE b` (LIKE is already case-insensitive
  // for ASCII). Quote-aware so patterns containing the word "ilike" survive.
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j++;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((c === 'i' || c === 'I') && /^ilike\b/i.test(text.slice(i)) && !/[\w"]/.test(text[i - 1] ?? ' ')) {
      out += 'like';
      i += 5;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const replaceRegexMatchOperator = (text: string): string => {
  // PostgreSQL `expr ~* pattern` -> regexp_ci(pattern, expr)
  const operand = /(?:"[^"]+"(?:\."[^"]+")?|\?|'[^']*')/y;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'" || text[i] === '"') {
      const q = text[i]!;
      let j = i + 1;
      while (j < text.length && text[j] !== q) j++;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = text[i - 1] ?? ' ';
    const next = text[i + 1] ?? ' ';
    if (text[i] === '~' && /\s/.test(prev) && (next === '*' || /\s/.test(next)) && out.trim()) {
      const ci = next === '*';
      const trimmed = out.trimEnd();
      const g = new RegExp(operand.source, 'g');
      const ms = [...trimmed.matchAll(g)];
      const lm = ms.at(-1);
      if (lm && lm[0] && trimmed.endsWith(lm[0])) {
        const left = lm[0];
        let k = i + (ci ? 2 : 1);
        while (k < text.length && /\s/.test(text[k]!)) k++;
        operand.lastIndex = 0;
        const rm = operand.exec(text.slice(k));
        if (rm && rm[0]) {
          out = trimmed.slice(0, trimmed.length - left.length);
          out += 'regexp_ci(' + rm[0] + ', ' + left + ')';
          i = k + rm[0].length;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return out;
};

const replaceLikeAnyArray = (text: string): string => {
  let outText = text;
  for (;;) {
    const m = /any\(\s*array\[([\s\S]*?)\](?:\s*::\s*[\w\s]+(?:\(\d+\))?\s*\[\s*\])?\s*\)/i.exec(outText);
    if (!m) break;
    const likeMatch = /like\s+$/i.exec(outText.slice(0, m.index));
    if (!likeMatch) break;
    const pre = outText.slice(0, m.index - likeMatch[0].length).trimEnd();
    const left = operandLeft(pre, pre.length);
    if (!left || !pre.endsWith(left)) break;
    const list = m[1];
    const replacement = `(select count(*) from json_each(json_array(${list})) as je where ${left} like je.value) > 0`;
    const startIdx = pre.length - left.length;
    outText = outText.slice(0, startIdx) + replacement + outText.slice(m.index + m[0].length);
  }
  return outText;
};

const splitTopLevelCommas = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const q = c;
      cur += c;
      i++;
      while (i < text.length && text[i] !== q) {
        cur += text[i];
        i++;
      }
      cur += text[i] ?? '';
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
};

const replaceInsertSelectOnConflict = (text: string): string =>
  text.replaceAll(/\binsert into ("?\w+"?)\s+select([\s\S]*?)\bon conflict do nothing\b/gi, (_m, t, rest) => {
    // Infer the column list from top-level select items: alias if present, else bare column name.
    const fromIdx = (() => {
      let depth = 0;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i]!;
        if (c === "'" || c === '"') {
          const q = c;
          i++;
          while (i < rest.length && rest[i] !== q) i++;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (depth === 0 && /\bfrom\b/i.test(rest.slice(i, i + 5)) && (i === 0 || /\s/.test(rest[i - 1] ?? ' '))) {
          const after = rest[i + 4] ?? ' ';
          if (/\s/.test(after)) return i;
        }
      }
      return -1;
    })();
    const selectPart = fromIdx >= 0 ? rest.slice(0, fromIdx) : rest;
    const cols = splitTopLevelCommas(selectPart)
      .map((item) => {
        const alias = /\bas\s+"?([\w"]+)"?\s*$/i.exec(item.trim());
        if (alias) return `"${alias[1]!.replaceAll('"', '')}"`;
        const qual = /"([\w]+)"\s*$/.exec(item.trim());
        return qual ? `"${qual[1]}"` : null;
      })
      .filter((x): x is string => !!x)
      .join(', ');
    const hasWhere = /\bwhere\b/i.test(rest);
    const tail = hasWhere ? rest.replaceAll(/\bon conflict do nothing\b/gi, '') : rest;
    const extra = hasWhere ? tail : `${tail} where true`;
    return `insert or ignore into ${t}${cols ? ` (${cols})` : ''} select${extra}`;
  });

const replaceDummyUnnest = (text: string): string => {
  // select unnest(a) as "c1", unnest(b) as "c2" from (select 1) as "dummy"
  // -> positionally paired json_each join (Postgres pairs zipped unnests)
  const re = /((?:json_each\(pg_array_json\([\s\S]*?\)\) as "\w+",?\s)+)from \(select 1\) as "dummy"/g;
  return text.replaceAll(re, (whole, items) => {
    const pairs = [...items.matchAll(/json_each\(pg_array_json\(([\s\S]*?)\)\) as "(\w+)"/g)].map((m) => ({
      ref: m[1],
      col: m[2],
    }));
    if (pairs.length === 0) return whole;
    const selects = pairs.map((p_, i_) => `je${i_}.value as "${p_.col}"`).join(', ');
    const froms = pairs.map((p_, i_) => `json_each(pg_array_json(${p_.ref})) as je${i_}`);
    let joins = froms[0];
    for (let k = 1; k < froms.length; k++) joins += ` join ${froms[k]} on je0.key = je${k}.key`;
    return `${selects} from ${joins} `;
  });
};

const replaceZipUnnest = (text: string): string => {
  // (select unnest(A) as "c1", unnest(B) as "c2") -> paired json_each join
  const re =
    /\(\s*select\s+unnest\(([\s\S]*?)\)\s*(?:::[\w\[\]]+)?\s+as "(\w+)",\s*unnest\(([\s\S]*?)\)\s*(?:::[\w\[\]]+)?\s+as "(\w+)"\s*\)/g;
  return text.replaceAll(
    re,
    (_m, a, c1, b, c2) =>
      `(select je0.value as "${c1}", je1.value as "${c2}" from json_each(pg_array_json(${a})) as je0 join json_each(pg_array_json(${b})) as je1 on je0.key = je1.key)`,
  );
};

const replaceMaintenance = (text: string): string => {
  if (/^\s*REINDEX\b/i.test(text)) return 'select 1';
  if (/^\s*VACUUM\b/i.test(text)) return /analyze/i.test(text) ? 'ANALYZE' : 'VACUUM';
  if (/^\s*ANALYZE\b/i.test(text)) return 'ANALYZE';
  return text.replaceAll(
    /\bdelete from ("?\w+"?) using ("?\w+"?) where /gi,
    (_m, t, u) => `delete from ${t} where exists (select 1 from ${u} where `,
  );
};

export const replaceUnnest = (text: string): string => {
  let outText = '';
  let i = 0;
  const lower = text.toLowerCase();
  const aliasRefs: string[] = [];
  while (i < text.length) {
    const idx = lower.indexOf('unnest(', i);
    if (idx === -1) {
      outText += text.slice(i);
      break;
    }
    outText += text.slice(i, idx);
    let depth = 1;
    let k = idx + 7;
    let inStr = false;
    for (; k < text.length; k++) {
      const c = text[k];
      if (inStr) {
        if (c === "'") inStr = false;
        continue;
      }
      if (c === "'") inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const inner = text.slice(idx + 7, k).trim();
    outText += `json_each(pg_array_json(${inner}))`;
    i = k + 1;
    const aliasMatch = /^\s+as\s+"([^"]+)"/.exec(text.slice(i));
    if (aliasMatch) {
      aliasRefs.push(aliasMatch[1]);
    }
  }
  for (const a of aliasRefs) {
    // Bare references to the alias must read the element value column; a
    // bare "x" against json_each yields the JSON path constant instead.
    const bare = new RegExp(String.raw`(?<![.\w"])"` + a + String.raw`"(?![.\w])`, 'g');
    const asDef = new RegExp(String.raw`\bas\s+"` + a + String.raw`"(?![.\w])`, 'g');
    outText = outText.replace(asDef, '__AS_' + a + '__');
    // In select position the output column must keep the plain alias name;
    // emit the value read plus a protected alias so the bare pass skips it.
    const selItem = new RegExp(String.raw`(select\s+|,\s*)"` + a + String.raw`"(\s+from\b)`, 'g');
    outText = outText.replace(selItem, '$1"' + a + '"."value" __AS_' + a + '__$2');
    outText = outText.replace(bare, '"' + a + '"."value"');
    outText = outText.replace(new RegExp('__AS_' + a + '__', 'g'), 'as "' + a + '"');
  }
  return outText;
};

// `select "x" from unnest(...) as "x"` becomes `... json_each(...) as "x"`.
// In SQLite a bare "x" against json_each resolves to the JSON path constant,
// not the element value; every bare reference to the alias must become
// "x"."value" (the alias definition itself is left alone).

const replaceDateParts = (text: string): string => {
  let outText = '';
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const idx = lower.indexOf('date_part(', i);
    if (idx === -1) {
      outText += text.slice(i);
      break;
    }
    outText += text.slice(i, idx);
    const quoteMatch = /^\s*'([a-z]+)'\s*,/i.exec(text.slice(idx + 10));
    if (!quoteMatch) {
      outText += text.slice(idx, idx + 10);
      i = idx + 10;
      continue;
    }
    const unit = quoteMatch[1].toLowerCase();
    const j = idx + 10 + quoteMatch[0].length;
    let depth = 1;
    let k = j;
    let inStr = false;
    for (; k < text.length; k++) {
      const c = text[k];
      if (inStr) {
        if (c === "'") inStr = false;
        continue;
      }
      if (c === "'") inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const expr = text.slice(j, k).trim();
    const f = DATE_PART_MAP[unit];
    let repl: string;
    if (f) repl = `cast(strftime('${f}', ${expr}) as REAL)`;
    else
      switch (unit) {
        case 'isodow': {
          repl = `((cast(strftime('%w', ${expr}) as INTEGER) + 6) % 7) + 1`;
          break;
        }
        case 'quarter': {
          repl = `((cast(strftime('%m', ${expr}) as INTEGER) + 2) / 3)`;
          break;
        }
        case 'week': {
          repl = `cast(strftime('%W', ${expr}) as REAL) + 1`;
          break;
        }
        case 'decade': {
          repl = `cast(strftime('%Y', ${expr}) as INTEGER) / 10`;
          break;
        }
        case 'century': {
          repl = `(cast(strftime('%Y', ${expr}) as INTEGER) + 99) / 100`;
          break;
        }
        case 'millennium': {
          repl = `(cast(strftime('%Y', ${expr}) as INTEGER) + 999) / 1000`;
          break;
        }
        default: {
          repl = text.slice(idx, k + 1);
        }
      }
    outText += repl;
    i = k + 1;
  }
  return outText;
};

export const rewritePgSql = (sqlText: string): string => {
  sqlText = injectUpdateDate(sqlText);
  // PostgreSQL session/local tuning knobs (vchordrq.probes etc.) have no
  // SQLite analogue; turn the SET into a harmless select keeping arg count.
  if (/^\s*set\s+(local|session)\s/i.test(sqlText)) {
    const m = sqlText.match(/=\s*(\?|'[^']*'|[\w.]+)\s*$/i);
    return m ? `select ${m[1]}` : 'select 1';
  }
  // ::date truncates ISO text to the date part; keep that semantic instead of
  // letting the generic cast stripper turn an equality into a no-match.
  let out = replaceDateCasts(sqlText);
  out = replaceIntervalArithmetic(out);
  out = out.replaceAll(PG_CASTS, '');
  // PostgreSQL allows EXISTS (SELECT FROM t); SQLite needs a projection
  if (process.env.REW_DEBUG) console.error('REW_STEP0>>', JSON.stringify(out.slice(0, 60)));
  out = out.replaceAll(/\bselect\s+from\b/gi, 'select 1 from');
  if (process.env.REW_DEBUG) console.error('REW_STEP1>>', JSON.stringify(out.slice(0, 60)));
  out = out.replaceAll(PG_INTERVAL, (_m, sign: string, n: string, unit: string) => {
    const u = unit.toLowerCase() + (Number(n) === 1 ? '' : 's');
    return `strftime('%Y-%m-%dT%H:%M:%fZ','now','${sign}${n} ${u}')`;
  });
  // `= any(?)` (single array param) / `= any(col)` -> json_each membership.
  out = out.replaceAll(/=\s*any\(\s*(\?|[\w".]+)\s*\)/g, (_m, ref: string) =>
    ref === '?' ? 'in (select value from json_each(pg_array_json(?)))' : `in (select value from json_each(${ref}))`,
  );
  // unnest(...) -> json_each row source; params normalized to JSON arrays
  out = replaceZipUnnest(out);
  out = replaceUnnest(out);
  out = replaceIlikeOperator(out);
  out = replaceRegexMatchOperator(out);
  out = out.replaceAll(/returning\s+"?\w+"?\.\*/gi, 'returning *');
  out = replaceDummyUnnest(out);
  out = replaceInsertSelectOnConflict(out);
  out = replaceShadowedCte(out);
  out = replaceDistinctOn(out);
  out = replaceMaintenance(out);
  // X like any(array[...]::text[]) -> correlated existence against JSON list
  out = replaceLikeAnyArray(out);
  // array[$1,$2,...]::type[] -> JSON array of the listed params
  out = out.replaceAll(/array\[\s*([^\]]+?)\s*\](?:\s*::\s*[\w\s]+(?:\(\d+\))?\s*\[\s*\])?/gi, (_m, inner: string) => {
    const items = inner.split(',').map((x) => x.trim());
    return `json_array(${items.join(', ')})`;
  });
  // extract(epoch from (a - b)) -> difference of epoch seconds
  out = out.replaceAll(
    /extract\(epoch from \(\s*([^)]+?)\s*-\s*([^)]+?)\s*\)\)/gi,
    "(strftime('%s',$1) - strftime('%s',$2))",
  );
  // AT TIME ZONE on already-UTC stored values: identity.
  out = out.replaceAll(/\s+at\s+time\s+zone\s+'[^']*'/gi, '');
  // date_part('unit', x) -> strftime equivalent (balanced-paren operand scan)
  out = replaceDateParts(out);
  // encode(x, 'base64') -> base64(x) scalar registered on the handle.
  out = out.replaceAll(/encode\(\s*([^,)]+)\s*,\s*'base64'\s*\)/gi, 'base64($1)');
  // pg_trgm similarity operator -> scalar Jaccard over padded trigram sets.  // jsonb chain operators a -> 'k' [-> 'k2'] ->> 'k3' -> json_extract with $.path
  out = out.replaceAll(
    /([\w"]+(?:\.[\w"]+)?)\s*((?:->>?)\s*'[^']*'(?:\s*->>?\s*'[^']*')*)/g,
    (m: string, base: string, chain: string) => {
      const parts = chain.match(/->>?\s*'([^']*)'/g) ?? [];
      if (parts.length === 0) return m;
      const path = '$' + parts.map((p) => '.' + p.match(/'([^']*)'/)?.[1]).join('');
      return `json_extract(${base}, '${path}')`;
    },
  );

  // Operands are either single-level function calls (f_unaccent(name)) or bare
  // identifiers/params. A permissive char class would let a greedy first operand
  // swallow `coalesce(` and emit unbalanced SQL.
  const trigFunc = String.raw`[A-Za-z_]\w*\s*\([^()]*\)`;
  const trigBare = String.raw`[\w".?]+`;
  out = out.replaceAll(
    new RegExp(String.raw`(?:${trigFunc}|${trigBare})\s*<->>>\s*(?:${trigFunc}|${trigBare})`, 'g'),
    // PG's `<->>>` is a word-similarity DISTANCE (smaller = closer): 1 - word_similarity(b, a).
    // Mapping it to a raw score would sort worst-first in ascending ORDER BY.
    (m: string) => {
      const [a, b] = m.split('<->>>', 2);
      return `(1 - word_similarity(${b.trim()}, ${a.trim()}))`;
    },
  );
  // bare `a %>> b` (PG17 strict-word-similarity gate) -> word_similarity gate at the
  // pg_trgm default threshold. Operands are function-call shapes like f_unaccent ($1).
  out = out.replaceAll(
    new RegExp(String.raw`(${trigFunc}|${trigBare})\s*%>>\s*(${trigFunc}|${trigBare})`, 'g'),
    (_m: string, a: string, b: string) => `word_similarity(${b}, ${a}) >= 0.6`,
  );
  // pgvector cosine distance operator (operands may be parenthesised subqueries)
  out = replaceCosineOperator(out);
  // a %> (select b where set_config('pg_trgm.*_threshold','V',true) is not null)
  //   -> word_similarity(b, a) >= V
  out = out.replaceAll(
    /([\w"().?']+)(\s*%>\s*)\(\s*select\s+([^)\s]+(?:\([^)]*\))?)\s+where\s+set_config\(\s*'pg_trgm\.\w+_threshold'\s*,\s*'(\d+(?:\.\d+)?)'\s*,\s*true\s*\)\s+is not null\s*\)/gi,
    (_m, a: string, _op: string, b: string, v: string) => `word_similarity(${b}, ${a}) >= ${v}`,
  );
  return out;
};

// Split the DDL into statements, treating `begin ... end` trigger bodies as
// a single statement (they contain interior semicolons). Safe because the
// DDL is machine-generated with predictable formatting.
export // Postgres microsecond precision: two statements in the same millisecond
// still get distinct, strictly increasing timestamps (specs assert updatedAt
// changes). JS Date truncates to ms, so sub-ms bumps are invisible after
// hydration; force the emitted millisecond itself to be strictly increasing.
let _lastIsoMs = 0;
const monotonicIso = () => {
  const now = Date.now();
  const ms = now > _lastIsoMs ? now : _lastIsoMs + 1;
  _lastIsoMs = ms;
  return new Date(ms).toISOString();
};

// Postgres BEFORE UPDATE triggers for @UpdateDateColumn set updatedAt/updateId
// before RETURNING sees the row; SQLite AFTER triggers cannot do that. Inject the
// same assignment into UPDATE statements for tables that have such triggers.
let _updateTriggerTables: Set<string> | null = null;
const updateTriggerTables = (): Set<string> => {
  if (!_updateTriggerTables) {
    _updateTriggerTables = new Set<string>();
    const re = /create trigger "([a-z0-9_]+)_updated_at_update" after update on "([a-z_]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(SCHEMA_SQLITE)) !== null) {
      _updateTriggerTables.add(m[2]);
    }
  }
  return _updateTriggerTables;
};

const injectUpdateDate = (sqlText: string): string => {
  const m = /^update "([a-z_]+)" set /i.exec(sqlText);
  if (!m) {
    return sqlText;
  }
  const table = m[1];
  if (!updateTriggerTables().has(table) || /"updatedAt"\s*=/.test(sqlText)) {
    return sqlText;
  }
  return sqlText.replace(
    /^update "([a-z_]+)" set /i,
    'update "$1" set "updatedAt" = now_iso(), "updateId" = uuidv7(), ',
  );
};

const splitStatements = (ddl: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const line of ddl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    buf += (buf ? '\n' : '') + line;
    const low = trimmed.toLowerCase();
    if (/\bbegin\s*$/.test(low)) depth++;
    if (/^end\s*;?$/.test(low)) depth = Math.max(0, depth - 1);
    if (!(depth === 0 && trimmed.endsWith(';'))) {
      continue;
    }

    out.push(buf);
    buf = '';
  }
  if (buf.trim()) out.push(buf);
  return out;
};

/** Apply the generated fresh-install schema through Kysely (idempotent). */
export const bootstrapSqliteSchema = async <T>(db: Kysely<T>): Promise<boolean> => {
  const { rows } = await sql<{ user_version: number }>`pragma user_version`.execute(db);
  if (rows[0]?.user_version >= SCHEMA_VERSION) return false;
  const statements = splitStatements(SCHEMA_SQLITE);
  await db.transaction().execute(async (trx) => {
    for (const stmt of statements) {
      await sql.raw(stmt).execute(trx);
    }
    await sql.raw(`pragma user_version = ${SCHEMA_VERSION}`).execute(trx);
  });
  return true;
};

const replaceShadowedCte = (text: string): string => {
  // Postgres allows a CTE to shadow a real table (`with "asset" as (select
  // from "asset")`); SQLite reads the inner reference as a circular CTE
  // self-reference. Unshadow it by qualifying the reference inside the CTE.
  const defRe = /\bwith\s+"([a-z_]+)"\s+as\s*\(|,\s*"([a-z_]+)"\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(text))) {
    const name = m[1] ?? m[2];
    const start = m.index + m[0].length;
    let end = start;
    let d = 1;
    while (end < text.length && d > 0) {
      if (text[end] === '(') d++;
      else if (text[end] === ')') d--;
      end++;
    }
    const body = text.slice(start, end - 1);
    const refRe = new RegExp(String.raw`((?:from|join)\s+)("?)${name}("?)((?!\s*\()\s)`, 'gi');
    const fixed = body.replace(refRe, `$1main."${name}"$4`);
    if (fixed !== body) {
      return text.slice(0, start) + fixed + text.slice(end - 1);
    }
  }
  return text;
};

const replaceDistinctOn = (text: string): string => {
  // Postgres `select distinct on (exprs) ...` keeps the first row per group;
  // emulate with row_number() over (partition by exprs) and filter rn = 1.
  const m = /\bselect\s+distinct\s+on\s*\(/i.exec(text);
  if (!m) {
    return text;
  }
  // enclosing-paren depth of this select (subquery vs statement top level)
  let prefixDepth = 0;
  for (let i = 0; i < m.index; i++) {
    if (text[i] === '(') prefixDepth++;
    else if (text[i] === ')') prefixDepth--;
  }
  let i = m.index + m[0].length;
  let d = 1;
  while (i < text.length && d > 0) {
    if (text[i] === '(') d++;
    else if (text[i] === ')') d--;
    i++;
  }
  const groups = text.slice(m.index + m[0].length, i - 1);
  // end of this select: end of text if top level, else its closing paren
  let end = text.length;
  if (prefixDepth > 0) {
    let depth = 1;
    let k = m.index;
    while (k < text.length && depth > 0) {
      if (text[k] === '(') depth++;
      else if (text[k] === ')') depth--;
      k++;
    }
    end = k - 1;
  }
  const body = text.slice(i, end);
  // first depth-0 ` from ` in the body separates select list from the rest
  let bd = 0;
  let inStr = false;
  let fromAt = -1;
  for (let q = 0; q < body.length; q++) {
    const c = body[q];
    if (inStr) {
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') bd++;
    else if (c === ')') bd--;
    else if (bd === 0 && /^from\b/i.test(body.slice(q))) {
      const prev = q > 0 ? body[q - 1] : ' ';
      if (/[\s)]/.test(prev)) {
        fromAt = q;
        break;
      }
    }
  }
  if (fromAt < 0) {
    return text;
  }
  const wrapped =
    `select * from (select ${body.slice(0, fromAt)}, ` +
    `row_number() over (partition by ${groups}) as __dono_rn ${body.slice(fromAt)}) where __dono_rn = 1`;
  return text.slice(0, m.index) + wrapped + text.slice(end);
};
