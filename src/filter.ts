import { DatabaseSync } from "node:sqlite";
import { iterateTable, getRawDefinition } from "./manifest.js";
import { extractNameDesc } from "./resolver.js";
import { className, damageName } from "./enums.js";

/**
 * Structured filter queries over DestinyInventoryItemDefinition (and
 * potentially other tables). Lets you ask things like:
 *   "all Exotic Rocket Launchers"
 *   "all weapons with Blast Radius > 80"
 *   "all Titan chest armor"
 *
 * Filters are applied in a single pass over the table. For the inventory-item
 * table (~39k rows) this takes ~200-400ms which is fine for interactive use.
 */

export interface FilterCriteria {
  /** Filter by itemType (3=Weapon, 2=Armor, etc). See ENUM_HINTS in formatter. */
  itemType?: number;
  /** Filter by item type display name substring, e.g. "Rocket Launcher", "Gauntlets". */
  itemTypeDisplayName?: string;
  /** Filter by tierType (6=Exotic, 5=Legendary, 4=Rare, 3=Uncommon, 2=Common). */
  tierType?: number;
  /** Filter by tier name: "Exotic", "Legendary", etc. */
  tierTypeName?: string;
  /** Filter by classType (0=Titan, 1=Hunter, 2=Warlock, 3=Any). */
  classType?: number;
  /** Filter by damage type (1=Kinetic, 2=Arc, 3=Solar, 4=Void, 6=Stasis, 7=Strand). */
  damageType?: number;
  /** Filter by bucket hash (e.g. 953998645 = Power Weapons). Resolves to name. */
  bucketTypeHash?: number;
  /** Filter by bucket display name substring, e.g. "Power Weapons", "Helmet". */
  bucketName?: string;
  /** Filter by item category hash (e.g. category for "Rocket Launcher"). */
  itemCategoryHash?: number;
  /** Stat filters: statHash -> {min?, max?}. Resolves stat names via index. */
  stats?: Record<number, { min?: number; max?: number }>;
  /** Stat filters by stat name (case-insensitive), e.g. { "Blast Radius": { min: 80 } }. */
  statsByName?: Record<string, { min?: number; max?: number }>;
  /** Name substring filter (case-insensitive). */
  nameContains?: string;
  /** Only include items with this trait hash. */
  traitHash?: number;
  /** Only items with this plug set (used in sockets). */
  plugSetHash?: number;
  /** Limit results (default 50). */
  limit?: number;
}

export interface FilterHit {
  table: string;
  hash: number;
  name: string;
  description?: string;
  itemTypeDisplayName?: string;
  tierTypeName?: string;
  classType?: number;
  damageType?: number;
  /** Matched stat values, if stat filters were applied. */
  matchedStats?: { name: string; value: number }[];
}

interface StatMaps {
  /** lowercase display name -> all stat hashes sharing that name */
  nameToHashes: Map<string, number[]>;
  /** stat hash -> display name */
  hashToName: Map<number, string>;
}

const STAT_MAPS_CACHE = new WeakMap<DatabaseSync, StatMaps>();

/**
 * Stat name/hash lookup built from the manifest's own DestinyStatDefinition
 * table (cached per db). This stays correct across manifest updates and works
 * in every language. Several stats share a display name, so names map to a
 * list of candidate hashes.
 */
export function getStatMaps(db: DatabaseSync): StatMaps {
  let maps = STAT_MAPS_CACHE.get(db);
  if (maps) return maps;
  const nameToHashes = new Map<string, number[]>();
  const hashToName = new Map<number, string>();
  for (const row of iterateTable(db, "DestinyStatDefinition")) {
    const name = row.json?.displayProperties?.name;
    if (typeof name === "string" && name.length > 0) {
      hashToName.set(row.hash, name);
      const key = name.toLowerCase();
      let list = nameToHashes.get(key);
      if (!list) {
        list = [];
        nameToHashes.set(key, list);
      }
      list.push(row.hash);
    }
  }
  maps = { nameToHashes, hashToName };
  STAT_MAPS_CACHE.set(db, maps);
  return maps;
}

/**
 * Apply filter criteria to a table (typically DestinyInventoryItemDefinition).
 * Returns matching hits sorted by name.
 */
export function filterItems(db: DatabaseSync, criteria: FilterCriteria): FilterHit[] {
  const table = "DestinyInventoryItemDefinition";
  const limit = criteria.limit ?? 50;
  const hits: FilterHit[] = [];
  const statMaps = getStatMaps(db);

  // Each stat filter is a group of candidate hashes (names can be ambiguous):
  // an item matches a group if ANY candidate stat is present and in range.
  const statFilterGroups: { hashes: number[]; range: { min?: number; max?: number } }[] = [];
  if (criteria.stats) {
    for (const [hashStr, range] of Object.entries(criteria.stats)) {
      statFilterGroups.push({ hashes: [Number(hashStr)], range });
    }
  }
  if (criteria.statsByName) {
    for (const [name, range] of Object.entries(criteria.statsByName)) {
      const hashes = statMaps.nameToHashes.get(name.toLowerCase());
      if (hashes) statFilterGroups.push({ hashes, range });
    }
  }

  for (const row of iterateTable(db, table)) {
    const def = row.json;
    const { name, description } = extractNameDesc(def);
    if (!name) continue;

    // name filter
    if (criteria.nameContains && !name.toLowerCase().includes(criteria.nameContains.toLowerCase())) continue;

    // itemType
    if (criteria.itemType !== undefined && def.itemType !== criteria.itemType) continue;
    if (criteria.itemTypeDisplayName) {
      const dn = def.itemTypeDisplayName ?? "";
      if (!dn.toLowerCase().includes(criteria.itemTypeDisplayName.toLowerCase())) continue;
    }

    // tierType (in inventory block)
    const inv = def.inventory ?? {};
    if (criteria.tierType !== undefined && inv.tierType !== criteria.tierType) continue;
    if (criteria.tierTypeName && (inv.tierTypeName ?? "").toLowerCase() !== criteria.tierTypeName.toLowerCase()) continue;

    // classType
    if (criteria.classType !== undefined && def.classType !== criteria.classType && def.classType !== 3) continue;

    // damageType
    if (criteria.damageType !== undefined && def.defaultDamageType !== criteria.damageType) continue;

    // bucket
    if (criteria.bucketTypeHash !== undefined && inv.bucketTypeHash !== criteria.bucketTypeHash) continue;
    if (criteria.bucketName) {
      const bucketDef = inv.bucketTypeHash ? getRawDefinition(db, "DestinyInventoryBucketDefinition", inv.bucketTypeHash) : undefined;
      const bn = bucketDef?.displayProperties?.name ?? "";
      if (!bn.toLowerCase().includes(criteria.bucketName.toLowerCase())) continue;
    }

    // itemCategory
    if (criteria.itemCategoryHash !== undefined) {
      const cats: number[] = def.itemCategoryHashes ?? [];
      if (!cats.includes(criteria.itemCategoryHash)) continue;
    }

    // trait
    if (criteria.traitHash !== undefined) {
      const traits: number[] = def.traitHashes ?? [];
      if (!traits.includes(criteria.traitHash)) continue;
    }

    // stats
    const matchedStats: { name: string; value: number }[] = [];
    if (statFilterGroups.length > 0) {
      const stats = def.stats?.stats ?? {};
      let allMatch = true;
      for (const group of statFilterGroups) {
        let groupMatched = false;
        for (const hash of group.hashes) {
          const statEntry = stats[hash];
          if (!statEntry) continue;
          const value = statEntry.value ?? 0;
          if (group.range.min !== undefined && value < group.range.min) continue;
          if (group.range.max !== undefined && value > group.range.max) continue;
          matchedStats.push({ name: statMaps.hashToName.get(hash) ?? `stat ${hash}`, value });
          groupMatched = true;
          break;
        }
        if (!groupMatched) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;
    }

    hits.push({
      table,
      hash: row.hash,
      name,
      description,
      itemTypeDisplayName: def.itemTypeDisplayName,
      tierTypeName: inv.tierTypeName,
      classType: def.classType,
      damageType: def.defaultDamageType,
      matchedStats: matchedStats.length > 0 ? matchedStats : undefined,
    });
  }

  hits.sort((a, b) => a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

/**
 * Format filter results as readable text.
 */
export function formatFilterResults(hits: FilterHit[]): string {
  if (hits.length === 0) return "No items matched the filter criteria.";
  const lines: string[] = [];
  lines.push(`${hits.length} item${hits.length === 1 ? "" : "s"} matched:`);
  lines.push("---");
  for (const h of hits) {
    const tier = h.tierTypeName ? `[${h.tierTypeName}] ` : "";
    const type = h.itemTypeDisplayName ? `${h.itemTypeDisplayName} ` : "";
    lines.push(`${tier}${type}${h.name} [${h.hash}]`);
    const extras: string[] = [];
    if (h.classType !== undefined && h.classType !== 3) extras.push(`class=${className(h.classType)}`);
    if (h.damageType) extras.push(`dmg=${damageName(h.damageType)}`);
    if (extras.length > 0) lines.push(`  ${extras.join(", ")}`);
    if (h.matchedStats) {
      lines.push(`  stats: ${h.matchedStats.map((s) => `${s.name}=${s.value}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}
