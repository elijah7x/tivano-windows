# tivano-job-helper — build & verification notes (Windows only)

**Status: native Windows component validation passed.**
MSVC compilation, 45 portable checks and all 24 harness cases passed on
Windows Server 2022 x64 under an elevated account. See
[native validation evidence](../../docs/validation/windows-helper-2026-10-24.md).
Application integration remains unverified; real provider launches stay refused.

## Prerequisites (install yourself — nothing installs them for you)

- **Visual Studio Build Tools** with the *C++ build tools* workload
  (provides `cl.exe`, `link.exe`, `vswhere.exe`), and
- **Windows 10 SDK** (`_WIN32_WINNT 0x0A00` targets; the helper uses
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`, supported since Windows 10).
- Node.js (for the harness only — the helper binary has no Node dep).

## Vendored dependency (already in the repo — never fetched at build time)

- `third_party/nlohmann/json.hpp` — nlohmann/json **v3.12.0** single
  header, MIT license (`third_party/nlohmann/LICENSE.MIT`).
  SHA-256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
  The build script verifies this hash and refuses on mismatch.
  See `third_party/nlohmann/PROVENANCE.txt`.

## Reproducible build

From a plain PowerShell prompt (the script locates the toolchain itself):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-job-helper.ps1 `
  -OutDir D:\tivano-evidence\helper-build
```

`scripts/build-job-helper.ps1`:

- checks for `vswhere`, an x64 MSVC toolchain and `vcvars64.bat` — fails
  with instructions if missing, installs nothing;
- requires `-OutDir` to be EXTERNAL, outside the source tree, and either
  nonexistent or completely EMPTY — a stale binary can never pass as a
  fresh build and nothing existing is deleted;
- imports the `vcvars64.bat` environment INTO the PowerShell process via
  its `set` dump — no .cmd wrapper, so Unicode paths survive unaltered
  under Windows PowerShell 5 and PowerShell 7 alike;
- compiles each translation unit separately then links, with
  `/std:c++17 /W4 /WX /O2 /EHsc /utf-8 /DUNICODE /D_UNICODE /DNOMINMAX
  /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /MT` (static CRT — no
  runtime DLL dependency); objects go to `obj\` under `-OutDir` so `/Fo`
  names a real directory;
- checks `$LASTEXITCODE` after EVERY cl/link step — a later step's
  success can never reset a failure; the complete log is preserved at
  `build.log`;
- captures the `/Bv` compiler banner from a REAL compile step (a bare
  `cl /Bv` with no source only reports a missing-input error);
- builds `tivano-job-helper.exe` and the test-only `job-fixture.exe`;
- writes `build-manifest.json` (the real `/Bv` banner, `VCToolsVersion`,
  `WindowsSDKVersion`, `UCRTVersion` captured from the build environment,
  per-file and output SHA-256, flags) into `-OutDir`.

## Integration harness (proof, not a checkbox)

```powershell
node tests\windows\helper-harness.mjs `
  --helper D:\tivano-evidence\helper-build\tivano-job-helper.exe `
  --fixture D:\tivano-evidence\helper-build\job-fixture.exe `
  --out D:\tivano-evidence\helper-run --commit <git sha>
```

Each case runs in an ISOLATED child runner under a hard outer watchdog —
a timeout kills the runner (observed, not just requested), and a case
PASSES only on `close` with exit 0 AND exactly one `RESULT{pass:true}`
line: a pass-claim plus a nonzero exit is a fail, duplicate or malformed
RESULT lines are a fail, and a case whose cleanup is unknown STOPS the
remaining suite. Covers: stdio roundtrip, CRT-quoting edge args, unicode
exe path + actual cwd proof, byte-exact UTF-8 env, env non-inheritance
(sentinel absence), delivered env-block ordering (`_` after letters),
exact stdout+stderr tail bytes, malformed/oversized spec rejection with
no-payload-marker assertions, wrong/dead/unrelated owner rejection
(exit 3, including a process ID whose exit was already observed; no
deterministic parent-death/pre-spawn interleaving is claimed), payload nonzero exit,
concurrent stdout+stderr flood with hash-exact stderr, reader
pause→resume byte recovery, reader-never-resumes bounded exit 4
(exit awaited under watchdog, reader resumed, close bounded — the paused
stream never deadlocks the wait), blocked input-write bounded exit 4,
child ignoring stdin, stdin EOF grace→terminate, payload exit with live
descendants via a deterministic marker+release handshake (ALL identities
proven live, root released explicitly, exit 6 + all-dead), real owner
death (helper+tree exit evidence, bounded disappearance), forced helper
kill via the retained ChildProcess handle, breakaway attempts (must be
REFUSED access-denied AND tree reaped), repeated start/stop. Liveness
uses three-state queries (alive / confirmed-not-found / unknown) against
`StartTime.ToFileTime()` — a query FAILURE never counts as cleanup proof,
marker identities carry the process's OWN creation FILETIME, and a
reused pid is a different process. Results land in
`harness-results.json`; each case dir keeps `launched.json` + marker
files as teardown evidence.

**Windows component verification: 24/24 passed on 2026-10-24.**
The harness still refuses checks off win32; macOS runs are not substitutes.
Standard-user Windows 10/11 and application integration remain unverified.

## Behaviour contract (unchanged unless the lead approves a revision)

- `tivano-job-helper.exe --serve <base64url(JSON spec v1)>` — spec adds
  `v:1` and `ownerPid` vs the P2b draft; the Node encoder versions with it.
- `--version` → small JSON capability description (diagnostic only).
- Exit codes: `0` payload-0 + job empty with NOTHING force-terminated ·
  `2` invalid request · `3` setup/owner-identity failure · `4` cleanup
  or I/O proof failure (empty-timeout, drain-timeout, stalled write,
  dead pump thread, failed wait, unprovable exit code) · `5`
  CreateProcessW failed · `6` payload nonzero or anything
  force-terminated (`payload-exit=<n>` on stderr).

## What remains gated

`probeProcessTreeSupport()` still returns unsupported on every platform,
including win32 — passing this matrix is a precondition for the lead's
attestation decision, not the decision itself.


## Lead review corrections (2026-10-24)

Before the Cloud run, Windows build and execution were NOT RUN. Local checks cover the portable core and harness control only. The lead corrected the remaining false-pass paths: process queries now accept only structured OS absence evidence; null/failed queries remain unknown; RESULT parsing includes malformed lines, requires exit 0 and explicit clean teardown; timeout remains a failure even when process exit preceded delayed stdio close. Any failed/timeout/unknown case stops the suite; stopping a runner is not proof that descendants died. Marker identities are checked through a bounded disappearance wait.

The dead-owner case now supplies a process ID whose exit was observed and asserts pre-launch rejection. It does not pretend that immediately exiting a launcher deterministically orders its death before another process starts; that scheduling race is not claimed as covered. A separate live-owner-death case verifies job cleanup. Stalled-input/output fixtures record creation identities for post-case cleanup checks. The inherited environment sentinel is actually supplied.

Build setup validates output containment before creating directories, captures native stderr without PowerShell treating a compiler banner as the exit result, and imports the vcvars environment with cmd /u plus explicit UTF-16 decoding. The subsequent Cloud run compiled and exercised these Windows-specific paths.

The PowerShell script includes a UTF-8 BOM so Windows PowerShell 5.1 reads
its non-ASCII text correctly. Preserve that encoding when editing it.
