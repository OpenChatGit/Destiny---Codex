# Destiny Codex

> Version **0.2.4.022** (07.01.2026)
>
> Turn the Destiny 2 Manifest (gibberish hash-reference JSON) into clean, AI-readable text — with full relationship traversal, structured filtering, and item comparison.

Destiny Codex is a CLI tool **and** an MCP server. It works for **100% of the manifest** — every definition table is supported generically. Hash references are resolved into human-readable names automatically, in both directions.

## Quick Start

```bash
# 1. Install
npm install
npm run build

# 2. Add your Bungie API key (get one at https://www.bungie.net/en/Application)
cp .env.example .env
# Edit .env: BUNGIE_API_KEY=your_key_here

# 3. Download the manifest + build indexes
node dist/index.js sync
node dist/index.js index

# 4. Use it
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
| `codex config set-key <key>` | Save your Bungie API key. |

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
| `get` | Readable text rendering of a definition (all hash refs resolved inline). |
| `resolve` | Bare hash → short summary. |
| `relationships` | Outgoing + incoming references (how things connect). |
| `graph` | Traverse the reference graph N hops deep as a tree. |
| `raw` | Raw JSON of a definition. |

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
├── mcp-server.ts     # MCP server registering all tools
├── manifest.ts       # Bungie API client, SQLite cache, version tracking
├── resolver.ts       # Hash-reference detection + resolution
├── formatter.ts      # Definition → AI-readable text
├── relationships.ts  # Reverse index, outgoing-refs, graph traversal
├── filter.ts         # Structured filter queries
├── compare.ts        # Side-by-side item comparison
├── search.ts         # Name index for fast substring search
└── index-sqlite.ts   # SQLite-backed versioned indexes
```

## License

MIT
