import { describe, it, expect } from "vitest";
import { filterItems, getStatMaps } from "../src/filter.js";
import { getWeaponRolls } from "../src/rolls.js";
import { findWeaponsWithPerk } from "../src/perksearch.js";
import { extractSocketPerks, dbPlugSetResolver } from "../src/sockets.js";
import { getRawDefinition } from "../src/manifest.js";
import { makeFixtureDb, FIXTURE } from "./fixture.js";

describe("getStatMaps", () => {
  it("builds name<->hash maps from the manifest", () => {
    const db = makeFixtureDb();
    const maps = getStatMaps(db);
    expect(maps.nameToHashes.get("blast radius")).toContain(FIXTURE.statBlastRadius);
    expect(maps.hashToName.get(FIXTURE.statVelocity)).toBe("Velocity");
    db.close();
  });
});

describe("filterItems", () => {
  it("filters by tier and type", () => {
    const db = makeFixtureDb();
    const hits = filterItems(db, { tierTypeName: "Exotic", itemTypeDisplayName: "Rocket Launcher" });
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe("Test Rocket");
    db.close();
  });

  it("filters by stat name range (dynamic hash resolution)", () => {
    const db = makeFixtureDb();
    const hits = filterItems(db, { statsByName: { "Blast Radius": { min: 80 } } });
    expect(hits.map((h) => h.name)).toEqual(["Test Rocket"]);
    expect(hits[0].matchedStats?.[0]).toEqual({ name: "Blast Radius", value: 90 });
    db.close();
  });

  it("excludes items below the stat threshold", () => {
    const db = makeFixtureDb();
    const hits = filterItems(db, { statsByName: { "Velocity": { min: 30 } } });
    expect(hits.map((h) => h.name)).toEqual(["Test Rocket"]); // sidearm velocity 20 excluded
    db.close();
  });
});

describe("getWeaponRolls", () => {
  it("extracts perks from initial + randomized plug set", () => {
    const db = makeFixtureDb();
    const rolls = getWeaponRolls(db, FIXTURE.weaponRocket);
    expect(rolls?.name).toBe("Test Rocket");
    const perkNames = rolls!.slots.flatMap((s) => s.perks.map((p) => p.name));
    expect(perkNames).toContain("High-Impact Frame");
    expect(perkNames).toContain("Incandescent");
    expect(perkNames).toContain("Vorpal Weapon");
    db.close();
  });

  it("marks the randomized socket as random", () => {
    const db = makeFixtureDb();
    const rolls = getWeaponRolls(db, FIXTURE.weaponRocket);
    const randomSlot = rolls!.slots.find((s) => s.perks.some((p) => p.name === "Incandescent"));
    expect(randomSlot?.isRandom).toBe(true);
    db.close();
  });
});

describe("findWeaponsWithPerk (slow path)", () => {
  it("finds weapons that can roll a perk by name", () => {
    const db = makeFixtureDb();
    const result = findWeaponsWithPerk(db, "Incandescent");
    expect(result?.perkHash).toBe(FIXTURE.perkIncandescent);
    expect(result?.weapons.map((w) => w.name)).toEqual(["Test Rocket"]);
    expect(result?.weapons[0].isRandom).toBe(true);
    db.close();
  });

  it("returns undefined for an unknown perk", () => {
    const db = makeFixtureDb();
    expect(findWeaponsWithPerk(db, "Nonexistent Perk")).toBeUndefined();
    db.close();
  });
});

describe("extractSocketPerks", () => {
  it("dedupes and flags default vs random perks", () => {
    const db = makeFixtureDb();
    const def = getRawDefinition(db, "DestinyInventoryItemDefinition", FIXTURE.weaponRocket);
    const sockets = extractSocketPerks(def, dbPlugSetResolver(db));
    expect(sockets).toHaveLength(2);

    const initial = sockets[0].perks;
    expect(initial).toEqual([{ plugItemHash: FIXTURE.perkHighImpact, isDefault: true, isRandom: false }]);

    const random = sockets[1];
    expect(random.isRandom).toBe(true);
    expect(random.perks.map((p) => p.plugItemHash)).toEqual([FIXTURE.perkIncandescent, FIXTURE.perkVorpal]);
    expect(random.perks.every((p) => p.isRandom)).toBe(true);
    db.close();
  });
});
