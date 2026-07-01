import { DatabaseSync } from "node:sqlite";
import { getRawDefinition, getTableSchema, iterateTable, listTables } from "./manifest.js";

/**
 * Heuristic mapping from common hash-field suffixes to their target table.
 * This avoids reverse-index lookups for the vast majority of references.
 * Keys are matched case-insensitively against the field name.
 */
const FIELD_SUFFIX_TO_TABLE: Record<string, string> = {
  itemHash: "DestinyInventoryItemDefinition",
  itemHashes: "DestinyInventoryItemDefinition",
  rewardItemHash: "DestinyInventoryItemDefinition",
  rewardItemHashes: "DestinyInventoryItemDefinition",
  previewItemHash: "DestinyInventoryItemDefinition",
  previewItemHashes: "DestinyInventoryItemDefinition",
  objectiveHash: "DestinyObjectiveDefinition",
  objectiveHashes: "DestinyObjectiveDefinition",
  activityHash: "DestinyActivityDefinition",
  activityHashes: "DestinyActivityDefinition",
  activityGraphHash: "DestinyActivityGraphDefinition",
  activityModeHash: "DestinyActivityModeDefinition",
  activityModeHashes: "DestinyActivityModeDefinition",
  activityTypeHash: "DestinyActivityTypeDefinition",
  classHash: "DestinyClassDefinition",
  classTypeHash: "DestinyClassDefinition",
  damageTypeHash: "DestinyDamageTypeDefinition",
  damageTypeHashes: "DestinyDamageTypeDefinition",
  statHash: "DestinyStatDefinition",
  statHashes: "DestinyStatDefinition",
  sandboxStatHash: "DestinyStatDefinition",
  perkHash: "DestinySandboxPerkDefinition",
  perkHashes: "DestinySandboxPerkDefinition",
  progressionHash: "DestinyProgressionDefinition",
  progressionHashes: "DestinyProgressionDefinition",
  factionHash: "DestinyFactionDefinition",
  factionHashes: "DestinyFactionDefinition",
  vendorHash: "DestinyVendorDefinition",
  vendorHashes: "DestinyVendorDefinition",
  vendorItemHash: "DestinyVendorItemDefinition",
  raceHash: "DestinyRaceDefinition",
  raceHashes: "DestinyRaceDefinition",
  genderHash: "DestinyGenderDefinition",
  talentGridHash: "DestinyTalentGridDefinition",
  talentGridHashes: "DestinyTalentGridDefinition",
  loreHash: "DestinyLoreDefinition",
  loreHashes: "DestinyLoreDefinition",
  plugSetHash: "DestinyPlugSetDefinition",
  plugSetHashes: "DestinyPlugSetDefinition",
  socketTypeHash: "DestinySocketTypeDefinition",
  socketTypeHashes: "DestinySocketTypeDefinition",
  socketCategoryHash: "DestinySocketCategoryDefinition",
  inventoryBucketHash: "DestinyInventoryBucketDefinition",
  bucketHash: "DestinyInventoryBucketDefinition",
  bucketHashes: "DestinyInventoryBucketDefinition",
  presentationNodeHash: "DestinyPresentationNodeDefinition",
  presentationNodeHashes: "DestinyPresentationNodeDefinition",
  recordHash: "DestinyRecordDefinition",
  recordHashes: "DestinyRecordDefinition",
  seasonHash: "DestinySeasonDefinition",
  seasonPassHash: "DestinySeasonPassDefinition",
  milestoneHash: "DestinyMilestoneDefinition",
  milestoneHashes: "DestinyMilestoneDefinition",
  enemyRaceHash: "DestinyEnemyRaceDefinition",
  placeHash: "DestinyPlaceDefinition",
  placeHashes: "DestinyPlaceDefinition",
  destinationHash: "DestinyDestinationDefinition",
  destinationHashes: "DestinyDestinationDefinition",
  locationHash: "DestinyLocationDefinition",
  locationHashes: "DestinyLocationDefinition",
  activityLocationHash: "DestinyActivityLocationDefinition",
  artifactHash: "DestinyArtifactDefinition",
  traitHash: "DestinyTraitDefinition",
  traitHashes: "DestinyTraitDefinition",
  traitCategoryHash: "DestinyTraitCategoryDefinition",
  materialRequirementHash: "DestinyMaterialRequirementSetDefinition",
  materialRequirementHashes: "DestinyMaterialRequirementSetDefinition",
  unlockHash: "DestinyUnlockDefinition",
  unlockHashes: "DestinyUnlockDefinition",
  unlockValueHash: "DestinyUnlockDefinition",
  rewardSheetHash: "DestinyRewardSheetDefinition",
  gearsetHash: "DestinyGearsetDefinition",
  gearsetHashes: "DestinyGearsetDefinition",
  metricHash: "DestinyMetricDefinition",
  metricHashes: "DestinyMetricDefinition",
  iconWatermarkHash: "DestinyInventoryItemDefinition",
  progressionMappingHash: "DestinyProgressionMappingDefinition",
  checklistHash: "DestinyChecklistDefinition",
  bondHash: "DestinyItemCategoryDefinition",
  itemCategoryHash: "DestinyItemCategoryDefinition",
  itemCategoryHashes: "DestinyItemCategoryDefinition",
  parentNodeHashes: "DestinyPresentationNodeDefinition",
  parentNodeHash: "DestinyPresentationNodeDefinition",
  childNodeHashes: "DestinyPresentationNodeDefinition",
  completionRecordHash: "DestinyRecordDefinition",
  scopeHash: "DestinyActivityModeDefinition",
  modeHash: "DestinyActivityModeDefinition",
  modifierHash: "DestinyActivityModifierDefinition",
  modifierHashes: "DestinyActivityModifierDefinition",
  playlistActivityHash: "DestinyActivityDefinition",
  directActivityModeHash: "DestinyActivityModeDefinition",
  loadoutHash: "DestinyLoadoutDefinition",
  loadoutHashes: "DestinyLoadoutDefinition",
  energyTypeHash: "DestinyEnergyTypeDefinition",
  energyTypeHashes: "DestinyEnergyTypeDefinition",
  insertionMaterialRequirementHash: "DestinyMaterialRequirementSetDefinition",
  plugItemHash: "DestinyInventoryItemDefinition",
  plugItemHashes: "DestinyInventoryItemDefinition",
  reusablePlugItemHash: "DestinyInventoryItemDefinition",
  reusablePlugItemHashes: "DestinyInventoryItemDefinition",
  randomizedPlugItemHash: "DestinyInventoryItemDefinition",
  randomizedPlugItemHashes: "DestinyInventoryItemDefinition",
  currencyItemHash: "DestinyInventoryItemDefinition",
  currencyItemHashes: "DestinyInventoryItemDefinition",
  creationConditions: "DestinyUnlockDefinition",
  setItemHashes: "DestinyInventoryItemDefinition",
  rewardHash: "DestinyInventoryItemDefinition",
  rewardHashes: "DestinyInventoryItemDefinition",
  itemListHash: "DestinyInventoryItemDefinition",
};

/**
 * Reverse index: hash (unsigned) -> table name. Built lazily and cached on the db object.
 */
export interface HashIndex {
  byHash: Map<number, string>;
}

const INDEX_KEY = Symbol("d2HashIndex");

export function getHashIndex(db: DatabaseSync): HashIndex {
  const anyDb = db as any;
  if (anyDb.__d2HashIndex) return anyDb.__d2HashIndex;
  if (anyDb[INDEX_KEY]) return anyDb[INDEX_KEY];
  const byHash = new Map<number, string>();
  for (const t of listTables(db)) {
    const schema = getTableSchema(db, t.name);
    if (schema.isTextKey) continue; // TEXT-keyed tables have no numeric hash
    for (const row of iterateTable(db, t.name)) {
      byHash.set(row.hash, t.name);
    }
  }
  const idx = { byHash };
  anyDb[INDEX_KEY] = idx;
  return idx;
}

/**
 * Guess the target table for a hash field by its name.
 */
export function guessTableByFieldName(field: string): string | undefined {
  const lower = field.charAt(0).toLowerCase() + field.slice(1);
  if (FIELD_SUFFIX_TO_TABLE[field]) return FIELD_SUFFIX_TO_TABLE[field];
  if (FIELD_SUFFIX_TO_TABLE[lower]) return FIELD_SUFFIX_TO_TABLE[lower];
  // try suffix match: field ends with a known key
  for (const key of Object.keys(FIELD_SUFFIX_TO_TABLE)) {
    if (field === key || field.endsWith(key)) return FIELD_SUFFIX_TO_TABLE[key];
  }
  return undefined;
}

export interface ResolvedRef {
  hash: number;
  table: string;
  name?: string;
  description?: string;
  found: boolean;
}

/**
 * Resolves a single hash to a definition. Tries the field-name hint first,
 * then falls back to the reverse index.
 */
export function resolveHash(
  db: DatabaseSync,
  hash: number,
  fieldHint?: string,
  index?: HashIndex,
): ResolvedRef {
  // 1. Try field name hint
  if (fieldHint) {
    const table = guessTableByFieldName(fieldHint);
    if (table) {
      try {
        const def = getRawDefinition(db, table, hash);
        if (def) {
          return { hash, table, ...extractNameDesc(def), found: true };
        }
      } catch {
        // table may not exist in this manifest version; fall through to reverse index
      }
    }
  }
  // 2. Reverse index fallback
  const idx = index ?? getHashIndex(db);
  const table = idx.byHash.get(hash);
  if (table) {
    const def = getRawDefinition(db, table, hash);
    if (def) return { hash, table, ...extractNameDesc(def), found: true };
  }
  return { hash, table: table ?? "(unknown)", found: false };
}

/**
 * Extracts a human-readable name + short description from a definition.
 * Most definitions follow the displayProperties.name/description convention.
 */
export function extractNameDesc(def: any): { name?: string; description?: string } {
  const dp = def?.displayProperties;
  const name = dp?.name || def?.name || def?.progressDescription || def?.statName;
  const description = dp?.description || def?.description;
  return {
    name: name && typeof name === "string" && name.length > 0 ? name : undefined,
    description:
      description && typeof description === "string" && description.length > 0
        ? description
        : undefined,
  };
}

/**
 * Heuristic: is this field name a hash reference?
 * Matches fields ending in "Hash" (singular) or "Hashes" (plural array).
 */
export function isHashField(field: string): boolean {
  return /Hash(es)?$/i.test(field);
}

export function isHashArrayField(field: string): boolean {
  return /Hashes$/i.test(field);
}
