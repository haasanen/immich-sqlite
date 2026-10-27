import { describe, expect, it } from 'vitest';
import { rewritePgSql } from 'src/utils/sqlite-database.js';

describe('rewritePgSql - trigram operator rewrites', () => {
  it('rewrites %>> to a word_similarity gate with the needle as first argument', () => {
    const out = rewritePgSql(`where f_unaccent(name) %>> f_unaccent($1)`);
    expect(out).toBe(`where word_similarity(f_unaccent($1), f_unaccent(name)) >= 0.6`);
  });

  it('rewrites <->>> inside coalesce() without swallowing the coalesce( prefix', () => {
    // regression: a permissive operand class used to match `coalesce(f_unaccent(name)`
    // as the left operand, producing unbalanced SQL (SQLite: wrong number of
    // arguments to function coalesce()).
    const out = rewritePgSql(`order by coalesce(f_unaccent(name) <->>> f_unaccent($1), 0.1)`);
    expect(out).toBe(`order by coalesce((1 - word_similarity(f_unaccent($1), f_unaccent(name))), 0.1)`);
    expect(out).not.toContain('<->>>');
  });

  it('rewrites the full searchPlaces ORDER BY sum of four coalesced distances', () => {
    const sql = [
      `coalesce(f_unaccent(name) <->>> f_unaccent($1), 0.1) +`,
      `coalesce(f_unaccent("admin2Name") <->>> f_unaccent($1), 0.1)`,
    ].join(' ');
    const out = rewritePgSql(sql);
    expect(out).toContain(`coalesce((1 - word_similarity(f_unaccent($1), f_unaccent(name))), 0.1)`);
    expect(out).toContain(`coalesce((1 - word_similarity(f_unaccent($1), f_unaccent("admin2Name"))), 0.1)`);
  });

  it('rewrites the parameterised threshold form used by person name search', () => {
    const sql = `f_unaccent("person"."name") %> (select f_unaccent($5) where set_config('pg_trgm.word_similarity_threshold','0.5',true) is not null)`;
    const out = rewritePgSql(sql);
    expect(out).toBe(`word_similarity(f_unaccent($5), f_unaccent("person"."name")) >= 0.5`);
  });
});
