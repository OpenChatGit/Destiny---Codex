import type { DatabaseSync } from "node:sqlite";
import { getRawDefinition } from "./manifest.js";

/**
 * Shared weapon-socket / perk extraction.
 *
 * Three features need the exact same "which perks live in which socket, and
 * are they random-rolled?" logic: `rolls` (what can this weapon roll?),
 * `perksearch` (which weapons can roll this perk?), and the `weapon_perks`
 * index build. Keeping it in one place stops those paths from drifting apart.
 */

export interface SocketPerk {
  plugItemHash: number;
  /** Came from the socket's singleInitialItemHash (default/fixed perk). */
  isDefault: boolean;
  /** Came from a randomizedPlugSetHash (random-roll pool). */
  isRandom: boolean;
}

export interface SocketPerks {
  index: number;
  socketTypeHash?: number;
  /** Perks for this socket, ordered by source and deduped by plug hash. */
  perks: SocketPerk[];
  /** Whether this socket has a randomized plug set. */
  isRandom: boolean;
}

/** Resolves a plug-set hash to the list of plug item hashes it contains. */
export type PlugSetResolver = (plugSetHash: number) => number[];

/**
 * Extracts every candidate perk plug hash per socket, from all sources
 * (singleInitialItemHash, randomizedPlugSetHash, reusablePlugSetHash,
 * reusablePlugItems), deduplicated per socket and in a stable order.
 */
export function extractSocketPerks(def: any, resolvePlugSet: PlugSetResolver): SocketPerks[] {
  const out: SocketPerks[] = [];
  const socketEntries: any[] = def?.sockets?.socketEntries ?? [];

  for (let i = 0; i < socketEntries.length; i++) {
    const sock = socketEntries[i];
    if (!sock) continue;

    const seen = new Set<number>();
    const perks: SocketPerk[] = [];
    let isRandom = false;

    const add = (hash: number | undefined, isDefault: boolean, random: boolean): void => {
      if (!hash || hash === 0 || seen.has(hash)) return;
      seen.add(hash);
      perks.push({ plugItemHash: hash, isDefault, isRandom: random });
    };

    add(sock.singleInitialItemHash, true, false);

    if (sock.randomizedPlugSetHash) {
      isRandom = true;
      for (const h of resolvePlugSet(sock.randomizedPlugSetHash)) add(h, false, true);
    }
    if (sock.reusablePlugSetHash) {
      for (const h of resolvePlugSet(sock.reusablePlugSetHash)) add(h, false, false);
    }
    for (const p of sock.reusablePlugItems ?? []) {
      add(p?.plugItemHash, false, false);
    }

    if (perks.length === 0) continue;
    out.push({ index: i, socketTypeHash: sock.socketTypeHash, perks, isRandom });
  }

  return out;
}

/** Plug-set resolver backed by the manifest DB (used by rolls + perksearch). */
export function dbPlugSetResolver(db: DatabaseSync): PlugSetResolver {
  return (hash) => {
    const ps = getRawDefinition(db, "DestinyPlugSetDefinition", hash);
    return (ps?.reusablePlugItems ?? [])
      .map((p: { plugItemHash?: number }) => p?.plugItemHash)
      .filter((h: unknown): h is number => typeof h === "number" && h !== 0);
  };
}

/** Maps socket index -> category display name, from a weapon's socketCategories. */
export function socketCategoryNames(db: DatabaseSync, def: any): Map<number, string> {
  const byIndex = new Map<number, string>();
  for (const cat of def?.sockets?.socketCategories ?? []) {
    const catDef = getRawDefinition(db, "DestinySocketCategoryDefinition", cat.socketCategoryHash);
    const catName = catDef?.displayProperties?.name ?? "(unknown category)";
    for (const idx of cat.socketIndexes ?? []) {
      byIndex.set(idx, catName);
    }
  }
  return byIndex;
}
