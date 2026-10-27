import { rewritePgSql } from '../src/utils/sqlite-database.js';

console.log(rewritePgSql('select from "asset_face" where x = 1'));
console.log(rewritePgSql('exists (select from "t")'));
