# Destiny Codex

Version **0.5.1.0** (02.07.2026)

CLI + MCP server that turns the Destiny 2 Manifest (gibberish hash-reference JSON)
into clean, AI-readable text with full relationship traversal. Works for **100% of
the manifest** — every definition table is supported generically.

## Setup

```bash
npm install
npm run build
```

Create a `.env` (see `.env.example`) with your Bungie.net API key:

```
BUNGIE_API_KEY=<key from https://www.bungie.net/en/Application>
```

Or save it persistently: `node dist/index.js config set-key <key>`

### Language

The manifest is available in 14 languages. Default is `en`. To switch:

```bash
codex config set-language de    # German
codex sync                      # download the German manifest
codex index --rebuild           # rebuild indexes for the new language
```

Or use a one-off language for sync: `codex sync --language fr`.

Supported: `en`, `de`, `es`, `es-mx`, `fr`, `fr-ca`, `it`, `ja`, `ko`, `pl`, `pt-br`, `ru`, `zh-chs`, `zh-cht`.

## Commands

| Command | Description |
|---|---|
| `npm run build` | TypeScript compile (`tsc`) → `dist/` |
| `npm test` | Run vitest test suite (74 tests, ~0.8s; uses an in-memory fixture manifest, no network) |
| `node dist/index.js sync [--force]` | Download/refresh manifest SQLite DB |
| `node dist/index.js index [--rebuild]` | Build/cache all indexes (forward, name, reverse). Speeds up search/relationships/graph ~3-4x. |
| `node dist/index.js info` | Cached version + table list with row counts |
| `node dist/index.js tables` | All definition tables |
| `node dist/index.js search "<name>" [-t <table>] [-l <n>]` | Search by name |
| `node dist/index.js filter [options]` | Structured filter (type/tier/class/damage/stats). E.g. `--tier-name Exotic --type-name "Rocket Launcher"` |
| `node dist/index.js browse [options]` | Browse items with full display data (icons, stats, sockets, damage, flavor text). Same filters as `filter` but enriched. |
| `node dist/index.js rolls "<name>"` | Show all possible perk rolls for a weapon (barrel, mag, traits, mods, catalyst). Answers "what can this weapon roll?" |
| `node dist/index.js perksearch <perk>` | Reverse perk search: find all weapons that can roll a given perk. Alias: `perks`. |
| `node dist/index.js item "<name>"` | Look up an item by name → readable definition in one step (fuzzy-matched) |
| `node dist/index.js compare <names...>` | Compare 2+ items side-by-side (stats, perks, properties in columns) |
| `node dist/index.js get <table> <hash> [--no-refs] [--depth <n>]` | Readable rendering of one definition (hash refs resolved inline) |
| `node dist/index.js resolve <hash>` | Auto-detect table for a bare hash |
| `node dist/index.js relationships <table> <hash> [-d both\|outgoing\|incoming] [-l <n>]` | Show how a definition connects to others (outgoing refs + reverse incoming refs) |
| `node dist/index.js graph <table> <hash> [--depth <n>] [--branch <n>]` | Traverse the reference graph as an indented tree |
| `node dist/index.js raw <table> <hash>` | Raw JSON of a definition |
| `node dist/index.js mcp` | Run as MCP server over stdio |
| `node dist/index.js serve [--port <n>] [--host <h>]` | Start REST API HTTP server for app integration (default: localhost:3000) |
| `node dist/index.js config set-language <lang>` | Save preferred manifest language (e.g. `de`, `fr`, `en`). Run `sync` after. |
| `node dist/index.js config get-language` | Show currently saved language preference |

## MCP tools (same as CLI)

- `manifest_info` — version, language, tables, row counts (auto-syncs)
- `list_tables` — all definition tables
- `search` — name search with optional table filter
- `filter` — structured query: itemType, tierType, classType, damageType, bucket, stat ranges (by name or hash)
- `browse` — enriched item data (icons, stats, sockets, damage, flavor text). Same filters as `filter`.
- `rolls` — all possible perk rolls for a weapon (from plug sets + random-roll pools)
- `perk_search` — reverse perk search: which weapons can roll a given perk?
- `item` — look up item by name → readable definition in one step (fuzzy-matched)
- `compare` — compare 2+ items side-by-side (stats, perks, properties in columns)
- `get` — readable text rendering of a definition (refs resolved)
- `resolve` — bare hash → short summary
- `relationships` — outgoing + incoming references (how things connect, both directions)
- `graph` — traverse the reference graph N hops deep as a tree
- `raw` — raw JSON of a definition

## Architecture

- `src/manifest.ts` — Bungie API client, SQLite cache (node:sqlite), version tracking
- `src/resolver.ts` — hash-reference detection (field-name heuristics + reverse index)
- `src/formatter.ts` — definition → AI-readable text with inline-resolved refs
- `src/relationships.ts` — reverse index (who references me?), outgoing-ref extraction, graph traversal
- `src/filter.ts` — structured filter queries (itemType, tier, class, damage, stats)
- `src/browse.ts` — enriched item browsing (icons, stats, sockets, damage, flavor text) built on filter
- `src/rolls.ts` — weapon perk-roll extraction (plug sets, random-roll pools, reusable plug items)
- `src/perksearch.ts` — reverse perk search (which weapons can roll perk X?)
- `src/compare.ts` — side-by-side item comparison (stats, perks, properties in columns)
- `src/index-sqlite.ts` — SQLite-backed versioned indexes (forward + name in memory, reverse + weapon_perks on-demand) for fast startup
- `src/enums.ts` — central class/damage enum <-> name mappings shared by CLI, MCP, REST, formatters
- `src/sockets.ts` — shared weapon-socket / perk extraction used by `rolls`, `perksearch`, and the `weapon_perks` index build
- `src/search.ts` — name index for fast substring search
- `src/mcp-server.ts` — MCP server registering all tools
- `src/cli.ts` — commander-based CLI mirroring the MCP tools
- `src/index.ts` — entry point (loads dotenv, dispatches to CLI)
- `src/api.ts` — programmatic API class (`DestinyCodex`) for app integration
- `src/server.ts` — REST API HTTP server (`codex serve`)

## Notes

- Manifest DB is cached at `~/.d2manifest/world_<lang>.sqlite` (~70 MB for `en`, one file per language). Metadata is per-language (`meta_<lang>.json`).
- The remote manifest version is only checked when the cache is missing, on `codex sync`, or when the last check is older than 1 hour. If Bungie is unreachable, the cached manifest is used (offline mode).
- Language preference is persisted at `~/.d2manifest/language`. Override with `D2_LANGUAGE` env var or `--language` flag on `sync`.
- Index DB is cached at `~/.d2manifest/index_<version>.db` (~420 MB, rebuilt on manifest version change). It includes a `weapon_perks` table that powers fast `perksearch`; caches built before 0.5.1.0 fall back to a full scan until `codex index --rebuild` is run.
- Hash references are resolved two ways: (1) field-name heuristic
  (`itemHash` → `DestinyInventoryItemDefinition`), (2) reverse index fallback
  (any hash → its table). Both are transparent to the caller.
- `node:sqlite` is used (Node 22+ with `--experimental-sqlite` flag on older
  versions; Node 26 has it stable).
- Auto-update check: if the manifest is older than 7 days, a warning is printed
  to stderr on every command. Bungie updates the manifest weekly (usually Thursdays).
