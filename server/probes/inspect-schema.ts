import { schemaFromCode } from '@immich/sql-tools';
import 'src/schema/index.js';
const schema = schemaFromCode();
console.log(
  'TABLES',
  schema.tables
    .map((t) => t.name)
    .sort()
    .join(','),
);
const trig = schema.tables.flatMap((t) =>
  t.triggers.map(
    (x) =>
      `${t.name}|${x.name}|${x.functionName ?? '?'}|${(x as any).scope ?? '?'}|${JSON.stringify((x as any).options ?? null).slice(0, 80)}`,
  ),
);
console.log('TRIGGER_DETAIL');
for (const t of trig) console.log(t);
