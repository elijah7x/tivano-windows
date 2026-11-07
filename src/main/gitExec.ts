// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// The ONLY way this slice ever spawns Git: a fixed executable, a fixed
// argument array, shell:false, and an environment built from scratch —
// never the inherited process environment. Every run is async (Electron
// main is never blocked), output-bounded and time-bounded; a runaway
// child is killed and its exit OBSERVED, never inferred from kill().

import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JOB_HELPER_RUN_EXIT_BASE,
  JOB_HELPER_RUN_EXIT_MAX,
  makeJobHelperSpawnImpl,
} from "./providerProcessLifecycle";
import type { SpawnImpl } from "./stdioTransport";

export interface GitRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the run hit the time bound and was killed. */
  timedOut: boolean;
  /** True when output exceeded the byte cap and the child was killed. */
  overflowed: boolean;
  /** Set when the child was cancelled by the service (dispose/delete). */
  cancelled: boolean;
  /** Set when the spawn itself failed (ENOENT/EACCES) — no process ever
   *  existed; `close` still resolves this run. Distinct from a real
   *  non-zero exit so callers never confuse "never ran" with "ran and
   *  failed". */
  spawnError?: string;
  /** Set when the EXECUTOR layer (Windows job-helper) failed or its exit
   *  could not be mapped to a real Git exit code — helper-level codes
   *  2..6, contract-violating values, unproven cleanup, or a sticky
   *  earlier cleanup failure. NEVER a Git negative: callers must not
   *  read code/stdout as repository truth. */
  executorFailed?: string;
}

export interface GitRunHandle {
  done: Promise<GitRunResult>;
  /** SIGTERM → SIGKILL escalation; resolves via `done` once the exit is
   *  observed. Idempotent: repeated calls never re-arm the SIGKILL timer
   *  and never signal a pid after `close` was observed (it may have been
   *  reused by then). kill() returning says nothing about the process
   *  being dead. */
  cancel(): void;
  /** Real pid of the spawned child (diagnostics / ownership tracking). */
  pid: number | null;
}

/** Environment seen by every Git child — built from scratch, so no
 *  GIT_* variable, config parameter, alias, PATH or credential helper can
 *  ever be inherited. `extra` layers the per-call values (ceiling dirs,
 *  object dir). */
export function gitChildEnv(
  homeDir: string,
  extra?: Record<string, string>,
  opts?: {
    platform?: NodeJS.Platform;
    /** Resolved git.exe — win32 only: its directory is the only
     *  non-system PATH entry. */
    executable?: string;
    /** Trusted main-process environment to lift SystemRoot/windir/
     *  SystemDrive/ComSpec from (case-insensitive). Defaults to the live
     *  process env — never a child's env and never renderer input. */
    systemEnv?: Record<string, string | undefined>;
    /** F13 push: the ONE op allowed to widen GIT_ALLOW_PROTOCOL — a
     *  service-hardcoded whitelist of URL transports (file/http/https/
     *  git/ssh). `ext`/`fd` command transports can never be named here
     *  unless the service source itself changes. Default stays "" (all
     *  transports blocked) for every other op. */
    allowProtocols?: string;
  },
): Record<string, string> {
  for (const key of Object.keys(extra ?? {})) {
    if (
      key !== "GIT_CEILING_DIRECTORIES" &&
      key !== "GIT_ALTERNATE_OBJECT_DIRECTORIES" &&
      key !== "GIT_INDEX_FILE"
    )
      throw new Error(`unsupported internal Git environment key: ${key}`);
  }
  if ((opts?.platform ?? process.platform) === "win32")
    return gitChildEnvWindows(homeDir, extra, opts);
  mkdirSync(homeDir, { recursive: true });
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homeDir,
    TMPDIR: join(homeDir, "tmp"),
    XDG_CONFIG_HOME: join(homeDir, "xdg"),
    LANG: "C",
    LC_ALL: "C",
    // No system/global config may ever contribute: repo config and our own
    // controlled view config are the only sources Git can see.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // No prompt, pager or external helper may ever run.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // No remote may ever be contacted, even by a lazy/partial fetch —
    // unless the caller is the push op, which names its own whitelist.
    GIT_ALLOW_PROTOCOL: opts?.allowProtocols ?? "",
    // Index refresh locks / gc locks are never taken, even by read-only
    // builtins: --no-optional-locks is also passed where it exists.
    GIT_OPTIONAL_LOCKS: "0",
    // All pathspecs are literal — a filename like ":(glob)" or "*.txt" is
    // data, never a pattern.
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NOGLOB_PATHSPECS: "1",
  };
  return { ...env, ...extra };
}

/** Windows path tail without relying on the host's path separator —
 *  this builder also runs under tests that simulate win32 elsewhere. */
const winDirname = (p: string): string => p.replace(/[\\/][^\\/]+$/, "");

/** Windows child environment. Isolated home/profile/temp/XDG roots;
 *  system/global Git config is masked by an EMPTY file we own (not a
 *  guessed NUL device name); PATH is exactly the resolved Git install
 *  directory plus the OS system directories — user PATH and every GIT_*
 *  variable are dropped; prompt/pager/askpass/ssh helpers are disabled
 *  or pointed at a guaranteed-absent executable inside the isolated home
 *  (an invoked helper fails to spawn instead of running anything). */
function gitChildEnvWindows(
  homeDir: string,
  extra: Record<string, string> | undefined,
  opts:
    | {
        executable?: string;
        systemEnv?: Record<string, string | undefined>;
        allowProtocols?: string;
      }
    | undefined,
): Record<string, string> {
  mkdirSync(homeDir, { recursive: true });
  const sys: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts?.systemEnv ?? process.env)) {
    const lk = k.toLowerCase();
    if (
      (lk === "systemroot" || lk === "windir" || lk === "systemdrive" || lk === "comspec") &&
      typeof v === "string" && v && !(lk in sys)
    )
      sys[lk] = v;
  }
  const systemRoot = sys.systemroot ?? sys.windir ?? null;
  const binDir = opts?.executable ? winDirname(opts.executable) : null;
  const pathDirs: string[] = [];
  for (const d of [
    ...(binDir ? [binDir] : []),
    ...(systemRoot ? [`${systemRoot.replace(/[\\/]+$/, "")}\\System32`, systemRoot] : []),
  ]) {
    if (!pathDirs.some((x) => x.toLowerCase() === d.toLowerCase())) pathDirs.push(d);
  }
  const emptyCfg = join(homeDir, "empty-gitconfig");
  try {
    writeFileSync(emptyCfg, "", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const mask = lstatSync(emptyCfg);
  if (!mask.isFile() || mask.isSymbolicLink() || mask.size !== 0)
    throw new Error("Git configuration mask must be a regular empty file");
  const tmp = join(homeDir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const noHelper = join(homeDir, "no-helper.exe");
  const env: Record<string, string> = {
    PATH: pathDirs.join(";"),
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: homeDir,
    LOCALAPPDATA: homeDir,
    HOMEDRIVE: "",
    HOMEPATH: "",
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(homeDir, "xdg"),
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: emptyCfg,
    GIT_CONFIG_GLOBAL: emptyCfg,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: noHelper,
    SSH_ASKPASS: noHelper,
    GIT_SSH_COMMAND: noHelper,
    GIT_PAGER: "",
    PAGER: "",
    GIT_ALLOW_PROTOCOL: opts?.allowProtocols ?? "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NOGLOB_PATHSPECS: "1",
  };
  if (sys.systemroot) env.SystemRoot = sys.systemroot;
  if (sys.windir) env.windir = sys.windir;
  if (sys.systemdrive) env.SystemDrive = sys.systemdrive;
  if (sys.comspec) env.ComSpec = sys.comspec;
  return { ...env, ...extra };
}

export type RunGit = (
  args: readonly string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number; maxBytes: number },
) => GitRunHandle;

export interface GitRunner {
  run: RunGit;
  /** Live children this runner owns — used by dispose to cancel + await. */
  active(): ReadonlySet<ChildProcess>;
  /** Cleanup proofs that were required but never arrived (Windows
   *  job-helper exit 4 or a helper killed before it could prove the Job
   *  empty). Sticky for the runner's lifetime: later spawns are refused
   *  and dispose keeps reporting them — a lost proof is never silently
   *  forgotten or claimed. */
  unprovenCleanups?(): readonly string[];
}

const SIGKILL_GRACE_MS = 800;

/**
 * Spawn-based runner. `maxBytes` is a HARD retained bound per stream: the
 * crossing chunk is truncated to the remaining room and everything after
 * is drained but discarded — a child that ignores SIGTERM can never grow
 * the result. Cancellation and timeouts escalate SIGTERM → SIGKILL once;
 * the promise resolves only after the child exit is observed.
 */
export function makeGitRunner(executable: string): GitRunner {
  const live = new Set<ChildProcess>();

  const run: RunGit = (args, opts) => {
    const child = spawn(executable, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.add(child);

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outLen = 0;
    let errLen = 0;
    let overflowed = false;
    let timedOut = false;
    let cancelled = false;
    let closed = false;
    let spawnError: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const kill = (sig: NodeJS.Signals): void => {
      if (closed) return; // never signal a possibly-reused pid
      try {
        child.kill(sig);
      } catch {
        /* already gone — the exit event still decides */
      }
    };

    // Escalate exactly once: the SIGKILL deadline is armed by the FIRST
    // fail() and is never re-armed by later calls.
    const fail = (): void => {
      kill("SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => kill("SIGKILL"), SIGKILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    // Hard retained bound: a chunk is appended only while the stream is
    // under the cap; the crossing chunk is sliced to fit, later chunks are
    // drained-and-dropped so the pipe never back-pressures the child.
    const onChunk = (buf: Buffer, isErr: boolean): void => {
      const seen = isErr ? (errLen += buf.length) : (outLen += buf.length);
      const kept = isErr ? stderr : stdout;
      if (kept.length < opts.maxBytes) {
        const room = opts.maxBytes - kept.length;
        const piece = buf.length <= room ? buf : buf.subarray(0, room);
        if (isErr) stderr = Buffer.concat([stderr, piece]);
        else stdout = Buffer.concat([stdout, piece]);
      }
      if (!overflowed && seen > opts.maxBytes) {
        overflowed = true;
        fail();
      }
    };
    child.stdout?.on("data", (d: Buffer) => onChunk(d, false));
    child.stderr?.on("data", (d: Buffer) => onChunk(d, true));
    child.on("error", (e) => {
      // Spawn failure (ENOENT/EACCES/…): no process exists. `close` still
      // fires and resolves the run — the flag distinguishes it from a
      // real exit.
      spawnError = e instanceof Error ? e.message : String(e);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      fail();
    }, opts.timeoutMs);
    timer.unref?.();

    let resolveDone: (r: GitRunResult) => void = () => {};
    const done = new Promise<GitRunResult>((resolve) => {
      resolveDone = resolve;
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      live.delete(child);
      resolveDone({
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        overflowed,
        cancelled,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    });

    return {
      done,
      pid: child.pid ?? null,
      cancel: () => {
        if (closed) return;
        cancelled = true;
        fail();
      },
    };
  };

  return { run, active: () => live };
}

// ---- Windows: Git through the attested job-helper (--run) --------------------

// The --run exit contract constants (JOB_HELPER_RUN_EXIT_BASE/MAX) are
// the single source in providerProcessLifecycle — see the import above.
// Only the 1024..1279 window restores a real Git exit code.

/** How long the runner waits after delivering stdin-EOF (or after a
 *  cancel/timeout) before escalating to killing the HELPER child it
 *  owns. Sized from the helper's own documented bounds: payload EOF
 *  grace (5 s), input pump stop (3 s), two sequential output drains
 *  (10 s + 3 s each), Job proof (10 s), diagnostics and scheduling slack.
 *  A kill request is never cleanup proof. */
export const GIT_HELPER_EOF_SETTLE_MS = 50_000;

interface HelperRunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  executorFailed?: string;
  /** Cleanup the helper could not prove — sticky for this runner. */
  unproven?: string;
}

/** Translate the helper's own exit channel into a GitRunResult shape.
 *  ONLY the 1024..1279 window restores a real Git exit code — stderr is
 *  never parsed for codes (helper diagnostics can fail to write and a
 *  payload could fake the same text). */
function mapHelperExit(
  raw: number | null,
  signal: NodeJS.Signals | null,
  killedByUs: boolean,
): HelperRunOutcome {
  if (raw === null)
    return {
      code: null,
      signal,
      executorFailed: "helper-terminated-without-exit",
      unproven: killedByUs
        ? "job-helper killed before cleanup proof"
        : `job-helper exited abnormally (signal ${signal ?? "?"}) — cleanup unproven`,
    };
  if (raw >= JOB_HELPER_RUN_EXIT_BASE && raw <= JOB_HELPER_RUN_EXIT_BASE + JOB_HELPER_RUN_EXIT_MAX)
    return { code: raw - JOB_HELPER_RUN_EXIT_BASE, signal: null };
  if (raw === 4)
    return {
      code: null,
      signal: null,
      executorFailed: "cleanup-unproven",
      unproven: "job-helper exited 4 — tree cleanup unproven",
    };
  if (raw === 2) return { code: null, signal: null, executorFailed: "helper-rejected-spec" };
  if (raw === 3) return { code: null, signal: null, executorFailed: "helper-setup-failed" };
  if (raw === 5) return { code: null, signal: null, executorFailed: "helper-spawn-failed" };
  if (raw === 6) return { code: null, signal: null, executorFailed: "payload-force-terminated" };
  return {
    code: null,
    signal: null,
    executorFailed: `helper-contract-violation:${raw}`,
    unproven: `job-helper exited ${raw} outside both contracts — cleanup unproven`,
  };
}

/**
 * Git runner that NEVER spawns git.exe directly: every run goes through
 * the attested job-helper in --run mode, so the entire tree sits inside
 * a Windows Job Object with kill-on-close.
 *
 * Cancellation/timeout/overflow first deliver stdin-EOF — the helper's
 * documented graceful path (payload stdin EOF → 5 s grace → bounded
 * job-empty proof) — instead of an immediate hard kill, so an ordinary
 * cancel still produces the helper's own cleanup evidence. Only when
 * that bounded window expires does the runner kill the ONE ChildProcess
 * handle it owns; a requested kill is never treated as cleanup proof.
 *
 * After ANY unproven cleanup (helper exit 4, contract violation, killed
 * helper) the runner is sticky-closed: run() refuses new spawns and
 * dispose keeps reporting the lost proofs — "Windows 正常非零负结果与
 * 执行器失败必须可区分" (executorFailed, never a fake Git negative).
 */
export function makeGitRunnerViaJobHelper(
  helperPath: string,
  executable: string,
  opts?: {
    eofSettleMs?: number;
    /** Test-only: replaces the job-helper spawn so host tests can drive
     *  the full 32-bit exit channel (POSIX truncates real exit codes to
     *  8 bits — 1024+code is unobservable through a real exit on macOS).
     *  Production always uses makeJobHelperSpawnImpl(helper, "run"). */
    spawnImpl?: SpawnImpl;
  },
): GitRunner {
  const live = new Set<ChildProcess>();
  const unproven: string[] = [];
  const spawnImpl = opts?.spawnImpl ?? makeJobHelperSpawnImpl(helperPath, "run");
  const settleMs = opts?.eofSettleMs ?? GIT_HELPER_EOF_SETTLE_MS;

  const immediate = (partial: Partial<GitRunResult>): GitRunHandle => ({
    done: Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      overflowed: false,
      cancelled: false,
      ...partial,
    }),
    pid: null,
    cancel: () => {},
  });

  const run: RunGit = (args, opts) => {
    if (unproven.length)
      return immediate({ executorFailed: "helper-cleanup-unproven" });
    let child: ChildProcess;
    try {
      child = spawnImpl({
        executable,
        args: [...args],
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env,
      });
    } catch (e) {
      return immediate({ spawnError: (e as Error).message, executorFailed: "spec-rejected" });
    }
    live.add(child);

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outLen = 0;
    let errLen = 0;
    let overflowed = false;
    let timedOut = false;
    let cancelled = false;
    let closed = false;
    let killedByUs = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // Graceful first phase: close OUR stdin to the helper — the helper
    // delivers payload stdin EOF, waits its own grace, then proves the
    // Job empty. Final escalation kills OUR helper handle only — Job
    // kill-on-close does the tree reaping, but unobserved reaping is
    // UNPROVEN cleanup, recorded sticky.
    const eofThenKill = (): void => {
      if (closed) return;
      try {
        child.stdin?.end();
      } catch {
        /* pipe already broken — the close event decides */
      }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          if (closed) return;
          killedByUs = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone — the exit event still decides */
          }
        }, settleMs);
        killTimer.unref?.();
      }
    };

    const onChunk = (buf: Buffer, isErr: boolean): void => {
      const seen = isErr ? (errLen += buf.length) : (outLen += buf.length);
      const kept = isErr ? stderr : stdout;
      if (kept.length < opts.maxBytes) {
        const room = opts.maxBytes - kept.length;
        const piece = buf.length <= room ? buf : buf.subarray(0, room);
        if (isErr) stderr = Buffer.concat([stderr, piece]);
        else stdout = Buffer.concat([stdout, piece]);
      }
      if (!overflowed && seen > opts.maxBytes) {
        overflowed = true;
        eofThenKill();
      }
    };
    child.stdout?.on("data", (d: Buffer) => onChunk(d, false));
    child.stderr?.on("data", (d: Buffer) => onChunk(d, true));
    let spawnError: string | undefined;
    let executionError: string | undefined;
    child.on("error", (e) => {
      if (closed) return;
      if (child.pid === undefined) spawnError = e instanceof Error ? e.message : String(e);
      else {
        executionError = "helper-process-error";
        eofThenKill();
      }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", () => {
        if (closed) return;
        executionError = "helper-stdio-error";
        eofThenKill();
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      eofThenKill();
    }, opts.timeoutMs);
    timer.unref?.();

    let resolveDone: (r: GitRunResult) => void = () => {};
    const done = new Promise<GitRunResult>((resolve) => {
      resolveDone = resolve;
    });
    child.on("close", (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      live.delete(child);
      // A child that never existed has no cleanup to prove — spawn
      // failure is an executor failure, NOT an unproven cleanup.
      const mapped =
        spawnError !== undefined
          ? { code: null, signal: null, executorFailed: "helper-spawn-failed" }
          : mapHelperExit(code, signal, killedByUs);
      if ("unproven" in mapped && mapped.unproven && !unproven.includes(mapped.unproven))
        unproven.push(mapped.unproven);
      const executorFailed = mapped.executorFailed ?? executionError;
      resolveDone({
        code: mapped.code,
        signal: mapped.signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        overflowed,
        cancelled,
        ...(spawnError !== undefined ? { spawnError } : {}),
        ...(executorFailed !== undefined ? { executorFailed } : {}),
      });
    });

    return {
      done,
      pid: child.pid ?? null,
      cancel: () => {
        if (closed) return;
        cancelled = true;
        eofThenKill();
      },
    };
  };

  return {
    run,
    active: () => live,
    unprovenCleanups: () => unproven,
  };
}
