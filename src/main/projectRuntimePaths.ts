// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// main-only workspace authorization: projectId → physically resolved
// directory. Only the main bootstrap and test harness may register; the
// renderer can name nothing here. A project name, message text or any
// stored string is NOT a cwd grant — authorization is this map alone.
//
// Persistence rules (repair-2):
//  - register() builds a candidate map and persists it BEFORE committing —
//    a failed write never activates a new grant and never drops the old one.
//  - restore() validates EVERY entry (no live-map mutation), then performs
//    one atomic save + one in-memory commit. An empty authorized-roots
//    list restores no managed grant; user-selected grants use their own rules.
//  - Main-created project directories carry an ownership marker file
//    (.tivano-project.json) naming projectId + dataRoot. Restore refuses
//    unmarked, mis-named or foreign-root directories — a grants entry alone
//    never proves ownership, and old unmarked data is never "re-signed".
//  - No migration is attempted: user content is never modified; entries
//    that fail validation are PRESERVED in the file for a later launch.
//
// USER-SELECTED directories (phase-2d): a second grants section records
// directories the user attached through the main-owned chooser. They are
// NOT managed fixture roots: no ownership marker is written (a user dir
// must never be modified), and authorized-root containment does not
// apply — a user dir may live anywhere. Restore validates schema, a real
// non-symlink directory, and that the recorded canonical path still
// resolves to itself; a missing/renamed/retargeted entry is preserved
// and reported, never dropped, repointed or silently broadened.

import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isInsideRoot } from "./store";
import type { WorkspaceGrant } from "./provider";

export class WorkspaceError extends Error {
  constructor(
    readonly code: "WORKSPACE_NOT_CONFIGURED" | "WORKSPACE_REVOKED" | "WORKSPACE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface GrantRestoreResult {
  restored: number;
  /** Entries that failed revalidation — surfaced, never silently dropped. */
  failed: Array<{ projectId: string; directory: string; reason: string }>;
}

/** Ownership marker inside every main-created project directory. */
export const PROJECT_MARKER_FILE = ".tivano-project.json";

function markerPath(dir: string): string {
  return join(dir, PROJECT_MARKER_FILE);
}

function parseMarker(raw: string): { projectId: string; dataRoot: string } | null {
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof doc !== "object" ||
      doc === null ||
      doc.version !== 1 ||
      typeof doc.projectId !== "string" ||
      typeof doc.dataRoot !== "string"
    )
      return null;
    return { projectId: doc.projectId, dataRoot: doc.dataRoot };
  } catch {
    return null;
  }
}

type GrantKind = "managed" | "user";

interface UnrestoredEntry {
  dir: string;
  kind: GrantKind;
}

export class ProjectRuntimePaths {
  private grants = new Map<string, WorkspaceGrant>();
  private persistenceError: string | undefined;
  private unrestored = new Map<string, UnrestoredEntry>();
  /** Kind of each live grant — set at register/restore time, removed at
   *  revoke. An absent id is treated as managed (strictest section). */
  private kinds = new Map<string, GrantKind>();
  /** Physical roots a grant must remain inside. An empty list authorizes
   *  register() callers directly but restores NOTHING from disk. */
  private readonly allowedRoots: string[];

  constructor(
    allowedRoots: string[] = [],
    private readonly persistPath?: string,
    /** Current app data root — recorded into ownership markers so a
     *  directory written by a DIFFERENT data root can never be adopted. */
    private readonly dataRoot?: string,
  ) {
    this.allowedRoots = allowedRoots.map((r) => realpathSync(resolve(r)));
  }

  /**
   * Full directory validation shared by register/restore — a real,
   * non-symlink, NUL-free absolute directory, physically inside an
   * authorized root when roots are configured.
   */
  private validateDir(projectId: string, dir: string): WorkspaceGrant {
    if (!isAbsolute(dir) || dir.includes("\0"))
      throw new WorkspaceError("WORKSPACE_INVALID", `workspace path is not a clean absolute path`);
    const st = lstatSync(dir);
    if (st.isSymbolicLink())
      throw new WorkspaceError("WORKSPACE_INVALID", `workspace must not be a symlink: ${dir}`);
    if (!st.isDirectory())
      throw new WorkspaceError("WORKSPACE_INVALID", `workspace is not a directory: ${dir}`);
    const physical = realpathSync(dir);
    if (this.allowedRoots.length > 0 && !this.allowedRoots.some((r) => isInsideRoot(r, physical)))
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        `workspace escapes the authorized fixture root`,
      );
    return { projectId, directory: physical };
  }

  /**
   * Authorize `dir` for `projectId`. The map is only mutated AFTER the
   * candidate state is durably written — a persistence failure activates
   * nothing and preserves any existing grant.
   */
  register(projectId: string, dir: string): WorkspaceGrant {
    const grant = this.validateDir(projectId, dir);
    const next = new Map(this.grants);
    next.set(projectId, grant);
    const nextKinds = new Map(this.kinds);
    nextKinds.set(projectId, "managed");
    this.persistMap(next, { kinds: nextKinds });
    this.grants = next;
    this.kinds = nextKinds;
    this.unrestored.delete(projectId);
    return grant;
  }

  /**
   * Register a directory MAIN created for this project. Ownership is
   * proven by an exclusive marker file inside the directory naming this
   * projectId and this dataRoot — a grants-file string alone never makes
   * a directory ours.
   */
  registerManaged(projectId: string, dir: string): WorkspaceGrant {
    const grant = this.validateDir(projectId, dir);
    const marker = markerPath(grant.directory);
    let wroteMarker = false;
    try {
      writeFileSync(
        marker,
        JSON.stringify({
          version: 1,
          projectId,
          dataRoot: this.dataRoot ?? "",
          createdAt: Date.now(),
        }),
        { flag: "wx" },
      );
      wroteMarker = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Re-verify the pre-existing marker after EEXIST — it must be a
        // real file naming exactly this project and this data root.
        const st = lstatSync(marker);
        if (st.isSymbolicLink() || !st.isFile())
          throw new WorkspaceError(
            "WORKSPACE_INVALID",
            "project marker is not a real file — refusing to adopt this directory",
          );
        const existing = parseMarker(readFileSync(marker, "utf8"));
        if (
          !existing ||
          existing.projectId !== projectId ||
          (this.dataRoot !== undefined && existing.dataRoot !== this.dataRoot)
        )
          throw new WorkspaceError(
            "WORKSPACE_INVALID",
            "project marker does not match this project and data root — refusing to adopt",
          );
      } else {
        throw err;
      }
    }
    const next = new Map(this.grants);
    next.set(projectId, grant);
    const nextKinds = new Map(this.kinds);
    nextKinds.set(projectId, "managed");
    try {
      this.persistMap(next, { kinds: nextKinds });
    } catch (err) {
      // The grant never became durable — remove only the marker THIS call
      // wrote so the directory is not silently left "owned".
      if (wroteMarker) {
        try {
          unlinkSync(marker);
        } catch {
          /* best effort */
        }
      }
      throw err;
    }
    this.grants = next;
    this.kinds = nextKinds;
    this.unrestored.delete(projectId);
    return grant;
  }

  /**
   * Canonicalize a user-selected directory for attachment: must be a
   * real, non-symlink directory; the canonical physical path is what the
   * grant and the display field both record. Nothing inside the chosen
   * directory is read or written — attaching is metadata only.
   */
  canonicalizeUserDir(dir: string): string {
    if (!isAbsolute(dir) || dir.includes("\0"))
      throw new WorkspaceError("WORKSPACE_INVALID", `directory path is not a clean absolute path`);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      throw new WorkspaceError("WORKSPACE_INVALID", `directory does not exist: ${dir}`);
    }
    if (st.isSymbolicLink())
      throw new WorkspaceError("WORKSPACE_INVALID", `directory must not be a symlink: ${dir}`);
    if (!st.isDirectory())
      throw new WorkspaceError("WORKSPACE_INVALID", `selection is not a directory: ${dir}`);
    return realpathSync(dir);
  }

  /**
   * Authorize a USER-SELECTED directory: no marker is written into it and
   * authorized-root containment does not apply — the grant records the
   * canonical path. The map is only mutated AFTER the candidate state is
   * durably written, exactly like managed registration.
   */
  registerUser(projectId: string, dir: string): WorkspaceGrant {
    const grant: WorkspaceGrant = { projectId, directory: this.canonicalizeUserDir(dir) };
    const next = new Map(this.grants);
    next.set(projectId, grant);
    const nextKinds = new Map(this.kinds);
    nextKinds.set(projectId, "user");
    this.persistMap(next, { kinds: nextKinds });
    this.grants = next;
    this.kinds = nextKinds;
    this.unrestored.delete(projectId);
    return grant;
  }

  /** The project a directory is already bound to, or undefined. Both
   *  grant kinds count: selecting a dir another project owns re-opens
   *  THAT project instead of minting a second binding. */
  findProjectByDirectory(canonicalDir: string): string | undefined {
    for (const [id, g] of this.grants) if (g.directory === canonicalDir) return id;
    return undefined;
  }

  /**
   * Display-only liveness check for a recorded directory: a real,
   * non-symlink directory whose canonical resolution is still itself.
   * This is NOT an authorization check — it answers "does the recorded
   * folder still exist where it was attached".
   */
  dirLive(dir: string): boolean {
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
      return realpathSync(dir) === dir;
    } catch {
      return false;
    }
  }

  /** Current grant for a project, or undefined. */
  lookup(projectId: string): WorkspaceGrant | undefined {
    return this.grants.get(projectId);
  }

  /** Deleting a project revokes its directory immediately. */
  revoke(projectId: string): void {
    const next = new Map(this.grants);
    if (!next.has(projectId) && !this.unrestored.has(projectId)) return;
    next.delete(projectId);
    const nextKinds = new Map(this.kinds);
    nextKinds.delete(projectId);
    this.persistMap(next, { omit: projectId, kinds: nextKinds });
    this.grants = next;
    this.kinds = nextKinds;
    this.unrestored.delete(projectId);
  }

  /**
   * Main-owned grants file — never consulted as authority, only rebuilt
   * from a candidate map and re-validated on restore. Each live grant
   * stays in the section its kind belongs to; `kinds` may carry a
   * candidate map so the grant being registered is sectioned correctly
   * before it is committed.
   */
  private persistMap(
    map: ReadonlyMap<string, WorkspaceGrant>,
    opts: { omit?: string; kinds?: ReadonlyMap<string, GrantKind> } = {},
  ): void {
    const keepManaged: Record<string, string> = {};
    const keepUser: Record<string, string> = {};
    for (const [id, e] of this.unrestored) {
      if (id === opts.omit || map.has(id)) continue;
      (e.kind === "user" ? keepUser : keepManaged)[id] = e.dir;
    }
    const kinds = opts.kinds ?? this.kinds;
    for (const [id, grant] of map) {
      ((kinds.get(id) ?? "managed") === "user" ? keepUser : keepManaged)[id] = grant.directory;
    }
    this.persistKeep(keepManaged, keepUser);
  }

  /**
   * One raw grants document merged with per-entry failures preserved —
   * the single restore/commit write. Two sections: `grants` (managed,
   * marker+roots required) and `userGrants` (user-selected, canonical
   * only). A file without `userGrants` simply has none.
   */
  private persistKeep(
    keepManaged: Record<string, string>,
    keepUser: Record<string, string>,
  ): void {
    if (!this.persistPath) return;
    if (this.persistenceError)
      throw new WorkspaceError("WORKSPACE_INVALID", this.persistenceError);
    const tmp = `${this.persistPath}.tmp-${process.pid}`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, grants: keepManaged, userGrants: keepUser }),
    );
    renameSync(tmp, this.persistPath);
  }

  /**
   * Verify a main-created directory's ownership marker. Restore only ever
   * adopts directories this app created — the marker must be a real file
   * naming this projectId and (when known) this dataRoot. Unmarked legacy
   * or foreign data is a reported failure, never silently "re-signed".
   */
  private verifyMarker(projectId: string, physical: string): void {
    let st;
    try {
      st = lstatSync(markerPath(physical));
    } catch {
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "directory carries no project-ownership marker — refusing to restore",
      );
    }
    if (st.isSymbolicLink() || !st.isFile())
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "project marker is not a real file — refusing to restore",
      );
    const marker = parseMarker(readFileSync(markerPath(physical), "utf8"));
    if (!marker)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "project marker is unreadable — refusing to restore",
      );
    if (marker.projectId !== projectId)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        `project marker names ${marker.projectId}, not ${projectId} — refusing to restore`,
      );
    if (this.dataRoot !== undefined && marker.dataRoot !== this.dataRoot)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "project marker belongs to a different data root — refusing to restore",
      );
  }

  /**
   * Restore-time validation for a USER-SELECTED directory: a real,
   * non-symlink directory whose recorded canonical path still resolves
   * to itself. A missing dir, a dir that became a symlink, or a parent
   * path that was relinked all fail here and are preserved — a recorded
   * grant is never silently broadened or repointed.
   */
  private validateUserDir(projectId: string, dir: string): WorkspaceGrant {
    if (!isAbsolute(dir) || dir.includes("\0"))
      throw new WorkspaceError("WORKSPACE_INVALID", `user directory is not a clean absolute path`);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      throw new WorkspaceError("WORKSPACE_INVALID", `user directory does not exist: ${dir}`);
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new WorkspaceError("WORKSPACE_INVALID", `user directory is not a real directory: ${dir}`);
    const physical = realpathSync(dir);
    if (physical !== dir)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        `user directory no longer resolves to its recorded canonical path`,
      );
    return { projectId, directory: physical };
  }

  /**
   * Rebuild grants after a restart. A persisted string is NEVER trusted:
   * every candidate must still belong to a live project, be a real
   * non-symlink directory, AND satisfy its section's proof — managed
   * entries must remain inside an authorized root and carry a matching
   * ownership marker, user entries must still resolve to their recorded
   * canonical path. Validation completes for ALL entries before one
   * atomic save + one in-memory commit. With no configured roots,
   * MANAGED entries restore nothing; user entries are unaffected — a
   * user-attached directory does not depend on fixture roots.
   * Failed entries are kept in the file so a later launch can still
   * restore them once the directory honestly exists again.
   */
  restore(validProjectIds: ReadonlySet<string>): GrantRestoreResult {
    const failed: GrantRestoreResult["failed"] = [];
    if (!this.persistPath) return { restored: 0, failed };
    const rejectDocument = (reason: string): GrantRestoreResult => {
      this.persistenceError = `workspace grants file preserved: ${reason}`;
      const ids = validProjectIds.size ? [...validProjectIds] : [""];
      return {
        restored: 0,
        failed: ids.map((projectId) => ({ projectId, directory: "", reason: this.persistenceError! })),
      };
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.persistPath, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.persistenceError = undefined;
        return { restored: 0, failed };
      }
      return rejectDocument(`cannot read document: ${(err as Error).message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return rejectDocument("expected an object");
    const doc = raw as Record<string, unknown>;
    if (doc.version !== 1) return rejectDocument("unsupported document version");
    for (const section of ["grants", "userGrants"] as const) {
      const entries = doc[section];
      if (entries === undefined) continue;
      if (typeof entries !== "object" || entries === null || Array.isArray(entries) ||
          Object.values(entries).some((dir) => typeof dir !== "string"))
        return rejectDocument(`invalid ${section} section`);
    }
    this.persistenceError = undefined;
    const managed = (doc.grants ?? {}) as Record<string, string>;
    const user = (doc.userGrants ?? {}) as Record<string, string>;
    if (Object.keys(managed).length === 0 && Object.keys(user).length === 0) {
      this.grants.clear();
      this.kinds.clear();
      this.unrestored.clear();
      return { restored: 0, failed };
    }

    const keepManaged: Record<string, string> = {};
    const keepUser: Record<string, string> = {};
    const candidate = new Map<string, WorkspaceGrant>();
    const candidateKinds = new Map<string, GrantKind>();
    const unrestored = new Map<string, UnrestoredEntry>();
    let restored = 0;

    for (const [projectId, dir] of Object.entries(managed)) {
      if (typeof dir !== "string" || !validProjectIds.has(projectId)) continue;
      if (this.allowedRoots.length === 0) {
        // No configured authorized roots — nothing managed can become a
        // grant. The entry stays in the file for a launch with roots.
        failed.push({
          projectId,
          directory: dir,
          reason: "no authorized workspace roots configured — persisted grant not restored",
        });
        keepManaged[projectId] = dir;
        unrestored.set(projectId, { dir, kind: "managed" });
        continue;
      }
      try {
        const grant = this.validateDir(projectId, dir);
        this.verifyMarker(projectId, grant.directory);
        candidate.set(projectId, grant);
        candidateKinds.set(projectId, "managed");
        keepManaged[projectId] = grant.directory;
        restored++;
      } catch (err) {
        failed.push({ projectId, directory: dir, reason: (err as Error).message });
        keepManaged[projectId] = dir;
        unrestored.set(projectId, { dir, kind: "managed" });
      }
    }

    for (const [projectId, dir] of Object.entries(user)) {
      if (typeof dir !== "string" || !validProjectIds.has(projectId)) continue;
      try {
        const grant = this.validateUserDir(projectId, dir);
        candidate.set(projectId, grant);
        candidateKinds.set(projectId, "user");
        keepUser[projectId] = grant.directory;
        restored++;
      } catch (err) {
        failed.push({ projectId, directory: dir, reason: (err as Error).message });
        keepUser[projectId] = dir;
        unrestored.set(projectId, { dir, kind: "user" });
      }
    }

    // One atomic save of the preserved file — failed entries stay
    // restorable — then one commit of the fully validated candidate map.
    try {
      this.persistKeep(keepManaged, keepUser);
    } catch (err) {
      const reason = `workspace restoration could not be saved: ${(err as Error).message}`;
      for (const [projectId, grant] of candidate)
        failed.push({ projectId, directory: grant.directory, reason });
      return { restored: 0, failed };
    }
    this.grants = candidate;
    this.kinds = candidateKinds;
    this.unrestored = unrestored;
    return { restored, failed };
  }

  /**
   * Re-verify a grant at spawn time: still registered, still a real
   * directory at the same canonical path. Registration-vs-spawn is a
   * filesystem race window; this is the required second check, not a
   * general OS sandbox.
   */
  verify(grant: WorkspaceGrant): WorkspaceGrant {
    const current = this.grants.get(grant.projectId);
    if (!current || current.directory !== grant.directory)
      throw new WorkspaceError(
        "WORKSPACE_REVOKED",
        "WORKSPACE_REVOKED: the project's directory authorization was removed",
      );
    const st = lstatSync(grant.directory);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "WORKSPACE_INVALID: authorized workspace no longer a real directory",
      );
    const physical = realpathSync(grant.directory);
    if (physical !== grant.directory)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "WORKSPACE_INVALID: workspace path moved or re-linked",
      );
    return grant;
  }

  /**
   * Re-verify an EXECUTION workspace at spawn time (F11): the registered
   * grant directory itself, or — for a worktree-bound thread — an
   * app-owned checkout confined under
   * `<dataRoot>/worktrees/<projectId>/`. The project's grant must still
   * be registered, so revoking it revokes worktree execution too. An
   * exec directory that is not the grant and cannot be proven inside
   * the app-owned root is refused — there is NO silent fallback to the
   * project directory.
   */
  verifyExec(grant: WorkspaceGrant): WorkspaceGrant {
    const current = this.grants.get(grant.projectId);
    if (!current)
      throw new WorkspaceError(
        "WORKSPACE_REVOKED",
        "WORKSPACE_REVOKED: the project's directory authorization was removed",
      );
    if (grant.directory === current.directory) return this.verify(grant);
    if (this.dataRoot === undefined)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "WORKSPACE_INVALID: worktree execution unavailable — no data root",
      );
    const st = lstatSync(grant.directory);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "WORKSPACE_INVALID: authorized workspace no longer a real directory",
      );
    const physical = realpathSync(grant.directory);
    if (physical !== grant.directory)
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "WORKSPACE_INVALID: workspace path moved or re-linked",
      );
    let rootPhys: string;
    try {
      rootPhys = realpathSync(join(this.dataRoot, "worktrees", grant.projectId));
    } catch {
      throw new WorkspaceError(
        "WORKSPACE_INVALID",
        "WORKSPACE_INVALID: thread worktree root is missing",
      );
    }
    if (!physical.startsWith(rootPhys + sep))
      throw new WorkspaceError(
        "WORKSPACE_REVOKED",
        "WORKSPACE_REVOKED: thread workspace is outside the app-owned worktree root",
      );
    return grant;
  }
}
