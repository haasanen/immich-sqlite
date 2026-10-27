import { Kysely } from 'kysely';
import 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { bootstrapSqliteSchema } from 'src/utils/sqlite-database.js';
import { SCHEMA_SQLITE } from 'src/schema/schema.sqlite.js';
import { tmpdir } from 'node:os';

const file = `${tmpdir()}/p2-bootstrap-${Date.now()}.db`;
const db = new Kysely(getKyselyConfig({ connectionType: 'sqlite', filename: file }));
try {
  const applied = await bootstrapSqliteSchema(db);
  console.log('BOOTSTRAP_OK applied=', applied);
} catch (e: any) {
  console.log('BOOTSTRAP_FAIL:', e.message);
  // manual replay to find the offending statement
  const statements = SCHEMA_SQLITE.split(';\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
  console.log('stmt_count=', statements.length);
  // also show the raw pragma path
  const { rows } = await (await import('kysely')).sql<{ user_version: number }>`pragma user_version`.execute(db);
  console.log('pragma_rows=', JSON.stringify(rows));
  const better = (await import('better-sqlite3')).default;
  const raw = new better(file);
  let i = 0;
  for (const s of statements) {
    try {
      raw.prepare(s);
      i++;
    } catch (e2: any) {
      console.log('RAW_FAIL at', i, ':', e2.message);
      console.log(s.slice(0, 300));
      break;
    }
  }
  console.log('raw_ok=', i, 'of', statements.length);
}
process.exit(0);
