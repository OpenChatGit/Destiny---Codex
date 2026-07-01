# Destiny Codex

> Version **0.5.0.0** (07.01.2026)
>
> Turn the Destiny 2 Manifest (gibberish hash-reference JSON) into clean, AI-readable text — with full relationship traversal, structured filtering, item comparison, and weapon perk-roll extraction.

Destiny Codex is a CLI tool **and** an MCP server. It works for **100% of the manifest** — every definition table is supported generically. Hash references are resolved into human-readable names automatically, in both directions.

## Changelog

### 0.5.0.0 (07.01.2026)

**Features:**
- **`browse` MCP tool + CLI command** — Browse items with full display data: icons, stats, sockets, damage type, watermarks, flavor text. Like `filter` but enriched for visual/display use.
- **`compare` MCP tool** — Compare 2-6 items side-by-side via MCP (stats, perks, properties in aligned columns). Previously only available in CLI and REST.
- **`item` MCP tool** — Look up an item by name and get its full readable definition in one step. Replaces the search+get two-call pattern.
- **AGENTS.md updated** — `browse.ts` and `compare.ts` now documented in the architecture section.

**Bug Fixes:**
- **`resolve` MCP tool** — Removed unnecessary database query that loaded a definition only to discard it (`void def`).

---

### 0.4.0.0 (07.01.2026)

**Features:**
- **Programmatic API** (`DestinyCodex` class) — Import as a library in your own Node.js app: `import { DestinyCodex } from "destiny-codex"`.
- **REST API Server** (`codex serve`) — HTTP endpoints for web apps and frontends. No Express dependency.
- **Weapon Perk Rolls** (`codex rolls`) — Shows all possible perks a weapon can roll, grouped by socket column (barrel, mag, traits, mods, catalyst). Marks each perk as default, random, or fixed.
- **Reverse Perk Search** (`codex perksearch` / `codex perks`) — Find all weapons that can roll a given perk. The inverse of `rolls`: "which weapons can roll Incandescent?"
- **Multi-Language Support** — 14 languages via `codex config set-language <lang>`. German, French, Spanish, Japanese, and more.
- **Auto-Update Check** — Warns when the manifest is older than 7 days (Bungie updates weekly).
- **Test Suite** — 50 vitest tests covering resolver, formatter, filter, and compare modules.
- **PolyForm Noncommercial License** — This software may never be used for commercial purposes.

**Bug Fixes:**
- **Formatter** — `displayProperties.icon` was not being skipped despite being in the skip list.

## Quick Start

```bash
# 1. Install
npm install
npm run build

# 2. Add your Bungie API key (get one at https://www.bungie.net/en/Application)
cp .env.example .env
# Edit .env: BUNGIE_API_KEY=your_key_here

# 3. (Optional) Set your preferred language (default: en)
codex config set-language de    # German, French, Spanish, Japanese, etc.

# 4. Download the manifest + build indexes
node dist/index.js sync
node dist/index.js index

# 5. Use it
node dist/index.js item Gjallarhorn
```

Or save the API key persistently:
```bash
node dist/index.js config set-key your_key_here
```

## CLI Commands

### Lookup & Search

| Command | Description |
|---|---|
| `codex item <name>` | Look up an item by name, show full readable definition. Picks best match automatically. |
| `codex search <query>` | Search by name (substring, case-insensitive). `-t <table>` to filter, `-l <n>` for limit. |
| `codex filter [options]` | Structured filter: `--tier`, `--type`, `--class`, `--damage`, `--bucket`, `--stat`. |
| `codex browse [options]` | Browse items with full display data (icons, stats, sockets, damage, flavor text). Same filters as `filter` but enriched. |
| `codex rolls <name>` | Show all possible perk rolls for a weapon (barrel, mag, traits, mods, catalyst). Answers "what can this weapon roll?" |
| `codex perksearch <perk>` | Reverse perk search: find all weapons that can roll a given perk. Alias: `perks`. |
| `codex get <table> <hash>` | Full readable definition by table + hash (all refs resolved inline). |
| `codex resolve <hash>` | Bare hash → short summary (auto-detects table). |
| `codex raw <table> <hash>` | Raw JSON of a definition. |

### Relationships & Graph

| Command | Description |
|---|---|
| `codex relationships <table> <hash>` | Show outgoing + incoming references. Alias: `codex rels`. |
| `codex graph <table> <hash>` | Traverse the reference graph as a tree. Alias: `codex tree`. |
| `codex compare <name1> <name2> [name3...]` | Compare 2+ items side-by-side (stats, perks, properties). |

### Management

| Command | Description |
|---|---|
| `codex sync` | Download/refresh the manifest. `--force` to re-download. |
| `codex index` | Build search indexes (speeds up everything ~10x). `--rebuild` to force. |
| `codex info` | Show manifest version + table list. |
| `codex tables` | List all definition tables. |
| `codex mcp` | Start the MCP server (for AI tool integration). |
| `codex serve` | Start REST API HTTP server for app integration. `--port`, `--host`. |
| `codex config set-key <key>` | Save your Bungie API key. |
| `codex config set-language <lang>` | Save preferred manifest language (`de`, `fr`, `es`, `ja`, ...). Run `sync` after. |
| `codex config get-language` | Show currently saved language. |

## Examples

### Look up an item
```bash
codex item Gjallarhorn
codex item "Last Wish" --table DestinyActivityDefinition
```

### Search
```bash
codex search Gjallarhorn
codex search "Wolfpack Rounds" -t DestinySandboxPerkDefinition
codex find "Last Wish" -l 5
```

### Filter
```bash
# All Exotic Rocket Launchers
codex filter --tier Exotic --type "Rocket Launcher"

# All Legendary Titan helmets
codex filter --tier Legendary --class Titan --bucket Helmet

# Rocket Launchers with Blast Radius >= 90
codex filter --type "Rocket Launcher" --stat "Blast Radius:90"

# Solar Sidearms, max 10 results
codex filter --damage Solar --type "Sidearm" --limit 10
```

### Browse (enriched item data)
```bash
# Exotic Rocket Launchers with icons, stats, sockets, flavor text
codex browse --tier Exotic --type "Rocket Launcher"

# Legendary Titan helmets with full display data
codex browse --tier Legendary --class Titan --bucket Helmet --limit 10

# Solar Sidearms with icons and stats
codex browse --damage Solar --type "Sidearm" --limit 10
```

### Relationships (how things connect)
```bash
# What does Gjallarhorn reference? (outgoing)
codex rels DestinyInventoryItemDefinition 1363886209 -d outgoing

# Who uses the "Wolfpack Rounds" perk? (incoming)
codex rels DestinySandboxPerkDefinition 2447763556 -d incoming

# Both directions
codex rels DestinyInventoryItemDefinition 1363886209
```

### Graph traversal
```bash
codex graph DestinyInventoryItemDefinition 1363886209 --depth 3
codex tree DestinyInventoryItemDefinition 1363886209 --depth 2 --branch 10
```

### Compare items
```bash
codex compare Gjallarhorn "Hezen Vengeance"
codex compare "Deathbringer" "Two-Tailed Fox" "Eyes of Tomorrow"
```

### Weapon perk rolls
```bash
# What can Code Duello roll?
codex rolls "Code Duello"

# Exotic perks + catalyst
codex rolls Gjallarhorn

# Raid weapon rolls
codex rolls "Hezen Vengeance"
```

### Reverse perk search
```bash
# Which weapons can roll Incandescent?
codex perksearch Incandescent

# Which weapons can roll Bait and Switch?
codex perks "Bait and Switch"

# Which weapons can roll Vorpal Weapon?
codex perksearch "Vorpal Weapon"
```

### Multi-language support
```bash
# Switch to German
codex config set-language de
codex sync
codex index --rebuild

# Now everything is in German
codex item Gjallarhorn          # "Raketenwerfer (Exotisch)"
codex filter --tier Exotisch --type "Raketenwerfer"
codex rolls "Code Duello"       # "INTRINSISCHE EIGENSCHAFTEN", "WAFFEN-PERKS"

# One-off language for sync (without saving)
codex sync --language fr
codex sync -l ja

# Supported languages
en, de, es, es-mx, fr, fr-ca, it, ja, ko, pl, pt-br, ru, zh-chs, zh-cht
```

## MCP Server (for AI tools)

Destiny Codex runs as an [MCP server](https://modelcontextprotocol.io/) over stdio. AI assistants like Devin, Claude, and others can call it directly.

### Start the server
```bash
codex mcp
```

### Configure in Devin CLI
Add to `.devin/config.json`:
```json
{
  "mcpServers": {
    "destiny-codex": {
      "command": "node",
      "args": ["/path/to/destiny-codex/dist/index.js", "mcp"],
      "cwd": "/path/to/destiny-codex"
    }
  }
}
```

### MCP Tools

| Tool | Description |
|---|---|
| `manifest_info` | Manifest version, language, table list with row counts. Auto-syncs. |
| `list_tables` | All definition tables. |
| `search` | Name search with optional table filter. |
| `filter` | Structured query: itemType, tierType, classType, damageType, bucket, stat ranges. |
| `browse` | Enriched item data: icons, stats, sockets, damage, flavor text. Same filters as `filter`. |
| `rolls` | All possible perk rolls for a weapon (barrel, mag, traits, mods, catalyst). |
| `perk_search` | Reverse perk search: which weapons can roll a given perk? |
| `item` | Look up item by name → full readable definition in one step (fuzzy-matched). |
| `compare` | Compare 2-6 items side-by-side (stats, perks, properties in columns). |
| `get` | Readable text rendering of a definition (all hash refs resolved inline). |
| `resolve` | Bare hash → short summary. |
| `relationships` | Outgoing + incoming references (how things connect). |
| `graph` | Traverse the reference graph N hops deep as a tree. |
| `raw` | Raw JSON of a definition. |

## App Integration

Destiny Codex can be used as a backend in your own app — without AI, without the CLI.

### Programmatic API (Node.js)

```ts
import { DestinyCodex } from "destiny-codex";

const codex = new DestinyCodex({ apiKey: "your-bungie-key" });
await codex.sync();    // download manifest
await codex.index();   // build indexes

// Search
const hits = await codex.search("Gjallarhorn");

// Weapon perk rolls
const rolls = await codex.getRolls("Code Duello");

// Reverse perk search
const weapons = await codex.findWeaponsWithPerk("Incandescent");

// Filter
const exotics = await codex.filter({ tierTypeName: "Exotic", itemTypeDisplayName: "Rocket Launcher" });

// Browse (enriched: icons, stats, sockets, flavor text)
const browseResults = await codex.browse({ tierTypeName: "Exotic", itemTypeDisplayName: "Rocket Launcher" });

// Compare
const comparison = await codex.compare(["Gjallarhorn", "Hezen Vengeance"]);

// Relationships
const rels = await codex.relationships("DestinyInventoryItemDefinition", 1363886209);

// Raw JSON
const raw = await codex.raw("DestinyInventoryItemDefinition", 1363886209);

codex.close();
```

### REST API Server (for web apps / frontends)

```bash
codex serve --port 3000
```

All endpoints return JSON with CORS enabled:

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/info` | Manifest version, language, tables |
| `GET /api/tables` | All definition tables |
| `GET /api/search?q=<name>&table=<t>&limit=<n>` | Search by name |
| `GET /api/filter?tier=<t>&type=<t>&class=<c>&damage=<d>` | Structured filter |
| `GET /api/browse?tier=<t>&type=<t>&class=<c>&damage=<d>` | Browse items with full display data (icons, stats, sockets) |
| `GET /api/get/<table>/<hash>` | Readable definition |
| `GET /api/resolve/<hash>` | Bare hash → summary |
| `GET /api/rolls/<name-or-hash>` | Weapon perk rolls |
| `GET /api/perksearch/<perk-name-or-hash>` | Weapons that can roll a perk |
| `GET /api/compare?items=<n1,n2,n3>` | Compare items |
| `GET /api/relationships/<table>/<hash>?direction=<both\|outgoing\|incoming>` | References |
| `GET /api/graph/<table>/<hash>?depth=<n>&branch=<n>` | Graph traversal |
| `GET /api/raw/<table>/<hash>` | Raw JSON |

```bash
# Examples
curl http://localhost:3000/api/search?q=Gjallarhorn
curl http://localhost:3000/api/rolls/Code%20Duello
curl http://localhost:3000/api/perksearch/Incandescent
curl "http://localhost:3000/api/filter?tier=Exotic&type=Rocket%20Launcher&limit=5"
curl "http://localhost:3000/api/browse?tier=Exotic&type=Rocket%20Launcher&limit=5"
```

## How It Works

The Destiny 2 Manifest is a SQLite database with ~83 tables of JSON definitions. Every definition is full of hash references — `itemHash: 1363886209`, `statHash: 155624089`, etc. — that are meaningless without looking up the target.

Destiny Codex:

1. **Downloads** the manifest from Bungie's API and caches it locally as SQLite.
2. **Builds indexes** (forward hash→table, name index, reverse reference index) stored as a versioned SQLite DB.
3. **Resolves** hash references two ways:
   - **Field-name heuristic**: `itemHash` → `DestinyInventoryItemDefinition` (fast, no lookup needed)
   - **Reverse index fallback**: any hash → its table (handles unknown field names)
4. **Formats** definitions as clean, indented text with hash refs replaced by `"Gjallarhorn" (hash 1363886209, DestinyInventoryItemDefinition)` inline.
5. **Traverses** the reference graph in both directions: outgoing (what does X reference?) and incoming (who references X?).

## Performance

| Operation | Time |
|---|---|
| Manifest download | ~10s (37 MB compressed) |
| Index build | ~15s (one-time per manifest version) |
| `codex search` (with index) | ~1.3s |
| `codex rels` (with index) | ~1.2s |
| `codex graph` (with index) | ~1.2s |
| `codex filter` | ~0.3s |

## Requirements

- Node.js 22+ (uses built-in `node:sqlite`)
- A Bungie.net API key (free, get one at https://www.bungie.net/en/Application)

## Project Structure

```
src/
├── index.ts          # Entry point (loads dotenv, dispatches to CLI)
├── cli.ts            # Commander-based CLI
├── api.ts            # Programmatic API (DestinyCodex class) for app integration
├── server.ts         # REST API HTTP server (codex serve)
├── mcp-server.ts     # MCP server registering all tools
├── manifest.ts       # Bungie API client, SQLite cache, version tracking
├── resolver.ts       # Hash-reference detection + resolution
├── formatter.ts      # Definition → AI-readable text
├── relationships.ts  # Reverse index, outgoing-refs, graph traversal
├── filter.ts         # Structured filter queries
├── browse.ts         # Enriched item browsing (icons, stats, sockets, flavor text)
├── rolls.ts          # Weapon perk-roll extraction (plug sets, random rolls)
├── perksearch.ts     # Reverse perk search (which weapons can roll perk X?)
├── compare.ts        # Side-by-side item comparison
├── search.ts         # Name index for fast substring search
└── index-sqlite.ts   # SQLite-backed versioned indexes
```

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE).

This software may **never** be used for commercial purposes. Personal use,
research, education, charitable organizations, and government institutions
are permitted. See the [full license text](https://polyformproject.org/licenses/noncommercial/1.0.0)
for details.
