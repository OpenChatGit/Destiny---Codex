import { DatabaseSync } from "node:sqlite";
import { hashToId } from "../src/manifest.js";

/**
 * Builds a tiny in-memory manifest DB that mimics the real Bungie SQLite
 * schema (bracketed `[id] INTEGER` / `[json] TEXT` columns, `Destiny*` table
 * names) so the core query logic can be tested without a real manifest or
 * network access.
 */

export interface FixtureDef {
  hash: number;
  json: any;
}

const STAT_BLAST_RADIUS = 3614673599;
const STAT_VELOCITY = 2523465841;

export const FIXTURE = {
  statBlastRadius: STAT_BLAST_RADIUS,
  statVelocity: STAT_VELOCITY,
  socketCategoryWeaponPerks: 1,
  socketTypeTrait: 10,
  plugSet: 100,
  perkIncandescent: 201,
  perkVorpal: 202,
  perkHighImpact: 203,
  weaponRocket: 1000,
  weaponSidearm: 1001,
};

export function makeFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  const tables: Record<string, FixtureDef[]> = {
    DestinyStatDefinition: [
      { hash: STAT_BLAST_RADIUS, json: { displayProperties: { name: "Blast Radius" } } },
      { hash: STAT_VELOCITY, json: { displayProperties: { name: "Velocity" } } },
    ],
    DestinySocketCategoryDefinition: [
      { hash: 1, json: { displayProperties: { name: "WEAPON PERKS" } } },
    ],
    DestinySocketTypeDefinition: [
      { hash: 10, json: { displayProperties: { name: "Trait" } } },
    ],
    DestinyPlugSetDefinition: [
      {
        hash: 100,
        json: {
          reusablePlugItems: [
            { plugItemHash: 201 },
            { plugItemHash: 202 },
          ],
        },
      },
    ],
    DestinyInventoryItemDefinition: [
      {
        hash: 201,
        json: {
          displayProperties: { name: "Incandescent", description: "Defeating targets creates a burst of Solar." },
          investmentStats: [{ statTypeHash: STAT_BLAST_RADIUS, value: 10 }],
        },
      },
      {
        hash: 202,
        json: { displayProperties: { name: "Vorpal Weapon", description: "Increased damage against bosses." } },
      },
      {
        hash: 203,
        json: { displayProperties: { name: "High-Impact Frame", description: "Slow firing and high damage." } },
      },
      {
        hash: 1000,
        json: {
          displayProperties: { name: "Test Rocket", description: "A test rocket launcher." },
          itemType: 3,
          itemSubType: 8,
          itemTypeDisplayName: "Rocket Launcher",
          defaultDamageType: 3,
          classType: 3,
          inventory: { tierType: 6, tierTypeName: "Exotic" },
          stats: {
            stats: {
              [STAT_BLAST_RADIUS]: { statHash: STAT_BLAST_RADIUS, value: 90, maximum: 100 },
              [STAT_VELOCITY]: { statHash: STAT_VELOCITY, value: 40, maximum: 100 },
            },
          },
          sockets: {
            socketCategories: [{ socketCategoryHash: 1, socketIndexes: [0, 1] }],
            socketEntries: [
              { singleInitialItemHash: 203, socketTypeHash: 10 },
              { randomizedPlugSetHash: 100, socketTypeHash: 10 },
            ],
          },
        },
      },
      {
        hash: 1001,
        json: {
          displayProperties: { name: "Test Sidearm", description: "A test sidearm." },
          itemType: 3,
          itemSubType: 14,
          itemTypeDisplayName: "Sidearm",
          defaultDamageType: 1,
          classType: 3,
          inventory: { tierType: 5, tierTypeName: "Legendary" },
          stats: {
            stats: {
              [STAT_VELOCITY]: { statHash: STAT_VELOCITY, value: 20, maximum: 100 },
            },
          },
        },
      },
    ],
  };

  for (const [table, defs] of Object.entries(tables)) {
    db.exec(`CREATE TABLE ${table} ([id] INTEGER PRIMARY KEY, [json] TEXT NOT NULL)`);
    const stmt = db.prepare(`INSERT INTO ${table} ([id], [json]) VALUES (?, ?)`);
    for (const d of defs) {
      stmt.run(hashToId(d.hash), JSON.stringify(d.json));
    }
  }

  return db;
}
