import 'src/schema/index.js';
import { schemaFromCode } from '@immich/sql-tools';

const s = schemaFromCode();
const t = s.tables.find((x: any) => x.name === 'album_user') as any;
for (const idx of t.indexes) {
  console.log(
    idx.name,
    JSON.stringify(Object.keys(idx)),
    'predicate=',
    (idx as any).predicate,
    'where=',
    (idx as any).where,
  );
}
