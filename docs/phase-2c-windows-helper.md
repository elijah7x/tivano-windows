# Phase 2c — Windows Job Object helper (WIN-P2C-JOB-HELPER-01, R2)

Status: **native Windows component validation passed**: 24/24 harness cases
and 45/45 portable checks on Windows Server 2022 x64 (elevated account).
The capability probe stays unsupported pending packaged-helper and
application lifecycle integration. See [native validation evidence](validation/windows-helper-2026-10-24.md).

## Why a helper exists at all

A real Codex child spawns descendants (the npm wrapper itself does), so
"the direct pid exited" or "kill() returned true" is never proof of a
reclaimed tree. Windows Job Objects are the only mechanism this phase
accepts: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the OS — not our
process-liveness bookkeeping — the cleanup authority.

## Files

| file | role |
|---|---|
| `helpers/win32/tivano-job-helper.cpp` | Win32 launcher: spec decode, actual-parent owner verify, Job + attribute-list create, dedicated pump threads, watch + drain + job-empty proof |
| `helpers/win32/helper_common.{hpp,cpp}` | **portable** core: base64url, spec v1 schema validation (incl. SAX depth bound), CRT quoting → UTF-16, ordinal-sorted env block — no Win32 headers |
| `helpers/win32/helper-selftest.cpp` | portable assertions compiled by `tests/windows/helper-core.test.ts` (host compiler) |
| `helpers/win32/third_party/nlohmann/json.hpp` | vendored nlohmann/json v3.12.0 (hash-pinned, MIT) |
| `helpers/win32/BUILD.md` | prerequisites + reproducible build + verification contract |
| `scripts/build-job-helper.ps1` | MSVC/SDK checks → vcvars env imported into PowerShell (Unicode-safe, no .cmd) → per-step `cl`/`link` with fail-fast → manifest (`/Bv` from a real compile + SDK/env versions + SHA-256) into a fresh external `-OutDir` |
| `tests/windows/job-fixture.cpp` | test-only payload: echo/args/printenv/getenv/cwd/flood/linger/spawn chains/breakaway attempts; UTF-8-explicit output; `PID:<pid>:<ct>` markers written at start |
| `tests/windows/helper-harness.mjs` | Windows-only integration harness (refuses off win32); 24 cases run in isolated child runners that must emit exactly one `RESULT{pass:true}` line AND exit 0; descendant identity = marker `PID:<pid>:<FILETIME>` verified against `StartTime.ToFileTime()` — a reused pid is a different process; unknown cleanup stops the suite |
| `tests/windows/harness-control.mjs` | platform-agnostic control layer: three-state identity queries, ownership tracking, isolated-runner watchdog |
| `tests/windows/harness-control.test.ts` + `test-runner.mjs` | control-semantics unit tests that run on ANY host |
| `tests/windows/owner-runner.mjs` | launcher stand-in for the owner-death case (announces `HELPERPID:<pid>`) |
| `src/main/providerProcessLifecycle.ts` | encodes spec v1 (`v`, `ownerPid`) into `--serve`; refuses encoded specs that cannot fit `lpCommandLine`; probe remains fail-closed |

## Wire contract

```
tivano-job-helper.exe --serve <base64url(JSON SpawnSpec)>
SpawnSpec v1 = {"v":1,"ownerPid":<int>,"executable":"<abs .exe>",
                "args":[<str>..],"cwd":"<abs dir>","env":{"K":"V"}}
```

Version bump vs the P2b draft: `v` + `ownerPid` were added, so the schema
is explicitly `v:1`; the Node encoder and the validator move together.

Validation (all before any OS object exists): spec ≤ 32 KiB AND the
encoded `--serve` command line ≤ 32700 chars (enforced by the Node
encoder — a spec near the JSON bound cannot fit `lpCommandLine` and is
refused before an impossible helper launch); strict UTF-8 (no NULs, no
lone surrogates); exact top-level field set; no duplicate fields **at any
depth** plus a SAX-level nesting bound (32) enforced before DOM
construction; `v == 1`; `ownerPid` a plausible pid; `executable`/`cwd`
absolute (`X:\`, `X:/` or `\\UNC`), executable ending `.exe` —
scripts/`.cmd`/`.bat`/extensionless are refused outright since no shell is
ever invoked — env keys `[A-Za-z_][A-Za-z0-9_]*` with case-insensitive
dedup, bounded args/env counts and string sizes, payload command line ≤
32700 chars. Rejection messages carry codes only — never spec content,
paths or env values.

`--version` prints a small JSON capability description — diagnostic
information, never treated as authorization evidence.

## Launch mechanics

1. **Owner verification first — the actual parent**: `spec.ownerPid` must
   equal this helper's real parent PID as recorded by the kernel process
   table (`CreateToolhelp32Snapshot` → `th32ParentProcessID`). The claimed
   pid is then `OpenProcess`ed (`SYNCHRONIZE|QUERY_LIMITED_INFORMATION`)
   and BOTH creation stamps are compared: an owner whose FILETIME
   postdates this helper's own is a reused pid, not the launcher —
   refused. An owner already signaled at open is refused, and the liveness
   check is repeated immediately before `CreateProcessW`. The held handle
   pins the identity we wait on; later pid reuse cannot redirect it. An
   image-name match proves nothing about who launched us and is NOT used
   as an authorization check.
2. **Unnamed Job**: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` only —
   `BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK` are deliberately absent.
3. **Atomic assignment**: `STARTUPINFOEXW` with
   `PROC_THREAD_ATTRIBUTE_JOB_LIST` — the payload is inside the Job at
   `CreateProcessW` (per *Old New Thing*, 2023-02-09). There is no
   suspended+assign window in which a helper death could orphan the tree;
   assignment failure = `CreateProcessW` failure.
4. **Narrow handle inheritance**: `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
   names exactly the three payload stdio ends; Job/owner handles are never
   inheritable. Explicit `lpApplicationName`; no shell, ever.
5. **Command line**: built with correct CRT quoting (empty args, embedded
   quotes, spaces, trailing backslashes, Unicode and metacharacters) —
   tested portably in `helper-selftest`.
6. **Environment**: the payload gets ONLY the spec env, sorted by the
   uppercase-folded ordinal order matching `CompareStringOrdinal(TRUE)`
   (`'_'` sorts after `'Z'`, unlike a lowercase fold), serialized as a
   double-NUL UTF-16 block with `CREATE_UNICODE_ENVIRONMENT`. Nothing
   leaks from the helper's env.
7. **I/O**: three pump threads (stdin→child, child stdout→parent stdout,
   child stderr→parent stderr), 64 KiB chunks, synchronous `ReadFile`/
   `WriteFile` with OS backpressure. The payload's own stdin close is
   benign (`kDestClosed`); OUR stdin EOF starts a bounded grace (5 s)
   after the payload's stdin is closed; a broken OUR-stdout/stderr means
   the launcher is gone → `TerminateJobObject`. Cancellation is
   `CancelSynchronousIo` aimed at each pump's OWN held thread handle
   (never a bare file handle, never another thread's I/O) plus a stop
   flag, with a bounded join (3 s). A pump that will not die turns the
   exit into `ExitProcess(4)` — storage shared with live threads is never
   destructed. `TerminateThread` is never used. Every pump write carries a
   zero-progress watchdog (15 s): ordinary backpressure below the deadline
   preserves bytes and resumes; a stall past it terminates the job and
   reports exit 4.
8. **Drain**: on payload exit the out/err pumps keep draining through real
   pipe EOF within a bound (10 s) — unread tail bytes cannot be dropped
   silently. ONLY a natural `kSourceEof` ending counts as complete output:
   a canceled, stopped, errored or bounded-out stream is truncated output
   and fails the session (exit 4), never folded into success.
9. **Wait**: `WaitForMultipleObjects(payload, owner, stdin-eof,
   pump-fatal)` sliced at 100 ms for the watchdogs. The manual-reset EOF
   event is consumed on first wake (no busy spin); any pump ending on a
   real I/O error (including `ERROR_INVALID_HANDLE`, which is never EOF)
   signals `pump-fatal` → `TerminateJobObject` → exit 4. Payload exit →
   job census; still-live members → active `TerminateJobObject`. Owner
   death → immediate terminate. EOF-grace expiry → terminate. Then
   bounded polling of `JobObjectBasicAccountingInformation.ActiveProcesses`
   until 0 (≤ 10 s). Post-launch failures can never return 3 — that code
   means "payload never ran"; post-launch is 4 (cleanup unprovable) or
   6 (cleanup proven).
10. **Diagnostics**: `tivano-job-helper: …` on stderr via a dedicated
    writer thread over a bounded drop queue — a full inherited stderr pipe
    stalls the writer, never lifecycle teardown; a still-blocked writer at
    exit turns it into a hard `ExitProcess(code)`.

## Exit taxonomy (stable contract)

| code | meaning |
|---|---|
| 0 | payload exited 0 AND job was already empty — nothing force-terminated |
| 2 | invalid invocation/spec — payload never ran |
| 3 | setup/owner-identity failure — payload never ran |
| 4 | cleanup/I-O proof failure: job-empty query failed or timed out, output drain exceeded its bound, a pump thread refused to die, a stdio write stalled past its no-progress deadline, the wait primitive failed, or the payload exit code is unprovable |
| 5 | CreateProcessW failed — payload never ran |
| 6 | payload nonzero OR anything was force-terminated (owner death, EOF-grace expiry, stalled write, lingering descendants) — `payload-exit=<n>` on stderr |

All diagnostics: `tivano-job-helper: ...` on stderr; stdout carries only
payload bytes.

## Non-obvious decisions (with sources)

- `PROC_THREAD_ATTRIBUTE_JOB_LIST` instead of suspended+assign — the
  documented orphan window is real ([Old New Thing](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)).
- Actual-parent owner binding — a spec is untrusted input; the kernel's
  process table is the only authority on who launched the helper. The held
  process handle pins the identity we wait on, so later PID reuse cannot
  redirect the wait ([Toolhelp](https://learn.microsoft.com/en-us/windows/win32/toolhelp/tool-help-reference),
  [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)).
- `CancelSynchronousIo` on dedicated thread handles — the documented
  mechanism for synchronous `ReadFile`/`WriteFile`; `CancelIoEx` alone
  cannot abort a synchronous pipe write ([CancelSynchronousIo](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelsynchronousio),
  [redirected stdio](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-a-child-process-with-redirected-input-and-output)).
- Job-empty proof uses `JobObjectBasicAccountingInformation.ActiveProcesses`
  — a definitive count with no process-id-list sizing problem.
- Abrupt helper death is covered by `KILL_ON_JOB_CLOSE`, but the helper
  makes NO claim of cleanup proof after dying — the harness's
  `forced-helper-termination` case is the OS-side check.

## What's verified where

- macOS (now): `tests/windows/helper-core.test.ts` compiles + runs the
  portable selftest (45 assertions) via clang++; `tests/windows/
  harness-control.test.ts` proves the watchdog/three-state-identity
  semantics with a stub query impl; lifecycle unit tests cover the encoded
  command-line bound. `npm run verify` green. This is NOT Windows
  validation.
- Windows (2026-10-24): MSVC build passed, native selftest 45/45, full
  harness 24/24 with clean teardown. Scope and hashes are recorded in the
  [native validation evidence](validation/windows-helper-2026-10-24.md).

## Explicitly not done

No real provider launch — the probe stays unsupported everywhere. No
installer, no signing, no signature/attestation step in the probe yet
(that arrives with maintainer evidence). No Wine/cross-compile substitute was
used or counts for anything.


## Maintainer review corrections (2026-10-24)

Before the Windows test-machine run, Windows build and execution were NOT RUN. Local checks cover the portable core and harness control only. The maintainer corrected the remaining false-pass paths: process queries now accept only structured OS absence evidence; null/failed queries remain unknown; RESULT parsing includes malformed lines, requires exit 0 and explicit clean teardown; timeout remains a failure even when process exit preceded delayed stdio close. Any failed/timeout/unknown case stops the suite; stopping a runner is not proof that descendants died. Marker identities are checked through a bounded disappearance wait.

The dead-owner case now supplies a process ID whose exit was observed and asserts pre-launch rejection. It does not pretend that immediately exiting a launcher deterministically orders its death before another process starts; that scheduling race is not claimed as covered. A separate live-owner-death case verifies job cleanup. Stalled-input/output fixtures record creation identities for post-case cleanup checks. The inherited environment sentinel is actually supplied.

Build setup validates output containment before creating directories, captures native stderr without PowerShell treating a compiler banner as the exit result, and imports the vcvars environment with cmd /u plus explicit UTF-16 decoding. The subsequent run on a Windows test machine compiled and exercised these Windows-specific paths.
