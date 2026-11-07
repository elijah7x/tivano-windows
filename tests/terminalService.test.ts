// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Embedded terminal service (phase-2e): ownership, synchronous capacity,
// same-tick races, startup failure, stale-incarnation fencing, ACK/flow
// accounting, read-only gating, and bounded cleanup — all against a
// scripted host so no real PTY is needed here (the real-PTY path is covered
// by the Electron smoke + e2e).

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLOW_HARD,
  FLOW_HIGH,
  FLOW_LOW,
  MAX_PER_THREAD,
  TerminalService,
  type TerminalHostHandle,
} from "../src/main/terminalService";
import { spawnWindowsTerminalHost } from "../src/main/windowsTerminalHost";
import { EngineError } from "../src/main/engine";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import type { AppEvent } from "../src/shared/ipc";
import type { TerminalInfo } from "../src/shared/types";

const dirs: string[] = [];
const tmp = (p = "tivano-p2e-"): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

const openStores: Store[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (openStores.length) {
    try {
      openStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

class ScriptedHost implements TerminalHostHandle {
  sent: unknown[] = [];
  killed = false;
  private msgCbs = new Set<(m: unknown) => void>();
  private exitCbs = new Set<(c: number | null) => void>();
  post(m: unknown): void {
    this.sent.push(m);
  }
  kill(): void {
    this.killed = true;
    this.emitExit(0);
  }
  onMessage(cb: (m: unknown) => void): void {
    this.msgCbs.add(cb);
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.add(cb);
  }
  emit(m: unknown): void {
    for (const cb of [...this.msgCbs]) cb(m);
  }
  emitExit(code: number | null): void {
    for (const cb of [...this.exitCbs]) cb(code);
  }
}

interface Rig {
  service: TerminalService;
  events: AppEvent[];
  hosts: ScriptedHost[];
  engine: Engine;
  store: Store;
  paths: ProjectRuntimePaths;
  mutable: { v: boolean };
  threadId: string;
  projectId: string;
}

function rig(opts: { mutable?: boolean; platform?: NodeJS.Platform } = {}): Rig {
  const dataRoot = tmp();
  const store = new Store(dataRoot);
  store.open();
  openStores.push(store);
  const grantFile = join(dataRoot, "workspace-grants.json");
  const paths = new ProjectRuntimePaths([], grantFile, dataRoot);
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
  const project = engine.createProject("p");
  const dir = tmp("tivano-p2e-ws-");
  paths.registerUser(project.id, dir);
  const thread = engine.createThread(project.id);
  const events: AppEvent[] = [];
  const hosts: ScriptedHost[] = [];
  const mutable = { v: opts.mutable ?? true };
  const service = new TerminalService({
    paths,
    threads: () => engine.snapshot().threads,
    mutable: () => mutable.v,
    emit: (e) => events.push(e),
    spawnHost: () => {
      const h = new ScriptedHost();
      hosts.push(h);
      return h;
    },
    platform: opts.platform ?? "darwin",
    isolatedHomeRoot: join(dataRoot, "term-home"),
  });
  return {
    service,
    events,
    hosts,
    engine,
    store,
    paths,
    mutable,
    threadId: thread.id,
    projectId: project.id,
  };
}

/** Drive a created session through ready → spawned → running. */
function boot(r: Rig, terminalId: string, pid = 4242): void {
  const host = r.hosts.at(-1)!;
  host.emit({ type: "ready" });
  const spawn = host.sent.find((m) => (m as { type?: string }).type === "spawn") as
    | { cols: number; rows: number; cwd: string }
    | undefined;
  expect(spawn).toBeTruthy();
  host.emit({ type: "spawned", pid, pgid: pid });
  const info = r.service.list(r.threadId).find((t) => t.id === terminalId);
  expect(info?.state).toBe("running");
}

const stateOf = (r: Rig, id: string): TerminalInfo | undefined =>
  r.service.list(r.threadId).find((t) => t.id === id);

describe("TerminalService — creation and ownership", () => {
  it("creates a running session in the authorized directory only", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 100, 30);
    expect(res.terminal?.state).toBe("starting");
    boot(r, res.terminal!.id);
    const host = r.hosts[0]!;
    const spawn = host.sent.find((m) => (m as { type?: string }).type === "spawn") as {
      cwd: string;
      env: Record<string, string>;
      shell: string;
    };
    expect(spawn.cwd).toBe(r.paths.lookup(r.projectId)!.directory);
    expect(spawn.env.TERM).toBe("xterm-256color");
    expect(spawn.env.HOME).toContain("term-");
    expect(spawn.env.HOME).not.toBe(process.env.HOME);
    expect(spawn.shell.startsWith("/")).toBe(true);
  });

  it("is unavailable on non-macOS platforms without spawning a host", () => {
    const r = rig({ platform: "win32" });
    const res = r.service.create(r.threadId, 80, 24);
    expect(res.unavailable).toBe("platform");
    expect(res.terminal).toBeUndefined();
    expect(r.hosts).toHaveLength(0);
  });

  it("win32 stays OFF when the candidate gate dep is absent or false", () => {
    // No dep at all — the ordinary packaged path.
    const r1 = rig({ platform: "win32" });
    expect(r1.service.create(r1.threadId, 80, 24).unavailable).toBe("platform");
    expect(r1.hosts).toHaveLength(0);
    // Dep present but the verdict is false — same refusal, no host.
    const events: AppEvent[] = [];
    const hosts: ScriptedHost[] = [];
    const svc = new TerminalService({
      paths: r1.paths,
      threads: () => r1.engine.snapshot().threads,
      mutable: () => true,
      emit: (e) => events.push(e),
      spawnHost: () => { const h = new ScriptedHost(); hosts.push(h); return h; },
      platform: "win32",
      windowsTerminalReady: () => false,
    });
    expect(svc.create(r1.threadId, 80, 24).unavailable).toBe("platform");
    expect(hosts).toHaveLength(0);
  });

  it("win32 candidate build creates sessions and the spawn message is Windows-shaped", () => {
    const events: AppEvent[] = [];
    const hosts: ScriptedHost[] = [];
    const r = rig();
    const svc = new TerminalService({
      paths: r.paths,
      threads: () => r.engine.snapshot().threads,
      mutable: () => true,
      emit: (e) => events.push(e),
      spawnHost: () => { const h = new ScriptedHost(); hosts.push(h); return h; },
      platform: "win32",
      isolatedHomeRoot: join(tmp(), "term-home"),
      windowsTerminalReady: () => true,
    });
    const res = svc.create(r.threadId, 80, 25);
    expect(res.terminal).toBeTruthy();
    const host = hosts[0]!;
    host.emit({ type: "ready" });
    const spawn = host.sent.find((m) => (m as { type?: string }).type === "spawn") as Record<string, unknown>;
    // Windows TerminalSpec contract: cols/rows/cwd/env — NO POSIX
    // shell/args fields ever reach the helper.
    expect(spawn.cols).toBe(80);
    expect(spawn.rows).toBe(25);
    expect(spawn.cwd).toBe(r.paths.lookup(r.projectId)!.directory);
    const env = spawn.env as Record<string, string>;
    expect(env.SystemRoot).toBeTruthy();
    expect(env.PATH).toContain("WindowsPowerShell");
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(env.USERPROFILE).toContain("term-");
    expect(env.TERM_PROGRAM).toBe("Tivano");
    expect(env.TERM).toBe("xterm-256color");
    expect("shell" in spawn).toBe(false);
    expect("args" in spawn).toBe(false);
    // The session drives exactly like POSIX after that.
    host.emit({ type: "spawned", pid: 4242 });
    expect(svc.list(r.threadId)[0]!.state).toBe("running");
  });

  it("win32 spawn env isolates all six roots inside the incarnation home", () => {
    const events: AppEvent[] = [];
    const hosts: ScriptedHost[] = [];
    const r = rig();
    const svc = new TerminalService({
      paths: r.paths,
      threads: () => r.engine.snapshot().threads,
      mutable: () => true,
      emit: (e) => events.push(e),
      spawnHost: () => { const h = new ScriptedHost(); hosts.push(h); return h; },
      platform: "win32",
      isolatedHomeRoot: join(tmp(), "term-home"),
      windowsTerminalReady: () => true,
    });
    const res = svc.create(r.threadId, 80, 25);
    const host = hosts[0]!;
    host.emit({ type: "ready" });
    const spawn = host.sent.find((m) => (m as { type?: string }).type === "spawn") as {
      env: Record<string, string>;
    };
    const env = spawn.env;
    const id = res.terminal!.id;
    const homePrefix = `term-${id}-1`;
    // All six roots inside THIS terminal's incarnation — nothing reaches
    // the host profile or a sibling incarnation.
    for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
      expect(env[key], key).toBeTruthy();
      expect(env[key]!, key).toContain(homePrefix);
      expect(env[key]!).not.toBe(process.env[key]);
    }
    expect(env.APPDATA).toContain("Roaming");
    expect(env.LOCALAPPDATA).toContain("Local");
    expect(env.APPDATA).not.toBe(env.LOCALAPPDATA);
    // No provider credentials, no inherited user environment: the env is
    // exactly the sterile allowlist, nothing more.
    const allowed = new Set([
      "SystemRoot", "SystemDrive", "windir", "PATH", "PATHEXT",
      "USERPROFILE", "HOME", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA",
      "TERM_PROGRAM", "TERM", "COLORTERM",
    ]);
    for (const key of Object.keys(env)) expect(allowed.has(key), key).toBe(true);
    for (const [k, v] of Object.entries(env)) {
      if (k === "SystemRoot" || k === "SystemDrive" || k === "windir" || k === "PATH" || k === "PATHEXT" ||
          k === "TERM_PROGRAM" || k === "TERM" || k === "COLORTERM") continue;
      expect(v).toContain(homePrefix);
    }
    // The isolated dirs were created before native launch.
    expect(existsSync(env.APPDATA!)).toBe(true);
    expect(existsSync(env.LOCALAPPDATA!)).toBe(true);
    expect(existsSync(env.TEMP!)).toBe(true);
  });

  it("win32 adapter+service: proven teardown cleans, unproven death retains", async () => {
    const r = rig();
    const children: (EventEmitter & { killed: boolean; stdin: { write(): boolean }; frame(o: unknown): void })[] = [];
    const mkChild = () => {
      const c = new EventEmitter() as EventEmitter & {
        killed: boolean;
        stdin: { write(): boolean };
        stdout: EventEmitter; stderr: EventEmitter;
        frame(o: unknown): void;
      };
      c.killed = false;
      c.stdin = { write: () => true };
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      (c as { kill?: () => boolean }).kill = () => { c.killed = true; return true; };
      c.frame = (o: unknown) => c.stdout.emit("data", Buffer.from(JSON.stringify(o) + "\n"));
      children.push(c);
      return c;
    };
    const svc = new TerminalService({
      paths: r.paths,
      threads: () => r.engine.snapshot().threads,
      mutable: () => true,
      emit: (e) => r.events.push(e),
      spawnHost: () => spawnWindowsTerminalHost({
        helperPath: "D:\\pkg\\tivano-job-helper.exe",
        spawnImpl: () => mkChild() as never,
      }),
      platform: "win32",
      isolatedHomeRoot: join(tmp(), "term-home"),
      windowsTerminalReady: () => true,
    });
    // Proven path: spawned → data → exit → cleanup{jobEmpty:true} → close(0)
    const id = svc.create(r.threadId, 80, 24).terminal!.id;
    await Promise.resolve();
    const c1 = children[0]!;
    c1.frame({ type: "spawned", pid: 4321 });
    expect(svc.list(r.threadId).find((t) => t.id === id)!.state).toBe("running");
    c1.frame({ type: "data", seq: 1, data: Buffer.from("hello").toString("base64") });
    c1.frame({ type: "exit", exitCode: 0, forced: false });
    c1.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    c1.emit("close", 0);
    expect(svc.list(r.threadId).find((t) => t.id === id)!.state).toBe("exited");
    // Unproven path: killed helper, no frames — never forgotten into success.
    const id2 = svc.create(r.threadId, 80, 24).terminal!.id;
    await Promise.resolve();
    const c2 = children[1]!;
    c2.frame({ type: "spawned", pid: 4322 });
    c2.emit("close", null); // death without testimony
    const s2 = svc.list(r.threadId).find((t) => t.id === id2)!;
    expect(s2.state).toBe("error");
    expect(s2.reason).toBe("host-lost");
  });

  it("a lost win32 host never triggers POSIX ownership recovery", () => {
    const events: AppEvent[] = [];
    const hosts: ScriptedHost[] = [];
    const r = rig();
    const svc = new TerminalService({
      paths: r.paths,
      threads: () => r.engine.snapshot().threads,
      mutable: () => true,
      emit: (e) => events.push(e),
      spawnHost: () => { const h = new ScriptedHost(); hosts.push(h); return h; },
      platform: "win32",
      isolatedHomeRoot: join(tmp(), "term-home"),
      windowsTerminalReady: () => true,
    });
    const id = svc.create(r.threadId, 80, 24).terminal!.id;
    const host = hosts[0]!;
    host.emit({ type: "ready" });
    host.emit({ type: "spawned", pid: 5150 });
    // Host dies without a cleanup proof: host-lost error, and NO
    // PtyOwnership restore is attempted on win32 — helper death is a
    // reap trigger, not an observed Job-empty proof, so ownership is
    // retained rather than forgotten into success.
    host.emitExit(6);
    const s = svc.list(r.threadId).find((t) => t.id === id)!;
    expect(s.state).toBe("error");
    expect(s.reason).toBe("host-lost");
    expect(hosts).toHaveLength(1); // no replacement spawn
  });

  it("is unavailable for an unbound thread and a lost grant", () => {
    const r = rig();
    const loose = r.engine.createThread(null);
    expect(r.service.create(loose.id, 80, 24).unavailable).toBe("unbound");
    const orphan = r.engine.createProject("orphan");
    const t2 = r.engine.createThread(orphan.id);
    expect(r.service.create(t2.id, 80, 24).unavailable).toBe("no-grant");
  });

  it("reserves capacity synchronously — a same-tick storm stops at the cap", () => {
    const r = rig();
    const made: string[] = [];
    for (let i = 0; i < MAX_PER_THREAD + 3; i++) {
      const res = r.service.create(r.threadId, 80, 24);
      if (res.terminal) made.push(res.terminal.id);
      else expect(res.unavailable).toBe("capacity-thread");
    }
    expect(made).toHaveLength(MAX_PER_THREAD);
    expect(r.hosts).toHaveLength(MAX_PER_THREAD);
  });

  it("rejects unknown threads and unknown terminals", () => {
    const r = rig();
    expect(() => r.service.create("no-such-thread", 80, 24)).toThrow(EngineError);
    expect(() => r.service.input("no-such", 1, "x")).toThrow(EngineError);
    expect(() => r.service.list("no-such-thread")).toThrow(EngineError);
  });
});

describe("TerminalService — startup failure and incarnation fencing", () => {
  it("startup failure (host launch throws) lands in error state", () => {
    const r = rig();
    // Replace the factory after the service exists? The service binds it at
    // construction — build a dedicated rig instead.
    const events: AppEvent[] = [];
    const svc = new TerminalService({
      paths: r.paths,
      threads: () => r.engine.snapshot().threads,
      mutable: () => true,
      emit: (e) => events.push(e),
      spawnHost: () => {
        throw new Error("boom");
      },
    });
    const res = svc.create(r.threadId, 80, 24);
    expect(res.terminal).toBeTruthy();
    const s = svc.list(r.threadId)[0]!;
    expect(s.state).toBe("error");
    expect(s.reason).toMatch(/^host-error:/);
  });

  it("spawn-failed from the host lands in error state", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    const host = r.hosts[0]!;
    host.emit({ type: "ready" });
    host.emit({ type: "spawn-failed", message: "posix_spawnp failed" });
    const s = stateOf(r, res.terminal!.id)!;
    expect(s.state).toBe("error");
    expect(s.reason).toContain("spawn-failed:");
  });

  it("a host that never responds is declared a startup timeout", () => {
    vi.useFakeTimers();
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    vi.advanceTimersByTime(6000);
    const s = stateOf(r, res.terminal!.id)!;
    expect(s.state).toBe("error");
    expect(s.reason).toBe("startup-timeout");
  });

  it("old-incarnation output/exit/input can never reach a restarted session", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    const id = res.terminal!.id;
    boot(r, id);
    const oldHost = r.hosts[0]!;
    r.service.restart(id);
    expect(stateOf(r, id)!.state).toBe("closing");
    expect(r.hosts).toHaveLength(1);
    oldHost.emit({ type: "cleanup", confirmed: true });
    oldHost.emitExit(0);
    expect(stateOf(r, id)!.incarnation).toBe(2);
    const before = r.events.filter((e) => e.type === "terminal-data").length;
    oldHost.emit({ type: "data", seq: 99, data: "STALE" });
    oldHost.emit({ type: "exit", exitCode: 0 });
    expect(r.events.filter((e) => e.type === "terminal-data")).toHaveLength(before);
    expect(() => r.service.input(id, 1, "x")).toThrow(/stale/);
    // The new incarnation boots independently.
    const newHost = r.hosts[1]!;
    expect(newHost).toBeTruthy();
    newHost.emit({ type: "ready" });
    newHost.emit({ type: "spawned", pid: 7777, pgid: 7777 });
    expect(stateOf(r, id)!.state).toBe("running");
    expect(oldHost.sent.some((m) => (m as { type?: string }).type === "shutdown")).toBe(
      true,
    );
  });
});

describe("TerminalService — flow control", () => {
  const flood = (r: Rig, host: ScriptedHost, n: number): void => {
    for (let i = 1; i <= n; i++) host.emit({ type: "data", seq: i, data: "x" });
  };

  it("pauses above the high-water mark and resumes below the low mark", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    boot(r, res.terminal!.id);
    const host = r.hosts[0]!;
    flood(r, host, FLOW_HIGH + 2);
    expect(host.sent.some((m) => (m as { type?: string }).type === "pause")).toBe(true);
    // ACK down to the low-water mark → resume is posted.
    r.service.ack(res.terminal!.id, 1, FLOW_HIGH + 2 - FLOW_LOW);
    expect(host.sent.some((m) => (m as { type?: string }).type === "resume")).toBe(true);
  });

  it("rejects future ACKs, tolerates duplicates, never grants unlimited credit", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    const id = res.terminal!.id;
    boot(r, id);
    const host = r.hosts[0]!;
    for (let seq = 1; seq <= 3; seq++) host.emit({ type: "data", seq, data: "abc" });
    expect(() => r.service.ack(id, 1, 4)).toThrow(/exceeds/);
    expect(() => r.service.ack(id, 1, 3)).not.toThrow();
    expect(() => r.service.ack(id, 1, 3)).not.toThrow(); // duplicate
    expect(() => r.service.ack(id, 2, 3)).toThrow(/stale/);
  });

  it("hard-cap backlog is a stalled consumer — error state + bounded teardown", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    boot(r, res.terminal!.id);
    const host = r.hosts[0]!;
    flood(r, host, FLOW_HARD + 1);
    const s = stateOf(r, res.terminal!.id)!;
    expect(s.state).toBe("error");
    expect(s.reason).toBe("stall");
    expect(host.sent.some((m) => (m as { type?: string }).type === "shutdown")).toBe(true);
  });

  it("a paused consumer that stops acking stalls out via the watchdog", () => {
    vi.useFakeTimers();
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    boot(r, res.terminal!.id);
    const host = r.hosts[0]!;
    flood(r, host, FLOW_HIGH + 5);
    expect(stateOf(r, res.terminal!.id)!.state).toBe("running");
    vi.advanceTimersByTime(16000);
    expect(stateOf(r, res.terminal!.id)!.state).toBe("error");
    expect(stateOf(r, res.terminal!.id)!.reason).toBe("stall");
  });
});

describe("TerminalService — close, restart, read-only, dispose", () => {
  it("same-tick create+close never leaks: the session is removed", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24);
    const id = res.terminal!.id;
    r.service.close(id);
    expect(r.service.list(r.threadId).find((t) => t.id === id)).toBeUndefined();
    expect(r.events.some((e) => e.type === "terminal-removed" && e.terminalId === id)).toBe(
      true,
    );
  });

  it("closing a live session waits for the host, then removes only that session", () => {
    const r = rig();
    const a = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, a);
    const b = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, b);
    r.service.close(a);
    expect(stateOf(r, a)?.state === "closing" || stateOf(r, a) === undefined).toBe(true);
    r.hosts[0]!.emit({ type: "exit", exitCode: 0 });
    r.hosts[0]!.emit({ type: "cleanup", confirmed: true });
    r.hosts[0]!.emitExit(0);
    expect(stateOf(r, a)).toBeUndefined();
    expect(stateOf(r, b)!.state).toBe("running");
  });

  it("a wedged host remains tracked after the close bound", () => {
    vi.useFakeTimers();
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    const host = r.hosts[0]!;
    r.service.close(id);
    vi.advanceTimersByTime(7000);
    expect(stateOf(r, id)?.state).toBe("error");
    expect(host.killed || host.sent.some((m) => (m as { type?: string }).type === "shutdown")).toBe(
      true,
    );
  });

  it("read-only blocks create and restart but never blocks close", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    r.mutable.v = false;
    expect(() => r.service.create(r.threadId, 80, 24)).toThrow(/read-only|closing/);
    expect(() => r.service.restart(id)).toThrow(/read-only|closing/);
    expect(() => r.service.close(id)).not.toThrow();
  });

  it("thread deletion kills sessions and removes them", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    const host = r.hosts[0]!;
    r.service.onThreadsDeleted([r.threadId]);
    expect(r.service.list(r.threadId)).toHaveLength(1);
    host.emit({ type: "cleanup", confirmed: true });
    host.emitExit(0);
    expect(r.service.list(r.threadId)).toHaveLength(0);
    expect(
      host.killed || host.sent.some((m) => (m as { type?: string }).type === "shutdown"),
    ).toBe(true);
  });

  it("dispose confirms clean exits and reports unconfirmed ones", async () => {
    vi.useFakeTimers();
    const r = rig();
    const a = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, a);
    const b = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, b);
    const p = r.service.dispose();
    // Session A exits cleanly; session B's host stays wedged → problem.
    r.hosts[0]!.emit({ type: "exit", exitCode: 0 });
    r.hosts[0]!.emit({ type: "cleanup", confirmed: true });
    r.hosts[0]!.emitExit(0);
    await vi.advanceTimersByTimeAsync(7000);
    const { problems } = await p;
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("unconfirmed");
    expect(r.service.list(r.threadId)).toHaveLength(1);
    expect(() => r.service.create(r.threadId, 80, 24)).toThrow(/closing/);
  });

  it("attach returns the bounded tail with honest seq bounds", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    const host = r.hosts[0]!;
    host.emit({ type: "data", seq: 1, data: "hello " });
    host.emit({ type: "data", seq: 2, data: "world" });
    const att = r.service.select(id);
    expect(att.tail).toBe("hello world");
    expect(att.tailFromSeq).toBe(1);
    expect(att.tailEndSeq).toBe(2);
    expect(att.info.state).toBe("running");
  });
});


describe("lead regression — terminal ownership boundaries", () => {
  it("read-only also rejects keyboard input", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    r.mutable.v = false;
    expect(() => r.service.input(id, 1, "touch unwanted\n")).toThrow(/read-only|closing/);
    expect(r.hosts[0]!.sent.some((m: any) => m.type === "input")).toBe(false);
  });
  it("rechecks the workspace when the asynchronous host becomes ready", () => {
    const r = rig();
    r.service.create(r.threadId, 80, 24);
    vi.spyOn(r.paths, "verify").mockImplementation(() => { throw new Error("grant revoked"); });
    r.hosts[0]!.emit({ type: "ready" });
    expect(r.hosts[0]!.sent.some((m: any) => m.type === "spawn")).toBe(false);
  });
  it("rechecks the workspace before restart", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    vi.spyOn(r.paths, "verify").mockImplementation(() => { throw new Error("grant revoked"); });
    expect(() => r.service.restart(id)).toThrow(/revoked/);
    expect(r.hosts).toHaveLength(1);
  });
  it("never inherits the login shell or its startup profiles", () => {
    const r = rig();
    r.service.create(r.threadId, 80, 24);
    r.hosts[0]!.emit({ type: "ready" });
    const spec = r.hosts[0]!.sent.find((m: any) => m.type === "spawn") as any;
    expect(spec.shell).toBe("/bin/zsh");
    expect(spec.args).toEqual(["-f"]);
  });
  it("close before host ready still shuts down that host", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    r.service.close(id);
    const host = r.hosts[0]!;
    expect(host.killed || host.sent.some((m: any) => m.type === "shutdown")).toBe(true);
    host.emit({ type: "ready" });
    expect(host.sent.some((m: any) => m.type === "spawn")).toBe(false);
  });
  it("restart does not spawn a replacement before cleanup is confirmed", () => {
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    r.service.restart(id);
    expect(r.hosts).toHaveLength(1);
  });
  it("PTY exit alone does not permit dispose while its host is still alive", async () => {
    vi.useFakeTimers();
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    const pending = r.service.dispose();
    r.hosts[0]!.emit({ type: "exit", exitCode: 0 });
    await vi.advanceTimersByTimeAsync(7000);
    expect((await pending).problems.length).toBeGreaterThan(0);
  });
  it("failed dispose retains unresolved ownership for the next retry", async () => {
    vi.useFakeTimers();
    const r = rig();
    const id = r.service.create(r.threadId, 80, 24).terminal!.id;
    boot(r, id);
    r.hosts[0]!.kill = () => {};
    const first = r.service.dispose();
    await vi.advanceTimersByTimeAsync(7000);
    expect((await first).problems.length).toBeGreaterThan(0);
    const second = r.service.dispose();
    await vi.advanceTimersByTimeAsync(7000);
    expect((await second).problems.length).toBeGreaterThan(0);
  });
});

describe("worktree-bound threads and script runs (A34)", () => {
  it("a worktree-bound thread spawns inside the worktree, not the project dir", () => {
    const r = rig();
    const dataRoot = (r.paths as unknown as { dataRoot: string }).dataRoot;
    mkdirSync(join(dataRoot, "worktrees", r.projectId, "wt-bound"), { recursive: true });
    // The binding stores the RESOLVED directory (verifyExec requires
    // realpath-identity — /var is a symlink to /private/var on macOS).
    const wtDir = realpathSync(join(dataRoot, "worktrees", r.projectId, "wt-bound"));
    r.store.update((d) => { d.threads[0]!.worktreeDir = wtDir; });
    const res = r.service.create(r.threadId, 80, 24);
    boot(r, res.terminal!.id);
    const spawn = r.hosts[0]!.sent.find((m) => (m as { type?: string }).type === "spawn") as { cwd: string };
    expect(spawn.cwd).toBe(wtDir);
  });

  it("a dead worktree binding reports unavailable instead of falling back to the project dir", () => {
    const r = rig();
    const dataRoot = (r.paths as unknown as { dataRoot: string }).dataRoot;
    const wtDir = join(dataRoot, "worktrees", r.projectId, "wt-dead");
    // Never created → verifyExec refuses; the project dir is NOT used.
    r.store.update((d) => { d.threads[0]!.worktreeDir = wtDir; });
    const res = r.service.create(r.threadId, 80, 24);
    expect(res.unavailable).toBeTruthy();
    expect(res.terminal).toBeUndefined();
    expect(r.hosts).toHaveLength(0);
  });

  it("opts.command is typed into the spawned shell and title lands on the session", () => {
    const r = rig();
    const res = r.service.create(r.threadId, 80, 24, { title: "Install", command: "npm install" });
    expect(res.terminal?.title).toBe("Install");
    boot(r, res.terminal!.id);
    const inputs = r.hosts[0]!.sent.filter((m) => (m as { type?: string }).type === "input");
    expect(inputs.map((m) => (m as { data?: string }).data).join("")).toBe("npm install\n");
  });
});
