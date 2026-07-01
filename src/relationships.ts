import { DatabaseSync } from "node:sqlite";
import {
  getRawDefinition,
  getTableSchema,
  iterateTable,
  listTables,
} from "./manifest.js";
import {
  extractNameDesc,
  getHashIndex,
  guessTableByFieldName,
  isHashArrayField,
  isHashField,
  type HashIndex,
} from "./resolver.js";

/**
 * A single hash reference found while scanning a definition.
 * `path` is a dotted path to the field, e.g. "sockets.socketEntries[2].singleInitialItemHash".
 */
export interface OutgoingRef {
  /** Dotted path within the source definition, e.g. "sockets.socketEntries[0].singleInitialItemHash". */
  path: string;
  /** Field name that held the hash (last segment), e.g. "singleInitialItemHash". */
  field: string;
  /** Target hash (unsigned 32-bit). */
  hash: number;
  /** Best-guess target table (from field-name heuristic or reverse index). */
  table?: string;
  /** Resolved target name, if the definition exists. */
  name?: string;
  found: boolean;
}

export interface IncomingRef {
  /** Table of the source definition that references us. */
  sourceTable: string;
  /** Hash of the source definition. */
  sourceHash: number;
  /** Name of the source definition. */
  sourceName?: string;
  /** Dotted path where the reference lives, e.g. "sockets.socketEntries[0].singleInitialItemHash". */
  path: string;
  /** Field name. */
  field: string;
}

const REVERSE_INDEX_KEY = Symbol("d2ReverseIndex");

export interface ReverseIndex {
  /** target hash -> list of references pointing at it */
  byTarget: Map<number, IncomingRef[]>;
}

/**
 * Builds (lazily, cached on the db) a reverse index:
 * for every hash H that appears in any definition's hash-field,
 * we record who referenced it and via which field/path.
 *
 * This is what powers "who points to me?" lookups.
 */
export function getReverseIndex(db: DatabaseSync): ReverseIndex {
  const anyDb = db as any;
  if (anyDb.__d2ReverseIndex) return anyDb.__d2ReverseIndex;
  if (anyDb[REVERSE_INDEX_KEY]) return anyDb[REVERSE_INDEX_KEY];
  const byTarget = new Map<number, IncomingRef[]>();
  const fwd = getHashIndex(db);

  for (const t of listTables(db)) {
    const schema = getTableSchema(db, t.name);
    if (schema.isTextKey) continue;
    for (const row of iterateTable(db, t.name)) {
      const sourceHash = row.hash;
      const def = row.json;
      const refs = extractOutgoingRefs(def, fwd);
      for (const r of refs) {
        let bucket = byTarget.get(r.hash);
        if (!bucket) {
          bucket = [];
          byTarget.set(r.hash, bucket);
        }
        bucket.push({
          sourceTable: t.name,
          sourceHash,
          sourceName: extractNameDesc(def).name,
          path: r.path,
          field: r.field,
        });
      }
    }
  }

  const idx = { byTarget };
  anyDb[REVERSE_INDEX_KEY] = idx;
  return idx;
}

/**
 * Walks a definition's JSON and collects every hash reference it contains,
 * with its dotted path. Returns them in stable (depth-first) order.
 */
export function extractOutgoingRefs(def: any, fwd?: HashIndex): OutgoingRef[] {
  const out: OutgoingRef[] = [];
  walk(def, "");
  return out;

  function walk(value: any, prefix: string): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${prefix}[${i}]`);
      }
      return;
    }
    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        const v = value[key];
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof v === "number" && isFinite(v) && v !== 0 && isHashField(key)) {
          out.push({
            path,
            field: key,
            hash: v >>> 0,
            table: guessTableByFieldName(key) ?? fwd?.byHash.get(v >>> 0),
            found: false,
          });
        } else if (Array.isArray(v) && isHashArrayField(key)) {
          v.forEach((h, i) => {
            if (typeof h === "number" && isFinite(h) && h !== 0) {
              out.push({
                path: `${path}[${i}]`,
                field: key,
                hash: h >>> 0,
                table: guessTableByFieldName(key) ?? fwd?.byHash.get(h >>> 0),
                found: false,
              });
            }
          });
        } else if (typeof v === "object" && v !== null) {
          walk(v, path);
        }
      }
      return;
    }
  }
}

/**
 * Enriches outgoing refs with resolved names by looking up each target.
 */
export function resolveOutgoingRefs(db: DatabaseSync, refs: OutgoingRef[]): OutgoingRef[] {
  return refs.map((r) => {
    if (!r.table) return { ...r, found: false };
    try {
      const def = getRawDefinition(db, r.table, r.hash);
      if (def) {
        const { name } = extractNameDesc(def);
        return { ...r, found: true, name };
      }
    } catch {
      // table may not exist
    }
    return { ...r, found: false };
  });
}

/**
 * Returns all definitions that reference the given hash (incoming edges).
 * Uses SQLite on-demand query if available, otherwise in-memory Map.
 */
export function findIncomingRefs(db: DatabaseSync, hash: number): IncomingRef[] {
  const idx = getReverseIndex(db);
  // SQLite-backed: query on demand
  const stmt = (idx as any).__queryStmt;
  if (stmt) {
    const rows = stmt.all(hash) as {
      source_table: string;
      source_hash: number;
      source_name: string | null;
      path: string;
      field: string;
    }[];
    return rows.map((r) => ({
      sourceTable: r.source_table,
      sourceHash: r.source_hash,
      sourceName: r.source_name ?? undefined,
      path: r.path,
      field: r.field,
    }));
  }
  // In-memory fallback
  return idx.byTarget.get(hash) ?? [];
}

export interface GraphNode {
  table: string;
  hash: number;
  name?: string;
}

export interface GraphEdge {
  from: GraphNode;
  to: GraphNode;
  field: string;
  path: string;
  found: boolean;
}

/**
 * Breadth-first traversal of the reference graph starting at (table, hash).
 * Follows outgoing references up to `maxDepth` hops, avoiding cycles.
 * Returns a flat list of edges (from -> to) which can be rendered as a tree.
 */
export function buildGraph(
  db: DatabaseSync,
  table: string,
  hash: number,
  opts: { maxDepth?: number; maxBranch?: number } = {},
): { edges: GraphEdge[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 2;
  const maxBranch = opts.maxBranch ?? 20;
  const fwd = getHashIndex(db);
  const edges: GraphEdge[] = [];
  const visited = new Set<string>(); // "table:hash"
  let truncated = false;

  const startDef = getRawDefinition(db, table, hash);
  const startName = startDef ? extractNameDesc(startDef).name : undefined;
  const startNode: GraphNode = { table, hash, name: startName };
  visited.add(`${table}:${hash}`);

  const queue: { node: GraphNode; depth: number }[] = [{ node: startNode, depth: 0 }];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const def = getRawDefinition(db, node.table, node.hash);
    if (!def) continue;
    const refs = extractOutgoingRefs(def, fwd);
    let count = 0;
    for (const r of refs) {
      if (count >= maxBranch) {
        truncated = true;
        break;
      }
      const targetTable = r.table ?? fwd.byHash.get(r.hash);
      if (!targetTable) {
        edges.push({
          from: node,
          to: { table: "(unknown)", hash: r.hash },
          field: r.field,
          path: r.path,
          found: false,
        });
        count++;
        continue;
      }
      const targetDef = getRawDefinition(db, targetTable, r.hash);
      const targetName = targetDef ? extractNameDesc(targetDef).name : undefined;
      const targetNode: GraphNode = { table: targetTable, hash: r.hash, name: targetName };
      const key = `${targetTable}:${r.hash}`;
      edges.push({
        from: node,
        to: targetNode,
        field: r.field,
        path: r.path,
        found: !!targetDef,
      });
      count++;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ node: targetNode, depth: depth + 1 });
      }
    }
  }

  return { edges, truncated };
}

/**
 * Renders the graph edges as an indented tree rooted at the start node.
 */
export function renderGraph(db: DatabaseSync, table: string, hash: number, opts: { maxDepth?: number; maxBranch?: number } = {}): string {
  const { edges, truncated } = buildGraph(db, table, hash, opts);
  const startDef = getRawDefinition(db, table, hash);
  const startName = startDef ? extractNameDesc(startDef).name : "(unnamed)";
  const lines: string[] = [];
  lines.push(`${startName} [${table} ${hash}]`);

  // Group edges by source node path, render children indented.
  // We render by depth: for each node, list its outgoing edges.
  const childrenByNode = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const k = `${e.from.table}:${e.from.hash}`;
    let arr = childrenByNode.get(k);
    if (!arr) {
      arr = [];
      childrenByNode.set(k, arr);
    }
    arr.push(e);
  }

  const rendered = new Set<string>();
  const rootKey = `${table}:${hash}`;
  renderNode(rootKey, 1);

  function renderNode(key: string, indent: number): void {
    if (rendered.has(key)) {
      lines.push(`${"  ".repeat(indent)}(... already shown)`);
      return;
    }
    rendered.add(key);
    const kids = childrenByNode.get(key) ?? [];
    for (const e of kids) {
      const targetLabel = e.found
        ? `${e.to.name ?? "(unnamed)"} [${e.to.table} ${e.to.hash}]`
        : `(unresolved hash ${e.to.hash})`;
      lines.push(`${"  ".repeat(indent)}- ${e.field}: ${targetLabel}`);
      const childKey = `${e.to.table}:${e.to.hash}`;
      if (childrenByNode.has(childKey) && !rendered.has(childKey)) {
        renderNode(childKey, indent + 1);
      }
    }
  }

  if (truncated) lines.push("(... some branches truncated, raise maxBranch to see more)");
  return lines.join("\n");
}
