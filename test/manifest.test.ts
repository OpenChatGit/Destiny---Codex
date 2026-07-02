import { describe, it, expect } from "vitest";
import {
  getRawDefinition,
  listTables,
  getTableSet,
  hashToId,
  getTableSchema,
} from "../src/manifest.js";
import { makeFixtureDb, FIXTURE } from "./fixture.js";

describe("manifest core", () => {
  it("round-trips a definition by hash", () => {
    const db = makeFixtureDb();
    const def = getRawDefinition(db, "DestinyInventoryItemDefinition", FIXTURE.weaponRocket);
    expect(def?.displayProperties?.name).toBe("Test Rocket");
    db.close();
  });

  it("throws on an unknown table (SQL-injection guard)", () => {
    const db = makeFixtureDb();
    expect(() => getRawDefinition(db, "DestinyInventoryItemDefinition; DROP TABLE x", 1)).toThrow(/Unknown table/);
    expect(() => getRawDefinition(db, "NotARealTable", 1)).toThrow(/Unknown table/);
    db.close();
  });

  it("lists only Destiny* tables", () => {
    const db = makeFixtureDb();
    const names = listTables(db).map((t) => t.name);
    expect(names).toContain("DestinyInventoryItemDefinition");
    expect(names.every((n) => n.startsWith("Destiny"))).toBe(true);
    db.close();
  });

  it("exposes a table set for validation", () => {
    const db = makeFixtureDb();
    const set = getTableSet(db);
    expect(set.has("DestinyStatDefinition")).toBe(true);
    expect(set.has("Nope")).toBe(false);
    db.close();
  });

  it("detects integer primary key schema", () => {
    const db = makeFixtureDb();
    const schema = getTableSchema(db, "DestinyInventoryItemDefinition");
    expect(schema.keyCol).toBe("id");
    expect(schema.isTextKey).toBe(false);
    db.close();
  });

  it("converts unsigned hashes to signed ids", () => {
    expect(hashToId(0xffffffff)).toBe(-1);
    expect(hashToId(1)).toBe(1);
  });
});
