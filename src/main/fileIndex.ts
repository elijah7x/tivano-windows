// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 @-mention file index — bounded port of the frozen FileIndex:
// a git repository lists `ls-files --cached --others --exclude-standard`
// (60k cap); anything else enumerates the tree (hidden files skipped,
// the frozen skip-directories and 16-level bound, 20k cap). Listings
// cache per directory for 60s and the index keeps at most two — the
// frozen RecentCache contract.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface FileIndexDeps {
  /** `git rev-parse --is-inside-work-tree` inside the directory —
   *  bounded, env-controlled; a failure is "not a repo", never a guess. */
  isRepo(directory: string): Promise<boolean>;
  /** `git ls-files --cached --others --exclude-standard -z` inside the
   *  directory, already NUL-split into relative paths. */
  gitFiles(directory: string): Promise<string[]>;
  now?: () => number;
}

const GIT_CAP = 60_000;
const WALK_CAP = 20_000;
const MAX_DEPTH = 16;
const FRESH_MS = 60_000;
const MAX_INDEXES = 2;
/** Frozen FileIndex.enumerate skip set — vendored/generated trees a
 *  mention never wants. */
const SKIP_DIRS = new Set([
  "node_modules",
  "build",
  "dist",
  ".build",
  "DerivedData",
  "Pods",
  "target",
]);

function enumerate(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= WALK_CAP) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory contributes nothing, never fails
    }
    for (const e of entries) {
      if (out.length >= WALK_CAP) return;
      if (e.name.startsWith(".")) continue; // skipsHiddenFiles
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        // POSIX-style relative paths — identical to ls-files output,
        // and what @-mentions insert on either platform.
        out.push(relative(directory, full).split("\\").join("/"));
      }
    }
  };
  walk(directory, 0);
  return out;
}

export class FileIndexService {
  private readonly cache = new Map<string, { paths: string[]; builtAt: number }>();

  constructor(private readonly deps: FileIndexDeps) {}

  /** The searchable paths for a directory — the cached index while it is
   *  fresh (the frozen port serves a stale index only while a rebuild is
   *  already running; this bounded version rebuilds inline instead). */
  async list(directory: string): Promise<string[]> {
    const now = (this.deps.now ?? Date.now)();
    const cached = this.cache.get(directory);
    if (cached && now - cached.builtAt < FRESH_MS) return cached.paths;
    const paths = await this.build(directory);
    this.cache.delete(directory); // refresh LRU position
    this.cache.set(directory, { paths, builtAt: now });
    while (this.cache.size > MAX_INDEXES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return paths;
  }

  private async build(directory: string): Promise<string[]> {
    try {
      if (await this.deps.isRepo(directory)) {
        const files = await this.deps.gitFiles(directory);
        if (files.length > 0) return files.slice(0, GIT_CAP);
      }
    } catch {
      // A failed git read falls back to the walk, like the frozen
      // `try? await output(...)` yielding enumerate().
    }
    return enumerate(directory);
  }

  /** Test seam: the paths a directory would list without touching the
   *  cache (enumerate is pure fs and cheap at the caps). */
  static enumerate(directory: string): string[] {
    return enumerate(directory);
  }

  /** A directory that no longer exists lists nothing — the caller
   *  resolves the thread's directory first, but a mid-flight removal
   *  still degrades honestly. */
  static exists(directory: string): boolean {
    try {
      return statSync(directory).isDirectory();
    } catch {
      return false;
    }
  }
}
