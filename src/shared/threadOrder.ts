// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01/F02 affiliation ordering — frozen AppModel.threads(in:) sort:
// pinned first, then sortOrder ascending, threads never reordered (nil
// sortOrder) stay on top, newest createdAt last.

import type { ChatThread, Project } from "./types";

export function compareThreads(a: ChatThread, b: ChatThread): number {
  if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
  const l = a.sortOrder;
  const r = b.sortOrder;
  if (l !== undefined && r !== undefined && l !== r) return l - r;
  if (l === undefined && r !== undefined) return -1;
  if (l !== undefined && r === undefined) return 1;
  return b.createdAt - a.createdAt;
}

/** The sidebar-visible order for one affiliation: non-archived threads
 *  sorted by the frozen comparator. */
export function threadsInAffiliation(
  threads: readonly ChatThread[],
  projectId: string | null,
): ChatThread[] {
  return threads
    // F22: Hydra heads stay out of the sidebar/palette — they surface
    // in the lead's head panel instead (frozen parity).
    .filter((t) => t.projectId === projectId && !t.isArchived && !t.hydraHead)
    .slice()
    .sort(compareThreads);
}

/** The sidebar's full visible order (no search filter): each project's
 *  threads in project order, then the ungrouped partition — what
 *  previous/next thread shortcuts walk (frozen AppCommands navigation). */
export function visibleThreads(
  projects: readonly Project[],
  threads: readonly ChatThread[],
): ChatThread[] {
  const out: ChatThread[] = [];
  for (const p of projects) out.push(...threadsInAffiliation(threads, p.id));
  out.push(...threadsInAffiliation(threads, null));
  return out;
}
