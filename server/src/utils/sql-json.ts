// JSON subquery helpers for this fork's single engine (SQLite). The exported
// signatures mirror upstream kysely postgres helpers (type-only import) so
// existing repository call sites and their $castTo chains keep typechecking;
// only the SQLite implementations are ever invoked.
import type { jsonArrayFrom as pgJsonArrayFrom, jsonObjectFrom as pgJsonObjectFrom } from 'kysely/helpers/postgres';
import { sqliteJsonArrayFrom, sqliteJsonObjectFrom } from 'src/utils/sqlite-json-helpers.js';

export const jsonArrayFrom: typeof pgJsonArrayFrom = (expr: Parameters<typeof pgJsonArrayFrom>[0]) =>
  sqliteJsonArrayFrom(expr as never) as never;

export const jsonObjectFrom: typeof pgJsonObjectFrom = (expr: Parameters<typeof pgJsonObjectFrom>[0]) =>
  sqliteJsonObjectFrom(expr as never) as never;
