import { DatabaseSync } from "node:sqlite";
import { getRawDefinition } from "./manifest.js";
import { extractNameDesc } from "./resolver.js";
import { resolveByName } from "./compare.js";
import { extractSocketPerks, dbPlugSetResolver, socketCategoryNames } from "./sockets.js";

/**
 * Extracts all possible perk rolls for a weapon from its socket definitions.
 *
 * Perks come from multiple sources:
 * - singleInitialItemHash: the default/fixed perk in a socket
 * - reusablePlugSetHash: points to a DestinyPlugSetDefinition with a list of plug items
 * - randomizedPlugSetHash: points to a DestinyPlugSetDefinition with random-roll perks
 * - reusablePlugItems: direct list of plug item hashes
 *
 * Sockets are categorized by the manifest:
 * - INTRINSIC TRAITS: fixed weapon trait (not rollable)
 * - WEAPON PERKS: the rollable perk columns (barrel, magazine, trait1, trait2, origin trait)
 * - WEAPON MODS: mod slots (boss spec, etc)
 * - WEAPON COSMETICS: shaders, ornaments
 */

export interface PerkSlot {
  /** Socket index in the weapon definition. */
  index: number;
  /** Category name (INTRINSIC TRAITS, WEAPON PERKS, etc). */
  category: string;
  /** Socket type name if available. */
  socketTypeName?: string;
  /** All possible perks for this slot. */
  perks: PerkOption[];
  /** Whether this slot is random-rollable (has randomizedPlugSetHash). */
  isRandom: boolean;
}

export interface PerkOption {
  hash: number;
  name: string;
  description?: string;
  /** Whether this is the default/fixed perk (singleInitialItemHash). */
  isDefault: boolean;
  /** Whether this comes from a random-roll plug set. */
  isRandomRoll: boolean;
  /** Stat modifiers from investmentStats (e.g. +15 Blast Radius, -5 Velocity). */
  statChanges?: { name: string; value: number }[];
}

/**
 * Gets all possible perk rolls for a weapon.
 * Accepts either a name (fuzzy-matched) or a direct hash.
 */
export function getWeaponRolls(db: DatabaseSync, hash: number): { name: string; slots: PerkSlot[] } | undefined {
  const def = getRawDefinition(db, "DestinyInventoryItemDefinition", hash);
  if (!def) return undefined;
  const { name } = extractNameDesc(def);
  if (!def.sockets) return { name: name ?? "(unnamed)", slots: [] };

  const categoryByIndex = socketCategoryNames(db, def);
  const socketPerks = extractSocketPerks(def, dbPlugSetResolver(db));
  const slots: PerkSlot[] = [];

  for (const socket of socketPerks) {
    const category = categoryByIndex.get(socket.index) ?? "(uncategorized)";

    // Skip cosmetic slots - we only want perks
    if (category.toLowerCase().includes("cosmetic")) continue;

    const socketTypeDef = socket.socketTypeHash
      ? getRawDefinition(db, "DestinySocketTypeDefinition", socket.socketTypeHash)
      : undefined;
    const socketTypeName = socketTypeDef?.displayProperties?.name;

    const perks: PerkOption[] = [];
    const seenNames = new Set<string>();
    for (const ref of socket.perks) {
      const perk = resolvePerk(db, ref.plugItemHash, ref.isDefault, ref.isRandom);
      if (perk && !seenNames.has(perk.name)) {
        perks.push(perk);
        seenNames.add(perk.name);
      }
    }

    if (perks.length === 0) continue;

    slots.push({
      index: socket.index,
      category,
      socketTypeName,
      perks,
      isRandom: socket.isRandom,
    });
  }

  return { name: name ?? "(unnamed)", slots };
}

function resolvePerk(
  db: DatabaseSync,
  hash: number,
  isDefault: boolean,
  isRandomRoll: boolean,
): PerkOption | undefined {
  const def = getRawDefinition(db, "DestinyInventoryItemDefinition", hash);
  if (!def) return undefined;
  const { name, description } = extractNameDesc(def);
  if (!name) return undefined;

  // Extract stat modifiers from investmentStats
  const statChanges: { name: string; value: number }[] = [];
  if (def.investmentStats) {
    for (const s of def.investmentStats) {
      if (s.value === 0) continue;
      const statDef = getRawDefinition(db, "DestinyStatDefinition", s.statTypeHash);
      const statName = statDef?.displayProperties?.name;
      if (statName) {
        statChanges.push({ name: statName, value: s.value });
      }
    }
  }

  return { hash, name, description, isDefault, isRandomRoll, statChanges: statChanges.length > 0 ? statChanges : undefined };
}

/**
 * Formats weapon rolls as readable text, grouped by socket column.
 */
export function formatRolls(db: DatabaseSync, hash: number): string {
  const result = getWeaponRolls(db, hash);
  if (!result) return `No weapon found for hash ${hash}.`;

  const lines: string[] = [];
  lines.push(`${result.name} - Possible Rolls`);
  lines.push("=".repeat(50));

  if (result.slots.length === 0) {
    lines.push("(no perk sockets found - this may not be a weapon)");
    return lines.join("\n");
  }

  // Group by category
  const byCategory = new Map<string, PerkSlot[]>();
  for (const slot of result.slots) {
    let arr = byCategory.get(slot.category);
    if (!arr) {
      arr = [];
      byCategory.set(slot.category, arr);
    }
    arr.push(slot);
  }

  for (const [category, slots] of byCategory) {
    lines.push("");
    lines.push(`[${category}]`);
    lines.push("-".repeat(50));

    for (const slot of slots) {
      const rollType = slot.isRandom ? "RANDOM ROLL" : "FIXED";
      const slotLabel = slot.socketTypeName
        ? `${slot.socketTypeName} (socket ${slot.index}, ${rollType})`
        : `Socket ${slot.index} (${rollType})`;
      lines.push(`\n  ${slotLabel}:`);

      for (const perk of slot.perks) {
        const tags: string[] = [];
        if (perk.isDefault) tags.push("default");
        if (perk.isRandomRoll) tags.push("random");
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        lines.push(`    - ${perk.name}${tagStr}`);
        if (perk.description && perk.description.length > 0) {
          const desc = perk.description.slice(0, 120);
          lines.push(`      ${desc}${perk.description.length > 120 ? "..." : ""}`);
        }
        if (perk.statChanges && perk.statChanges.length > 0) {
          const stats = perk.statChanges.map(s => `${s.value > 0 ? "+" : ""}${s.value} ${s.name}`).join(", ");
          lines.push(`      Stats: ${stats}`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Convenience: resolve a weapon by name and show its rolls.
 */
export function rollsByName(db: DatabaseSync, name: string): string | undefined {
  const item = resolveByName(db, name, "DestinyInventoryItemDefinition");
  if (!item) return undefined;
  return formatRolls(db, item.hash);
}
