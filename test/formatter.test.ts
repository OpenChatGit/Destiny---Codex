import { describe, it, expect } from "vitest";
import { formatDefinition, summarizeDefinition } from "../src/formatter.js";

/**
 * Mock DB that simulates node:sqlite well enough for getRawDefinition + getTableSchema.
 * Stores definitions as { table -> { hash -> def } }.
 */
function makeMockDb(tableData: Record<string, Record<number, any>>): any {
  // Build fake sqlite_master rows for getTableSchema
  const tables = Object.keys(tableData);
  const masterRows = tables.map((name) => ({
    name,
    sql: `CREATE TABLE "${name}" ([id] INTEGER PRIMARY KEY, [json] TEXT)`,
  }));

  return {
    prepare: (sql: string) => {
      // sqlite_master queries
      if (sql.includes("sqlite_master") && sql.includes("SELECT name")) {
        return {
          all: () => masterRows.map((r) => ({ name: r.name })),
          get: () => undefined,
          iterate: () => [],
        };
      }
      if (sql.includes("sqlite_master") && sql.includes("SELECT sql")) {
        // getTableSchema: SELECT sql FROM sqlite_master WHERE name=?
        return {
          get: (table: string) => masterRows.find((r) => r.name === table),
          all: () => [],
          iterate: () => [],
        };
      }
      // COUNT(*) queries (from listTables)
      if (sql.includes("COUNT(*)")) {
        const tableMatch = sql.match(/"([^"]+)"/);
        const tableName = tableMatch ? tableMatch[1] : "";
        return {
          get: () => ({ n: Object.keys(tableData[tableName] ?? {}).length }),
          all: () => [],
          iterate: () => [],
        };
      }
      // SELECT json FROM "Table" WHERE id = ?
      const selectMatch = sql.match(/SELECT json FROM "([^"]+)" WHERE (\w+) = \?/);
      if (selectMatch) {
        const [, tableName, keyCol] = selectMatch;
        const defs = tableData[tableName] ?? {};
        return {
          get: (key: number | string) => {
            // Convert signed int to unsigned for lookup
            const hash = typeof key === "number" ? (key >>> 0) : key;
            const def = defs[hash as number];
            return def ? { json: JSON.stringify(def) } : undefined;
          },
          all: () => [],
          iterate: function* () {
            for (const [hash, def] of Object.entries(defs)) {
              yield { k: Number(hash) | 0, json: JSON.stringify(def) };
            }
          },
        };
      }
      // SELECT id AS k, json FROM "Table" (iterateTable)
      const iterMatch = sql.match(/SELECT (\w+) AS k, json FROM "([^"]+)"/);
      if (iterMatch) {
        const [, keyCol, tableName] = iterMatch;
        const defs = tableData[tableName] ?? {};
        return {
          get: () => undefined,
          all: () => [],
          iterate: function* () {
            for (const [hash, def] of Object.entries(defs)) {
              yield { k: Number(hash) | 0, json: JSON.stringify(def) };
            }
          },
        };
      }
      // Fallback
      return {
        get: () => undefined,
        all: () => [],
        iterate: () => [],
      };
    },
  };
}

describe("summarizeDefinition", () => {
  it("produces a compact one-line summary", () => {
    const def = {
      displayProperties: { name: "Gjallarhorn", description: "Wolfpack Rounds for everyone." },
    };
    const summary = summarizeDefinition("DestinyInventoryItemDefinition", 1363886209, def);
    expect(summary).toContain("Gjallarhorn");
    expect(summary).toContain("[DestinyInventoryItemDefinition 1363886209]");
    expect(summary).toContain("Wolfpack Rounds");
  });

  it("handles unnamed definitions", () => {
    const def = { displayProperties: {} };
    const summary = summarizeDefinition("DestinyInventoryItemDefinition", 123, def);
    expect(summary).toContain("(unnamed)");
    expect(summary).toContain("[DestinyInventoryItemDefinition 123]");
  });

  it("truncates long descriptions", () => {
    const longDesc = "A".repeat(300);
    const def = { displayProperties: { name: "Test", description: longDesc } };
    const summary = summarizeDefinition("Test", 1, def);
    expect(summary.length).toBeLessThan(longDesc.length + 50);
  });
});

describe("formatDefinition", () => {
  const mockDb = makeMockDb({
    DestinyInventoryItemDefinition: {
      4043523819: { displayProperties: { name: "Impact" } },
      155624089: { displayProperties: { name: "Stability" } },
    },
    DestinyStatDefinition: {
      4043523819: { displayProperties: { name: "Impact" } },
      155624089: { displayProperties: { name: "Stability" } },
    },
  });

  it("produces a header with name, table, and hash", () => {
    const def = {
      displayProperties: { name: "Test Weapon", description: "A test weapon." },
    };
    const result = formatDefinition(mockDb, "DestinyInventoryItemDefinition", 999, def, {
      resolveRefs: false,
    });
    expect(result.text).toContain("Test Weapon");
    expect(result.text).toContain("[DestinyInventoryItemDefinition, hash 999]");
    expect(result.text).toContain("A test weapon.");
    expect(result.name).toBe("Test Weapon");
    expect(result.description).toBe("A test weapon.");
  });

  it("skips empty values by default", () => {
    const def = {
      displayProperties: { name: "Test" },
      emptyString: "",
      zeroValue: 0,
      falseValue: false,
      nullValue: null,
      emptyArray: [],
      emptyObject: {},
      realValue: 42,
    };
    const result = formatDefinition(mockDb, "Test", 1, def, { resolveRefs: false });
    expect(result.text).not.toContain("emptyString");
    expect(result.text).not.toContain("zeroValue");
    expect(result.text).not.toContain("falseValue");
    expect(result.text).not.toContain("nullValue");
    expect(result.text).not.toContain("emptyArray");
    expect(result.text).not.toContain("emptyObject");
    expect(result.text).toContain("realValue: 42");
  });

  it("includes empty values when skipEmpty is false", () => {
    const def = {
      displayProperties: { name: "Test" },
      zeroValue: 0,
      emptyString: "",
    };
    const result = formatDefinition(mockDb, "Test", 1, def, {
      resolveRefs: false,
      skipEmpty: false,
    });
    expect(result.text).toContain("zeroValue: 0");
    expect(result.text).toContain("emptyString:");
  });

  it("resolves hash references when resolveRefs is true", () => {
    const def = {
      displayProperties: { name: "Test Weapon" },
      statHash: 4043523819, // should resolve to "Impact"
    };
    const result = formatDefinition(mockDb, "DestinyInventoryItemDefinition", 1, def, {
      resolveRefs: true,
    });
    expect(result.text).toContain("Impact");
    expect(result.text).toContain("4043523819");
  });

  it("shows enum hints for known fields", () => {
    const def = {
      displayProperties: { name: "Test" },
      tierType: 6, // should show "Exotic"
      classType: 0, // should show "Titan"
    };
    const result = formatDefinition(mockDb, "Test", 1, def, {
      resolveRefs: false,
      skipEmpty: false, // classType: 0 would be skipped otherwise
    });
    expect(result.text).toContain("Exotic");
    expect(result.text).toContain("Titan");
  });

  it("respects maxDepth", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } };
    const def = { displayProperties: { name: "Test" }, nested: deep };
    const result = formatDefinition(mockDb, "Test", 1, def, {
      resolveRefs: false,
      maxDepth: 2,
    });
    expect(result.text).toContain("truncated at max depth");
  });

  it("truncates long strings", () => {
    const longStr = "A".repeat(500);
    const def = { displayProperties: { name: "Test", description: longStr } };
    const result = formatDefinition(mockDb, "Test", 1, def, {
      resolveRefs: false,
      maxStringLength: 50,
    });
    expect(result.text).toContain("…");
    expect(result.text).not.toContain("A".repeat(100));
  });

  it("handles arrays of objects", () => {
    const def = {
      displayProperties: { name: "Test" },
      items: [
        { name: "Item 1", value: 10 },
        { name: "Item 2", value: 20 },
      ],
    };
    const result = formatDefinition(mockDb, "Test", 1, def, { resolveRefs: false });
    expect(result.text).toContain("[0]:");
    expect(result.text).toContain("[1]:");
    expect(result.text).toContain("Item 1");
    expect(result.text).toContain("Item 2");
  });

  it("handles arrays of scalars", () => {
    const def = {
      displayProperties: { name: "Test" },
      numbers: [1, 2, 3],
    };
    const result = formatDefinition(mockDb, "Test", 1, def, { resolveRefs: false });
    expect(result.text).toContain("- 1");
    expect(result.text).toContain("- 2");
    expect(result.text).toContain("- 3");
  });

  it("skips default noisy fields (bug fix: displayProperties.icon)", () => {
    const def = {
      displayProperties: { name: "Test", icon: "/common/destiny2_content/icons/icon.png" },
      hash: 12345,
      redacted: false,
      hasIcon: true,
    };
    const result = formatDefinition(mockDb, "Test", 1, def, { resolveRefs: false });
    expect(result.text).not.toContain("icon.png");
    expect(result.text).not.toContain("redacted");
    expect(result.text).not.toContain("hasIcon");
  });
});
