import { schemaFromCode } from '@immich/sql-tools';
import 'src/schema/index.js';

const schema = schemaFromCode();
const names = schema.tables.map((t) => t.name);
console.log('tables:', names.length);
console.log('av present:', names.filter((n) => n.startsWith('asset_')).join(','));
