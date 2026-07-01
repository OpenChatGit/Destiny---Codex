import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

const BUNGIE_ROOT = "https://www.bungie.net";
const MANIFEST_ENDPOINT = "/Platform/Destiny2/Manifest/";

export interface ManifestMeta {
  version: string;
  mobileWorldContentPath: string; // for the chosen language
  language: string;
  downloadedAt: number; // epoch ms
  sqlitePath: string;
}

export interface ManifestInfo {
  version: string;
  language: string;
  downloadedAt: number;
  tables: { name: string; rowCount: number }[];
  sqlitePath: string;
}

export interface ManifestConfig {
  apiKey: string;
  language: string; // default "en"
  cacheDir: string; // default ~/.d2manifest
}

export function defaultCacheDir(): string {
  return join(homedir(), ".d2manifest");
}

export function resolveConfig(partial?: Partial<ManifestConfig>): ManifestConfig {
  const apiKey =
    partial?.apiKey ??
    process.env.BUNGIE_API_KEY ??
    readApiKeyFromFile();
  if (!apiKey) {
    throw new Error(
      "No Bungie API key provided. Set BUNGIE_API_KEY env var or run `codex config set-key <key>`.",
    );
  }
  const cacheDir = partial?.cacheDir ?? process.env.D2_CACHE_DIR ?? defaultCacheDir();
  return {
    apiKey,
    language: partial?.language ?? process.env.D2_LANGUAGE ?? "en",
    cacheDir,
  };
}

function apiKeyFilePath(cacheDir: string): string {
  return join(cacheDir, "apikey");
}

function readApiKeyFromFile(): string | undefined {
  const dir = defaultCacheDir();
  const file = apiKeyFilePath(dir);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return undefined;
}

export function saveApiKeyToFile(key: string, cacheDir: string = defaultCacheDir()): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(apiKeyFilePath(cacheDir), key.trim(), { mode: 0o600 });
}

async function bungieGet(path: string, apiKey: string): Promise<any> {
  const url = path.startsWith("http") ? path : BUNGIE_ROOT + path;
  const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bungie API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  const json: any = await res.json();
  if (json.ErrorCode && json.ErrorCode !== 1) {
    throw new Error(`Bungie API error ${json.ErrorCode}: ${json.Message}`);
  }
  return json.Response ?? json;
}

function metaFilePath(cacheDir: string): string {
  return join(cacheDir, "meta.json");
}

function readMeta(cacheDir: string): ManifestMeta | undefined {
  const file = metaFilePath(cacheDir);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as ManifestMeta;
}

function writeMeta(cacheDir: string, meta: ManifestMeta): void {
  writeFileSync(metaFilePath(cacheDir), JSON.stringify(meta, null, 2));
}

/**
 * Returns the current manifest version string from Bungie (without downloading the DB).
 */
export async function fetchRemoteVersion(config: ManifestConfig): Promise<{ version: string; mobileWorldContentPath: string }> {
  const manifest: any = await bungieGet(MANIFEST_ENDPOINT, config.apiKey);
  const version: string = manifest.version;
  const lang = config.language ?? "en";
  const path: string | undefined = manifest.mobileWorldContentPaths?.[lang];
  if (!path) {
    throw new Error(`No mobileWorldContentPath for language "${lang}". Available: ${Object.keys(manifest.mobileWorldContentPaths ?? {}).join(", ")}`);
  }
  return { version, mobileWorldContentPath: path };
}

/**
 * Ensures a local cached SQLite copy of the manifest exists and is up to date.
 * Returns metadata about the loaded manifest. Does NOT keep a DB connection open.
 */
export async function ensureManifest(config: ManifestConfig, opts?: { force?: boolean }): Promise<ManifestMeta> {
  mkdirSync(config.cacheDir, { recursive: true });
  const existing = readMeta(config.cacheDir);
  const remote = await fetchRemoteVersion(config);

  const sqlitePath = join(config.cacheDir, `world_${config.language}.sqlite`);
  const needsDownload =
    opts?.force ||
    !existing ||
    existing.version !== remote.version ||
    !existsSync(sqlitePath);

  if (needsDownload) {
    const url = BUNGIE_ROOT + remote.mobileWorldContentPath;
    const tmpPath = sqlitePath + ".tmp";
    const res = await fetch(url, { headers: { "X-API-Key": config.apiKey } });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download manifest DB: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Bungie's mobileWorldContentPaths are ZIP archives containing a single
    // uncompressed SQLite file (named "<something>.content"). Extract it.
    const zip = new AdmZip(buf);
    const entry = zip.getEntries()[0];
    if (!entry) throw new Error("Manifest ZIP archive is empty.");
    const unzipped = entry.getData();
    writeFileSync(tmpPath, unzipped);
    if (existsSync(sqlitePath)) rmSync(sqlitePath);
    renameSync(tmpPath, sqlitePath);

    const meta: ManifestMeta = {
      version: remote.version,
      mobileWorldContentPath: remote.mobileWorldContentPath,
      language: config.language ?? "en",
      downloadedAt: Date.now(),
      sqlitePath,
    };
    writeMeta(config.cacheDir, meta);
    return meta;
  }

  return { ...existing!, sqlitePath };
}

export function openDb(sqlitePath: string): DatabaseSync {
  if (!existsSync(sqlitePath)) {
    throw new Error(`Manifest SQLite not found at ${sqlitePath}. Run 'codex sync' first.`);
  }
  return new DatabaseSync(sqlitePath, { readOnly: true });
}

/**
 * Lists all definition tables in the manifest with row counts.
 */
export function listTables(db: DatabaseSync): { name: string; rowCount: number }[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Destiny%' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map((r) => {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get() as { n: number };
    return { name: r.name, rowCount: c.n };
  });
}

const SCHEMA_CACHE = new WeakMap<DatabaseSync, Map<string, { keyCol: string; isTextKey: boolean }>>();

/**
 * Returns the primary-key column info for a table. Most Destiny tables use
 * `id` (INTEGER), but a few (e.g. DestinyHistoricalStatsDefinition) use `key` (TEXT).
 */
export function getTableSchema(db: DatabaseSync, table: string): { keyCol: string; isTextKey: boolean } {
  let cache = SCHEMA_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    SCHEMA_CACHE.set(db, cache);
  }
  const cached = cache.get(table);
  if (cached) return cached;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string } | undefined;
  const sql = row?.sql ?? "";
  // Look for the primary key column definition.
  const idMatch = /\[id\]\s+INTEGER/i.exec(sql);
  const keyMatch = /\[key\]\s+TEXT/i.exec(sql);
  const result = idMatch
    ? { keyCol: "id", isTextKey: false }
    : keyMatch
      ? { keyCol: "key", isTextKey: true }
      : { keyCol: "id", isTextKey: false };
  cache.set(table, result);
  return result;
}

/**
 * SQLite stores the hash as a signed 32-bit int. Convert unsigned hash -> signed id.
 */
export function hashToId(hash: number): number {
  return hash | 0;
}

/**
 * Fetches the raw JSON definition for a single (table, hash).
 * For INTEGER-keyed tables, `hash` is treated as the unsigned 32-bit hash and
 * converted to the signed id SQLite stores. For TEXT-keyed tables, `hash` is
 * ignored and `key` (a string) is expected via `getRawDefinitionByKey`.
 */
export function getRawDefinition(db: DatabaseSync, table: string, hash: number): any | undefined {
  const schema = getTableSchema(db, table);
  const stmt = db.prepare(`SELECT json FROM "${table}" WHERE ${schema.keyCol} = ?`);
  const keyValue = schema.isTextKey ? String(hash) : hashToId(hash);
  const row = stmt.get(keyValue) as { json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.json);
}

/**
 * Fetches a definition by its string key (for TEXT-keyed tables like
 * DestinyHistoricalStatsDefinition).
 */
export function getRawDefinitionByKey(db: DatabaseSync, table: string, key: string): any | undefined {
  const stmt = db.prepare(`SELECT json FROM "${table}" WHERE key = ?`);
  const row = stmt.get(key) as { json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.json);
}

/**
 * Returns all rows of a table as {hash, json, key?}. Use sparingly (some tables are huge).
 * For INTEGER-keyed tables, `hash` is the unsigned 32-bit id.
 * For TEXT-keyed tables, `hash` is 0 and `key` is the string primary key.
 */
export function* iterateTable(
  db: DatabaseSync,
  table: string,
): Generator<{ hash: number; key?: string; json: any }> {
  const schema = getTableSchema(db, table);
  const stmt = db.prepare(`SELECT ${schema.keyCol} AS k, json FROM "${table}"`);
  for (const row of stmt.iterate() as Iterable<{ k: number | string; json: string }>) {
    if (schema.isTextKey) {
      yield { hash: 0, key: String(row.k), json: JSON.parse(row.json) };
    } else {
      yield { hash: (row.k as number) >>> 0, json: JSON.parse(row.json) };
    }
  }
}
