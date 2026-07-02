import { DatabaseSync } from "node:sqlite";
import { iterateTable, getRawDefinition } from "./manifest.js";
import { extractNameDesc } from "./resolver.js";
import { resolveByName } from "./compare.js";
import { queryWeaponsWithPerk } from "./index-sqlite.js";
import { extractSocketPerks, dbPlugSetResolver } from "./sockets.js";

/**
 * Reverse perk search: finds all weapons that can roll a given perk.
 *
 * This is the inverse of the `rolls` tool. Instead of "what can this weapon
 * roll?", it answers "which weapons can roll this perk?".
 *
 * Algorithm:
 * 1. Find the perk's plug item hash (search by name in DestinyInventoryItemDefinition).
 * 2. Scan all DestinyPlugSetDefinitions for ones that contain that plug item hash.
 * 3. Scan all DestinyInventoryItemDefinitions (weapons) for ones that reference
 *    any of those plug set hashes in their socket entries.
 * 4. Also check weapons that list the perk directly in reusablePlugItems.
 *
 * Returns matching weapons sorted by name, with their tier and type.
 */

export interface PerkWeaponMatch {
  hash: number;
  name: string;
  tierTypeName?: string;
  itemTypeDisplayName?: string;
  /** Which socket column the perk appears in. */
  socketIndex: number;
  /** Whether it's a random roll or fixed. */
  isRandom: boolean;
}

/**
 * Finds all weapons that can roll a given perk.
 * Accepts either a perk name (fuzzy-matched) or a direct plug item hash.
 */
export function findWeaponsWithPerk(
  db: DatabaseSync,
  perkNameOrHash: string | number,
): { perkName: string; perkHash: number; weapons: PerkWeaponMatch[] } | undefined {
  // 1. Resolve the perk to a plug item hash
  let perkHash: number;
  let perkName: string;

  if (typeof perkNameOrHash === "number") {
    perkHash = perkNameOrHash;
    const def = getRawDefinition(db, "DestinyInventoryItemDefinition", perkHash);
    if (!def) return undefined;
    const { name } = extractNameDesc(def);
    perkName = name ?? `(hash ${perkHash})`;
  } else {
    // Search by name - find the perk definition
    const item = resolveByName(db, perkNameOrHash, "DestinyInventoryItemDefinition");
    if (!item) return undefined;
    perkHash = item.hash;
    perkName = item.name;
  }

  // Fast path: precomputed weapon_perks table in the index DB.
  const indexed = queryWeaponsWithPerk(db, perkHash);
  if (indexed) {
    const weapons: PerkWeaponMatch[] = [];
    const seenNames = new Set<string>();
    for (const r of indexed) {
      if (seenNames.has(r.weaponName)) continue; // skip Adept/crafted duplicates
      seenNames.add(r.weaponName);
      weapons.push({
        hash: r.weaponHash,
        name: r.weaponName,
        tierTypeName: r.tierTypeName,
        itemTypeDisplayName: r.itemTypeDisplayName,
        socketIndex: r.socketIndex,
        isRandom: r.isRandom,
      });
    }
    return { perkName, perkHash, weapons };
  }

  // Slow path (index cache predates weapon_perks): full manifest scan using
  // the shared socket-perk extraction.
  const resolvePlugSet = dbPlugSetResolver(db);
  const weapons: PerkWeaponMatch[] = [];
  const seenNames = new Set<string>();

  for (const row of iterateTable(db, "DestinyInventoryItemDefinition")) {
    const def = row.json;
    if (!def.sockets?.socketEntries) continue;
    const { name } = extractNameDesc(def);
    if (!name) continue;
    // Only weapons (itemType 3) or items with itemTypeDisplayName
    if (def.itemType !== 3 && !def.itemTypeDisplayName) continue;
    // Deduplicate by name (skip Adept/crafted duplicates)
    if (seenNames.has(name)) continue;

    for (const socket of extractSocketPerks(def, resolvePlugSet)) {
      const match = socket.perks.find((p) => p.plugItemHash === perkHash);
      if (match) {
        seenNames.add(name);
        weapons.push({
          hash: row.hash,
          name,
          tierTypeName: def.inventory?.tierTypeName,
          itemTypeDisplayName: def.itemTypeDisplayName,
          socketIndex: socket.index,
          isRandom: match.isRandom,
        });
        break; // Only report the first matching socket per weapon
      }
    }
  }

  weapons.sort((a, b) => a.name.localeCompare(b.name));

  return { perkName, perkHash, weapons };
}

/**
 * Formats the reverse perk search results as readable text.
 */
export function formatPerkWeapons(
  db: DatabaseSync,
  perkNameOrHash: string | number,
): string {
  const result = findWeaponsWithPerk(db, perkNameOrHash);
  if (!result) {
    return typeof perkNameOrHash === "string"
      ? `No perk named "${perkNameOrHash}" found. Try 'codex search "${perkNameOrHash}"' first.`
      : `No perk with hash ${perkNameOrHash} found.`;
  }

  const lines: string[] = [];
  lines.push(`Weapons that can roll "${result.perkName}" (hash ${result.perkHash})`);
  lines.push("=".repeat(60));

  if (result.weapons.length === 0) {
    lines.push("(no weapons found with this perk)");
    return lines.join("\n");
  }

  lines.push(`${result.weapons.length} weapon${result.weapons.length === 1 ? "" : "s"} matched:`);
  lines.push("---");

  // Group by tier
  const byTier = new Map<string, PerkWeaponMatch[]>();
  for (const w of result.weapons) {
    const tier = w.tierTypeName ?? "Unknown";
    let arr = byTier.get(tier);
    if (!arr) {
      arr = [];
      byTier.set(tier, arr);
    }
    arr.push(w);
  }

  // Sort tiers: Exotic, Legendary, Rare, ...
  const tierOrder = ["Exotic", "Legendary", "Rare", "Uncommon", "Common"];
  const sortedTiers = Array.from(byTier.keys()).sort((a, b) => {
    const ia = tierOrder.indexOf(a);
    const ib = tierOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const tier of sortedTiers) {
    const weapons = byTier.get(tier)!;
    lines.push("");
    lines.push(`[${tier}] (${weapons.length})`);
    lines.push("-".repeat(40));
    for (const w of weapons) {
      const type = w.itemTypeDisplayName ? `${w.itemTypeDisplayName} ` : "";
      const roll = w.isRandom ? "random" : "fixed";
      lines.push(`  ${type}${w.name} [${w.hash}] (socket ${w.socketIndex}, ${roll})`);
    }
  }

  return lines.join("\n");
}
