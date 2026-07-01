import { DatabaseSync } from "node:sqlite";
import { getRawDefinition } from "./manifest.js";
import { extractNameDesc, getHashIndex } from "./resolver.js";
import { searchByName } from "./search.js";
import { formatDefinition } from "./formatter.js";

/**
 * Compare two or more inventory items side-by-side.
 * Shows stats, perks, and other fields with differences highlighted.
 */

export interface CompareItem {
  table: string;
  hash: number;
  name: string;
  def: any;
}

/**
 * Resolves a name query to a single definition. If multiple matches, picks
 * the first exact match, else the first result. Returns undefined if no match.
 */
export function resolveByName(db: DatabaseSync, query: string, table?: string): CompareItem | undefined {
  const hits = searchByName(db, query, { table, limit: 10 });
  if (hits.length === 0) return undefined;
  // prefer exact name match
  const exact = hits.find((h) => h.name.toLowerCase() === query.toLowerCase());
  const hit = exact ?? hits[0];
  const def = getRawDefinition(db, hit.table, hit.hash);
  if (!def) return undefined;
  return { table: hit.table, hash: hit.hash, name: hit.name, def };
}

const STAT_NAMES: Record<number, string> = {
  4284893193: "RPM",
  3614673599: "Blast Radius",
  4043523819: "Impact",
  2523465841: "Velocity",
  155624089: "Stability",
  943549884: "Handling",
  4188031367: "Reload Speed",
  1345609583: "Aim Assist",
  2714457168: "Airborne",
  3555269338: "Zoom",
  3871231066: "Magazine",
  1480404414: "Attack",
  1935470627: "Power",
  2715839340: "Recoil",
  1931675084: "Ammo Gen",
  2961394505: "Charge Time",
  447667954: "Draw Time",
};

/**
 * Formats a side-by-side comparison of 2+ items.
 * Focuses on: tier, type, damage, stats, and socket perks.
 */
export function formatComparison(db: DatabaseSync, items: CompareItem[]): string {
  if (items.length === 0) return "No items to compare.";
  if (items.length === 1) {
    return formatDefinition(db, items[0].table, items[0].hash, items[0].def, {
      index: getHashIndex(db),
    }).text;
  }

  const lines: string[] = [];
  const names = items.map((i) => i.name);
  const headerWidth = Math.max(...names.map((n) => n.length), 20);

  // Header
  lines.push("COMPARISON");
  lines.push("=".repeat(60));
  lines.push(padRow("Field", names, headerWidth));
  lines.push("-".repeat(60));

  // Basic properties
  const props: [string, (d: any) => string][] = [
    ["Tier", (d) => d.inventory?.tierTypeName ?? "-"],
    ["Type", (d) => d.itemTypeDisplayName ?? "-"],
    ["Class", (d) => ["Titan", "Hunter", "Warlock", "Any"][d.classType ?? 3]],
    ["Damage", (d) => ["", "Kinetic", "Arc", "Solar", "Void", "", "Stasis", "Strand"][d.defaultDamageType ?? 0] ?? "?"],
    ["Bucket", (d) => {
      const b = d.inventory?.bucketTypeHash;
      if (!b) return "-";
      const bd = getRawDefinition(db, "DestinyInventoryBucketDefinition", b);
      return bd?.displayProperties?.name ?? "-";
    }],
  ];

  for (const [label, fn] of props) {
    const values = items.map((i) => fn(i.def));
    lines.push(padRow(label, values, headerWidth));
  }

  // Stats
  lines.push("");
  lines.push("STATS");
  lines.push("-".repeat(60));

  // Collect all stat hashes across items
  const allStatHashes = new Set<number>();
  for (const item of items) {
    const stats = item.def.stats?.stats ?? {};
    for (const h of Object.keys(stats)) allStatHashes.add(Number(h));
  }

  if (allStatHashes.size === 0) {
    lines.push("  (no stats)");
  } else {
    const sortedHashes = Array.from(allStatHashes).sort((a, b) => (STAT_NAMES[a] ?? `stat ${a}`).localeCompare(STAT_NAMES[b] ?? `stat ${b}`));
    for (const hash of sortedHashes) {
      const statDef = getRawDefinition(db, "DestinyStatDefinition", hash);
      const label = STAT_NAMES[hash] ?? statDef?.displayProperties?.name ?? `stat ${hash}`;
      const values = items.map((i) => {
        const s = i.def.stats?.stats?.[hash];
        return s ? String(s.value ?? 0) : "-";
      });
      lines.push(padRow(label, values, headerWidth));
    }
  }

  // Perks / sockets
  lines.push("");
  lines.push("PERKS & SOCKETS");
  lines.push("-".repeat(60));

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    lines.push(`\n[${item.name}]:`);
    const sockets = item.def.sockets?.socketEntries ?? [];
    const categories = item.def.sockets?.socketCategories ?? [];
    for (const cat of categories) {
      const catDef = getRawDefinition(db, "DestinySocketCategoryDefinition", cat.socketCategoryHash);
      const catName = catDef?.displayProperties?.name ?? "(unknown category)";
      lines.push(`  ${catName}:`);
      for (const sockIdx of cat.socketIndexes ?? []) {
        const sock = sockets[sockIdx];
        if (!sock) continue;
        const plugHash = sock.singleInitialItemHash;
        if (!plugHash || plugHash === 0) continue;
        const plugDef = getRawDefinition(db, "DestinyInventoryItemDefinition", plugHash);
        const plugName = plugDef?.displayProperties?.name ?? "(unnamed)";
        const plugDesc = plugDef?.displayProperties?.description ?? "";
        const desc = plugDesc ? ` - ${plugDesc.slice(0, 80)}` : "";
        lines.push(`    - ${plugName}${desc}`);
      }
    }
  }

  return lines.join("\n");
}

function padRow(label: string, values: string[], headerWidth: number): string {
  const labelCol = label.padEnd(14);
  const valCols = values.map((v) => v.padEnd(headerWidth + 2));
  return `${labelCol}${valCols.join("")}`;
}
