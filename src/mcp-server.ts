import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureManifest,
  listTables,
  openDb,
  getRawDefinition,
  type ManifestConfig,
} from "./manifest.js";
import { formatDefinition, summarizeDefinition } from "./formatter.js";
import { searchByName } from "./search.js";
import { resolveHash, getHashIndex, extractNameDesc } from "./resolver.js";
import {
  extractOutgoingRefs,
  findIncomingRefs,
  resolveOutgoingRefs,
  renderGraph,
} from "./relationships.js";
import { getSqliteIndexes } from "./index-sqlite.js";
import { filterItems, formatFilterResults, type FilterCriteria } from "./filter.js";
import { DATE_VERSION, SEMVER, FULL_VERSION } from "./version.js";
import { getWeaponRolls, formatRolls, rollsByName } from "./rolls.js";
import { formatPerkWeapons } from "./perksearch.js";

// We keep a single DB connection + lazy manifest sync for the lifetime of the server.
let db: DatabaseSync | undefined;
let config: ManifestConfig;

async function getDb(): Promise<DatabaseSync> {
  if (db) return db;
  const meta = await ensureManifest(config);
  db = openDb(meta.sqlitePath);
  // Preload all indexes (SQLite-backed: forward + name in memory, reverse on-demand).
  getSqliteIndexes(db, config.cacheDir, meta.version, meta.language);

  // Auto-update check: warn if manifest is older than 7 days
  const ageDays = (Date.now() - meta.downloadedAt) / (1000 * 60 * 60 * 24);
  if (ageDays > 7) {
    console.error(
      `[Destiny Codex] Warning: Manifest is ${Math.floor(ageDays)} days old. ` +
      `Run 'codex sync' to update. Bungie updates the manifest weekly.`,
    );
  }

  return db;
}

export async function startMcpServer(cfg: ManifestConfig): Promise<void> {
  config = cfg;
  const server = new McpServer({
    name: "destiny-codex",
    version: FULL_VERSION,
  });

  server.registerTool(
    "manifest_info",
    {
      description:
        "Returns the cached Destiny 2 manifest version, language, download time, and a list of all definition tables with row counts. Call this first to learn what data is available. Syncs/downloads the manifest automatically if not present.",
      inputSchema: {},
    },
    async () => {
      const d = await getDb();
      const meta = await ensureManifest(config);
      const tables = listTables(d);
      const text =
        `Destiny Codex ${FULL_VERSION}\n` +
        `codex version: ${SEMVER} (${DATE_VERSION})\n` +
        `---\n` +
        `Destiny 2 Manifest\n` +
        `manifest version: ${meta.version}\n` +
        `language: ${meta.language}\n` +
        `downloadedAt: ${new Date(meta.downloadedAt).toISOString()}\n` +
        `tables: ${tables.length}\n` +
        `---\n` +
        tables.map((t) => `${t.name}: ${t.rowCount} rows`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "list_tables",
    {
      description:
        "Lists all Destiny manifest definition tables (e.g. DestinyInventoryItemDefinition) with row counts. Use to pick a table for get/search.",
      inputSchema: {},
    },
    async () => {
      const d = await getDb();
      const tables = listTables(d);
      const text = tables.map((t) => `${t.name}: ${t.rowCount}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Searches manifest definitions by name (case-insensitive substring). Returns matching {table, hash, name, description}. Use to find the hash for a named item/weapon/activity/etc. Optionally filter by table.",
      inputSchema: {
        query: z.string().describe("Name or part of a name to search for, e.g. 'Gjallarhorn'."),
        table: z
          .string()
          .optional()
          .describe("Optional table filter, e.g. 'DestinyInventoryItemDefinition'."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25)."),
      },
    },
    async (args) => {
      const d = await getDb();
      const hits = searchByName(d, args.query, {
        table: args.table,
        limit: args.limit ?? 25,
      });
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${args.query}".` }] };
      }
      const text = hits
        .map((h, i) => `${i + 1}. ${summarizeDefinition(h.table, h.hash, { displayProperties: { name: h.name, description: h.description } })}`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "get",
    {
      description:
        "Returns a clean, AI-readable text rendering of a single manifest definition by table + hash, with all hash references resolved into human-readable names inline. This is the main tool for understanding what a definition actually is.",
      inputSchema: {
        table: z.string().describe("Manifest table name, e.g. 'DestinyInventoryItemDefinition'."),
        hash: z.number().int().describe("Unsigned 32-bit hash id of the definition."),
        resolveRefs: z.boolean().optional().describe("Resolve hash references to names (default true)."),
        maxDepth: z.number().int().min(1).max(10).optional().describe("Max nesting depth (default 6)."),
      },
    },
    async (args) => {
      const d = await getDb();
      const def = getRawDefinition(d, args.table, args.hash);
      if (!def) {
        return { content: [{ type: "text", text: `No definition in ${args.table} for hash ${args.hash}.` }] };
      }
      const result = formatDefinition(d, args.table, args.hash, def, {
        resolveRefs: args.resolveRefs ?? true,
        maxDepth: args.maxDepth ?? 6,
        index: getHashIndex(d),
      });
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.registerTool(
    "resolve",
    {
      description:
        "Resolves a single hash (auto-detects which table it belongs to) and returns a short readable summary: name, table, description. Use when you only have a bare hash with no table context.",
      inputSchema: {
        hash: z.number().int().describe("Unsigned 32-bit hash to resolve."),
      },
    },
    async (args) => {
      const d = await getDb();
      const ref = resolveHash(d, args.hash, undefined, getHashIndex(d));
      if (!ref.found) {
        return { content: [{ type: "text", text: `Hash ${args.hash} not found in any table.` }] };
      }
      const def = getRawDefinition(d, ref.table, args.hash);
      const text =
        `Hash ${args.hash} -> ${ref.table}\n` +
        `name: ${ref.name ?? "(unnamed)"}\n` +
        (ref.description ? `description: ${ref.description}` : "(no description)");
      void def;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "raw",
    {
      description:
        "Returns the raw JSON of a definition (table + hash), unformatted. Use only when the readable 'get' output is missing a field you need. Output can be large.",
      inputSchema: {
        table: z.string(),
        hash: z.number().int(),
      },
    },
    async (args) => {
      const d = await getDb();
      const def = getRawDefinition(d, args.table, args.hash);
      if (!def) {
        return { content: [{ type: "text", text: `No definition in ${args.table} for hash ${args.hash}.` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(def, null, 2) }] };
    },
  );

  server.registerTool(
    "relationships",
    {
      description:
        "Shows both directions of a definition's connections. OUTGOING: every hash this definition references (with resolved names + paths). INCOMING: every other definition that references THIS one (reverse lookup - e.g. which weapons use a perk, which activities drop an item). Use this to understand how things connect.",
      inputSchema: {
        table: z.string().describe("Table of the definition, e.g. 'DestinyInventoryItemDefinition'."),
        hash: z.number().int().describe("Hash of the definition."),
        direction: z
          .enum(["both", "outgoing", "incoming"])
          .optional()
          .describe("Which direction to show (default 'both')."),
        limit: z.number().int().min(1).max(200).optional().describe("Max refs per direction (default 50)."),
      },
    },
    async (args) => {
      const d = await getDb();
      const def = getRawDefinition(d, args.table, args.hash);
      if (!def) {
        return { content: [{ type: "text", text: `No definition in ${args.table} for hash ${args.hash}.` }] };
      }
      const dir = args.direction ?? "both";
      const limit = args.limit ?? 50;
      const lines: string[] = [];
      const { name } = extractNameDesc(def);
      lines.push(`${name ?? "(unnamed)"} [${args.table} ${args.hash}]`);
      lines.push("===");

      if (dir === "both" || dir === "outgoing") {
        const fwd = getHashIndex(d);
        const refs = resolveOutgoingRefs(d, extractOutgoingRefs(def, fwd));
        lines.push(`OUTGOING (${refs.length} reference${refs.length === 1 ? "" : "s"}):`);
        if (refs.length === 0) {
          lines.push("  (none)");
        } else {
          refs.slice(0, limit).forEach((r) => {
            const target = r.found
              ? `${r.name ?? "(unnamed)"} [${r.table} ${r.hash}]`
              : `(unresolved hash ${r.hash}${r.table ? `, ${r.table}` : ""})`;
            lines.push(`  ${r.field}: ${target}`);
            lines.push(`    @ ${r.path}`);
          });
          if (refs.length > limit) lines.push(`  ...and ${refs.length - limit} more (raise limit)`);
        }
      }

      if (dir === "both" || dir === "incoming") {
        const incoming = findIncomingRefs(d, args.hash);
        lines.push(`INCOMING (${incoming.length} reference${incoming.length === 1 ? "" : "s"}):`);
        if (incoming.length === 0) {
          lines.push("  (none - nothing references this)");
        } else {
          incoming.slice(0, limit).forEach((r) => {
            lines.push(`  ${r.sourceName ?? "(unnamed)"} [${r.sourceTable} ${r.sourceHash}]`);
            lines.push(`    via ${r.field} @ ${r.path}`);
          });
          if (incoming.length > limit) lines.push(`  ...and ${incoming.length - limit} more (raise limit)`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "graph",
    {
      description:
        "Traverses the reference graph starting at a definition and renders it as an indented tree. Follows outgoing hash-references up to `maxDepth` hops, resolving names at each level. Use this to see the full connected web of an item (weapon -> perks -> stats -> objectives -> ...). Cycles are handled (already-shown nodes are marked).",
      inputSchema: {
        table: z.string().describe("Starting table, e.g. 'DestinyInventoryItemDefinition'."),
        hash: z.number().int().describe("Starting hash."),
        maxDepth: z.number().int().min(1).max(5).optional().describe("How many hops to follow (default 2). Each hop can multiply results, keep small."),
        maxBranch: z.number().int().min(1).max(100).optional().describe("Max outgoing refs to follow per node (default 20)."),
      },
    },
    async (args) => {
      const d = await getDb();
      const text = renderGraph(d, args.table, args.hash, {
        maxDepth: args.maxDepth ?? 2,
        maxBranch: args.maxBranch ?? 20,
      });
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "filter",
    {
      description:
        "Structured filter query over DestinyInventoryItemDefinition. Find items by type, tier, class, damage type, bucket, item category, and stat ranges. Examples: 'all Exotic Rocket Launchers' (tierTypeName=Exotic, itemTypeDisplayName=Rocket Launcher), 'weapons with Blast Radius > 80' (statsByName={'Blast Radius':{min:80}}), 'all Titan helmets' (classType=0, bucketName=Helmet). Returns name, hash, tier, type, and matched stat values.",
      inputSchema: {
        itemType: z.number().int().optional().describe("itemType: 3=Weapon, 2=Armor, 19=Consumable, 22=Mod, etc."),
        itemTypeDisplayName: z.string().optional().describe("Substring match on type, e.g. 'Rocket Launcher', 'Gauntlets', 'Helmet'."),
        tierType: z.number().int().optional().describe("tierType: 6=Exotic, 5=Legendary, 4=Rare, 3=Uncommon, 2=Common."),
        tierTypeName: z.string().optional().describe("Tier name: 'Exotic', 'Legendary', 'Rare', etc."),
        classType: z.number().int().optional().describe("0=Titan, 1=Hunter, 2=Warlock, 3=Any. Items with classType=3 match all class filters."),
        damageType: z.number().int().optional().describe("1=Kinetic, 2=Arc, 3=Solar, 4=Void, 6=Stasis, 7=Strand."),
        bucketTypeHash: z.number().int().optional().describe("Bucket hash, e.g. 953998645=Power Weapons."),
        bucketName: z.string().optional().describe("Bucket name substring, e.g. 'Power Weapons', 'Helmet', 'Gauntlets'."),
        itemCategoryHash: z.number().int().optional().describe("Item category hash to filter by."),
        stats: z
          .record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional() }))
          .optional()
          .describe("Stat filters by statHash (numeric string key): { '3614673599': { min: 80 } } for Blast Radius >= 80."),
        statsByName: z
          .record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional() }))
          .optional()
          .describe("Stat filters by stat name (case-insensitive): { 'Blast Radius': { min: 80 } }. Names: Rounds Per Minute, Blast Radius, Impact, Velocity, Stability, Handling, Reload Speed, Aim Assistance, Magazine, Attack, Power, Recoil Direction, etc."),
        nameContains: z.string().optional().describe("Substring filter on item name (case-insensitive)."),
        traitHash: z.number().int().optional().describe("Only items with this trait hash."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
      },
    },
    async (args) => {
      const d = await getDb();
      const criteria: FilterCriteria = {
        itemType: args.itemType,
        itemTypeDisplayName: args.itemTypeDisplayName,
        tierType: args.tierType,
        tierTypeName: args.tierTypeName,
        classType: args.classType,
        damageType: args.damageType,
        bucketTypeHash: args.bucketTypeHash,
        bucketName: args.bucketName,
        itemCategoryHash: args.itemCategoryHash,
        stats: args.stats as Record<number, { min?: number; max?: number }> | undefined,
        statsByName: args.statsByName as Record<string, { min?: number; max?: number }> | undefined,
        nameContains: args.nameContains,
        traitHash: args.traitHash,
        limit: args.limit ?? 50,
      };
      const hits = filterItems(d, criteria);
      return { content: [{ type: "text", text: formatFilterResults(hits) }] };
    },
  );

  server.registerTool(
    "rolls",
    {
      description:
        "Shows all possible perk rolls for a weapon. Extracts every perk from plug sets, random-roll pools, and reusable plug items. Groups by socket column (intrinsic trait, weapon perks, mods). Marks each perk as default, random, or fixed. Use this to answer 'what can this weapon roll?' Accepts either a weapon name (fuzzy-matched, preferred) or a numeric hash.",
      inputSchema: {
        name: z.string().optional().describe("Weapon name to search (e.g. 'Code Duello', 'Gjallarhorn'). Preferred over hash."),
        hash: z.number().int().optional().describe("Numeric hash of the weapon (DestinyInventoryItemDefinition). Use if name is ambiguous."),
      },
    },
    async (args) => {
      const d = await getDb();
      let text: string;
      if (args.name) {
        const result = rollsByName(d, args.name);
        if (!result) {
          return { content: [{ type: "text", text: `No weapon named "${args.name}" found. Try the search tool first.` }] };
        }
        text = result;
      } else if (args.hash !== undefined) {
        text = formatRolls(d, args.hash);
      } else {
        return { content: [{ type: "text", text: "Provide either 'name' or 'hash'." }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "perk_search",
    {
      description:
        "Reverse perk search: finds all weapons that can roll a given perk. The inverse of 'rolls'. Answers 'which weapons can roll Incandescent / Bait and Switch / Vorpal Weapon?'. Groups results by tier (Exotic, Legendary, etc). Accepts perk name or hash.",
      inputSchema: {
        name: z.string().optional().describe("Perk name to search (e.g. 'Incandescent', 'Bait and Switch'). Preferred over hash."),
        hash: z.number().int().optional().describe("Numeric hash of the perk plug item (DestinyInventoryItemDefinition). Use if name is ambiguous."),
      },
    },
    async (args) => {
      const d = await getDb();
      const key = args.name ?? args.hash;
      if (key === undefined) {
        return { content: [{ type: "text", text: "Provide either 'name' or 'hash'." }] };
      }
      const text = formatPerkWeapons(d, key);
      return { content: [{ type: "text", text }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

