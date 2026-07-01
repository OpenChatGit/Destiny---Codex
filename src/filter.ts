import { DatabaseSync } from "node:sqlite";
import { iterateTable, getRawDefinition } from "./manifest.js";
import { extractNameDesc } from "./resolver.js";
import { getHashIndex } from "./resolver.js";

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

const STAT_NAME_TO_HASH: Record<string, number> = {
  "rounds per minute": 4284893193,
  "charge time": 2961394505,
  "blast radius": 3614673599,
  "impact": 4043523819,
  "velocity": 2523465841,
  "stability": 155624089,
  "handling": 943549884,
  "reload speed": 4188031367,
  "aim assistance": 1345609583,
  "airborne effectiveness": 2714457168,
  "zoom": 3555269338,
  "magazine": 3871231066,
  "attack": 1480404414,
  "defense": 3897883278,
  "power": 1935470627,
  "recoil direction": 2715839340,
  "ammo generation": 1931675084,
  "draw time": 447667954,
  "accuracy": 1598249740,
  "charge rate": 3611177937,
  "guard endurance": 3611177938,
  "swing speed": 3611177939,
  "efficiency": 3611177940,
  "defense efficiency": 3611177941,
};

/**
 * Apply filter criteria to a table (typically DestinyInventoryItemDefinition).
 * Returns matching hits sorted by name.
 */
export function filterItems(db: DatabaseSync, criteria: FilterCriteria): FilterHit[] {
  const table = "DestinyInventoryItemDefinition";
  const fwd = getHashIndex(db);
  const limit = criteria.limit ?? 50;
  const hits: FilterHit[] = [];

  // Resolve statsByName -> stats by hash
  const statFilters: Record<number, { min?: number; max?: number }> = {};
  if (criteria.stats) Object.assign(statFilters, criteria.stats);
  if (criteria.statsByName) {
    for (const [name, range] of Object.entries(criteria.statsByName)) {
      const hash = STAT_NAME_TO_HASH[name.toLowerCase()];
      if (hash) statFilters[hash] = range;
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
    if (Object.keys(statFilters).length > 0) {
      const stats = def.stats?.stats ?? {};
      let allMatch = true;
      for (const [hashStr, range] of Object.entries(statFilters)) {
        const hash = Number(hashStr);
        const statEntry = stats[hash];
        if (!statEntry) {
          allMatch = false;
          break;
        }
        const value = statEntry.value ?? 0;
        if (range.min !== undefined && value < range.min) {
          allMatch = false;
          break;
        }
        if (range.max !== undefined && value > range.max) {
          allMatch = false;
          break;
        }
        // record matched stat with resolved name
        const statDef = getRawDefinition(db, "DestinyStatDefinition", hash);
        const statName = statDef?.displayProperties?.name ?? `stat ${hash}`;
        matchedStats.push({ name: statName, value });
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

    if (hits.length >= limit * 3) break; // over-fetch a bit for sorting, then trim
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
    const dmg = h.damageType ? `dmg=${h.damageType} ` : "";
    const cls = h.classType !== undefined && h.classType !== 3 ? `class=${h.classType} ` : "";
    lines.push(`${tier}${type}${h.name} [${h.hash}]`);
    const extras: string[] = [];
    if (cls.trim()) extras.push(cls.trim());
    if (dmg.trim()) extras.push(dmg.trim());
    if (extras.length > 0) lines.push(`  ${extras.join(", ")}`);
    if (h.matchedStats) {
      lines.push(`  stats: ${h.matchedStats.map((s) => `${s.name}=${s.value}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}
