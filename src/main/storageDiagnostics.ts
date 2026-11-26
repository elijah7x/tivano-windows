// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-03 Storage diagnostics: measure and clean in-scope recovery backups
// under <dataRoot> without ever touching the newest recovery file, active
// recovery paths, symlinks/junctions, or the live store and turn segments.

import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { posix, win32 } from "node:path";
import type {
  StorageDiagnosticsCategoryId,
  StorageDiagnosticsCategoryUsage,
  StorageDiagnosticsResult,
} from "../shared/types";
import { isInsideRoot, TURNS_DIRNAME } from "./store";

export interface StorageDiagnosticsFs {
  lstatSync: (p: string) => Stats;
  readdirSync: (p: string, opts: { withFileTypes: true }) => Dirent[];
  realpathSync: (p: string) => string;
  unlinkSync: (p: string) => void;
  rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
}

const DEFAULT_FS: StorageDiagnosticsFs = {
  lstatSync,
  readdirSync: (p, opts) => readdirSync(p, opts),
  realpathSync,
  unlinkSync,
  rmSync,
};

export interface StorageDiagnosticsOptions {
  dataRoot: string;
  /** Paths currently in use (for example store.recoveredFrom) that cleanup must keep. */
  getProtectedPaths?: () => readonly string[];
  /** Optional unpackaged test seam to simulate a measurement error. */
  injectMeasureError?: () => string | null;
  fs?: Partial<StorageDiagnosticsFs>;
  platform?: NodeJS.Platform;
}

type RecoveryBackupKind = "store" | "turns" | "token-activity" | "remote-mcp";

interface RecoveryEntry {
  /** Path relative to dataRoot (for stable tie-break ordering). */
  name: string;
  path: string;
  realPath: string;
  kind: "file" | "dir";
  backupKind: RecoveryBackupKind;
  stamp: string | null;
  bytes: number;
  mtimeMs: number;
}

const STORE_CORRUPT_RE = /^store\.corrupt-(.+)\.json$/;
const TOKEN_CORRUPT_RE = /^token-activity\.corrupt-(.+)\.json$/;
const REMOTE_MCP_CORRUPT_RE = /^remote-mcp\.json\..+\.corrupt$/;
const TURNS_CORRUPT_DIR_RE = /^turns\.corrupt-(.+?)(?:-[0-9a-f]{8})?$/;
const SEGMENT_CORRUPT_RE = /^.+\.corrupt-(.+?)(?:-[0-9a-f]{8})?\.json$/;

function classifyTopLevelRecoveryFile(
  name: string,
): { backupKind: RecoveryBackupKind; stamp: string | null } | null {
  const storeMatch = STORE_CORRUPT_RE.exec(name);
  if (storeMatch) return { backupKind: "store", stamp: storeMatch[1] ?? null };
  const tokenMatch = TOKEN_CORRUPT_RE.exec(name);
  if (tokenMatch) return { backupKind: "token-activity", stamp: tokenMatch[1] ?? null };
  if (REMOTE_MCP_CORRUPT_RE.test(name)) return { backupKind: "remote-mcp", stamp: null };
  return null;
}

function measureDirectoryTree(
  dirPath: string,
  dirStat: Stats,
  fs: StorageDiagnosticsFs,
  pathApi: typeof posix | typeof win32,
  realRoot: string,
): { bytes: number; mtimeMs: number } {
  const realDir = fs.realpathSync(dirPath);
  if (!isInsideRoot(realRoot, realDir, pathApi)) {
    throw new Error(`refusing path outside data root: ${dirPath}`);
  }
  let bytes = 0;
  let maxMtime = dirStat.mtimeMs;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = pathApi.join(dirPath, entry.name);
    const childStat = fs.lstatSync(childPath);
    if (childStat.isSymbolicLink()) {
      throw new Error(`refusing symlink inside recovery directory: ${entry.name}`);
    }
    if (childStat.isDirectory()) {
      const sub = measureDirectoryTree(childPath, childStat, fs, pathApi, realRoot);
      bytes += sub.bytes;
      if (sub.mtimeMs > maxMtime) maxMtime = sub.mtimeMs;
    } else if (childStat.isFile()) {
      const realChild = fs.realpathSync(childPath);
      if (!isInsideRoot(realRoot, realChild, pathApi)) {
        throw new Error(`refusing file outside data root: ${entry.name}`);
      }
      bytes += childStat.size;
      if (childStat.mtimeMs > maxMtime) maxMtime = childStat.mtimeMs;
    } else {
      throw new Error(`unexpected non-regular entry in recovery directory: ${entry.name}`);
    }
  }
  return { bytes, mtimeMs: maxMtime };
}

function normalizeProtectedSet(
  dataRoot: string,
  paths: readonly string[],
  fs: StorageDiagnosticsFs,
  pathApi: typeof posix | typeof win32,
): Set<string> {
  const out = new Set<string>();
  for (const raw of paths) {
    if (!raw) continue;
    const abs = pathApi.resolve(dataRoot, raw);
    out.add(abs);
    try {
      out.add(fs.realpathSync(abs));
    } catch {
      /* path may not exist on disk anymore */
    }
  }
  return out;
}

function scanRecoveryEntries(opts: StorageDiagnosticsOptions): {
  entries: RecoveryEntry[];
  cleanable: RecoveryEntry[];
  usage: StorageDiagnosticsCategoryUsage;
} {
  const injected = opts.injectMeasureError?.();
  if (injected) {
    throw new Error(injected);
  }
  const fs: StorageDiagnosticsFs = { ...DEFAULT_FS, ...opts.fs };
  const pathApi = (opts.platform ?? process.platform) === "win32" ? win32 : posix;
  const absRoot = pathApi.resolve(opts.dataRoot);
  const rootStat = fs.lstatSync(absRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`data root must not be a symlink: ${absRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`data root is not a directory: ${absRoot}`);
  }
  const realRoot = fs.realpathSync(absRoot);

  const discovered: RecoveryEntry[] = [];
  const rootEntries = fs.readdirSync(absRoot, { withFileTypes: true });
  let hasTurnsDir = false;

  for (const entry of rootEntries) {
    if (entry.name === TURNS_DIRNAME) {
      hasTurnsDir = true;
      continue;
    }
    const topMatch = classifyTopLevelRecoveryFile(entry.name);
    if (topMatch) {
      const p = pathApi.join(absRoot, entry.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        throw new Error(`refusing symlink recovery file: ${entry.name}`);
      }
      if (!st.isFile()) {
        throw new Error(`recovery entry is not a regular file: ${entry.name}`);
      }
      const rp = fs.realpathSync(p);
      if (!isInsideRoot(realRoot, rp, pathApi)) {
        throw new Error(`refusing recovery file outside data root: ${entry.name}`);
      }
      discovered.push({
        name: entry.name,
        path: p,
        realPath: rp,
        kind: "file",
        backupKind: topMatch.backupKind,
        stamp: topMatch.stamp,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } else {
      const turnsDirMatch = TURNS_CORRUPT_DIR_RE.exec(entry.name);
      if (turnsDirMatch) {
        const p = pathApi.join(absRoot, entry.name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          throw new Error(`refusing symlink recovery directory: ${entry.name}`);
        }
        if (!st.isDirectory()) {
          throw new Error(`recovery directory entry is not a directory: ${entry.name}`);
        }
        const rp = fs.realpathSync(p);
        if (!isInsideRoot(realRoot, rp, pathApi)) {
          throw new Error(`refusing recovery directory outside data root: ${entry.name}`);
        }
        const tree = measureDirectoryTree(p, st, fs, pathApi, realRoot);
        discovered.push({
          name: entry.name,
          path: p,
          realPath: rp,
          kind: "dir",
          backupKind: "turns",
          stamp: turnsDirMatch[1] ?? null,
          bytes: tree.bytes,
          mtimeMs: tree.mtimeMs,
        });
      }
    }
  }

  if (hasTurnsDir) {
    const turnsPath = pathApi.join(absRoot, TURNS_DIRNAME);
    const turnsStat = fs.lstatSync(turnsPath);
    if (turnsStat.isSymbolicLink()) {
      throw new Error(`turns path must not be a symlink: ${turnsPath}`);
    }
    if (!turnsStat.isDirectory()) {
      throw new Error(`turns path is not a directory: ${turnsPath}`);
    }
    const realTurns = fs.realpathSync(turnsPath);
    if (!isInsideRoot(realRoot, realTurns, pathApi)) {
      throw new Error(`turns path escapes data root: ${turnsPath}`);
    }
    const turnEntries = fs.readdirSync(turnsPath, { withFileTypes: true });
    for (const entry of turnEntries) {
      if (entry.name.endsWith(".tmp")) continue;
      const segMatch = SEGMENT_CORRUPT_RE.exec(entry.name);
      if (!segMatch) continue;
      const p = pathApi.join(turnsPath, entry.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        throw new Error(`refusing symlink recovery file: ${TURNS_DIRNAME}/${entry.name}`);
      }
      if (!st.isFile()) {
        throw new Error(`recovery entry is not a regular file: ${TURNS_DIRNAME}/${entry.name}`);
      }
      const rp = fs.realpathSync(p);
      if (!isInsideRoot(realRoot, rp, pathApi)) {
        throw new Error(`refusing recovery file outside data root: ${TURNS_DIRNAME}/${entry.name}`);
      }
      discovered.push({
        name: `${TURNS_DIRNAME}/${entry.name}`,
        path: p,
        realPath: rp,
        kind: "file",
        backupKind: "turns",
        stamp: segMatch[1] ?? null,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  // Newest first (matching upstream HangWatchdog.completedReports order); tie-break by name desc.
  discovered.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name > a.name ? 1 : b.name < a.name ? -1 : 0;
  });

  const protectedPaths = normalizeProtectedSet(
    absRoot,
    opts.getProtectedPaths?.() ?? [],
    fs,
    pathApi,
  );

  // Protect the newest recovery entry per backup kind, plus any turns backup
  // sharing the newest store recovery stamp, plus any active in-use path.
  const newestStoreStamp = discovered.find((d) => d.backupKind === "store")?.stamp ?? null;
  const seenNewestByKind = new Set<RecoveryBackupKind>();

  let totalBytes = 0;
  let cleanableBytes = 0;
  const cleanable: RecoveryEntry[] = [];
  for (const item of discovered) {
    totalBytes += item.bytes;
    const isNewestForKind = !seenNewestByKind.has(item.backupKind);
    if (isNewestForKind) seenNewestByKind.add(item.backupKind);
    const sharesNewestStoreStamp =
      item.backupKind === "turns" && newestStoreStamp !== null && item.stamp === newestStoreStamp;
    const isProtected =
      isNewestForKind ||
      sharesNewestStoreStamp ||
      protectedPaths.has(item.path) ||
      protectedPaths.has(item.realPath);
    if (!isProtected) {
      cleanableBytes += item.bytes;
      cleanable.push(item);
    }
  }

  return {
    entries: discovered,
    cleanable,
    usage: {
      id: "recovery",
      totalBytes,
      cleanableBytes,
      fileCount: discovered.length,
      cleanableCount: cleanable.length,
    },
  };
}

export function measureStorageDiagnostics(
  opts: StorageDiagnosticsOptions,
): StorageDiagnosticsResult {
  try {
    const scan = scanRecoveryEntries(opts);
    return { categories: [scan.usage] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      categories: [
        {
          id: "recovery",
          totalBytes: 0,
          cleanableBytes: 0,
          fileCount: 0,
          cleanableCount: 0,
          error: msg,
        },
      ],
    };
  }
}

export function cleanStorageDiagnostics(
  opts: StorageDiagnosticsOptions,
  category: StorageDiagnosticsCategoryId,
): StorageDiagnosticsResult {
  if (category !== "recovery") {
    return measureStorageDiagnostics(opts);
  }
  const fs: StorageDiagnosticsFs = { ...DEFAULT_FS, ...opts.fs };
  let scan: ReturnType<typeof scanRecoveryEntries>;
  try {
    scan = scanRecoveryEntries(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      categories: [
        {
          id: "recovery",
          totalBytes: 0,
          cleanableBytes: 0,
          fileCount: 0,
          cleanableCount: 0,
          error: msg,
        },
      ],
      cleanupError: msg,
    };
  }

  const errors: string[] = [];
  for (const item of scan.cleanable) {
    try {
      // Re-verify right before unlink/rm that the target is not a symlink.
      const current = fs.lstatSync(item.path);
      if (current.isSymbolicLink()) {
        errors.push(`refused symlink: ${item.name}`);
        continue;
      }
      if (item.kind === "dir") {
        fs.rmSync(item.path, { recursive: true, force: false });
      } else {
        fs.unlinkSync(item.path);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      errors.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const remeasured = measureStorageDiagnostics(opts);
  if (errors.length > 0) {
    return { ...remeasured, cleanupError: errors.join(" ") };
  }
  return remeasured;
}

export function createStorageDiagnosticsService(opts: StorageDiagnosticsOptions) {
  return {
    measure: () => measureStorageDiagnostics(opts),
    clean: (category: StorageDiagnosticsCategoryId) => cleanStorageDiagnostics(opts, category),
  };
}
