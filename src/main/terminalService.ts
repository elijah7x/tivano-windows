// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppEvent } from "../shared/ipc";
import type { ChatThread, TerminalAttach, TerminalCreateResult, TerminalInfo } from "../shared/types";
import { PtyOwnership, type PtyIdentity } from "./ptyOwnership";
import { EngineError } from "./engine";
import type { ProjectRuntimePaths } from "./projectRuntimePaths";
import type { WorkspaceGrant } from "./provider";

export const MAX_PER_THREAD = 4;
export const MAX_TOTAL = 16;
export const FLOW_HIGH = 256;
export const FLOW_LOW = 64;
export const FLOW_HARD = 2048;
export const FLOW_STALL_MS = 15000;
export const TAIL_CAP = 65536;
export const SPAWN_TIMEOUT_MS = 5000;
export const CLOSE_OBSERVE_MS = 6000;
export const OUTPUT_CHUNK_MAX = 4096;
const OUTPUT_BYTES_MAX = 1024 * 1024;

export interface TerminalHostHandle {
  post(msg: unknown): void;
  kill(): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
}
export type TerminalHostFactory = () => TerminalHostHandle;
export interface TerminalServiceDeps {
  paths: ProjectRuntimePaths | null;
  threads: () => readonly ChatThread[];
  mutable: () => boolean;
  emit: (e: AppEvent) => void;
  spawnHost: TerminalHostFactory;
  isolatedHomeRoot?: string;
  platform?: NodeJS.Platform;
  /** win32 only: the validation-candidate gate — returns true ONLY when
   *  the compile-time candidate flag AND the attested helper's
   *  terminalCapable verdict both hold. Ordinary Windows builds never
   *  have this injected (or it returns false), so create() keeps
   *  reporting { unavailable: "platform" }. */
  windowsTerminalReady?: () => boolean;
  now?: () => number;
}
interface Session {
  info: TerminalInfo;
  host: TerminalHostHandle | null;
  spawnSent: boolean;
  hostExited: boolean;
  cleanupConfirmed: boolean;
  cols: number;
  rows: number;
  sentSeq: number;
  ackedSeq: number;
  pending: Map<number, number>;
  pendingBytes: number;
  paused: boolean;
  lastAckAt: number;
  tailChunks: { seq: number; data: string }[];
  tailLen: number;
  startTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  action: "close" | "restart" | "stop" | null;
  waiters: Set<(ok: boolean) => void>;
  ownership: { anchor: PtyIdentity | null; members: PtyIdentity[] } | null;
  /** F12: a command injected once the shell reports spawned — one shot,
   *  cleared on use. Runs inside the sterile shell in the session cwd. */
  command?: string;
}
const reason = (e: unknown): string => e instanceof Error ? e.message : String(e);
export class TerminalService {
  private sessions = new Map<string, Session>();
  private counters = new Map<string, number>();
  private disposed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: TerminalServiceDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private emitInfo(s: Session): void { this.deps.emit({ type: "terminal-state", terminal: { ...s.info } }); }
  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new EngineError(`unknown terminal ${id}`);
    return s;
  }
  private grant(s: Session): WorkspaceGrant {
    const t = this.deps.threads().find(t => t.id === s.info.threadId);
    if (!t?.projectId) throw new EngineError("unbound");
    const g = this.deps.paths?.lookup(t.projectId);
    if (!g) throw new EngineError("no-grant");
    this.deps.paths!.verify(g);
    if (g.directory !== s.info.cwd) {
      // F11/F12: a worktree session runs in the thread's bound exec dir —
      // proven confined under the app-owned project worktree root while
      // the grant itself stays the authorization anchor (revoking the
      // project kills this session's re-verification too). Anything else
      // is the old "terminal workspace changed" refusal.
      this.deps.paths!.verifyExec({ projectId: t.projectId, directory: s.info.cwd ?? "" });
    }
    return g;
  }
  private assertMutable(): void {
    if (this.disposed) throw new EngineError("the application is closing");
    if (!this.deps.mutable()) throw new EngineError("read-only: close failed or teardown is running");
  }
  list(threadId: string): TerminalInfo[] {
    if (!this.deps.threads().some(t => t.id === threadId)) throw new EngineError(`unknown thread ${threadId}`);
    return [...this.sessions.values()].filter(s => s.info.threadId === threadId).map(s => ({ ...s.info }));
  }
  select(id: string): TerminalAttach {
    const s = this.get(id);
    return { info: { ...s.info }, tail: s.tailChunks.map(c => c.data).join(""),
      tailFromSeq: s.tailChunks[0]?.seq ?? s.sentSeq + 1, tailEndSeq: s.sentSeq };
  }
  private owned(s: Session): boolean {
    return !!s.host && !(s.hostExited && (s.cleanupConfirmed || !s.spawnSent));
  }
  create(
    threadId: string,
    cols: number,
    rows: number,
    opts?: { title?: string; command?: string },
  ): TerminalCreateResult {
    this.assertMutable();
    const thread = this.deps.threads().find(t => t.id === threadId);
    if (!thread) throw new EngineError(`unknown thread ${threadId}`);
    const platform = this.deps.platform ?? process.platform;
    // Windows terminals exist ONLY in the compiled validation candidate
    // with an attested ConPTY helper — ordinary builds stay off. POSIX
    // other than darwin stays off unconditionally.
    if (platform === "win32") {
      if (this.deps.windowsTerminalReady?.() !== true)
        return { unavailable: "platform" };
    } else if (platform !== "darwin") {
      return { unavailable: "platform" };
    }
    if (!thread.projectId) return { unavailable: "unbound" };
    const grant = this.deps.paths?.lookup(thread.projectId);
    if (!grant) return { unavailable: "no-grant" };
    try { this.deps.paths!.verify(grant); } catch (e) { return { unavailable: reason(e) }; }
    // F11/F12: a worktree-bound thread's terminals run inside the bound
    // worktree — a dead or moved binding refuses honestly; there is NO
    // silent fallback to the project directory.
    let cwd = grant.directory;
    if (thread.worktreeDir !== undefined) {
      try {
        this.deps.paths!.verifyExec({ projectId: thread.projectId, directory: thread.worktreeDir });
        cwd = thread.worktreeDir;
      } catch (e) {
        return { unavailable: reason(e) };
      }
    }
    const active = [...this.sessions.values()].filter(s => this.owned(s));
    if (active.filter(s => s.info.threadId === threadId).length >= MAX_PER_THREAD) return { unavailable: "capacity-thread" };
    if (active.length >= MAX_TOTAL) return { unavailable: "capacity-total" };
    const n = (this.counters.get(threadId) ?? 0) + 1;
    this.counters.set(threadId, n);
    const title = (opts?.title ?? "").trim().slice(0, 80) || `Terminal ${n}`;
    const s: Session = {
      info: { id: randomUUID(), threadId, title, state: "starting", incarnation: 1, cwd },
      ...(opts?.command !== undefined ? { command: opts.command.slice(0, 4000) } : {}),
      host: null, spawnSent: false, hostExited: false, cleanupConfirmed: false,
      cols, rows, sentSeq: 0, ackedSeq: 0, pending: new Map(), pendingBytes: 0,
      paused: false, lastAckAt: this.now(), tailChunks: [], tailLen: 0,
      startTimer: null, closeTimer: null, action: null, waiters: new Set(), ownership: null,
    };
    this.sessions.set(s.info.id, s);
    this.emitInfo(s);
    this.start(s);
    return { terminal: { ...s.info } };
  }
  input(id: string, incarnation: number, data: string): void {
    this.assertMutable();
    const s = this.get(id);
    this.grant(s);
    if (incarnation !== s.info.incarnation) throw new EngineError("stale terminal incarnation");
    if (s.info.state !== "running" || !s.host) throw new EngineError("terminal is not running");
    s.host.post({ type: "input", data });
  }
  resize(id: string, incarnation: number, cols: number, rows: number): void {
    const s = this.get(id);
    if (incarnation !== s.info.incarnation) throw new EngineError("stale terminal incarnation");
    s.cols = cols; s.rows = rows;
    if (s.info.state === "running") s.host?.post({ type: "resize", cols, rows });
  }
  ack(id: string, incarnation: number, seq: number): void {
    const s = this.get(id);
    if (incarnation !== s.info.incarnation) throw new EngineError("stale terminal incarnation");
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > s.sentSeq) throw new EngineError("acknowledgement exceeds sent output");
    if (seq <= s.ackedSeq) return;
    for (const [n, bytes] of s.pending) if (n <= seq) { s.pendingBytes -= bytes; s.pending.delete(n); }
    s.ackedSeq = seq; s.lastAckAt = this.now();
    s.host?.post({ type: "ack", seq });
    if (s.paused && s.pending.size <= FLOW_LOW && s.pendingBytes < OUTPUT_BYTES_MAX / 4) {
      s.paused = false; s.host?.post({ type: "resume" });
    }
  }
  close(id: string): void { this.stop(this.get(id), "close"); }
  restart(id: string): void {
    this.assertMutable();
    const s = this.get(id);
    this.grant(s);
    if (s.action) throw new EngineError("terminal is closing");
    if (!this.owned(s)) {
      const active = [...this.sessions.values()].filter(x => this.owned(x));
      if (active.length >= MAX_TOTAL || active.filter(x => x.info.threadId === s.info.threadId).length >= MAX_PER_THREAD)
        throw new EngineError("capacity-thread");
    }
    this.stop(s, "restart");
  }
  onThreadsDeleted(ids: readonly string[]): void {
    for (const s of this.sessions.values()) if (ids.includes(s.info.threadId)) this.stop(s, "close");
  }
  async dispose(): Promise<{ problems: string[] }> {
    this.disposed = true;
    const pending = [...this.sessions.values()].map(s => new Promise<string | null>(resolve => {
      const done = (ok: boolean): void => { s.waiters.delete(done); resolve(ok ? null : `terminal ${s.info.title}: cleanup unconfirmed`); };
      s.waiters.add(done);
      this.stop(s, "close");
    }));
    const results = await Promise.all(pending);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    return { problems: results.filter((x): x is string => x !== null) };
  }
  private stop(s: Session, action: Session["action"]): void {
    s.action = action;
    if (s.startTimer) clearTimeout(s.startTimer);
    s.startTimer = null;
    if (!this.owned(s)) { this.cleaned(s); return; }
    if (action !== "stop") { s.info.state = "closing"; this.emitInfo(s); }
    if (!s.closeTimer) {
      s.closeTimer = setTimeout(() => {
        s.closeTimer = null;
        s.info.state = "error"; s.info.reason = "kill-timeout"; this.emitInfo(s);
        // Never forget a live or unconfirmed host to make the next retry pass.
        for (const done of [...s.waiters]) done(false);
      }, CLOSE_OBSERVE_MS);
      s.closeTimer.unref?.();
    }
    try { s.host?.post({ type: "shutdown" }); } catch { /* retain ownership until observed */ }
    if (!s.spawnSent && !s.hostExited) s.host?.kill();
    else if (s.hostExited && s.host) void this.recoverHost(s, s.host);
  }
  private cleaned(s: Session): void {
    if (s.closeTimer) clearTimeout(s.closeTimer);
    s.closeTimer = null;
    const action = s.action;
    s.action = null;
    s.host = null;
    for (const done of [...s.waiters]) done(true);
    if (action === "restart" && !this.disposed) {
      s.info.incarnation++;
      s.info.state = "starting";
      delete s.info.exitCode; delete s.info.signal; delete s.info.reason; delete s.info.pid;
      s.sentSeq = s.ackedSeq = s.pendingBytes = s.tailLen = 0;
      s.pending.clear(); s.tailChunks = []; s.paused = false;
      this.emitInfo(s); this.start(s);
    } else if (action === "close" || this.disposed) {
      this.sessions.delete(s.info.id);
      this.deps.emit({ type: "terminal-removed", terminalId: s.info.id });
    }
  }
  private fail(s: Session, why: string): void {
    s.info.state = "error"; s.info.reason = why; this.emitInfo(s);
    this.stop(s, "stop");
  }
  private start(s: Session): void {
    try {
      this.assertMutable(); this.grant(s);
      s.spawnSent = s.hostExited = s.cleanupConfirmed = false;
      s.ownership = null;
      s.host = this.deps.spawnHost();
      const host = s.host;
      host.onMessage(m => { if (s.host === host) this.message(s, m); });
      host.onExit(() => {
        if (s.host !== host) return;
        s.hostExited = true;
        if (s.cleanupConfirmed || !s.spawnSent) this.cleaned(s);
        else {
          s.info.state = "error"; s.info.reason = "host-lost"; this.emitInfo(s);
          void this.recoverHost(s, host);
        }
      });
      s.startTimer = setTimeout(() => { if (s.host === host && !s.action && s.info.state === "starting") this.fail(s, "startup-timeout"); }, SPAWN_TIMEOUT_MS);
      s.startTimer.unref?.();
      this.ensureWatchdog();
    } catch (e) { s.info.state = "error"; s.info.reason = `host-error:${reason(e)}`; this.emitInfo(s); }
  }
  private async recoverHost(s: Session, host: TerminalHostHandle): Promise<void> {
    if (!s.ownership) return;
    // PtyOwnership is POSIX-identity only — the Windows host adapter
    // never synthesizes an ownership record, and POSIX process-group
    // recovery must never run on win32 regardless.
    if ((this.deps.platform ?? process.platform) === "win32") return;
    const owner = new PtyOwnership(); owner.restore(s.ownership);
    try {
      if (await owner.stop() && s.host === host) { s.cleanupConfirmed = true; this.cleaned(s); }
    } catch { /* Query/permission failure leaves ownership unresolved. */ }
  }
  private spawnMessage(s: Session): Record<string, unknown> {
    this.assertMutable();
    const grant = this.grant(s);
    if (!this.deps.isolatedHomeRoot) throw new EngineError("isolated terminal HOME is required");
    const home = join(this.deps.isolatedHomeRoot, `term-${s.info.id}-${s.info.incarnation}`);
    mkdirSync(join(home, "tmp"), { recursive: true });
    if ((this.deps.platform ?? process.platform) === "win32") {
      // Validation candidate only (the gate above already decided). The
      // helper launches a FIXED system shell — TerminalSpec v1 has no
      // shell/args fields at all. The env is sterile: system roots from
      // THIS machine (SystemRoot is required for the Win32 subsystem),
      // an isolated per-incarnation profile/tmp, and NOTHING inherited —
      // no provider credentials, no user PATH additions, no COMSPEC.
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const tmp = join(home, "tmp");
      // Per-incarnation profile roots — created before native launch so
      // the shell never falls back to host profile locations. This is
      // env isolation for the terminal session only, not a filesystem
      // or security sandbox.
      const appData = join(home, "AppData", "Roaming");
      const localAppData = join(home, "AppData", "Local");
      mkdirSync(appData, { recursive: true });
      mkdirSync(localAppData, { recursive: true });
      return { type: "spawn", cols: s.cols, rows: s.rows, cwd: s.info.cwd,
        env: {
          SystemRoot: systemRoot,
          SystemDrive: process.env.SystemDrive ?? "C:",
          windir: systemRoot,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          PATH: `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
          USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp,
          APPDATA: appData, LOCALAPPDATA: localAppData,
          TERM_PROGRAM: "Tivano", TERM: "xterm-256color", COLORTERM: "truecolor",
        } };
    }
    return { type: "spawn", cols: s.cols, rows: s.rows, shell: "/bin/zsh", args: ["-f"], cwd: s.info.cwd,
      env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Tivano", HOME: home,
        ZDOTDIR: home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", LANG: "en_US.UTF-8", SHELL: "/bin/zsh" } };
  }
  private message(s: Session, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>;
    if (m.type === "ownership") {
      if (m.anchor && Array.isArray(m.members) && m.members.length <= 512) s.ownership = m as unknown as Session["ownership"];
      return;
    }
    if (m.type === "cleanup") {
      if (m.confirmed === true) {
        s.cleanupConfirmed = true;
        if (s.hostExited) this.cleaned(s);
      } else {
        s.info.state = "error"; s.info.reason = "kill-timeout"; this.emitInfo(s);
        if (s.closeTimer) clearTimeout(s.closeTimer);
        s.closeTimer = null;
        for (const done of [...s.waiters]) done(false);
      }
      return;
    }
    if (m.type === "exit") {
      if (s.startTimer) clearTimeout(s.startTimer);
      s.startTimer = null;
      if (!s.action) s.info.state = "exited";
      if (typeof m.exitCode === "number") s.info.exitCode = m.exitCode;
      if (typeof m.signal === "number") s.info.signal = m.signal;
      this.emitInfo(s);
      return;
    }
    if (s.action || s.info.state === "error") return;
    switch (m.type) {
      case "ready":
        if (s.spawnSent) return;
        try { const spec = this.spawnMessage(s); s.spawnSent = true; s.host!.post(spec); }
        catch (e) { this.fail(s, `host-error:${reason(e)}`); }
        break;
      case "spawned":
        if (!s.spawnSent || !Number.isSafeInteger(m.pid) || (m.pid as number) < 2) { this.fail(s, "host-error:invalid spawn report"); break; }
        if (s.startTimer) clearTimeout(s.startTimer);
        s.startTimer = null;
        s.info.pid = m.pid as number; s.info.state = "running"; this.emitInfo(s);
        // F12: a script session gets its command as the first input line —
        // visibly executed inside the sterile shell, never silently.
        if (s.command !== undefined) {
          const cmd = s.command;
          delete s.command;
          try { s.host!.post({ type: "input", data: cmd + "\n" }); }
          catch (e) { this.fail(s, `host-error:${reason(e)}`); }
        }
        break;
      case "spawn-failed": this.fail(s, `spawn-failed:${String(m.message ?? "unknown")}`); break;
      case "host-error": this.fail(s, `host-error:${String(m.message ?? "unknown")}`); break;
      case "kill-failed": this.fail(s, "kill-timeout"); break;
      case "data": {
        const seq = m.seq, data = m.data;
        if (!Number.isSafeInteger(seq) || seq !== s.sentSeq + 1 || typeof data !== "string" || data.length > OUTPUT_CHUNK_MAX) {
          this.fail(s, "host-error:invalid output frame"); break;
        }
        const n = seq as number, bytes = Buffer.byteLength(data);
        if (s.pending.size >= FLOW_HARD || s.pendingBytes + bytes > OUTPUT_BYTES_MAX) { this.fail(s, "stall"); break; }
        if (s.pending.size === 0) s.lastAckAt = this.now();
        s.sentSeq = n; s.pending.set(n, bytes); s.pendingBytes += bytes;
        s.tailChunks.push({ seq: n, data }); s.tailLen += data.length;
        while (s.tailLen > TAIL_CAP && s.tailChunks.length) s.tailLen -= s.tailChunks.shift()!.data.length;
        this.deps.emit({ type: "terminal-data", terminalId: s.info.id, incarnation: s.info.incarnation, seq: n, data });
        if (!s.paused && (s.pending.size > FLOW_HIGH || s.pendingBytes > OUTPUT_BYTES_MAX / 2)) {
          s.paused = true; s.host!.post({ type: "pause" });
        }
        break;
      }
    }
  }
  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      for (const s of this.sessions.values()) if (!s.action && s.pending.size > 0 && this.now() - s.lastAckAt > FLOW_STALL_MS) this.fail(s, "stall");
      if (![...this.sessions.values()].some(s => this.owned(s))) { clearInterval(this.watchdog!); this.watchdog = null; }
    }, 1000);
    this.watchdog.unref?.();
  }
}
