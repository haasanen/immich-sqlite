import { splitStatements } from '../src/utils/sqlite-database.js';
import { SCHEMA_SQLITE } from '../src/schema/schema.sqlite.js';

const stmts: string[] = splitStatements(SCHEMA_SQLITE);
const triggers = stmts.filter((s) => /create trigger/i.test(s));
const broken = stmts.filter(
  (s) => /^\s*end\s*;/i.test(s.trim()) || (s.toLowerCase().includes('begin') && !s.toLowerCase().includes('end;')),
);
console.log(JSON.stringify({ stmts: stmts.length, triggers: triggers.length, broken: broken.length }));
for (const b of broken) console.log('BROKEN:', JSON.stringify(b.slice(0, 220)));
