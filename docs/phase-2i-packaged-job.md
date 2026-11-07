# Phase 2i — Packaged job-helper: attestation, packaging, offline app-layer test

**Status: maintainer accepted local implementation, build/typecheck + 663 unit tests + 107 Electron checks (12 instances, all exited). Windows build & app-layer run NOT RUN.**

This phase connects the already Windows-component-validated Job Object
helper (`tivano-job-helper.exe`, 45 portable checks + 24/24 harness cases
on Server 2022 x64 — *component* evidence only) into the packaged
application and prepares a repeatable, offline, application-layer
validation. It does **not** claim the packaged path works on Windows
yet — nothing here ran on Windows.

## Real call chain (now wired)

```
Electron main (index.ts)
  └─ probeAndAttestPackagedJobHelper()        [packagedJobHelper.ts]
       1. fixed locations only: resources/app.asar/dist/job-helper-manifest.json
                                  resources/job-helper/tivano-job-helper.exe
       2. win32 + x64 + app.isPackaged required — dev/other platforms
          return unsupported with an explicit reason
       3. real regular file, physical containment inside resources root
       4. size + SHA-256 == build-pinned manifest (inside the ASAR,
          same trust domain as the verifier)
       5. bounded `--version` probe (5 s plus up to 1 s cleanup observation, combined stdout/stderr capped at 64 KiB): exit 0 AND observed pipe close AND
          exact contract {helper, version==manifest.helperVersion,
          spec==1, diagnosticOnly:true, mechanisms⊋"job-object"}
       → ProcessTreeCapability { supported, helperPath, helperVersion,
                                 mechanism:"windows-job-object" }
  └─ resolveCodexRuntime(env, dataRoot, { treeCapability })
       verdict injected verbatim; TIVANO_CODEX_JOB_HELPER cannot reach it
  └─ CodexAppServerProvider.spawnImplForMode()
       real mode → makeJobHelperSpawnImpl(helperPath) →
         tivano-job-helper.exe --serve <base64url SpawnSpec v1>
           → Job Object (KILL_ON_JOB_CLOSE, no breakaway)
           → payload (codex.exe | test launcher) + descendants
       unsupported/missing helper → spawn impl that throws loudly;
       verification failure NEVER falls back to a plain payload spawn
```

The probe is kicked off at module load (in parallel with Electron
startup) and awaited once inside `makeProvider` during `whenReady` —
bounded, so startup can never hang on helper attestation. Unclosed probe handles remain owned by the close coordinator; a quit during bootstrap waits for initialization before saving the store, and new work stays blocked.

## Helper exit/close semantics → transport mapping

| Helper outcome | Transport sees | Meaning |
|---|---|---|
| exit 0 + `close` | close 0 | payload ended AND Job provably empty — clean teardown |
| exit 2/3/5 + close | close ≠0 | payload NEVER ran (invalid spec/owner/setup/CreateProcess) — loud failure |
| exit 4 + close | close ≠0 | cleanup or I/O proof failed — transport records failed teardown |
| exit 6 + close | close ≠0 | payload nonzero OR tree force-terminated — loud failure |
| helper killed externally | exit+close | Job handle closure triggers OS termination; the Windows harness must independently observe every recorded Job identity gone |
| exit w/o close | exit observed, close missing | pipes held by a straggler — `dispose()` reports INCOMPLETE cleanup, never success |
| no exit at all | bounded dispose | escalate per transport policy; still no false success |

`StdioTransport` semantics are unchanged: `exit` is informational,
`close` is the sole teardown proof, `kill()` is a request — never proof.
A normal helper exit follows its Job-empty check. Exit 4 explicitly means cleanup was not proven: the adapter retains that failure across disposal retries and blocks further launches. Externally killing the helper relies on Job kill-on-close; the Windows harness separately polls identities and cannot turn a kill request into a pass.

Cancellation: `turns:cancel` → transport stdin end → grace → kill helper
→ Job reaps → close observed → `interrupted`/`cancelled`. App exit:
`CloseCoordinator.disposeChildren` → `adapter.dispose()` → each
transport's bounded dispose — shutdown propagates through the
helper-backed transport; unconfirmed closes land in `problems[]` and
keep the app open (read-only), matching the existing lifecycle contract.

## Packaging contract (config + scripts)

- `config/windows-dev-builder.cjs`: `files` gains
  `dist/job-helper-manifest.json` (ASAR-pinned identity);
  `extraResources` = exactly one entry staging
  `dist/job-helper/tivano-job-helper.exe` →
  `resources/job-helper/tivano-job-helper.exe` (OUTSIDE the ASAR — a
  real exe the OS can CreateProcess). Unsigned/NSIS/no-publish/no-auto-run
  policy unchanged.
- `package-windows.mjs --build` stage 1.5 (win32/x64 only):
  `powershell -ExecutionPolicy Bypass -File scripts/build-job-helper.ps1
  -OutDir <fresh external tmp>` (bounded child) → runs the built exe's
  `--version` under a bound → hashes it → cross-checks the build
  script's own `build-manifest.json` → stages `dist/job-helper/*.exe` +
  writes `dist/job-helper-manifest.json` {schema, file, sha256, bytes,
  specVersion, helperVersion, builtAtUtc, toolchain, source{commit,
  sourceDigest}}. Missing toolchain/compiler failure → build fails; a
  stale exe can never be staged (script requires an EMPTY external dir).
- `package-plan.mjs`: `validateBuilderConfig` pins the exact
  extraResources entry + manifest allowlist coverage + forbids the exe
  as a `files:` payload + forbids test fixtures/sources;
  `inspectBuiltOutput` requires the exe at its fixed location, re-reads
  the ASAR manifest, and proves packaged bytes == pinned sha256/bytes —
  plus rejects duplicate helper copies, test fixtures, and source maps.
- `config/cloud-source-manifest.json`: helper sources, vendored
  nlohmann, build script, the two test `.cpp` inputs and
  `packaged-job-test.mjs` are now explicit inputs; `tests/**` exclusion
  narrowed accordingly (explicit paths win).

## Offline application-layer validation (prepared — NOT RUN)

`scripts/windows/packaged-job-test.mjs` — win32/x64 gated (exit 3
elsewhere), drives the REAL packaged exe via Playwright with
`TIVANO_PROVIDER=codex` + `TIVANO_CODEX_EXECUTABLE=<staged codex.exe>`
inside isolated task dirs whose paths contain Unicode + spaces:

```powershell
node scripts\windows\packaged-job-test.mjs `
  --exe     "D:\out\win-unpacked\Tivano Windows Dev.exe" `
  --launcher "D:\helper-build\codex-launcher.exe" `
  --evidence "D:\evidence\packaged-job"
```

- `tests/windows/codex-launcher.cpp` (built by the same
  `build-job-helper.ps1`, NEVER shipped) is the app-server JSONL
  protocol fixture as a native exe: initialize/thread+turn flows,
  approval request/answer, interrupt, `descendant` (spawns two
  grandchildren that record `PID:<pid>:<creationQuad>` then sleep —
  proving Job membership, not payload lifetime), `die`, `sleep`,
  `slow`, `elsewhere`, `badjson`. Marker evidence under
  `CODEX_HOME\fixture-state\markers\` (the whitelisted env's only
  guaranteed root).
- Scenarios: byte-level session → approval resolve → interrupt →
  descendants alive → kill helper → whole tree dead → fresh re-spawn →
  clean close → run-2 resume → descendants → kill ONLY the app →
  owner-death reaps the tree. Identities are pid+creation-FILETIME,
  three-state queried (`harness-control.mjs`); a case whose cleanup
  evidence cannot be proven STOPS the suite. Results →
  `packaged-job.json`; the task dir is preserved on any failure.
- The production package contains NO test hooks: the launcher is
  staged by the test, not shipped; `packaged-smoke` remains the
  mock-provider path.
- `job-fixture.exe`/`codex-launcher.exe` are build artifacts of the
  same script — they exist so BOTH component and packaged paths can be
  re-verified on one Windows host.

## Windows commands (prepared — none executed here)

```powershell
# 1. build (compiles helper+fixtures, builds dist, packs dir+nsis)
node scripts\package-windows.mjs --build --output D:\evidence\pkg-<ts>

# 2. offline packaged-job application test (above)
# 3. existing packaged smoke (mock provider) — unchanged:
node scripts\windows\packaged-smoke.mjs --exe <exe> --evidence <dir>
# 4. native helper component harness (optional re-verification):
node tests\windows\helper-harness.mjs --helper <exe> --fixture <fx> --out <dir>
```

## Remaining Windows acceptance gates (explicitly NOT RUN)

- Real Windows build (`--build`), packaged-job-test, packaged-smoke —
  all gated `win32/x64`, refuse elsewhere.
- Real `codex.exe`, authentication, model inference — never configured.
- Install/uninstall, signing, updater — out of scope by policy.
- Standard-user Windows 10/11 helper behavior (component evidence is
  Server 2022 x64 elevated only).

## Maintainer corrections before freezing

- Reproduced and rejected oversized probe output, trailing output after JSON, and exit without close; retained unresolved probe ownership for retry.
- Parsed PowerShell 5.1 UTF-8 BOM build manifests; rejected helper version probes with timeout, overflow, failed cleanup or missing close.
- Rejected duplicate helper executables inside ASAR; preserved build directory and fixture path in the build evidence.
- Serialized bootstrap against close and propagated helper exit-4 cleanup uncertainty, including close backlogs.
- Hardened native fixture marker sharing and reader synchronization. Fixture control terminates a recorded identity through the same Windows process handle used to verify its creation time.
- Packaged driver retains process identities, checks streaming before completion and original resume binding, stops after unproven cleanup, and records renderer errors/screenshots. Native changes still require Windows compilation and execution.

Evidence is kept in the maintainer archive outside the repository; initial failures remain preserved. This is local acceptance only, not authentication/inference or Windows application acceptance.
