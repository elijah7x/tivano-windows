// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Per-turn checkpoint coordinator: the single owner of the before/end
// capture lifecycle, the durable ledger and the structured edit
// attribution. The engine calls beginTurn BEFORE a provider may mutate
// the authorized project, turnEnded exactly once per finished turn, and
// recordEdits only for the live matching turn. Every async boundary
// re-proves identity (thread, turn, grant, mutability) so a cancelled,
// deleted or rebound turn can never mint a complete record or start a
// provider. Nothing here ever writes into the user repository or index.

import { EngineError } from "./engine";
import { boundedTouched, CheckpointLedger, type TurnCheckpoint } from "./checkpointLedger";
import type { CheckpointService, PreviewResult, RestoreResult } from "./checkpointService";
import type { ProjectRuntimePaths } from "./projectRuntimePaths";
import type { ChatThread, CheckpointDiffView, Project } from "../shared/types";

export interface CheckpointCoordinatorDeps {
  service: CheckpointService;
  ledger: CheckpointLedger;
  paths: ProjectRuntimePaths | null;
  projects: () => readonly Project[];
  threads: () => readonly ChatThread[];
  emit: (e: { type: "checkpoints-changed"; threadId: string }) => void;
}

interface PendingTurn {
  recordId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  grantDir: string;
  /** Set by turnCancelled/threadDeleted/closing — a pending before-
   *  capture that resolves later must never start the provider. */
  cancelled: boolean;
  /** Structured edit paths attributed while the turn is live. */
  edits: Set<string>;
}

export class CheckpointCoordinator {
  private pending = new Map<string, PendingTurn>();
  /** Per-thread serialization of the capture pair. */
  private chains = new Map<string, Promise<void>>();
  private closed = false;
  /** Bounded shadow of turns whose ledger/capture path failed — shown as
   *  unavailable on the checkpoint card even when the ledger itself can
   *  no longer persist a record. */
  private failures = new Map<string, { threadId: string; turnId: string; reason: string; at: number }>();
  private static readonly MAX_FAILURES = 128;

  constructor(private deps: CheckpointCoordinatorDeps) {}

  private noteFailure(threadId: string, turnId: string, reason: string): void {
    if (this.failures.size >= CheckpointCoordinator.MAX_FAILURES) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(turnId, { threadId, turnId, reason: reason.slice(0, 240), at: Date.now() });
  }

  /** Ledger mutations may throw LedgerUnavailableError — a rejection is
   *  recorded visibly, never allowed to mint phantom success or escape
   *  into a delete/close path. */
  private safeUpdate(recordId: string, patch: Partial<TurnCheckpoint>, threadId: string, turnId: string): TurnCheckpoint | null {
    try {
      return this.deps.ledger.update(recordId, patch);
    } catch (err) {
      this.noteFailure(threadId, turnId, `ledger:${String((err as Error)?.message ?? err).slice(0, 160)}`);
      return null;
    }
  }

  private safeInvalidate(pred: (r: TurnCheckpoint) => boolean, reason: string): void {
    try {
      this.deps.ledger.invalidateWhere(pred, reason);
    } catch {
      /* ledger already unavailable — pending records show interrupted on reopen */
    }
  }

  private thread(threadId: string): ChatThread | null {
    return this.deps.threads().find((t) => t.id === threadId) ?? null;
  }

  private chain<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      threadId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Reserve ledger state, capture the "before" snapshot, then report
   * whether the provider may start. The reservation lands BEFORE the
   * first await so a cancel/delete arriving mid-capture is observed.
   * Returns false only when the turn must not start (cancelled/deleted/
   * closed) — an unavailable checkpoint NEVER blocks ordinary chat.
   */
  async beginTurn(thread: ChatThread, turnId: string): Promise<boolean> {
    const projectId = thread.projectId;
    if (!projectId || this.closed) return !this.closed;
    const grant = this.deps.paths?.lookup(projectId);
    if (!grant) return true; // no authorized directory — nothing to snapshot
    let record: TurnCheckpoint;
    try {
      record = this.deps.ledger.reserve({
        projectId,
        threadId: thread.id,
        turnId,
        grantDir: grant.directory,
        touchedPaths: [],
      });
    } catch (err) {
      // The ledger refused the reservation (unavailable, over-bound,
      // duplicate). Checkpoints are unavailable for this turn — visibly —
      // and ordinary chat still proceeds.
      this.noteFailure(
        thread.id,
        turnId,
        `ledger-reserve:${String((err as Error)?.message ?? err).slice(0, 160)}`,
      );
      this.deps.emit({ type: "checkpoints-changed", threadId: thread.id });
      return true;
    }
    const p: PendingTurn = {
      recordId: record.recordId,
      projectId,
      threadId: thread.id,
      turnId,
      grantDir: grant.directory,
      cancelled: false,
      edits: new Set(),
    };
    this.pending.set(turnId, p);
    this.deps.emit({ type: "checkpoints-changed", threadId: thread.id });

    const res = await this.chain(thread.id, () =>
      this.deps.service.capture(projectId, thread.id, turnId, "before"),
    ).catch((err): { kind: string; checkpointId?: string; reason?: string } => ({
      kind: "error",
      reason: `capture-threw:${String((err as Error)?.message ?? err).slice(0, 160)}`,
    }));

    // After EVERY await: re-prove ownership. A turn cancelled, deleted
    // or closed while the capture was in flight must never start its
    // provider — the pending latch was set synchronously, so it is
    // always visible here.
    const live = this.thread(thread.id);
    const owned =
      !p.cancelled &&
      !this.closed &&
      live !== null &&
      live.turn !== null &&
      live.turn.id === turnId &&
      (live.turn.status === "running" || live.turn.status === "waiting-approval");
    if (!owned) {
      this.safeUpdate(
        record.recordId,
        { status: "invalidated", reason: "turn-ended-before-start" },
        thread.id,
        turnId,
      );
      this.pending.delete(turnId);
      this.deps.emit({ type: "checkpoints-changed", threadId: thread.id });
      return false;
    }
    if (res.kind === "captured" && res.checkpointId) {
      this.safeUpdate(
        record.recordId,
        { baseCheckpointId: res.checkpointId },
        thread.id,
        turnId,
      );
    } else {
      // Honest unavailability — chat proceeds, the ledger shows why.
      this.safeUpdate(
        record.recordId,
        { status: "unavailable", reason: res.reason ?? res.kind },
        thread.id,
        turnId,
      );
    }
    this.deps.emit({ type: "checkpoints-changed", threadId: thread.id });
    return true;
  }

  /** Structured provider edit events — ONLY the live matching turn may
   *  accumulate paths; stale/foreign attributions are dropped. */
  recordEdits(turnId: string, paths: readonly string[]): void {
    const p = this.pending.get(turnId);
    if (!p || p.cancelled) return;
    for (const v of boundedTouched(paths)) {
      if (p.edits.size >= 1024) break;
      p.edits.add(v);
    }
  }

  /**
   * Exactly-once per finished turn. Only a successfully completed
   * ("done") turn earns an end capture; every other terminal state
   * invalidates the record. The end capture re-proves thread identity
   * and grant before persisting the pair.
   */
  turnEnded(threadId: string, turnId: string, status: string): void {
    const p = this.pending.get(turnId);
    if (!p || p.threadId !== threadId) return;
    this.pending.delete(turnId);
    const record = this.deps.ledger.get(p.recordId);
    if (status !== "done" || p.cancelled) {
      // A before-capture that already resolved "unavailable" keeps that
      // honest verdict; anything else ends invalidated.
      this.safeUpdate(
        p.recordId,
        {
          status: record?.status === "unavailable" ? "unavailable" : "invalidated",
          ...(record?.status === "unavailable" ? {} : { reason: `turn-${status}` }),
        },
        threadId,
        turnId,
      );
      this.deps.emit({ type: "checkpoints-changed", threadId });
      return;
    }
    if (!record || record.status !== "capturing" || !record.baseCheckpointId) {
      // Before capture never completed successfully — the record already
      // shows "unavailable"; an end capture without a base is meaningless.
      this.deps.emit({ type: "checkpoints-changed", threadId });
      return;
    }
    // A detached capture can still reject (service throw, ledger
    // unavailability) — it must NEVER surface as an unhandled rejection.
    void this.captureEnd(p, [...p.edits]).catch((err) => {
      this.noteFailure(
        p.threadId,
        p.turnId,
        `capture-end:${String((err as Error)?.message ?? err).slice(0, 160)}`,
      );
      this.deps.emit({ type: "checkpoints-changed", threadId: p.threadId });
    });
  }

  private async captureEnd(p: PendingTurn, edits: string[]): Promise<void> {
    const res = await this.chain(p.threadId, () =>
      this.deps.service.capture(p.projectId, p.threadId, p.turnId, "after"),
    ).catch((err): { kind: string; checkpointId?: string; reason?: string } => ({
      kind: "error",
      reason: `capture-threw:${String((err as Error)?.message ?? err).slice(0, 160)}`,
    }));
    // Stale-proofing: the turn object is gone (ended), so ownership is
    // proven by the persisted assistant message turnId + the SAME grant
    // directory. A rebound grant or deleted thread invalidates honestly.
    const thread = this.thread(p.threadId);
    const grant = this.deps.paths?.lookup(p.projectId);
    const owned =
      !this.closed &&
      !p.cancelled &&
      thread !== null &&
      thread.projectId === p.projectId &&
      thread.messages.some((m) => m.turnId === p.turnId) &&
      grant !== undefined &&
      grant.directory === p.grantDir;
    if (!owned) {
      this.safeUpdate(
        p.recordId,
        { status: "invalidated", reason: "ownership-lost-before-end" },
        p.threadId,
        p.turnId,
      );
      this.deps.emit({ type: "checkpoints-changed", threadId: p.threadId });
      return;
    }
    if (res.kind === "captured" && res.checkpointId) {
      this.safeUpdate(
        p.recordId,
        {
          status: "complete",
          endCheckpointId: res.checkpointId,
          touchedPaths: boundedTouched(edits),
        },
        p.threadId,
        p.turnId,
      );
    } else {
      this.safeUpdate(
        p.recordId,
        { status: "unavailable", reason: `after-capture:${res.reason ?? res.kind}` },
        p.threadId,
        p.turnId,
      );
    }
    this.deps.emit({ type: "checkpoints-changed", threadId: p.threadId });
  }

  /** Synchronous cancel latch — a pending before-capture resolving later
   *  can never start the provider. */
  turnCancelled(threadId: string, turnId: string): void {
    const p = this.pending.get(turnId);
    if (p && p.threadId === threadId) p.cancelled = true;
  }

  threadDeleted(threadId: string): void {
    this.deps.service.onThreadDeleted(threadId);
    for (const p of this.pending.values())
      if (p.threadId === threadId) p.cancelled = true;
    this.safeInvalidate(
      (r) => r.threadId === threadId,
      "thread-deleted",
    );
  }

  projectDeleted(projectId: string): void {
    this.deps.service.onProjectDeleted(projectId);
    for (const p of this.pending.values())
      if (p.projectId === projectId) p.cancelled = true;
    this.safeInvalidate(
      (r) => r.projectId === projectId,
      "project-deleted",
    );
  }

  /** Stop admission; pending captures may still settle under the service's
   *  own op ownership but can never mint a complete pair afterward. */
  closing(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.cancelled = true;
    this.safeInvalidate((r) => r.status === "capturing", "closing");
  }

  /** F20 hand-off: the ledger's provider-declared touched paths for one
   *  turn — pure read, no renderer identity involved. */
  touchedPathsFor(threadId: string, turnId: string): string[] {
    return (
      this.deps.ledger.list(threadId).find((r) => r.turnId === turnId)
        ?.touchedPaths ?? []
    );
  }

  /**
   * Renderer-facing list. Identity is the ledger's own — a caller picks
   * thread + record only. `stale` marks grant-dir drift so the UI can
   * show the record without pretending it is restorable.
   */
  list(threadId: string): Array<
    Pick<
      TurnCheckpoint,
      "recordId" | "turnId" | "status" | "reason" | "createdAt" | "updatedAt" | "touchedPaths"
    > & { stale: boolean }
  > {
    const t = this.thread(threadId);
    if (!t) return [];
    // Shadow entries for turns whose ledger path failed — they surface
    // as "unavailable" cards even when the ledger itself is refusing.
    const shadows = [...this.failures.values()]
      .filter((f) => f.threadId === threadId)
      .map((f) => ({
        recordId: `failed-${f.turnId}`,
        turnId: f.turnId,
        status: "unavailable" as const,
        reason: f.reason,
        createdAt: f.at,
        updatedAt: f.at,
        touchedPaths: [] as string[],
        stale: false,
      }));
    const records = this.deps.ledger.list(threadId).map((r) => {
      const grant = this.deps.paths?.lookup(r.projectId);
      return {
        recordId: r.recordId,
        turnId: r.turnId,
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        touchedPaths: r.touchedPaths,
        stale: grant?.directory !== r.grantDir,
      };
    });
    return [...records, ...shadows];
  }

  /**
   * Non-mutating preview driven ONLY by ledger identity. The caller names
   * a turn inside an authorized thread; checkpoint ids, roots and touched
   * paths come from the record — never from the request.
   */
  async preview(threadId: string, turnId: string): Promise<PreviewResult> {
    const fail = (reason: string): PreviewResult => ({
      kind: "unavailable",
      baseCheckpointId: "",
      endCheckpointId: "",
      touchedPaths: [],
      entries: [],
      limitations: [],
      reason,
    });
    const t = this.thread(threadId);
    if (!t || !t.projectId) return fail("thread-not-found");
    const record = this.deps.ledger.byTurn(threadId, turnId);
    if (!record) return fail("record-not-found");
    if (record.projectId !== t.projectId) return fail("foreign-record");
    if (record.status !== "complete" || !record.baseCheckpointId || !record.endCheckpointId)
      return fail(record.reason ? `not-complete:${record.reason}` : "not-complete");
    const grant = this.deps.paths?.lookup(record.projectId);
    if (!grant || grant.directory !== record.grantDir) return fail("grant-rebound");
    return this.deps.service.preview(
      record.projectId,
      threadId,
      record.baseCheckpointId,
      record.endCheckpointId,
      record.touchedPaths,
    );
  }

  /**
   * Mutating undo driven by the SAME ledger identity as preview — the
   * renderer still names only a thread+turn; every path and byte comes
   * from the verified record/manifest/blob side. Per-path results report
   * what was actually written, removed or kept.
   */
  async restore(threadId: string, turnId: string): Promise<RestoreResult> {
    const fail = (reason: string): RestoreResult => ({
      kind: "unavailable",
      entries: [],
      reason,
    });
    const t = this.thread(threadId);
    if (!t || !t.projectId) return fail("thread-not-found");
    const record = this.deps.ledger.byTurn(threadId, turnId);
    if (!record) return fail("record-not-found");
    if (record.projectId !== t.projectId) return fail("foreign-record");
    if (record.status !== "complete" || !record.baseCheckpointId || !record.endCheckpointId)
      return fail(record.reason ? `not-complete:${record.reason}` : "not-complete");
    const grant = this.deps.paths?.lookup(record.projectId);
    if (!grant || grant.directory !== record.grantDir) return fail("grant-rebound");
    return this.deps.service.restore(
      record.projectId,
      threadId,
      record.baseCheckpointId,
      record.endCheckpointId,
      record.touchedPaths,
    );
  }

  /** Whole-thread diff scope (frozen parsedDiff(selection:nil)): the
   *  earliest complete record's base vs the latest one's end over the
   *  union of touched paths — one fixed pair, so a mid-thread revert
   *  moves the end with the ledger. Null when no complete pair exists
   *  or the grant drifted. */
  private threadScope(
    threadId: string,
  ):
    | {
        projectId: string;
        baseCheckpointId: string;
        endCheckpointId: string;
        touchedPaths: string[];
      }
    | null {
    const t = this.thread(threadId);
    if (!t || !t.projectId) return null;
    const records = this.deps.ledger
      .list(threadId)
      .filter(
        (r) =>
          r.projectId === t.projectId &&
          r.status === "complete" &&
          !!r.baseCheckpointId &&
          !!r.endCheckpointId &&
          this.deps.paths?.lookup(r.projectId)?.directory === r.grantDir,
      );
    if (records.length === 0) return null;
    const touched = [...new Set(records.flatMap((r) => r.touchedPaths))];
    return {
      projectId: t.projectId,
      baseCheckpointId: records[0]!.baseCheckpointId!,
      endCheckpointId: records[records.length - 1]!.endCheckpointId!,
      touchedPaths: touched,
    };
  }

  /** Frozen FileChangeSummary for the whole thread — per-file +/−
   *  counted from the stored base→end blob diff. Read-only; files
   *  with no net text change still list (0/0) so the count stays
   *  honest about attribution. */
  async threadChangeSummary(threadId: string): Promise<{
    files: {
      path: string;
      additions: number;
      deletions: number;
      binary: boolean;
      reason?: string;
    }[];
    additions: number;
    deletions: number;
  } | null> {
    const scope = this.threadScope(threadId);
    if (!scope || scope.touchedPaths.length === 0) return null;
    const files: {
      path: string;
      additions: number;
      deletions: number;
      binary: boolean;
      reason?: string;
    }[] = [];
    let additions = 0;
    let deletions = 0;
    for (const path of scope.touchedPaths) {
      const v = await this.deps.service.diff(
        scope.projectId,
        threadId,
        scope.baseCheckpointId,
        scope.endCheckpointId,
        scope.touchedPaths,
        path,
      );
      if (v.kind === "binary") {
        files.push({ path, additions: 0, deletions: 0, binary: true });
        continue;
      }
      if (v.kind !== "text" && v.kind !== "empty") {
        // Attribution stays honest: base-unknown/end-unknown are UNKNOWN,
        // not absence — the file lists with its reason rather than fake
        // counts, and contributes nothing to the totals.
        files.push({
          path,
          additions: 0,
          deletions: 0,
          binary: false,
          ...(v.kind === "unavailable" && v.reason ? { reason: v.reason } : {}),
        });
        continue;
      }
      if (v.kind !== "text") {
        files.push({ path, additions: 0, deletions: 0, binary: false });
        continue;
      }
      let a = 0;
      let d = 0;
      for (const line of v.patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) a += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) d += 1;
      }
      files.push({ path, additions: a, deletions: d, binary: false });
      additions += a;
      deletions += d;
    }
    return { files, additions, deletions };
  }

  /** Whole-thread per-path diff — same scope as the summary. */
  async threadDiff(threadId: string, path: string): Promise<CheckpointDiffView> {
    const scope = this.threadScope(threadId);
    if (!scope) return { kind: "unavailable", reason: "no-thread-scope" };
    return this.deps.service.diff(
      scope.projectId,
      threadId,
      scope.baseCheckpointId,
      scope.endCheckpointId,
      scope.touchedPaths,
      path,
    );
  }

  /** Per-turn diff (F10/A32) — same ledger-identity resolution as
   *  preview; the service compares stored blobs only. */
  async diff(threadId: string, turnId: string, path: string): Promise<CheckpointDiffView> {
    const fail = (reason: string): CheckpointDiffView => ({ kind: "unavailable", reason });
    const t = this.thread(threadId);
    if (!t || !t.projectId) return fail("thread-not-found");
    const record = this.deps.ledger.byTurn(threadId, turnId);
    if (!record) return fail("record-not-found");
    if (record.projectId !== t.projectId) return fail("foreign-record");
    if (record.status !== "complete" || !record.baseCheckpointId || !record.endCheckpointId)
      return fail(record.reason ? `not-complete:${record.reason}` : "not-complete");
    const grant = this.deps.paths?.lookup(record.projectId);
    if (!grant || grant.directory !== record.grantDir) return fail("grant-rebound");
    return this.deps.service.diff(
      record.projectId,
      threadId,
      record.baseCheckpointId,
      record.endCheckpointId,
      record.touchedPaths,
      path,
    );
  }

  async dispose(): Promise<{ problems: string[] }> {
    this.closing();
    const problems = (await this.deps.service.dispose()).problems;
    // Anything still reserved but not terminal is honestly invalidated —
    // a restarted app sees the failure, not a phantom complete pair.
    this.safeInvalidate((r) => r.status === "capturing", "disposed");
    return { problems };
  }

  /** Guard helper for the engine — throws EngineError on bad identity. */
  mustThread(threadId: string): ChatThread {
    const t = this.thread(threadId);
    if (!t) throw new EngineError(`unknown thread ${threadId}`);
    return t;
  }
}
