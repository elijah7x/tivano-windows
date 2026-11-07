# Phase 2H — Windows x64 internal dev packaging (preparation)

Status: pipeline implemented; plan + harness self-test validated on
macOS. **No Windows artifact has been built. No Windows validation has
run.** This phase delivers the *pipeline* — the actual package build,
install and smoke are follow-up steps on a real Windows x64 host.

## What this is (and is not)

| mode | command | meaning |
|---|---|---|
| plan | `node scripts/package-windows.mjs --plan --evidence <dir>` | static validation: REAL scheme.json validation (ajv via app-builder-lib), committed-config policy, dist payload, win32-x64 node-pty runtime, resolvable deps → `build-plan.json`. Safe on any host. **Never implies a Windows build or Windows validation.** |
| build | `node scripts/package-windows.mjs --build --output <fresh dir> [--source-manifest <m>]` | real packaging. **Refuses unless run on win32/x64** — checked before any output mutation. electron-builder runs as a *bounded child process* (sanitized env, wall-time bound — an in-process call could enforce neither). Produces `win-unpacked/` + one NSIS installer + `build-manifest.json` + `BUILD-OK`, or `failure.json` with the partial output preserved. |
| freeze | `node scripts/package-windows.mjs --freeze-source-manifest --output <file>` | writes a `tivano-windows-source-manifest/1` (commit + per-file sha256) that must travel with a .git-less source archive; `--build` refuses when identity is unverifiable. |
| packaged smoke | `node scripts/windows/packaged-smoke.mjs --exe <.exe> --evidence <dir>` | offline smoke of a packaged exe on win32/x64 only. **No install/uninstall automation.** |
| dev harness | `node scripts/dev-smoke-harness.mjs --evidence <dir>` | DEV/HARNESS ONLY — the same shared flow on the macOS dev Electron. Proves selectors/IPC/persistence/bounds **before** spending Windows time. Not Windows validation, does not bypass the packaged gate. |

`npm run package:windows:plan` / `package:windows` / `smoke:packaged` wrap the first three.

## Prerequisites

- Windows 10/11 x64 host, Node ≥ 22.12.0 (use a current Node 24 LTS x64 installation), repo checkout.
- `npm ci` — exact lockfile; `electron-builder@26.18.0` pinned (no `^`).
- node-pty `prebuilds/win32-x64/` present in `node_modules` (npm's
  install-scripts policy may skip postinstall — prebuilds ship in the
  tarball and are verified by the pipeline).
- A **fresh, empty, external** `--output` for `--build`, `--evidence`
  for plan/smoke (a sibling of the checkout is fine; inside the source,
  an ancestor of it, a symlink into it, or anything non-empty is refused).

## Package identity & policy (committed config)

`config/windows-dev-builder.cjs` — validated three ways at plan/build:
ajv against the installed `scheme.json` (unknown properties rejected),
`validateBuilderConfig` policy, and electron-builder's own validation
inside the builder child.

- `appId: com.tivano.windows.dev`, `productName: "Tivano Windows Dev"`
- targets: `dir` + `nsis`, x64 only
- assisted per-user NSIS: `oneClick:false`, `perMachine:false`,
  `allowElevation:false`, `allowToChangeInstallationDirectory:true`,
  `runAfterFinish:false`, `deleteAppDataOnUninstall:false`
- **unsigned**: no certificate fields; child env strips `CSC_*`,
  provider and publish variables, and forces
  `CSC_IDENTITY_AUTO_DISCOVERY=false`
- **no auto-updater, no publish, no `--publish`, no associations**
- `npmRebuild:false`, `nodeGypRebuild:false`

## Application payload and production dependencies

`files:` — exact entries, no `dist/**` (stray build leftovers would
ship): the six dist payloads (`main/index.cjs`, `main/ptyHost.cjs`,
`preload/index.cjs`, `renderer/index.html`, `renderer/renderer.js`,
`renderer/styles.css`), `package.json`, `LICENSE`,
`THIRD_PARTY_NOTICES.md`, `TRADEMARK.md`, `node_modules/node-pty/{lib,prebuilds}/**` +
its package metadata; `!**/*.map`, `!node_modules/node-pty/**/*.test.js`.
electron-builder also includes declared production dependencies by default; the exact app allowlist is not a claim that node-pty is the only bundled package. Post-build inspection checks the resulting archive and unpacked runtime.

`asarUnpack: node-pty/**` — `.node` bindings, `winpty.dll`,
`winpty-agent.exe` and worker scripts cannot run from inside an ASAR.

Pre-build, `REQUIRED_DIST_FILES` + `REQUIRED_WIN_PTY_FILES` (18 files)
are verified on disk; a missing win32-x64 binding fails the build.
Post-build, `inspectBuiltOutput` requires the unpacked dir, the
`-setup.exe`, `resources/app.asar`, every node-pty Windows file under
`app.asar.unpacked/`, every `REQUIRED_ASAR_ENTRIES` inside the ASAR
(via `@electron/asar listPackage`), and rejects any `*.map`,
`tests/`/`src/`/`fixtures/` tree, `.devdata`, or symlink shipped.
The whole unpacked tree is hashed (`hashTree` → deterministic
`treeDigest`).

## Source binding

`enumerateSourceInput` hashes the REAL input set before the build:
`git ls-files -c -o --exclude-standard -z` on a checkout (dirty trees
are recorded honestly, never hidden), or the supplied frozen manifest
on a .git-less archive — **a build with neither refuses**
(`source-identity-unknown`). After the builder exits,
`verifySourceUnchanged` re-enumerates and fails on any drift. The
manifest records commit, mode, per-file sha256 list and
`sourceDigest` — the artifact is bound to what it actually came from.
`--freeze-source-manifest` produces the manifest at input-assembly
time; no baseline commit is hardcoded anywhere.

## Subprocess discipline (`runBounded`)

- POSIX children run `detached` (own process group); `exit` is
  authoritative, `close` gets a bounded settle — a descendant holding
  inherited pipes can never hang the run.
- On timeout with a live child: group `kill(-pid)` (POSIX) or
  `taskkill /PID <pid> /T /F` (Windows, explicit pid — never a name
  sweep), then bounded kill-settle; unconfirmed exits are reported as
  `kill-unconfirmed`, not painted green.
- On timeout or a missing close AFTER the child exited, POSIX cleanup targets the owned process group. Windows cannot prove descendant cleanup once its parent has gone; the build rejects any non-clean close/cleanup result. It never calls that a successful build.
- Output cap **kills** the producer (`outputOverflow`), never silently
  truncates while it runs forever.
- Spawn errors resolve promptly via `spawnError`.
- Result honesty: `exitObserved`, `closeObserved`, `cleanup`.

## Data root (packaged vs development)

`src/main/appDataPaths.ts` — resolved before Electron `ready`:

| condition | root |
|---|---|
| `--data-root=<path>` flag | that path (wins) |
| `TIVANO_DATA_ROOT` env | that path |
| `app.isPackaged` | `<OS appData>/Tivano Windows Dev` |
| otherwise (dev) | `<project>/.devdata` (unchanged) |

Chromium `userData`/`sessionData` stay under the resolved root. The
packaged default can never live inside the install dir or the ASAR, and
the dev product never reuses Tivano / Tivano Dev / Droppy stores or
imports credentials. The packaged-default path itself is exercised only
by the manual install checklist (smoke uses the `--data-root`
override by design — it does not claim the default).

## Packaged smoke (offline, Windows x64 only)

Thin wrapper around `scripts/lib/smoke-flow.mjs`:

- hard gate first: exits `3` off win32/x64 **before** any mutation;
- Playwright Core Electron API on the packaged exe with
  `--data-root=<fresh tmp>` + `TIVANO_WORKSPACE_ROOT=<fresh tmp>`;
- env allowlist drops every provider/credential variable — only the
  in-process **mock provider** can run;
- asserts: window+bridge+`isPackaged`, `userData`/`sessionData` under
  the test root and outside the install dir (component-aware path
  checks), project+thread via IPC, mock badge → approval → stream done,
  **project bound through the real grants restore path** (store.json
  `directory` + `userGrants`), real terminal/git panels opened and the
  unavailable state observed in the UI (not only IPC), EN + zh-Hans UI,
  clean restart + persisted thread, zero page errors;
- every close is `boundedClose` (time-boxed, owned-handle kill); all
  owned processes must confirm exit before data is cleaned — failures
  preserve it;
- `packaged-smoke.json` + screenshots in the evidence dir; any failed
  assertion exits nonzero.

## Dev harness self-test (this run's only dynamic proof)

`scripts/dev-smoke-harness.mjs` ran the same flow on macOS dev Electron:
**20/20 checks** — boot, bridge, isolated chromium dirs, `packaged=false`,
project/thread, mock approval→done, clean exit, grant-bound restart,
terminal honestly open (darwin gate), `git:overview` `ready` on a real
seeded repo, zh+en UI, both instances `outcome=resolved exitCode=0`.
Marked `DEV_HARNESS_ONLY` / `NOT_WINDOWS_VALIDATION` in its report.
Windows-only expectations (packaged flag, install-dir checks, closed
gates) are parameterized out — product code was not altered to fake
platform state.

## Capability matrix (unchanged gates)

| feature | Windows x64 | verified |
|---|---|---|
| mock provider turns | in-process | dev-harness (darwin) + packaged smoke pending |
| real providers | gated off unless configured | — |
| terminal | hard gate `platform` | packaged smoke pending (harness proved posix-open path) |
| git read panel | `/usr/bin/git` absent → honest `no-git`/`unavailable` | packaged smoke pending (harness proved posix-open `ready`) |
| checkpoints | backend only; unsupported off darwin | — |
| checkpoint apply | **not implemented** | — |
| auth | not implemented | — |

## Manual install/uninstall checklist — `NOT RUN`

On the Windows host, ordinary-user context (no admin):

1. [ ] run `Tivano-Windows-Dev-0.1.0-x64-setup.exe`; assisted, no
   elevation; per-user dir — `NOT RUN`
2. [ ] launch via Start-menu/desktop shortcut; window appears — `NOT RUN`
3. [ ] mock turn: approve, stream completes — `NOT RUN`
4. [ ] quit; relaunch; thread persisted — `NOT RUN`
5. [ ] `%APPDATA%\Tivano Windows Dev` exists, NOT under install dir —
   `NOT RUN`
6. [ ] terminal/git panels show honest unavailable — `NOT RUN`
7. [ ] uninstall via Settings → Apps; app removed; app-data retained —
   `NOT RUN`

No install acceptance is claimed without these observations.

## Tested vs deferred (honest ledger)

Tested on the macOS arm64 development host (darwin/arm64): focused unit tests, `--plan` with real
schema validation, `--build` host-guard refusal (exit 1, no mutation),
packaged-smoke gate refusal (exit 3, no mutation), shared-flow dev
harness end-to-end, `npm run verify` full suite.
Deferred to win32/x64: actual `--build`, packaged smoke, install
checklist. Electron was updated by the maintainer to exact 44.9.3; the final full suite ran on that version. The npm install audit reported zero known vulnerabilities. Official advisory: https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9 (44.9.1 is the first patched 44.x release).

## Limits

- No signing/notarization claims — unsigned by design.
- No release readiness claim — internal dev package only.
- macOS results are plan/dev-harness validation, not Windows validation.

## Maintainer acceptance (2026-10-25)

Build, typecheck, 626 unit tests, 107 Electron regression checks (12 instances exited), 20 shared-flow harness checks (2 instances exited), and schema/payload plan checks passed independently. English and Chinese final harness screenshots were reviewed. Actual ASAR fixture regressions cover normalized archive paths, forbidden source files and missing executable; frozen source hashes are checked before a build and again afterward. The source freeze uses the explicit build-input allowlist, not the entire checkout, and refuses existing manifest files.

Accepted scope is local packaging preparation and the test harness. Windows build, packaged execution, ordinary-user installation, uninstall/data retention, signatures and updates remain NOT RUN. Evidence is kept in the maintainer archive outside the repository.
