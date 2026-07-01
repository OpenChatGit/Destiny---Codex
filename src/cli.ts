import { Command } from "commander";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureManifest,
  listTables,
  openDb,
  getRawDefinition,
  resolveConfig,
  saveApiKeyToFile,
  saveLanguageToFile,
  readLanguageFromFile,
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  fetchRemoteVersion,
  type ManifestConfig,
} from "./manifest.js";
import { formatDefinition, summarizeDefinition } from "./formatter.js";
import { searchByName } from "./search.js";
import { resolveHash, getHashIndex, extractNameDesc } from "./resolver.js";
import { startMcpServer } from "./mcp-server.js";
import {
  extractOutgoingRefs,
  findIncomingRefs,
  resolveOutgoingRefs,
  renderGraph,
} from "./relationships.js";
import { getSqliteIndexes } from "./index-sqlite.js";
import { filterItems, formatFilterResults, type FilterCriteria } from "./filter.js";
import { resolveByName, formatComparison } from "./compare.js";
import { rollsByName, formatRolls } from "./rolls.js";
import { formatPerkWeapons } from "./perksearch.js";
import { startRestServer } from "./server.js";
import { DATE_VERSION, SEMVER, FULL_VERSION } from "./version.js";

async function loadDb(): Promise<{ cfg: ManifestConfig; db: DatabaseSync }> {
  const cfg = resolveConfig();
  const meta = await ensureManifest(cfg);
  const db = openDb(meta.sqlitePath);
  getSqliteIndexes(db, cfg.cacheDir, meta.version, meta.language);

  // Auto-update check: warn if manifest is older than 7 days
  const ageDays = (Date.now() - meta.downloadedAt) / (1000 * 60 * 60 * 24);
  if (ageDays > 7) {
    console.error(
      `⚠ Manifest is ${Math.floor(ageDays)} days old (downloaded ${new Date(meta.downloadedAt).toISOString().slice(0, 10)}). ` +
      `Run 'codex sync' to update. Bungie updates the manifest weekly (usually Thursdays).`,
    );
  }

  return { cfg, db };
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("codex")
    .description(
      "Destiny Codex - Turn the Destiny 2 Manifest into clean, AI-readable text.\n\n" +
        "Examples:\n" +
        "  codex sync                    # Download the manifest\n" +
        "  codex item Gjallarhorn        # Look up an item by name\n" +
        "  codex rolls \"Code Duello\"     # What can this weapon roll?\n" +
        "  codex perks Incandescent       # Which weapons can roll this perk?\n" +
        "  codex search \"Last Wish\"      # Search by name\n" +
        "  codex filter --tier Exotic --type \"Rocket Launcher\"\n" +
        "  codex compare Gjallarhorn \"Hezen Vengeance\"\n" +
        "  codex rels DestinyInventoryItemDefinition 1363886209 -d incoming\n" +
        "  codex mcp                     # Start MCP server for AI tools\n" +
        "  codex serve                   # Start REST API server for apps",
    )
    .version(FULL_VERSION);

  // ── Version ─────────────────────────────────────────────────────────
  program
    .command("version")
    .description("Show version information.")
    .addHelpText("after", "\nExample:\n  codex version")
    .action(() => {
      console.log(`Destiny Codex`);
      console.log(`version:   ${SEMVER}`);
      console.log(`date:      ${DATE_VERSION}`);
      console.log(`full:      ${FULL_VERSION}`);
    });

  // ── Config ──────────────────────────────────────────────────────────
  const config = program.command("config").description("Manage local configuration (API key, language).");

  config
    .command("set-key <key>")
    .description("Save your Bungie API key to ~/.d2manifest/apikey.")
    .action((key: string) => {
      saveApiKeyToFile(key);
      console.log("API key saved to ~/.d2manifest/apikey");
    });

  config
    .command("set-language <lang>")
    .description(
      `Save your preferred manifest language to ~/.d2manifest/language. Supported: ${SUPPORTED_LANGUAGES.join(", ")}.`,
    )
    .addHelpText(
      "after",
      "\nExamples:\n  codex config set-language de    # German\n  codex config set-language fr    # French\n  codex config set-language en    # English (default)\n\nAfter changing the language, run 'codex sync' to download the new manifest.",
    )
    .action((lang: string) => {
      const lower = lang.toLowerCase();
      if (!isSupportedLanguage(lower)) {
        console.error(`Unsupported language: "${lang}"`);
        console.error(`Supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
        process.exit(1);
      }
      saveLanguageToFile(lower);
      console.log(`Language saved: ${lower}`);
      console.log("Run 'codex sync' to download the manifest in the new language.");
    });

  config
    .command("get-language")
    .description("Show the currently saved language preference.")
    .action(() => {
      const saved = readLanguageFromFile();
      if (saved) {
        console.log(`Saved language: ${saved}`);
      } else {
        console.log("No language saved. Default: en");
        console.log("Run 'codex config set-language <lang>' to set one.");
      }
    });

  // ── Sync ────────────────────────────────────────────────────────────
  program
    .command("sync")
    .alias("s")
    .description("Download the Destiny 2 manifest SQLite DB (cached locally). Run once before using other commands.")
    .option("-f, --force", "Force re-download even if version matches.")
    .option("-l, --language <lang>", `Manifest language (default: saved or 'en'). Supported: ${SUPPORTED_LANGUAGES.join(", ")}.`)
    .addHelpText("after", "\nExamples:\n  codex sync\n  codex sync --force\n  codex sync --language de\n  codex sync -l fr")
    .action(async (opts: { force?: boolean; language?: string }) => {
      let lang = opts.language;
      if (lang) {
        lang = lang.toLowerCase();
        if (!isSupportedLanguage(lang)) {
          console.error(`Unsupported language: "${opts.language}"`);
          console.error(`Supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
          process.exit(1);
        }
      }
      const cfg = resolveConfig(lang ? { language: lang } : undefined);
      const remote = await fetchRemoteVersion(cfg);
      console.log(`Remote manifest version: ${remote.version}`);
      const meta = await ensureManifest(cfg, { force: opts.force });
      console.log(`Cached at: ${meta.sqlitePath}`);
      console.log(`Language: ${meta.language}`);
      console.log(`Downloaded: ${new Date(meta.downloadedAt).toISOString()}`);
      console.log("\nRun 'codex index' to build search indexes (recommended).");
    });

  // ── Index ───────────────────────────────────────────────────────────
  program
    .command("index")
    .description("Build search indexes (forward, name, reverse). Speeds up search/relationships/graph ~10x. Run once after sync.")
    .option("--rebuild", "Force rebuild even if a cache exists.")
    .addHelpText("after", "\nExamples:\n  codex index\n  codex index --rebuild")
    .action(async (opts: { rebuild?: boolean }) => {
      const cfg = resolveConfig();
      const meta = await ensureManifest(cfg);
      const db = openDb(meta.sqlitePath);
      const { loadSqliteIndex, buildAndCacheSqliteIndex } = await import("./index-sqlite.js");
      if (!opts.rebuild) {
        const existing = loadSqliteIndex(cfg.cacheDir, meta.version);
        if (existing) {
          console.log(`Index cache already exists for version ${meta.version}.`);
          console.log("Use --rebuild to force a rebuild.");
          existing.db.close();
          return;
        }
      }
      console.log("Building indexes...");
      const t0 = Date.now();
      const store = buildAndCacheSqliteIndex(db, cfg.cacheDir, meta.version, meta.language);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`Indexes built and cached in ${elapsed}s.`);
      store.db.close();
    });

  // ── Info ────────────────────────────────────────────────────────────
  program
    .command("info")
    .description("Show cached manifest version, download date, and table list with row counts.")
    .addHelpText("after", "\nExample:\n  codex info")
    .action(async () => {
      const { cfg, db } = await loadDb();
      const meta = await ensureManifest(cfg);
      console.log(`version: ${meta.version}`);
      console.log(`language: ${meta.language}`);
      console.log(`downloaded: ${new Date(meta.downloadedAt).toISOString()}`);
      const tables = listTables(db);
      console.log(`tables: ${tables.length}`);
      for (const t of tables) console.log(`  ${t.name}: ${t.rowCount}`);
    });

  // ── Tables ──────────────────────────────────────────────────────────
  program
    .command("tables")
    .description("List all definition tables in the manifest (name + row count).")
    .addHelpText("after", "\nExample:\n  codex tables")
    .action(async () => {
      const { db } = await loadDb();
      for (const t of listTables(db)) console.log(`${t.name}\t${t.rowCount}`);
    });

  // ── Search ──────────────────────────────────────────────────────────
  program
    .command("search <query>")
    .alias("find")
    .description("Search definitions by name (case-insensitive substring). Returns table, hash, name, description.")
    .option("-t, --table <table>", "Filter by table name, e.g. DestinyInventoryItemDefinition.")
    .option("-l, --limit <n>", "Max results.", "25")
    .addHelpText(
      "after",
      "\nExamples:\n  codex search Gjallarhorn\n  codex search \"Last Wish\" -t DestinyActivityDefinition\n  codex find \"Wolfpack Rounds\" -l 5",
    )
    .action(async (query: string, opts: { table?: string; limit: string }) => {
      const { db } = await loadDb();
      const hits = searchByName(db, query, { table: opts.table, limit: parseInt(opts.limit, 10) });
      if (hits.length === 0) {
        console.log(`No matches for "${query}".`);
        return;
      }
      hits.forEach((h, i) =>
        console.log(
          `${i + 1}. ${summarizeDefinition(h.table, h.hash, {
            displayProperties: { name: h.name, description: h.description },
          })}`,
        ),
      );
    });

  // ── Item (convenience: search + get in one step) ────────────────────
  program
    .command("item <name>")
    .description("Look up an item by name and show its full readable definition. Picks the best match automatically.")
    .option("--table <table>", "Restrict search to a table.", "DestinyInventoryItemDefinition")
    .option("--no-refs", "Do not resolve hash references.")
    .option("--depth <n>", "Max nesting depth.", "6")
    .addHelpText(
      "after",
      "\nExamples:\n  codex item Gjallarhorn\n  codex item \"Last Wish\" --table DestinyActivityDefinition\n  codex item \"Wolfpack Rounds\" --table DestinySandboxPerkDefinition",
    )
    .action(async (name: string, opts: { table: string; refs: boolean; depth: string }) => {
      const { db } = await loadDb();
      const resolved = resolveByName(db, name, opts.table);
      if (!resolved) {
        console.log(`No item named "${name}" found in ${opts.table}.`);
        console.log("Try: codex search \"" + name + "\"");
        return;
      }
      const result = formatDefinition(db, resolved.table, resolved.hash, resolved.def, {
        resolveRefs: opts.refs,
        maxDepth: parseInt(opts.depth, 10),
        index: getHashIndex(db),
      });
      console.log(result.text);
    });

  // ── Rolls (what can this weapon roll?) ──────────────────────────────
  program
    .command("rolls <name>")
    .description("Show all possible perk rolls for a weapon. Answers 'what can this weapon roll?'")
    .addHelpText(
      "after",
      "\nExamples:\n  codex rolls \"Code Duello\"\n  codex rolls \"Hezen Vengeance\"\n  codex rolls Gjallarhorn",
    )
    .action(async (name: string) => {
      const { db } = await loadDb();
      const text = rollsByName(db, name);
      if (!text) {
        console.log(`No weapon named "${name}" found.`);
        console.log("Try: codex search \"" + name + "\"");
        return;
      }
      console.log(text);
    });

  // ── Perk Search (which weapons can roll this perk?) ─────────────────
  program
    .command("perksearch <perk>")
    .alias("perks")
    .description("Find all weapons that can roll a given perk. Reverse of 'rolls'. E.g. 'codex perksearch Incandescent'.")
    .addHelpText(
      "after",
      "\nExamples:\n  codex perksearch Incandescent\n  codex perks \"Bait and Switch\"\n  codex perksearch \"Vorpal Weapon\"",
    )
    .action(async (perk: string) => {
      const { db } = await loadDb();
      const text = formatPerkWeapons(db, perk);
      console.log(text);
    });

  // ── Filter ──────────────────────────────────────────────────────────
  program
    .command("filter")
    .description("Structured filter over items. Find by type, tier, class, damage, or stat ranges.")
    .option("--tier <name>", "Tier name: Exotic, Legendary, Rare, Uncommon, Common.")
    .option("--type <name>", "Item type substring: 'Rocket Launcher', 'Helmet', 'Gauntlets'.")
    .option("--class <name>", "Class: Titan, Hunter, Warlock.")
    .option("--damage <name>", "Damage: Kinetic, Arc, Solar, Void, Stasis, Strand.")
    .option("--bucket <name>", "Bucket name: 'Power Weapons', 'Helmet', 'Chest Armor'.")
    .option("--stat <name>:<min>[:<max>]>", "Stat filter (repeatable): 'Blast Radius:80' or 'Stability:50:70'.", collectStats, [])
    .option("--name <substring>", "Filter by item name substring.")
    .option("-l, --limit <n>", "Max results.", "50")
    .addHelpText(
      "after",
      "\nExamples:\n  codex filter --tier Exotic --type \"Rocket Launcher\"\n  codex filter --tier Legendary --class Titan --bucket Helmet\n  codex filter --type \"Rocket Launcher\" --stat \"Blast Radius:90\"\n  codex filter --damage Solar --type \"Sidearm\" --limit 10",
    )
    .action(async (opts: FilterCliOpts) => {
      const { db } = await loadDb();
      const criteria: FilterCriteria = { limit: parseInt(opts.limit, 10) };
      if (opts.tier) criteria.tierTypeName = opts.tier;
      if (opts.type) criteria.itemTypeDisplayName = opts.type;
      if (opts.class) criteria.classType = CLASS_NAMES[opts.class.toLowerCase()];
      if (opts.damage) criteria.damageType = DAMAGE_NAMES[opts.damage.toLowerCase()];
      if (opts.bucket) criteria.bucketName = opts.bucket;
      if (opts.name) criteria.nameContains = opts.name;
      if (opts.stat && opts.stat.length > 0) {
        const statsByName: Record<string, { min?: number; max?: number }> = {};
        for (const s of opts.stat) {
          const [statName, minStr, maxStr] = s.split(":");
          const range: { min?: number; max?: number } = {};
          if (minStr) range.min = parseInt(minStr, 10);
          if (maxStr) range.max = parseInt(maxStr, 10);
          statsByName[statName] = range;
        }
        criteria.statsByName = statsByName;
      }
      if (opts.class && criteria.classType === undefined) {
        console.log(`Unknown class "${opts.class}". Use: Titan, Hunter, Warlock.`);
        return;
      }
      if (opts.damage && criteria.damageType === undefined) {
        console.log(`Unknown damage type "${opts.damage}". Use: Kinetic, Arc, Solar, Void, Stasis, Strand.`);
        return;
      }
      const hits = filterItems(db, criteria);
      console.log(formatFilterResults(hits));
    });

  // ── Get ─────────────────────────────────────────────────────────────
  program
    .command("get <table> <hash>")
    .description("Print a readable rendering of a definition by table + hash. All hash references resolved inline.")
    .option("--no-refs", "Do not resolve hash references.")
    .option("--depth <n>", "Max nesting depth.", "6")
    .addHelpText(
      "after",
      "\nExamples:\n  codex get DestinyInventoryItemDefinition 1363886209\n  codex get DestinyActivityDefinition 1661734046 --depth 3",
    )
    .action(async (table: string, hashStr: string, opts: { refs: boolean; depth: string }) => {
      const { db } = await loadDb();
      const hash = parseInt(hashStr, 10);
      const def = getRawDefinition(db, table, hash);
      if (!def) {
        console.log(`No definition in ${table} for hash ${hash}.`);
        return;
      }
      const result = formatDefinition(db, table, hash, def, {
        resolveRefs: opts.refs,
        maxDepth: parseInt(opts.depth, 10),
        index: getHashIndex(db),
      });
      console.log(result.text);
    });

  // ── Resolve ─────────────────────────────────────────────────────────
  program
    .command("resolve <hash>")
    .description("Resolve a bare hash (auto-detect table) to a short summary.")
    .addHelpText("after", "\nExample:\n  codex resolve 1363886209")
    .action(async (hashStr: string) => {
      const { db } = await loadDb();
      const hash = parseInt(hashStr, 10);
      const ref = resolveHash(db, hash, undefined, getHashIndex(db));
      if (!ref.found) {
        console.log(`Hash ${hash} not found in any table.`);
        return;
      }
      console.log(`Hash ${hash} -> ${ref.table}`);
      console.log(`name: ${ref.name ?? "(unnamed)"}`);
      if (ref.description) console.log(`description: ${ref.description}`);
    });

  // ── Relationships ───────────────────────────────────────────────────
  program
    .command("relationships <table> <hash>")
    .alias("rels")
    .description("Show how a definition connects to others. OUTGOING = what it references. INCOMING = what references it.")
    .option("-d, --direction <dir>", "both | outgoing | incoming", "both")
    .option("-l, --limit <n>", "Max refs per direction.", "50")
    .addHelpText(
      "after",
      "\nExamples:\n  codex rels DestinyInventoryItemDefinition 1363886209\n  codex rels DestinySandboxPerkDefinition 2447763556 -d incoming\n  codex relationships DestinyInventoryItemDefinition 1363886209 -d outgoing -l 10",
    )
    .action(async (table: string, hashStr: string, opts: { direction: string; limit: string }) => {
      const { db } = await loadDb();
      const hash = parseInt(hashStr, 10);
      const def = getRawDefinition(db, table, hash);
      if (!def) {
        console.log(`No definition in ${table} for hash ${hash}.`);
        return;
      }
      const limit = parseInt(opts.limit, 10);
      const { name } = extractNameDesc(def);
      console.log(`${name ?? "(unnamed)"} [${table} ${hash}]`);
      console.log("===");

      if (opts.direction === "both" || opts.direction === "outgoing") {
        const fwd = getHashIndex(db);
        const refs = resolveOutgoingRefs(db, extractOutgoingRefs(def, fwd));
        console.log(`OUTGOING (${refs.length}):`);
        if (refs.length === 0) console.log("  (none)");
        else {
          refs.slice(0, limit).forEach((r) => {
            const target = r.found
              ? `${r.name ?? "(unnamed)"} [${r.table} ${r.hash}]`
              : `(unresolved hash ${r.hash}${r.table ? `, ${r.table}` : ""})`;
            console.log(`  ${r.field}: ${target}`);
            console.log(`    @ ${r.path}`);
          });
          if (refs.length > limit) console.log(`  ...and ${refs.length - limit} more`);
        }
      }

      if (opts.direction === "both" || opts.direction === "incoming") {
        const incoming = findIncomingRefs(db, hash);
        console.log(`INCOMING (${incoming.length}):`);
        if (incoming.length === 0) console.log("  (none)");
        else {
          incoming.slice(0, limit).forEach((r) => {
            console.log(`  ${r.sourceName ?? "(unnamed)"} [${r.sourceTable} ${r.sourceHash}]`);
            console.log(`    via ${r.field} @ ${r.path}`);
          });
          if (incoming.length > limit) console.log(`  ...and ${incoming.length - limit} more`);
        }
      }
    });

  // ── Graph ───────────────────────────────────────────────────────────
  program
    .command("graph <table> <hash>")
    .alias("tree")
    .description("Traverse the reference graph from a definition and render it as an indented tree.")
    .option("--depth <n>", "Max hops to follow (default 2).", "2")
    .option("--branch <n>", "Max outgoing refs per node (default 20).", "20")
    .addHelpText(
      "after",
      "\nExamples:\n  codex graph DestinyInventoryItemDefinition 1363886209\n  codex tree DestinyInventoryItemDefinition 1363886209 --depth 3 --branch 10",
    )
    .action(async (table: string, hashStr: string, opts: { depth: string; branch: string }) => {
      const { db } = await loadDb();
      const hash = parseInt(hashStr, 10);
      const text = renderGraph(db, table, hash, {
        maxDepth: parseInt(opts.depth, 10),
        maxBranch: parseInt(opts.branch, 10),
      });
      console.log(text);
    });

  // ── Compare ─────────────────────────────────────────────────────────
  program
    .command("compare <names...>")
    .description("Compare 2+ items side-by-side. Stats, perks, and properties shown in columns. Names are fuzzy-matched.")
    .addHelpText(
      "after",
      "\nExamples:\n  codex compare Gjallarhorn \"Hezen Vengeance\"\n  codex compare \"Deathbringer\" \"Two-Tailed Fox\" \"Eyes of Tomorrow\"",
    )
    .action(async (names: string[]) => {
      const { db } = await loadDb();
      const items = names.map((n) => resolveByName(db, n, "DestinyInventoryItemDefinition")).filter((x) => x !== undefined) as any[];
      if (items.length < names.length) {
        const found = items.map((i) => i.name);
        const missing = names.filter((n) => !found.some((f) => f.toLowerCase() === n.toLowerCase()));
        console.log(`Could not find: ${missing.join(", ")}`);
        if (items.length === 0) return;
        console.log(`Comparing ${items.length} found item(s)...\n`);
      }
      console.log(formatComparison(db, items));
    });

  // ── Raw ─────────────────────────────────────────────────────────────
  program
    .command("raw <table> <hash>")
    .description("Print the raw JSON of a definition (unformatted). Use when 'get' is missing a field.")
    .addHelpText("after", "\nExample:\n  codex raw DestinyInventoryItemDefinition 1363886209")
    .action(async (table: string, hashStr: string) => {
      const { db } = await loadDb();
      const hash = parseInt(hashStr, 10);
      const def = getRawDefinition(db, table, hash);
      if (!def) {
        console.log(`No definition in ${table} for hash ${hash}.`);
        return;
      }
      console.log(JSON.stringify(def, null, 2));
    });

  // ── MCP ─────────────────────────────────────────────────────────────
  program
    .command("mcp")
    .description("Run as an MCP server over stdio (for AI tool integration).")
    .addHelpText("after", "\nExample:\n  codex mcp   # starts the MCP server on stdin/stdout")
    .action(async () => {
      const cfg = resolveConfig();
      await startMcpServer(cfg);
    });

  // ── REST API Server ─────────────────────────────────────────────────
  program
    .command("serve")
    .description("Start a REST API HTTP server for app integration (web apps, frontends, backends).")
    .option("-p, --port <n>", "Port number (default: 3000).", "3000")
    .option("-h, --host <host>", "Host to bind (default: localhost).", "localhost")
    .addHelpText(
      "after",
      "\nExamples:\n  codex serve                    # http://localhost:3000\n  codex serve --port 8080        # http://localhost:8080\n  codex serve --host 0.0.0.0     # accessible from network\n\nEndpoints:\n  GET /api/search?q=Gjallarhorn\n  GET /api/rolls/Code%20Duello\n  GET /api/perksearch/Incandescent\n  GET /api/filter?tier=Exotic&type=Rocket%20Launcher",
    )
    .action(async (opts: { port: string; host: string }) => {
      await startRestServer({ port: parseInt(opts.port, 10), host: opts.host });
    });

  await program.parseAsync(argv);
}

// ── Helpers for filter CLI ─────────────────────────────────────────────

const CLASS_NAMES: Record<string, number> = { titan: 0, hunter: 1, warlock: 2 };
const DAMAGE_NAMES: Record<string, number> = {
  kinetic: 1, arc: 2, solar: 3, void: 4, stasis: 6, strand: 7,
};

interface FilterCliOpts {
  tier?: string;
  type?: string;
  class?: string;
  damage?: string;
  bucket?: string;
  stat: string[];
  name?: string;
  limit: string;
}

function collectStats(value: string, previous: string[]): string[] {
  return [...previous, value];
}
