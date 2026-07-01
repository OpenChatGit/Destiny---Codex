import { describe, it, expect } from "vitest";
import {
  guessTableByFieldName,
  extractNameDesc,
  isHashField,
  isHashArrayField,
} from "../src/resolver.js";

describe("guessTableByFieldName", () => {
  it("resolves exact field names", () => {
    expect(guessTableByFieldName("itemHash")).toBe("DestinyInventoryItemDefinition");
    expect(guessTableByFieldName("statHash")).toBe("DestinyStatDefinition");
    expect(guessTableByFieldName("activityHash")).toBe("DestinyActivityDefinition");
    expect(guessTableByFieldName("classHash")).toBe("DestinyClassDefinition");
  });

  it("resolves plural hash fields", () => {
    expect(guessTableByFieldName("itemHashes")).toBe("DestinyInventoryItemDefinition");
    expect(guessTableByFieldName("activityHashes")).toBe("DestinyActivityDefinition");
    expect(guessTableByFieldName("perkHashes")).toBe("DestinySandboxPerkDefinition");
  });

  it("resolves case-insensitively (first char)", () => {
    expect(guessTableByFieldName("ItemHash")).toBe("DestinyInventoryItemDefinition");
    expect(guessTableByFieldName("StatHash")).toBe("DestinyStatDefinition");
  });

  it("resolves by suffix match", () => {
    expect(guessTableByFieldName("rewardItemHash")).toBe("DestinyInventoryItemDefinition");
    expect(guessTableByFieldName("previewItemHash")).toBe("DestinyInventoryItemDefinition");
    expect(guessTableByFieldName("socketCategoryHash")).toBe("DestinySocketCategoryDefinition");
  });

  it("resolves compound suffix fields", () => {
    expect(guessTableByFieldName("rewardSheetHash")).toBe("DestinyRewardSheetDefinition");
    expect(guessTableByFieldName("progressionMappingHash")).toBe("DestinyProgressionMappingDefinition");
  });

  it("returns undefined for unknown fields", () => {
    expect(guessTableByFieldName("unknownField")).toBeUndefined();
    expect(guessTableByFieldName("randomNumber")).toBeUndefined();
    expect(guessTableByFieldName("")).toBeUndefined();
  });

  it("handles edge cases", () => {
    // Fields that contain 'Hash' but aren't in the map
    expect(guessTableByFieldName("someRandomHash")).toBeUndefined();
    // 'hash' lowercase should not match (case sensitivity in suffix)
    // Actually the suffix match is case-sensitive on the key
    expect(guessTableByFieldName("hash")).toBeUndefined();
  });
});

describe("extractNameDesc", () => {
  it("extracts from displayProperties", () => {
    const def = {
      displayProperties: {
        name: "Gjallarhorn",
        description: "A legendary rocket launcher.",
      },
    };
    const { name, description } = extractNameDesc(def);
    expect(name).toBe("Gjallarhorn");
    expect(description).toBe("A legendary rocket launcher.");
  });

  it("falls back to def.name when displayProperties missing", () => {
    const def = { name: "Direct Name" };
    const { name, description } = extractNameDesc(def);
    expect(name).toBe("Direct Name");
    expect(description).toBeUndefined();
  });

  it("falls back to progressDescription", () => {
    const def = { progressDescription: "Progress Name" };
    const { name } = extractNameDesc(def);
    expect(name).toBe("Progress Name");
  });

  it("falls back to statName", () => {
    const def = { statName: "Stat Name" };
    const { name } = extractNameDesc(def);
    expect(name).toBe("Stat Name");
  });

  it("returns undefined name for empty displayProperties", () => {
    const def = { displayProperties: {} };
    const { name, description } = extractNameDesc(def);
    expect(name).toBeUndefined();
    expect(description).toBeUndefined();
  });

  it("returns undefined for empty strings", () => {
    const def = { displayProperties: { name: "", description: "" } };
    const { name, description } = extractNameDesc(def);
    expect(name).toBeUndefined();
    expect(description).toBeUndefined();
  });

  it("handles null/undefined input", () => {
    const { name, description } = extractNameDesc(undefined);
    expect(name).toBeUndefined();
    expect(description).toBeUndefined();
  });

  it("handles null displayProperties", () => {
    const def = { displayProperties: null };
    const { name } = extractNameDesc(def);
    expect(name).toBeUndefined();
  });
});

describe("isHashField", () => {
  it("matches Hash suffix", () => {
    expect(isHashField("itemHash")).toBe(true);
    expect(isHashField("statHash")).toBe(true);
    expect(isHashField("activityHash")).toBe(true);
  });

  it("matches Hashes suffix", () => {
    expect(isHashField("itemHashes")).toBe(true);
    expect(isHashField("activityHashes")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isHashField("itemhash")).toBe(true);
    expect(isHashField("ITEMHASH")).toBe(true);
    expect(isHashField("ItemHashes")).toBe(true);
  });

  it("rejects non-hash fields", () => {
    expect(isHashField("itemName")).toBe(false);
    expect(isHashField("description")).toBe(false);
  });

  it("matches 'hash' lowercase (case-insensitive regex)", () => {
    // The regex /Hash(es)?$/i matches "hash" case-insensitively
    expect(isHashField("hash")).toBe(true);
  });

  it("rejects empty and non-suffix fields", () => {
    expect(isHashField("")).toBe(false);
    expect(isHashField("Hashington")).toBe(false);
  });
});

describe("isHashArrayField", () => {
  it("matches Hashes suffix", () => {
    expect(isHashArrayField("itemHashes")).toBe(true);
    expect(isHashArrayField("activityHashes")).toBe(true);
    expect(isHashArrayField("perkHashes")).toBe(true);
  });

  it("rejects singular Hash", () => {
    expect(isHashArrayField("itemHash")).toBe(false);
    expect(isHashArrayField("statHash")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isHashArrayField("itemhashes")).toBe(true);
    expect(isHashArrayField("ITEMHASHES")).toBe(true);
  });

  it("rejects non-hash fields", () => {
    expect(isHashArrayField("itemName")).toBe(false);
    expect(isHashArrayField("")).toBe(false);
  });
});
