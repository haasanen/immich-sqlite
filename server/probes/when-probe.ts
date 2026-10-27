import { schemaFromCode } from '@immich/sql-tools';
import '../src/schema/tables/user.table.js';
import '../src/schema/tables/asset-av.table.js';
import '../src/schema/tables/workflow-log.table.js';
const schema = schemaFromCode();
const seen = new Set();
for (const t of schema.tables) {
  for (const tr of t.triggers ?? []) {
    if (tr.when) console.log(t.name, tr.name, 'WHEN:', tr.when);
  }
}
