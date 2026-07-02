import { describe, it, expect } from "vitest";
import { extractOutgoingRefs, resolveOutgoingRefs } from "../src/relationships.js";
import { getHashIndex } from "../src/resolver.js";
import { makeFixtureDb, FIXTURE } from "./fixture.js";

describe("extractOutgoingRefs", () => {
  it("collects hash references with dotted paths", () => {
    const db = makeFixtureDb();
    const def = { statHash: FIXTURE.statBlastRadius, nested: { itemHash: FIXTURE.perkIncandescent } };
    const refs = extractOutgoingRefs(def, getHashIndex(db));
    const byField = Object.fromEntries(refs.map((r) => [r.field, r]));
    expect(byField.statHash.hash).toBe(FIXTURE.statBlastRadius);
    expect(byField.itemHash.path).toBe("nested.itemHash");
    db.close();
  });

  it("resolves refs to target names", () => {
    const db = makeFixtureDb();
    const def = { statHash: FIXTURE.statBlastRadius };
    const resolved = resolveOutgoingRefs(db, extractOutgoingRefs(def, getHashIndex(db)));
    expect(resolved[0].found).toBe(true);
    expect(resolved[0].name).toBe("Blast Radius");
    db.close();
  });

  it("ignores zero and non-hash fields", () => {
    const db = makeFixtureDb();
    const refs = extractOutgoingRefs({ statHash: 0, value: 5, name: "x" }, getHashIndex(db));
    expect(refs).toHaveLength(0);
    db.close();
  });
});
