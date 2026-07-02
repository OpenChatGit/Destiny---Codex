import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { listTables, getTableSchema, iterateTable, getTableSet } from "./manifest.js";
import {
  extractNameDesc,
  isHashField,
  isHashArrayField,
  type HashIndex,
} from "./resolver.js";
import type { NameIndex, SearchHit } from "./search.js";
import type { ReverseIndex, IncomingRef } from "./relationships.js";
import { extractSocketPerks, type PlugSetResolver } from "./sockets.js";

/**
 * SQLite-backed index cache. Stores all three indexes (forward, name, reverse)
 * in a single SQLite database file, versioned by manifest version.
 *
 * The reverse index is queried on-demand (no full in-memory load) which makes
 * it ~10x smaller on disk and instant to "load" (just open the DB).
 *
 * Cache file: <cacheDir>/index_<version>.db
 */

function indexDbPath(cacheDir: string, version: string): string {
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(cacheDir, `index_${safe}.db`);
}

function versionMarkerPath(cacheDir: string, version: string): string {
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(cacheDir, `index_${safe}.version`);
}

export interface SqliteIndexStore {
  /** The open SQLite connection to the index database. */
  db: DatabaseSync;
  /** Forward index loaded into memory (small, ~100k entries). */
  forward: HashIndex;
  /** Name index loaded into memory (small-medium, ~50k named entries). */
  name: NameIndex;
  /** Reverse index is queried on-demand via `db` — no full in-memory load. */
  reverse: ReverseIndex;
}

/**
 * Attempts to open an existing SQLite index cache for the given version.
 * Returns undefined if no cache exists.
 */
export function loadSqliteIndex(cacheDir: string, version: string): SqliteIndexStore | undefined {
  const marker = versionMarkerPath(cacheDir, version);
  const dbPath = indexDbPath(cacheDir, version);
  if (!existsSync(marker) || !existsSync(dbPath)) return undefined;

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });

    // Load forward index into memory (small)
    const forwardMap = new Map<number, string>();
    for (const row of db.prepare("SELECT hash, table_name FROM forward").iterate() as Iterable<{ hash: number; table_name: string }>) {
      forwardMap.set(row.hash, row.table_name);
    }

    // Load name index into memory (medium)
    const byName = new Map<string, SearchHit[]>();
    const allHits: SearchHit[] = [];
    const nameStmt = db.prepare("SELECT name_lower, table_name, hash, key, display_name, description FROM name_index");
    for (const row of nameStmt.iterate() as Iterable<{
      name_lower: string;
      table_name: string;
      hash: number;
      key: string | null;
      display_name: string;
      description: string | null;
    }>) {
      const hit: SearchHit = {
        table: row.table_name,
        hash: row.hash,
        key: row.key ?? undefined,
        name: row.display_name,
        description: row.description ?? undefined,
      };
      allHits.push(hit);
      let bucket = byName.get(row.name_lower);
      if (!bucket) {
        bucket = [];
        byName.set(row.name_lower, bucket);
      }
      bucket.push(hit);
    }

    // Reverse index: query-backed wrapper that looks like a Map
    const reverseStmt = db.prepare(
      "SELECT source_table, source_hash, source_name, path, field FROM reverse_index WHERE target_hash = ?",
    );
    const reverse: ReverseIndex = {
      byTarget: new Map<number, IncomingRef[]>(), // not preloaded
      // We override the lookup pattern in relationships.ts to use the query directly.
    };

    // We need a way for relationships.ts to query on-demand.
    // Attach the prepared statement via a custom property.
    (reverse as any).__queryStmt = reverseStmt;
    (reverse as any).__isSqliteBacked = true;

    return {
      db,
      forward: { byHash: forwardMap },
      name: { byName, all: allHits },
      reverse,
    };
  } catch (e) {
    console.error(`[index-sqlite] warning: failed to load cache: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Builds all three indexes in a single pass over the manifest and stores them
 * in a SQLite database. This is the expensive operation (~15s for ~100k defs).
 */
export function buildAndCacheSqliteIndex(
  manifestDb: DatabaseSync,
  cacheDir: string,
  version: string,
  language: string,
): SqliteIndexStore {
  const dbPath = indexDbPath(cacheDir, version);

  // Remove old cache if exists
  if (existsSync(dbPath)) unlinkSync(dbPath);
  mkdirSync(cacheDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE forward (hash INTEGER NOT NULL, table_name TEXT NOT NULL);
    CREATE TABLE name_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_lower TEXT NOT NULL,
      table_name TEXT NOT NULL,
      hash INTEGER NOT NULL,
      key TEXT,
      display_name TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE reverse_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_hash INTEGER NOT NULL,
      source_table TEXT NOT NULL,
      source_hash INTEGER NOT NULL,
      source_name TEXT,
      path TEXT NOT NULL,
      field TEXT NOT NULL
    );
    CREATE TABLE weapon_perks (
      perk_hash INTEGER NOT NULL,
      weapon_hash INTEGER NOT NULL,
      weapon_name TEXT NOT NULL,
      tier_type_name TEXT,
      item_type_display_name TEXT,
      socket_index INTEGER NOT NULL,
      is_random INTEGER NOT NULL
    );
  `);

  const insertForward = db.prepare("INSERT OR REPLACE INTO forward (hash, table_name) VALUES (?, ?)");
  const insertName = db.prepare(
    "INSERT INTO name_index (name_lower, table_name, hash, key, display_name, description) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertReverse = db.prepare(
    "INSERT INTO reverse_index (target_hash, source_table, source_hash, source_name, path, field) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertWeaponPerk = db.prepare(
    "INSERT INTO weapon_perks (perk_hash, weapon_hash, weapon_name, tier_type_name, item_type_display_name, socket_index, is_random) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const forwardMap = new Map<number, string>();
  const byName = new Map<string, SearchHit[]>();
  const allHits: SearchHit[] = [];

  // Pre-pass: plug-set contents, needed to expand weapon sockets. Plug sets
  // sort after inventory items in listTables order, so we must read them first.
  const plugSetContents = new Map<number, number[]>();
  if (getTableSet(manifestDb).has("DestinyPlugSetDefinition")) {
    for (const row of iterateTable(manifestDb, "DestinyPlugSetDefinition")) {
      const items = (row.json.reusablePlugItems ?? [])
        .map((p: { plugItemHash?: number }) => p.plugItemHash)
        .filter((h: unknown): h is number => typeof h === "number" && h !== 0);
      plugSetContents.set(row.hash, items);
    }
  }
  const resolvePlugSet: PlugSetResolver = (h) => plugSetContents.get(h) ?? [];

  db.exec("BEGIN TRANSACTION");

  for (const t of listTables(manifestDb)) {
    const schema = getTableSchema(manifestDb, t.name);
    const isItemTable = t.name === "DestinyInventoryItemDefinition";
    for (const row of iterateTable(manifestDb, t.name)) {
      // forward index (only numeric-key tables)
      if (!schema.isTextKey) {
        forwardMap.set(row.hash, t.name);
        insertForward.run(row.hash, t.name);
      }

      // name index
      const { name, description } = extractNameDesc(row.json);
      if (name) {
        const hit: SearchHit = {
          table: t.name,
          hash: row.hash,
          key: row.key,
          name,
          description,
        };
        allHits.push(hit);
        const lower = name.toLowerCase();
        let bucket = byName.get(lower);
        if (!bucket) {
          bucket = [];
          byName.set(lower, bucket);
        }
        bucket.push(hit);
        insertName.run(lower, t.name, row.hash, row.key ?? null, name, description ?? null);
      }

      // reverse index (only numeric-key tables)
      if (!schema.isTextKey) {
        const refs = extractOutgoingRefsFast(row.json);
        for (const r of refs) {
          insertReverse.run(r.hash, t.name, row.hash, name ?? null, r.path, r.field);
        }
      }

      // weapon_perks: one row per (perk, weapon), first socket a perk appears in wins
      const def = row.json;
      if (isItemTable && name && def.sockets?.socketEntries && (def.itemType === 3 || def.itemTypeDisplayName)) {
        const recorded = new Set<number>();
        for (const socket of extractSocketPerks(def, resolvePlugSet)) {
          for (const perk of socket.perks) {
            if (recorded.has(perk.plugItemHash)) continue;
            recorded.add(perk.plugItemHash);
            insertWeaponPerk.run(
              perk.plugItemHash,
              row.hash,
              name,
              def.inventory?.tierTypeName ?? null,
              def.itemTypeDisplayName ?? null,
              socket.index,
              perk.isRandom ? 1 : 0,
            );
          }
        }
      }
    }
  }

  db.exec("COMMIT");

  // Create indexes after bulk insert for faster creation
  db.exec(`
    CREATE INDEX idx_forward_hash ON forward(hash);
    CREATE INDEX idx_name_lower ON name_index(name_lower);
    CREATE INDEX idx_reverse_target ON reverse_index(target_hash);
    CREATE INDEX idx_weapon_perks_perk ON weapon_perks(perk_hash);
  `);

  // Write version marker
  writeFileSync(versionMarkerPath(cacheDir, version), version);

  // Prepare the reverse query statement
  const reverseStmt = db.prepare(
    "SELECT source_table, source_hash, source_name, path, field FROM reverse_index WHERE target_hash = ?",
  );
  const reverse: ReverseIndex = {
    byTarget: new Map(),
  };
  (reverse as any).__queryStmt = reverseStmt;
  (reverse as any).__isSqliteBacked = true;

  return {
    db,
    forward: { byHash: forwardMap },
    name: { byName, all: allHits },
    reverse,
  };
}

/**
 * Fast inline version of extractOutgoingRefs for the hot path during index building.
 */
function extractOutgoingRefsFast(def: any): { path: string; field: string; hash: number }[] {
  const out: { path: string; field: string; hash: number }[] = [];
  walk(def, "");
  return out;

  function walk(value: any, prefix: string): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${prefix}[${i}]`);
      }
      return;
    }
    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        const v = value[key];
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof v === "number" && isFinite(v) && v !== 0 && isHashField(key)) {
          out.push({ path, field: key, hash: v >>> 0 });
        } else if (Array.isArray(v) && isHashArrayField(key)) {
          for (let i = 0; i < v.length; i++) {
            const h = v[i];
            if (typeof h === "number" && isFinite(h) && h !== 0) {
              out.push({ path: `${path}[${i}]`, field: key, hash: h >>> 0 });
            }
          }
        } else if (typeof v === "object" && v !== null) {
          walk(v, path);
        }
      }
      return;
    }
  }
}

/**
 * High-level: get all three indexes, loading from SQLite cache or building if needed.
 * Attaches them to the manifest db object so subsequent calls are instant.
 */
export function getSqliteIndexes(
  manifestDb: DatabaseSync,
  cacheDir: string,
  version: string,
  language: string,
): SqliteIndexStore {
  const anyDb = manifestDb as any;
  if (anyDb.__sqliteIndexStore) return anyDb.__sqliteIndexStore;

  let store = loadSqliteIndex(cacheDir, version);
  if (!store) {
    store = buildAndCacheSqliteIndex(manifestDb, cacheDir, version, language);
  }

  // Attach to manifest db so old getHashIndex/getNameIndex/getReverseIndex can use them
  anyDb.__d2HashIndex = store.forward;
  anyDb.__d2NameIndex = store.name;
  anyDb.__d2ReverseIndex = store.reverse;
  anyDb.__sqliteIndexStore = store;
  return store;
}

export interface WeaponPerkRow {
  weaponHash: number;
  weaponName: string;
  tierTypeName?: string;
  itemTypeDisplayName?: string;
  socketIndex: number;
  isRandom: boolean;
}

/**
 * Fast lookup: which weapons can roll a perk? Uses the precomputed
 * weapon_perks table in the index DB. Returns undefined if this manifest's
 * index cache predates the table (caller falls back to a full scan;
 * `codex index --rebuild` upgrades the cache).
 */
export function queryWeaponsWithPerk(manifestDb: DatabaseSync, perkHash: number): WeaponPerkRow[] | undefined {
  const store: SqliteIndexStore | undefined = (manifestDb as any).__sqliteIndexStore;
  if (!store) return undefined;
  const hasTable = store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='weapon_perks'",
  ).get();
  if (!hasTable) return undefined;
  const rows = store.db.prepare(
    "SELECT weapon_hash, weapon_name, tier_type_name, item_type_display_name, socket_index, is_random " +
    "FROM weapon_perks WHERE perk_hash = ? ORDER BY weapon_name",
  ).all(perkHash) as {
    weapon_hash: number;
    weapon_name: string;
    tier_type_name: string | null;
    item_type_display_name: string | null;
    socket_index: number;
    is_random: number;
  }[];
  return rows.map((r) => ({
    weaponHash: r.weapon_hash,
    weaponName: r.weapon_name,
    tierTypeName: r.tier_type_name ?? undefined,
    itemTypeDisplayName: r.item_type_display_name ?? undefined,
    socketIndex: r.socket_index,
    isRandom: r.is_random === 1,
  }));
}

/**
 * Query the reverse index on-demand from SQLite. Returns incoming refs for a hash.
 * This replaces the in-memory Map lookup for SQLite-backed indexes.
 */
export function queryIncomingRefs(reverse: ReverseIndex, hash: number): IncomingRef[] {
  const stmt = (reverse as any).__queryStmt;
  if (stmt) {
    const rows = stmt.all(hash) as {
      source_table: string;
      source_hash: number;
      source_name: string | null;
      path: string;
      field: string;
    }[];
    return rows.map((r) => ({
      sourceTable: r.source_table,
      sourceHash: r.source_hash,
      sourceName: r.source_name ?? undefined,
      path: r.path,
      field: r.field,
    }));
  }
  // Fallback to in-memory Map
  return reverse.byTarget.get(hash) ?? [];
}
