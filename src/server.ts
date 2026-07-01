/**
 * Destiny Codex - REST API Server
 *
 * A lightweight HTTP server that exposes all Destiny Codex query operations
 * as REST endpoints. Uses Node's built-in `http` module (no Express dependency).
 *
 * Start: `codex serve --port 3000`
 *
 * Endpoints:
 *   GET  /api/info                          - manifest version, language, tables
 *   GET  /api/tables                        - all definition tables
 *   GET  /api/search?q=<name>&table=<t>&limit=<n>
 *   GET  /api/filter?tier=<t>&type=<t>&class=<c>&damage=<d>&limit=<n>
 *   GET  /api/get/<table>/<hash>            - readable definition
 *   GET  /api/resolve/<hash>                - bare hash → summary
 *   GET  /api/rolls/<name-or-hash>          - weapon perk rolls
 *   GET  /api/perksearch/<perk-name-or-hash> - weapons that can roll a perk
 *   GET  /api/compare?items=<n1,n2,n3>      - compare items side-by-side
 *   GET  /api/relationships/<table>/<hash>?direction=<both|outgoing|incoming>
 *   GET  /api/graph/<table>/<hash>?depth=<n>&branch=<n>
 *   GET  /api/raw/<table>/<hash>            - raw JSON
 *   GET  /health                            - health check
 */

import http from "node:http";
import { DestinyCodex } from "./api.js";

export interface ServeOptions {
  port?: number;
  host?: string;
}

export async function startRestServer(opts: ServeOptions = {}): Promise<void> {
  const port = opts.port ?? 3000;
  const host = opts.host ?? "localhost";

  const codex = new DestinyCodex();
  await codex.ready();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;
      const q = url.searchParams;

      // CORS headers for web apps
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== "GET") {
        return json(res, 405, { error: "Method not allowed. Use GET." });
      }

      // ── Routes ──────────────────────────────────────────────────

      if (path === "/health") {
        return json(res, 200, { status: "ok", version: codex.Meta?.version });
      }

      if (path === "/api/info") {
        const tables = await codex.tables();
        return json(res, 200, {
          version: codex.Meta?.version,
          language: codex.Meta?.language,
          downloadedAt: codex.Meta?.downloadedAt,
          tableCount: tables.length,
          tables,
        });
      }

      if (path === "/api/tables") {
        const tables = await codex.tables();
        return json(res, 200, tables);
      }

      if (path === "/api/search") {
        const query = q.get("q");
        if (!query) return json(res, 400, { error: "Missing 'q' parameter" });
        const hits = await codex.search(query, {
          table: q.get("table") ?? undefined,
          limit: q.get("limit") ? parseInt(q.get("limit")!, 10) : 25,
        });
        return json(res, 200, hits);
      }

      if (path === "/api/filter") {
        const criteria: Record<string, any> = {};
        if (q.get("tier")) criteria.tierTypeName = q.get("tier")!;
        if (q.get("type")) criteria.itemTypeDisplayName = q.get("type")!;
        if (q.get("class")) {
          const classMap: Record<string, number> = { Titan: 0, Hunter: 1, Warlock: 2 };
          criteria.classType = classMap[q.get("class")!];
        }
        if (q.get("damage")) {
          const dmgMap: Record<string, number> = { Kinetic: 1, Arc: 2, Solar: 3, Void: 4, Stasis: 6, Strand: 7 };
          criteria.damageType = dmgMap[q.get("damage")!];
        }
        if (q.get("bucket")) criteria.bucketName = q.get("bucket")!;
        if (q.get("name")) criteria.nameContains = q.get("name")!;
        if (q.get("limit")) criteria.limit = parseInt(q.get("limit")!, 10);
        const hits = await codex.filter(criteria);
        return json(res, 200, hits);
      }

      // /api/browse — like filter but returns full display data (icons, stats, sockets)
      if (path === "/api/browse") {
        const criteria: Record<string, any> = {};
        if (q.get("tier")) criteria.tierTypeName = q.get("tier")!;
        if (q.get("type")) criteria.itemTypeDisplayName = q.get("type")!;
        if (q.get("class")) {
          const classMap: Record<string, number> = { Titan: 0, Hunter: 1, Warlock: 2 };
          criteria.classType = classMap[q.get("class")!];
        }
        if (q.get("damage")) {
          const dmgMap: Record<string, number> = { Kinetic: 1, Arc: 2, Solar: 3, Void: 4, Stasis: 6, Strand: 7 };
          criteria.damageType = dmgMap[q.get("damage")!];
        }
        if (q.get("bucket")) criteria.bucketName = q.get("bucket")!;
        if (q.get("name")) criteria.nameContains = q.get("name")!;
        criteria.limit = q.get("limit") ? parseInt(q.get("limit")!, 10) : 100;
        const items = await codex.browse(criteria);
        return json(res, 200, items);
      }

      // /api/get/<table>/<hash>
      const getMatch = path.match(/^\/api\/get\/([^/]+)\/(-?\d+)$/);
      if (getMatch) {
        const [, table, hashStr] = getMatch;
        const result = await codex.get(table, parseInt(hashStr, 10));
        return json(res, 200, result);
      }

      // /api/resolve/<hash>
      const resolveMatch = path.match(/^\/api\/resolve\/(-?\d+)$/);
      if (resolveMatch) {
        const result = await codex.resolve(parseInt(resolveMatch[1], 10));
        return json(res, 200, result);
      }

      // /api/rolls/<name-or-hash>
      const rollsMatch = path.match(/^\/api\/rolls\/(.+)$/);
      if (rollsMatch) {
        const key = decodeURIComponent(rollsMatch[1]);
        const hash = Number(key);
        const result = typeof key === "string" && !isNaN(hash) && Number.isInteger(hash)
          ? await codex.getRolls(hash)
          : await codex.getRolls(key);
        if (!result) return json(res, 404, { error: "Weapon not found" });
        return json(res, 200, result);
      }

      // /api/perksearch/<perk-name-or-hash>
      const perkMatch = path.match(/^\/api\/perksearch\/(.+)$/);
      if (perkMatch) {
        const key = decodeURIComponent(perkMatch[1]);
        const hash = Number(key);
        const result = typeof key === "string" && !isNaN(hash) && Number.isInteger(hash)
          ? await codex.findWeaponsWithPerk(hash)
          : await codex.findWeaponsWithPerk(key);
        if (!result) return json(res, 404, { error: "Perk not found" });
        return json(res, 200, result);
      }

      // /api/compare?items=Gjallarhorn,Hezen Vengeance
      if (path === "/api/compare") {
        const itemsParam = q.get("items");
        if (!itemsParam) return json(res, 400, { error: "Missing 'items' parameter (comma-separated)" });
        const names = itemsParam.split(",").map((s) => s.trim());
        const text = await codex.compare(names);
        return json(res, 200, { text });
      }

      // /api/relationships/<table>/<hash>?direction=both
      const relMatch = path.match(/^\/api\/relationships\/([^/]+)\/(-?\d+)$/);
      if (relMatch) {
        const [, table, hashStr] = relMatch;
        const direction = (q.get("direction") as "both" | "outgoing" | "incoming") ?? "both";
        const result = await codex.relationships(table, parseInt(hashStr, 10), direction);
        return json(res, 200, result);
      }

      // /api/graph/<table>/<hash>?depth=3&branch=10
      const graphMatch = path.match(/^\/api\/graph\/([^/]+)\/(-?\d+)$/);
      if (graphMatch) {
        const [, table, hashStr] = graphMatch;
        const text = await codex.graph(
          table,
          parseInt(hashStr, 10),
          q.get("depth") ? parseInt(q.get("depth")!, 10) : 3,
          q.get("branch") ? parseInt(q.get("branch")!, 10) : 10,
        );
        return json(res, 200, { text });
      }

      // /api/raw/<table>/<hash>
      const rawMatch = path.match(/^\/api\/raw\/([^/]+)\/(-?\d+)$/);
      if (rawMatch) {
        const [, table, hashStr] = rawMatch;
        const def = await codex.raw(table, parseInt(hashStr, 10));
        if (!def) return json(res, 404, { error: "Definition not found" });
        return json(res, 200, def);
      }

      // 404
      return json(res, 404, { error: `Not found: ${path}` });
    } catch (err: any) {
      return json(res, 500, { error: err?.message ?? "Internal server error" });
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${port} is already in use.`);
      console.error("");
      console.error("Solutions:");
      console.error(`  1. Use a different port:  codex serve --port ${port + 1}`);
      console.error(`  2. Find and kill the process using port ${port}:`);
      console.error(`     netstat -ano | findstr ":${port}"`);
      console.error(`     Stop-Process -Id <PID> -Force`);
      process.exit(1);
    }
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`Destiny Codex REST API server running at http://${host}:${port}`);
    console.log(`Manifest: ${codex.Meta?.version} (${codex.Meta?.language})`);
    console.log("");
    console.log("Endpoints:");
    console.log("  GET /health");
    console.log("  GET /api/info");
    console.log("  GET /api/tables");
    console.log("  GET /api/search?q=<name>&table=<t>&limit=<n>");
    console.log("  GET /api/filter?tier=<t>&type=<t>&class=<c>&damage=<d>");
    console.log("  GET /api/get/<table>/<hash>");
    console.log("  GET /api/resolve/<hash>");
    console.log("  GET /api/rolls/<name-or-hash>");
    console.log("  GET /api/perksearch/<perk-name-or-hash>");
    console.log("  GET /api/compare?items=<n1,n2,n3>");
    console.log("  GET /api/relationships/<table>/<hash>?direction=<both|outgoing|incoming>");
    console.log("  GET /api/graph/<table>/<hash>?depth=<n>&branch=<n>");
    console.log("  GET /api/raw/<table>/<hash>");
    console.log("");
    console.log("Press Ctrl+C to stop.");
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => {
      codex.close();
      console.log("Server closed. Bye!");
      process.exit(0);
    });
    // Force exit after 5s if connections don't close
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function json(res: http.ServerResponse, status: number, body: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
