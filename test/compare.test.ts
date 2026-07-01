import { describe, it, expect } from "vitest";
import { formatComparison, type CompareItem } from "../src/compare.js";

/**
 * Mock DB that simulates node:sqlite for getRawDefinition + getTableSchema.
 */
function makeMockDb(tableData: Record<string, Record<number, any>>): any {
  const tables = Object.keys(tableData);
  const masterRows = tables.map((name) => ({
    name,
    sql: `CREATE TABLE "${name}" ([id] INTEGER PRIMARY KEY, [json] TEXT)`,
  }));

  return {
    prepare: (sql: string) => {
      if (sql.includes("sqlite_master") && sql.includes("SELECT name")) {
        return { all: () => masterRows.map((r) => ({ name: r.name })), get: () => undefined, iterate: () => [] };
      }
      if (sql.includes("sqlite_master") && sql.includes("SELECT sql")) {
        return { get: (table: string) => masterRows.find((r) => r.name === table), all: () => [], iterate: () => [] };
      }
      if (sql.includes("COUNT(*)")) {
        const m = sql.match(/"([^"]+)"/);
        const t = m ? m[1] : "";
        return { get: () => ({ n: Object.keys(tableData[t] ?? {}).length }), all: () => [], iterate: () => [] };
      }
      const selectMatch = sql.match(/SELECT json FROM "([^"]+)" WHERE (\w+) = \?/);
      if (selectMatch) {
        const [, tableName] = selectMatch;
        const defs = tableData[tableName] ?? {};
        return {
          get: (key: number | string) => {
            const hash = typeof key === "number" ? (key >>> 0) : key;
            const def = defs[hash as number];
            return def ? { json: JSON.stringify(def) } : undefined;
          },
          all: () => [],
          iterate: () => [],
        };
      }
      return { get: () => undefined, all: () => [], iterate: () => [] };
    },
  };
}

describe("formatComparison", () => {
  it("handles empty items array", () => {
    const text = formatComparison(makeMockDb({}), []);
    expect(text).toBe("No items to compare.");
  });

  it("formats two items side-by-side with header", () => {
    const db = makeMockDb({
      DestinyInventoryBucketDefinition: {
        1: { displayProperties: { name: "Power Weapons" } },
        2: { displayProperties: { name: "Power Weapons" } },
      },
    });

    const items: CompareItem[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 100,
        name: "Gjallarhorn",
        def: {
          displayProperties: { name: "Gjallarhorn" },
          inventory: { tierTypeName: "Exotic", bucketTypeHash: 1 },
          itemTypeDisplayName: "Rocket Launcher",
          classType: 3,
          defaultDamageType: 3,
        },
      },
      {
        table: "DestinyInventoryItemDefinition",
        hash: 200,
        name: "Hezen Vengeance",
        def: {
          displayProperties: { name: "Hezen Vengeance" },
          inventory: { tierTypeName: "Legendary", bucketTypeHash: 2 },
          itemTypeDisplayName: "Rocket Launcher",
          classType: 3,
          defaultDamageType: 3,
        },
      },
    ];

    const text = formatComparison(db, items);
    expect(text).toContain("COMPARISON");
    expect(text).toContain("Gjallarhorn");
    expect(text).toContain("Hezen Vengeance");
    expect(text).toContain("Exotic");
    expect(text).toContain("Legendary");
    expect(text).toContain("Rocket Launcher");
  });

  it("shows stats section", () => {
    const db = makeMockDb({
      DestinyStatDefinition: {
        3614673599: { displayProperties: { name: "Blast Radius" } },
      },
    });

    const items: CompareItem[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 1,
        name: "Weapon A",
        def: {
          displayProperties: { name: "Weapon A" },
          inventory: { tierTypeName: "Legendary" },
          classType: 3,
          stats: { stats: { "3614673599": { value: 90 } } },
        },
      },
      {
        table: "DestinyInventoryItemDefinition",
        hash: 2,
        name: "Weapon B",
        def: {
          displayProperties: { name: "Weapon B" },
          inventory: { tierTypeName: "Legendary" },
          classType: 3,
          stats: { stats: { "3614673599": { value: 75 } } },
        },
      },
    ];

    const text = formatComparison(db, items);
    expect(text).toContain("STATS");
    expect(text).toContain("Blast Radius");
    expect(text).toContain("90");
    expect(text).toContain("75");
  });

  it("shows no stats message when items have no stats", () => {
    const db = makeMockDb({});
    const items: CompareItem[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 1,
        name: "No Stats Item",
        def: { displayProperties: { name: "No Stats Item" }, classType: 3 },
      },
      {
        table: "DestinyInventoryItemDefinition",
        hash: 2,
        name: "Also No Stats",
        def: { displayProperties: { name: "Also No Stats" }, classType: 3 },
      },
    ];

    const text = formatComparison(db, items);
    expect(text).toContain("(no stats)");
  });

  it("shows perks and sockets section", () => {
    const db = makeMockDb({
      DestinySocketCategoryDefinition: {
        3956125808: { displayProperties: { name: "Intrinsic Traits" } },
      },
      DestinyInventoryItemDefinition: {
        9999: { displayProperties: { name: "Wolfpack Rounds", description: "Splits into tracking missiles." } },
        8888: { displayProperties: { name: "Aggressive Frame", description: "High damage, high recoil." } },
      },
    });

    const items: CompareItem[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 1,
        name: "Gjallarhorn",
        def: {
          displayProperties: { name: "Gjallarhorn" },
          inventory: { tierTypeName: "Exotic" },
          classType: 3,
          sockets: {
            socketEntries: [
              { singleInitialItemHash: 9999 },
            ],
            socketCategories: [
              { socketCategoryHash: 3956125808, socketIndexes: [0] },
            ],
          },
        },
      },
      {
        table: "DestinyInventoryItemDefinition",
        hash: 2,
        name: "Code Duello",
        def: {
          displayProperties: { name: "Code Duello" },
          inventory: { tierTypeName: "Legendary" },
          classType: 3,
          sockets: {
            socketEntries: [
              { singleInitialItemHash: 8888 },
            ],
            socketCategories: [
              { socketCategoryHash: 3956125808, socketIndexes: [0] },
            ],
          },
        },
      },
    ];

    const text = formatComparison(db, items);
    expect(text).toContain("PERKS & SOCKETS");
    expect(text).toContain("Intrinsic Traits");
    expect(text).toContain("Wolfpack Rounds");
    expect(text).toContain("Aggressive Frame");
  });

  it("shows class names correctly", () => {
    const db = makeMockDb({});
    const items: CompareItem[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 1,
        name: "Titan Armor",
        def: { displayProperties: { name: "Titan Armor" }, classType: 0, inventory: {} },
      },
      {
        table: "DestinyInventoryItemDefinition",
        hash: 2,
        name: "Hunter Armor",
        def: { displayProperties: { name: "Hunter Armor" }, classType: 1, inventory: {} },
      },
    ];

    const text = formatComparison(db, items);
    expect(text).toContain("Titan");
    expect(text).toContain("Hunter");
  });
});
