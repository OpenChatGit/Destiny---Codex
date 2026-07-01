import { DatabaseSync } from "node:sqlite";
import {
  extractNameDesc,
  isHashArrayField,
  isHashField,
  resolveHash,
  type HashIndex,
} from "./resolver.js";

export interface FormatOptions {
  maxDepth?: number; // default 6
  maxStringLength?: number; // default 400
  skipEmpty?: boolean; // default true - skip null/0/""/false/[]
  resolveRefs?: boolean; // default true - resolve hash fields
  index?: HashIndex; // optional prebuilt reverse index
  /** Fields to always skip (noisy / huge / non-human-readable). */
  skipFields?: Set<string>;
}

const DEFAULT_SKIP = new Set<string>([
  "displaySources",
  "displayProperties.icon",
  "displayProperties.highResIcon",
  "displayProperties/iconSequences",
  "iconSequences",
  "redacted",
  "blacklisted",
  "hasIcon",
  "showDuration",
  "doNotShowInInventory",
  "visible",
  "isDefault",
  "isPlug",
  "isRandomized",
  "hash", // shown in header
  "index", // internal sort index
  "databasePath",
]);

const ENUM_HINTS: Record<string, Record<number, string>> = {
  tierType: { 0: "Unknown", 1: "Currency", 2: "Common", 3: "Uncommon", 4: "Rare", 5: "Legendary", 6: "Exotic" },
  classType: { 0: "Titan", 1: "Hunter", 2: "Warlock", 3: "Unknown" },
  damageType: { 0: "None", 1: "Kinetic", 2: "Arc", 3: "Solar", 4: "Void", 5: "Raid", 6: "Stasis", 7: "Strand" },
  itemType: {
    0: "None", 1: "Currency", 2: "Armor", 3: "Weapon", 8: "Message", 9: "Bounty", 10: "Subclass",
    12: "Quest", 13: "Emote", 14: "Emblem", 15: "Shader", 16: "Ship", 17: "Vehicle",
    18: "Ghost", 19: "Consumable", 20: "Finisher", 21: "ClanBanner", 22: "Mod",
    23: "Dummy", 24: "Package", 25: "Bounty", 26: "Glimmer", 27: "Silver",
  },
  itemSubType: { 0: "None", 1: "Helmet", 2: "Gauntlets", 4: "ChestArmor", 8: "LegArmor", 16: "ClassArmor", 32: "Weapon", 64: "Subclass" },
};

export interface FormatResult {
  text: string;
  name?: string;
  description?: string;
}

/**
 * Formats a manifest definition into clean, AI-readable text with hash references resolved inline.
 */
export function formatDefinition(
  db: DatabaseSync,
  table: string,
  hash: number,
  def: any,
  opts: FormatOptions = {},
): FormatResult {
  const maxDepth = opts.maxDepth ?? 6;
  const maxStringLength = opts.maxStringLength ?? 400;
  const skipEmpty = opts.skipEmpty ?? true;
  const resolveRefs = opts.resolveRefs ?? true;
  const skipFields = opts.skipFields ?? DEFAULT_SKIP;
  const index = opts.index;

  const { name, description } = extractNameDesc(def);
  const headerName = name ?? "(unnamed)";

  const lines: string[] = [];
  lines.push(`${headerName}  [${table}, hash ${hash}]`);
  if (description) lines.push(`"${truncate(description, maxStringLength)}"`);
  lines.push("---");

  const path: string[] = [];
  walk(def, 0);

  function shouldSkipField(field: string, value: any): boolean {
    if (skipFields.has(field)) return true;
    if (skipFields.has(path.join(".") + "." + field)) return true;
    if (skipEmpty) {
      if (value === null || value === undefined) return true;
      if (typeof value === "string" && value.trim() === "") return true;
      if (typeof value === "number" && value === 0) return true;
      if (typeof value === "boolean" && value === false) return true;
      if (Array.isArray(value) && value.length === 0) return true;
      if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return true;
    }
    return false;
  }

  function push(indent: number, text: string): void {
    lines.push(`${"  ".repeat(indent)}${text}`);
  }

  function walk(value: any, depth: number): void {
    if (depth > maxDepth) {
      push(depth, "(...truncated at max depth)");
      return;
    }
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "object" && item !== null) {
          push(depth, `[${i}]:`);
          walk(item, depth + 1);
        } else {
          push(depth, `- ${scalar(item)}`);
        }
      }
      return;
    }
    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        const v = value[key];
        if (shouldSkipField(key, v)) {
          continue;
        }
        path.push(key);
        if (typeof v === "object" && v !== null) {
          push(depth, `${key}:`);
          walk(v, depth + 1);
        } else if (resolveRefs && isHashField(key) && typeof v === "number" && isFinite(v) && v !== 0) {
          push(depth, formatHashField(key, v, depth));
        } else if (resolveRefs && isHashArrayField(key) && Array.isArray(v)) {
          push(depth, `${key}:`);
          for (const h of v) {
            if (typeof h === "number" && h !== 0) {
              push(depth + 1, `- ${formatHashField(key, h, depth + 1)}`);
            }
          }
        } else {
          push(depth, `${key}: ${scalarWithHint(key, v)}`);
        }
        path.pop();
      }
      return;
    }
    push(depth, scalar(value));
  }

  function formatHashField(field: string, hash: number, _depth: number): string {
    const ref = resolveHash(db, hash, field, index);
    if (!ref.found) {
      return `${field}: (unresolved hash ${hash})`;
    }
    const namePart = ref.name ? `"${truncate(ref.name, 80)}"` : "(no name)";
    return `${field}: ${namePart} (hash ${hash}, ${ref.table})`;
  }

  function scalarWithHint(field: string, v: any): string {
    if (typeof v === "number" && Number.isInteger(v)) {
      const hint = ENUM_HINTS[field];
      if (hint && hint[v]) return `${v} (${hint[v]})`;
    }
    return scalar(v);
  }

  function scalar(v: any): string {
    if (typeof v === "string") return JSON.stringify(truncate(v, maxStringLength));
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v === null) return "null";
    return String(v);
  }

  return { text: lines.join("\n"), name, description };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/**
 * Compact one-line summary for search result lists.
 */
export function summarizeDefinition(table: string, hash: number, def: any): string {
  const { name, description } = extractNameDesc(def);
  const head = name ?? "(unnamed)";
  const desc = description ? ` — ${truncate(description, 120)}` : "";
  return `${head} [${table} ${hash}]${desc}`;
}
