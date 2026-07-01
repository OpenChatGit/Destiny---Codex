import type { DatabaseSync } from "node:sqlite";
import { filterItems, type FilterCriteria, type FilterHit } from "./filter.js";
import { getRawDefinition } from "./manifest.js";
import { extractNameDesc } from "./resolver.js";

export interface BrowseItem extends FilterHit {
  icon?: string;
  watermark?: string;
  screenshot?: string;
  damageType?: number;
  flavorText?: string;
  itemCategoryHashes?: number[];
  stats?: { name: string; value: number; maximum: number }[];
  sockets?: { index: number; category: string; perkHashes: number[] }[];
}

/**
 * Browse items with full display data: icons, stats, damage type, sockets.
 * Uses filter() internally, then enriches each hit with display properties.
 */
export function browseItems(db: DatabaseSync, criteria: FilterCriteria & { limit?: number }): BrowseItem[] {
  const hits = filterItems(db, criteria);
  const limit = criteria.limit ?? 100;
  const results: BrowseItem[] = [];

  for (const hit of hits.slice(0, limit)) {
    const def = getRawDefinition(db, "DestinyInventoryItemDefinition", hit.hash);
    if (!def) {
      results.push(hit);
      continue;
    }

    const item: BrowseItem = {
      ...hit,
      icon: def.displayProperties?.icon,
      watermark: def.iconWatermark || def.quality?.displayVersionWatermarkIcons?.[0],
      screenshot: def.screenshot,
      damageType: def.defaultDamageType,
      flavorText: def.flavorText,
      itemCategoryHashes: def.itemCategoryHashes,
    };

    // Extract stats
    if (def.stats?.stats) {
      item.stats = [];
      for (const [, statBlock] of Object.entries(def.stats.stats)) {
        const sb = statBlock as any;
        if (sb.statHash && sb.value !== undefined) {
          const statDef = getRawDefinition(db, "DestinyStatDefinition", sb.statHash);
          const statName = statDef?.displayProperties?.name;
          if (statName) {
            item.stats.push({
              name: statName,
              value: sb.value,
              maximum: sb.maximum ?? 100,
            });
          }
        }
      }
    }

    // Extract socket categories with perk hashes
    if (def.sockets?.socketEntries && def.sockets.socketCategories) {
      const catByIndex = new Map<number, string>();
      for (const cat of def.sockets.socketCategories) {
        const catDef = getRawDefinition(db, "DestinySocketCategoryDefinition", cat.socketCategoryHash);
        const catName = catDef?.displayProperties?.name ?? "";
        for (const idx of cat.socketIndexes ?? []) {
          catByIndex.set(idx, catName);
        }
      }

      item.sockets = [];
      def.sockets.socketEntries.forEach((sock: any, i: number) => {
        const perkHashes: number[] = [];
        if (sock.singleInitialItemHash) perkHashes.push(sock.singleInitialItemHash);
        if (sock.reusablePlugItems) {
          for (const p of sock.reusablePlugItems) {
            if (p.plugItemHash) perkHashes.push(p.plugItemHash);
          }
        }
        item.sockets!.push({
          index: i,
          category: catByIndex.get(i) ?? "",
          perkHashes,
        });
      });
    }

    results.push(item);
  }

  return results;
}
