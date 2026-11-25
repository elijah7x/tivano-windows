// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Per-thread streaming-markdown coordinator cache. The cache outlives the
// ChatView mount that filled it so returning to a running chat reuses
// landed parse work instead of reparsing the whole timeline.

import type { StreamingMarkdownCoordinator } from "./markdown";

/** Bounded so a long session never pins every visited timeline. */
export const MD_COORD_CACHE_MAX = 4;

const mdCoordCache = new Map<
  string,
  Map<string, StreamingMarkdownCoordinator>
>();

/** Get the coordinator map for a thread, refreshing its LRU position. */
export function mdCoordMapFor(
  threadId: string,
): Map<string, StreamingMarkdownCoordinator> {
  const cached = mdCoordCache.get(threadId);
  if (cached !== undefined) {
    mdCoordCache.delete(threadId);
    mdCoordCache.set(threadId, cached);
    return cached;
  }
  const map = new Map<string, StreamingMarkdownCoordinator>();
  mdCoordCache.set(threadId, map);
  while (mdCoordCache.size > MD_COORD_CACHE_MAX) {
    const oldest = mdCoordCache.keys().next().value;
    if (oldest === undefined) break;
    mdCoordCache.get(oldest)?.forEach((c) => c.dispose());
    mdCoordCache.delete(oldest);
  }
  return map;
}

/** Memory-pressure flush: dispose and drop every coordinator, but keep the
 *  per-thread map objects anchored in the outer cache. A mounted ChatView
 *  holds its map object; clearing the outer cache would detach that map,
 *  strand later coordinators outside the LRU, and hide them from the next
 *  pressure flush. The empty map shells are tiny; the memory being released
 *  is in the coordinators themselves. */
export function clearMdCoordCacheForMemoryPressure(): void {
  mdCoordCache.forEach((map) => {
    map.forEach((c) => c.dispose());
    map.clear();
  });
}
