#!/usr/bin/env python3
"""Classify immich repository SQL files for SQLite portability (v3.3.5)."""
import json, re, pathlib, sys

TOKENS = {
    "cast": r"::\s*\w+",
    "cast_uuid": r"::\s*uuid", "cast_text": r"::\s*text", "cast_int": r"::\s*(integer|bigint|numeric)",
    "cast_ts": r"::\s*(timestamp|timestamptz|date)", "cast_interval": r"::\s*interval",
    "array_agg": r"\barray_agg\b", "string_agg": r"\bstring_agg\b", "unnest": r"\bunnest\b",
    "array_ctor": r"ARRAY\s*\[", "any_array": r"\bANY\s*\(",
    "generate_series": r"\bgenerate_series\b", "with_ordinality": r"WITH ORDINALITY",
    "distinct_on": r"DISTINCT ON", "lateral": r"\bLATERAL\b",
    "ilike": r"\bILIKE\b", "filter_agg": r"FILTER\s*\(",
    "nulls_last": r"NULLS (LAST|FIRST)", "window_over": r"OVER\s*\(",
    "returning": r"\bRETURNING\b", "on_conflict": r"ON CONFLICT",
    "earthdistance_op": r"<@>|<->|##", "earthdistance_fn": r"\b(slow_distance|geo_distance|earthdistance)\b",
    "trgm": r"\b(similarity|gin_trgm_ops)\b", "unaccent": r"\bunaccent\b",
    "fts": r"to_tsvector|to_tsquery|tsquery|tsvector",
    "json_op": r"->>?|#>|#>>|\?\\|jsonb_", "extract": r"\bEXTRACT\s*\(",
    "date_trunc": r"\bdate_trunc\b", "at_time_zone": r"AT TIME ZONE",
    "interval_lit": r"INTERVAL\s*'", "coalesce": r"\bCOALESCE\b",
    "case_when": r"\bCASE\b", "left_join": r"\bLEFT JOIN\b", "group_by": r"\bGROUP BY\b",
    "having": r"\bHAVING\b", "in_subquery": r"\bIN\s*\(\s*SELECT", "exists": r"\bEXISTS\s*\(",
}
PG_ONLY = [t for t in TOKENS if t not in ("coalesce", "case_when", "left_join", "group_by",
           "having", "in_subquery", "exists", "cast", "cast_int", "cast_text")]

def score(counts):
    heavies = sum(counts[k] for k in ("earthdistance_op","earthdistance_fn","trgm","unaccent","fts",
                 "array_agg","unnest","array_ctor","any_array","generate_series","with_ordinality",
                 "distinct_on","json_op","at_time_zone","window_over","on_conflict","returning")
                 if k in counts)
    casts = counts.get("cast", 0)
    if heavies >= 8 or counts.get("earthdistance_fn",0) >= 2: return "heavy"
    if heavies > 0 or casts > 20: return "medium"
    return "easy"

def main(root):
    qdir = pathlib.Path(root) / "server" / "src" / "queries"
    out = []
    for f in sorted(qdir.glob("*.sql")):
        text = f.read_text()
        lines = text.count("\n") + 1
        counts = {}
        for name, pat in TOKENS.items():
            c = len(re.findall(pat, text, re.IGNORECASE))
            if c: counts[name] = c
        out.append({"file": f.name, "lines": lines, "tokens": counts, "difficulty": score(counts)})
    out.sort(key=lambda r: ({"easy":0,"medium":1,"heavy":2}[r["difficulty"]], -r["lines"]), reverse=True)
    print(json.dumps(out, indent=1))
    tot = {"easy":0,"medium":0,"heavy":0}
    for r in out: tot[r["difficulty"]] += 1
    print(json.dumps({"summary": tot, "files": len(out),
                      "total_lines": sum(r["lines"] for r in out)}), file=sys.stderr)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/opt/data/cache/scratch/immich-fork")
