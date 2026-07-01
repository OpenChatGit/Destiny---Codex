/**
 * Destiny Codex - Programmatic API
 *
 * Use this module to integrate Destiny Codex into your own Node.js app
 * without the CLI or MCP server.
 *
 * @example
 * ```ts
 * import { DestinyCodex } from "destiny-codex";
 *
 * const codex = new DestinyCodex({ apiKey: "your-key" });
 * await codex.sync();           // download manifest
 * await codex.index();          // build indexes
 *
 * const results = codex.search("Gjallarhorn");
 * const rolls = codex.getRolls("Code Duello");
 * const weapons = codex.findWeaponsWithPerk("Incandescent");
 * ```
 */

import type { DatabaseSync } from "node:sqlite";
import {
  ensureManifest,
  openDb,
  resolveConfig,
  type ManifestConfig,
  type ManifestMeta,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  saveLanguageToFile,
} from "./manifest.js";
import { searchByName, type SearchHit } from "./search.js";
import { formatDefinition, type FormatOptions, type FormatResult } from "./formatter.js";
import { getRawDefinition, listTables } from "./manifest.js";
import { getHashIndex, resolveHash, type HashIndex } from "./resolver.js";
import { filterItems, type FilterCriteria, type FilterHit } from "./filter.js";
import { resolveByName, formatComparison, type CompareItem } from "./compare.js";
import { getWeaponRolls, formatRolls, type PerkSlot } from "./rolls.js";
import { findWeaponsWithPerk, formatPerkWeapons, type PerkWeaponMatch } from "./perksearch.js";
import {
  extractOutgoingRefs,
  findIncomingRefs,
  resolveOutgoingRefs,
  renderGraph,
  type OutgoingRef,
  type IncomingRef,
} from "./relationships.js";
import { getSqliteIndexes } from "./index-sqlite.js";

export interface CodexOptions {
  /** Bungie API key (required). Or set BUNGIE_API_KEY env var. */
  apiKey?: string;
  /** Manifest language (default: "en"). */
  language?: string;
  /** Cache directory (default: ~/.d2manifest). */
  cacheDir?: string;
}

/**
 * Main API class for Destiny Codex.
 *
 * Manages manifest download, indexing, and all query operations.
 * Call `sync()` once, then use the query methods.
 */
export class DestinyCodex {
  private config: ManifestConfig;
  private _db: DatabaseSync | undefined;
  private meta: ManifestMeta | undefined;
  private hashIndex: HashIndex | undefined;

  constructor(opts: CodexOptions = {}) {
    this.config = resolveConfig({
      apiKey: opts.apiKey,
      language: opts.language,
      cacheDir: opts.cacheDir,
    });
  }

  /** Current configuration (apiKey, language, cacheDir). */
  get Config(): ManifestConfig {
    return this.config;
  }

  /** Current manifest metadata (version, language, download date). */
  get Meta(): ManifestMeta | undefined {
    return this.meta;
  }

  /** Supported manifest languages. */
  static get SupportedLanguages(): readonly string[] {
    return SUPPORTED_LANGUAGES;
  }

  /** Check if a language code is supported. */
  static isSupportedLanguage(lang: string): boolean {
    return isSupportedLanguage(lang);
  }

  /** Change the language preference (persists to disk). Call `sync()` after. */
  setLanguage(lang: string): void {
    if (!isSupportedLanguage(lang)) {
      throw new Error(`Unsupported language: "${lang}". Supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
    }
    this.config = resolveConfig({ ...this.config, language: lang });
    saveLanguageToFile(lang, this.config.cacheDir);
    // Reset DB so it reopens with the new language
    this._db?.close();
    this._db = undefined;
    this.meta = undefined;
    this.hashIndex = undefined;
  }

  /** Download/refresh the manifest. Returns manifest metadata. */
  async sync(force = false): Promise<ManifestMeta> {
    this.meta = await ensureManifest(this.config, { force });
    return this.meta;
  }

  /** Build search indexes (speeds up search/relationships/graph). */
  async index(rebuild = false): Promise<void> {
    await this.ready();
    const d = this._db!;
    if (!rebuild) {
      const existing = getSqliteIndexes(d, this.config.cacheDir, this.meta!.version, this.meta!.language);
      if (existing) return;
    }
    const { buildAndCacheSqliteIndex } = await import("./index-sqlite.js");
    buildAndCacheSqliteIndex(d, this.config.cacheDir, this.meta!.version, this.meta!.language);
  }

  /** Ensure manifest is downloaded and DB is open. Called automatically by query methods. */
  async ready(): Promise<void> {
    if (!this.meta) {
      this.meta = await ensureManifest(this.config);
    }
    if (!this._db) {
      this._db = openDb(this.meta.sqlitePath);
      getSqliteIndexes(this._db, this.config.cacheDir, this.meta.version, this.meta.language);
      this.hashIndex = getHashIndex(this._db);
    }
  }

  private db_(): DatabaseSync {
    if (!this._db || !this.meta || !this.hashIndex) {
      throw new Error("Not ready. Call sync() + index() first, or await ready().");
    }
    return this._db;
  }

  // ── Query Methods ──────────────────────────────────────────────────

  /** Search definitions by name (substring, case-insensitive). */
  async search(query: string, opts?: { table?: string; limit?: number }): Promise<SearchHit[]> {
    await this.ready();
    return searchByName(this.db_(), query, opts);
  }

  /** Get a readable text rendering of a definition by table + hash. */
  async get(table: string, hash: number, opts?: FormatOptions): Promise<FormatResult> {
    await this.ready();
    const d = this.db_();
    const def = getRawDefinition(d, table, hash);
    if (!def) throw new Error(`No definition found: ${table} ${hash}`);
    return formatDefinition(d, table, hash, def, { index: this.hashIndex, ...opts });
  }

  /** Resolve a bare hash to its definition (auto-detects table). */
  async resolve(hash: number): Promise<{ hash: number; table: string; name?: string; found: boolean }> {
    await this.ready();
    return resolveHash(this.db_(), hash, undefined, this.hashIndex);
  }

  /** Look up an item by name (fuzzy-matched). Returns the raw definition. */
  async getItem(name: string, table = "DestinyInventoryItemDefinition"): Promise<CompareItem | undefined> {
    await this.ready();
    return resolveByName(this.db_(), name, table);
  }

  /** Structured filter: find items by tier, type, class, damage, stats. */
  async filter(criteria: FilterCriteria): Promise<FilterHit[]> {
    await this.ready();
    return filterItems(this.db_(), criteria);
  }

  /** Get all possible perk rolls for a weapon (by name or hash). */
  async getRolls(nameOrHash: string | number): Promise<{ name: string; slots: PerkSlot[] } | undefined> {
    await this.ready();
    const d = this.db_();
    if (typeof nameOrHash === "number") {
      return getWeaponRolls(d, nameOrHash);
    }
    const item = resolveByName(d, nameOrHash, "DestinyInventoryItemDefinition");
    if (!item) return undefined;
    return getWeaponRolls(d, item.hash);
  }

  /** Get all possible perk rolls formatted as readable text. */
  async getRollsText(nameOrHash: string | number): Promise<string> {
    await this.ready();
    const d = this.db_();
    if (typeof nameOrHash === "number") {
      return formatRolls(d, nameOrHash);
    }
    const item = resolveByName(d, nameOrHash, "DestinyInventoryItemDefinition");
    if (!item) return `No weapon named "${nameOrHash}" found.`;
    return formatRolls(d, item.hash);
  }

  /** Reverse perk search: find all weapons that can roll a given perk. */
  async findWeaponsWithPerk(nameOrHash: string | number): Promise<{ perkName: string; perkHash: number; weapons: PerkWeaponMatch[] } | undefined> {
    await this.ready();
    return findWeaponsWithPerk(this.db_(), nameOrHash);
  }

  /** Compare 2+ items side-by-side. */
  async compare(names: string[]): Promise<string> {
    await this.ready();
    const d = this.db_();
    const items: CompareItem[] = [];
    for (const name of names) {
      const item = resolveByName(d, name, "DestinyInventoryItemDefinition");
      if (item) items.push(item);
    }
    return formatComparison(d, items);
  }

  /** Show outgoing + incoming references for a definition. */
  async relationships(table: string, hash: number, direction: "both" | "outgoing" | "incoming" = "both"): Promise<{
    outgoing: OutgoingRef[];
    incoming: IncomingRef[];
  }> {
    await this.ready();
    const d = this.db_();
    const def = getRawDefinition(d, table, hash);
    let outgoing: OutgoingRef[] = [];
    if (direction !== "incoming" && def) {
      const rawRefs = extractOutgoingRefs(def, this.hashIndex);
      outgoing = resolveOutgoingRefs(d, rawRefs);
    }
    const incoming = direction !== "outgoing" ? findIncomingRefs(d, hash) : [];
    return { outgoing, incoming };
  }

  /** Traverse the reference graph as a tree. */
  async graph(table: string, hash: number, depth = 3, branch = 10): Promise<string> {
    await this.ready();
    return renderGraph(this.db_(), table, hash, { maxDepth: depth, maxBranch: branch });
  }

  /** Get raw JSON of a definition. */
  async raw(table: string, hash: number): Promise<any | undefined> {
    await this.ready();
    return getRawDefinition(this.db_(), table, hash);
  }

  /** List all definition tables with row counts. */
  async tables(): Promise<{ name: string; rowCount: number }[]> {
    await this.ready();
    return listTables(this.db_());
  }

  /** Close the database connection. */
  close(): void {
    this._db?.close();
    this._db = undefined;
  }
}

// Re-export all types and utility functions for advanced usage
export type { ManifestConfig, ManifestMeta } from "./manifest.js";
export type { SearchHit } from "./search.js";
export type { FormatOptions, FormatResult } from "./formatter.js";
export type { FilterCriteria, FilterHit } from "./filter.js";
export type { CompareItem } from "./compare.js";
export type { PerkSlot, PerkOption } from "./rolls.js";
export type { PerkWeaponMatch } from "./perksearch.js";
export type { HashIndex, ResolvedRef } from "./resolver.js";
export { SUPPORTED_LANGUAGES, isSupportedLanguage } from "./manifest.js";
export { extractNameDesc, guessTableByFieldName, isHashField } from "./resolver.js";
