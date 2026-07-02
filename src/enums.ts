/**
 * Central Destiny enum <-> name mappings, shared by CLI, MCP server, REST
 * server, and formatters. Values follow the Bungie.net API enums.
 */

/** DestinyClass enum. */
export const CLASS_NAMES: Record<number, string> = {
  0: "Titan",
  1: "Hunter",
  2: "Warlock",
  3: "Any",
};

/** DamageType enum. */
export const DAMAGE_NAMES: Record<number, string> = {
  0: "None",
  1: "Kinetic",
  2: "Arc",
  3: "Solar",
  4: "Void",
  5: "Raid",
  6: "Stasis",
  7: "Strand",
};

/** Lowercase class name -> DestinyClass value (for CLI/REST input parsing). */
export const CLASS_NAME_TO_TYPE: Record<string, number> = {
  titan: 0,
  hunter: 1,
  warlock: 2,
};

/** Lowercase damage name -> DamageType value (for CLI/REST input parsing). */
export const DAMAGE_NAME_TO_TYPE: Record<string, number> = {
  kinetic: 1,
  arc: 2,
  solar: 3,
  void: 4,
  stasis: 6,
  strand: 7,
};

export function className(classType: number | undefined): string {
  if (classType === undefined) return "?";
  return CLASS_NAMES[classType] ?? String(classType);
}

export function damageName(damageType: number | undefined): string {
  if (damageType === undefined) return "?";
  return DAMAGE_NAMES[damageType] ?? String(damageType);
}
