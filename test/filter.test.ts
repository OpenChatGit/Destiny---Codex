import { describe, it, expect } from "vitest";
import { formatFilterResults, type FilterHit } from "../src/filter.js";

describe("formatFilterResults", () => {
  it("handles empty results", () => {
    const text = formatFilterResults([]);
    expect(text).toBe("No items matched the filter criteria.");
  });

  it("formats a single result", () => {
    const hits: FilterHit[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 1363886209,
        name: "Gjallarhorn",
        tierTypeName: "Exotic",
        itemTypeDisplayName: "Rocket Launcher",
        damageType: 3,
        classType: 3,
      },
    ];
    const text = formatFilterResults(hits);
    expect(text).toContain("1 item matched:");
    expect(text).toContain("[Exotic]");
    expect(text).toContain("Rocket Launcher");
    expect(text).toContain("Gjallarhorn");
    expect(text).toContain("1363886209");
  });

  it("formats multiple results with plural", () => {
    const hits: FilterHit[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 1,
        name: "Item A",
        tierTypeName: "Legendary",
        itemTypeDisplayName: "Hand Cannon",
      },
      {
        table: "DestinyInventoryItemDefinition",
        hash: 2,
        name: "Item B",
        tierTypeName: "Legendary",
        itemTypeDisplayName: "Scout Rifle",
      },
    ];
    const text = formatFilterResults(hits);
    expect(text).toContain("2 items matched:");
    expect(text).toContain("Item A");
    expect(text).toContain("Item B");
  });

  it("shows class and damage for non-Any class items", () => {
    const hits: FilterHit[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 100,
        name: "Titan Helmet",
        classType: 0, // Titan
        damageType: 2, // Arc
      },
    ];
    const text = formatFilterResults(hits);
    expect(text).toContain("class=0");
    expect(text).toContain("dmg=2");
  });

  it("hides class for classType 3 (Any)", () => {
    const hits: FilterHit[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 100,
        name: "Universal Item",
        classType: 3, // Any
      },
    ];
    const text = formatFilterResults(hits);
    expect(text).not.toContain("class=");
  });

  it("shows matched stats", () => {
    const hits: FilterHit[] = [
      {
        table: "DestinyInventoryItemDefinition",
        hash: 200,
        name: "High Blast Weapon",
        matchedStats: [
          { name: "Blast Radius", value: 95 },
          { name: "Velocity", value: 80 },
        ],
      },
    ];
    const text = formatFilterResults(hits);
    expect(text).toContain("Blast Radius");
    expect(text).toContain("95");
    expect(text).toContain("Velocity");
    expect(text).toContain("80");
  });
});
