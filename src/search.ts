import { DatabaseSync } from "node:sqlite";
import { iterateTable, listTables } from "./manifest.js";
import { extractNameDesc } from "./resolver.js";

export interface SearchHit {
  table: string;
  hash: number;
  key?: string;
  name: string;
  description?: string;
}

export interface NameIndex {
  /** lowercase name -> hits */
  byName: Map<string, SearchHit[]>;
  /** all hits (for table-filtered iteration) */
  all: SearchHit[];
}

const INDEX_KEY = Symbol("d2NameIndex");

export function getNameIndex(db: DatabaseSync): NameIndex {
  const anyDb = db as any;
  if (anyDb.__d2NameIndex) return anyDb.__d2NameIndex;
  if (anyDb[INDEX_KEY]) return anyDb[INDEX_KEY];
  const byName = new Map<string, SearchHit[]>();
  const all: SearchHit[] = [];
  for (const t of listTables(db)) {
    for (const row of iterateTable(db, t.name)) {
      const { name, description } = extractNameDesc(row.json);
      if (!name) continue;
      const hit: SearchHit = {
        table: t.name,
        hash: row.hash,
        key: row.key,
        name,
        description,
      };
      all.push(hit);
      const key = name.toLowerCase();
      let bucket = byName.get(key);
      if (!bucket) {
        bucket = [];
        byName.set(key, bucket);
      }
      bucket.push(hit);
    }
  }
  const idx = { byName, all };
  anyDb[INDEX_KEY] = idx;
  return idx;
}

/**
 * Search definitions by name. Substring, case-insensitive.
 * Optionally filter by table. Returns up to `limit` hits, best matches first
 * (exact match > prefix match > substring match).
 */
export function searchByName(
  db: DatabaseSync,
  query: string,
  opts: { table?: string; limit?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 25;
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const idx = getNameIndex(db);
  const candidates: SearchHit[] = [];

  for (const [key, hits] of idx.byName) {
    if (key.includes(q)) {
      for (const h of hits) {
        if (opts.table && h.table !== opts.table) continue;
        candidates.push(h);
      }
    }
  }

  // dedupe by table+hash
  const seen = new Set<string>();
  const unique = candidates.filter((h) => {
    const k = `${h.table}:${h.hash}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // rank: exact > prefix > substring; then alphabetical
  unique.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    const aExact = an === q ? 0 : an.startsWith(q) ? 1 : 2;
    const bExact = bn === q ? 0 : bn.startsWith(q) ? 1 : 2;
    if (aExact !== bExact) return aExact - bExact;
    return an.localeCompare(bn);
  });

  return unique.slice(0, limit);
}
