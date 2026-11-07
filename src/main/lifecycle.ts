// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Async close coordinator. Order is contractual:
//   1. Synchronously block new work (turns/mutations) — before ANY await.
//   2. Asynchronously dispose provider children; only a confirmed close
//      counts, a dispatched signal or a cached "killed" flag does not.
//   3. Only then flush the store and release its lock — no write may ever
//      happen after the lock is gone, and no lock release before children
//      are confirmed gone.
// Failures surface through an async prompt: "retry" re-runs only the
// still-unconfirmed steps, "keep" leaves the app open in a read-only,
// stopped-accepting-work state with the failure evidence intact. The whole
// flow is single-flight — a second close request never spawns a duplicate
// teardown task.

export interface CloseCoordinatorDeps {
  /** SYNC: stop accepting new turns/work. Runs before any async gap. */
  blockNewWork(): void;
  /** Async provider teardown; never throws — unconfirmed children are
   * reported inside the result. */
  disposeChildren(): Promise<{ problems: string[] }>;
  /** Flush + release the store lock. Throws on failure (ownership kept). */
  saveStore(): void;
  /** Async user prompt; resolve "retry" or "keep". */
  askUser(failure: string): Promise<"retry" | "keep">;
  /** Resume the originally requested quit/close (exactly once). */
  finishQuit(): void;
  /** Switch to the read-only keep-open state. */
  enterReadOnly(): void;
}

export class CloseCoordinator {
  private running = false;
  private completed = false;
  /** Steps already confirmed — a retry never re-runs them. */
  private disposeConfirmed = false;

  constructor(private readonly deps: CloseCoordinatorDeps) {}

  /** Whether a pending close/quit may proceed without intervention. */
  get allowQuit(): boolean {
    return this.completed;
  }

  /** True while a teardown is in flight (UI may show a busy hint). */
  get inFlight(): boolean {
    return this.running;
  }

  /**
   * Trigger the close flow. Safe to call from BOTH the window 'close' and
   * the app 'before-quit' handlers — it is single-flight and idempotent.
   */
  requestClose(): void {
    if (this.completed || this.running) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    this.deps.blockNewWork();
    for (;;) {
      const problems: string[] = [];
      // Dispose runs only until one pass confirms every child — a later
      // retry skips it entirely rather than disposing twice.
      if (!this.disposeConfirmed) {
        try {
          problems.push(...(await this.deps.disposeChildren()).problems);
        } catch (err) {
          problems.push(`dispose failed: ${(err as Error).message}`);
        }
        if (problems.length === 0) this.disposeConfirmed = true;
      }
      if (problems.length === 0) {
        try {
          this.deps.saveStore();
        } catch (err) {
          problems.push((err as Error).message);
        }
      }
      if (problems.length === 0) {
        this.completed = true;
        this.running = false;
        this.deps.finishQuit();
        return;
      }
      const choice = await this.deps.askUser(problems.join("\n"));
      if (choice === "keep") {
        this.running = false;
        this.deps.enterReadOnly();
        return;
      }
      // "retry": loop — only the still-unconfirmed steps run again.
    }
  }
}
