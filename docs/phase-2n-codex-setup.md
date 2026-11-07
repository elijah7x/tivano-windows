# Phase 2n — Codex CLI setup (user-chosen executable)

Status: **implemented; independently checked on the macOS development host.**
Windows, packaged-app and real-provider acceptance remain separate. This document is the behavior contract for
`WIN-P2N-CODEX-SETUP-01`. Choosing, saving and clearing the Codex CLI program
path is a user-facing settings feature; the saved path is a **candidate for
the next launch only** — it is never installed, verified, authenticated, or
probed, and it never starts a process by itself.

## What the feature is (and is not)

A user opens Settings → Codex CLI, clicks **Choose program…**, picks a file in
the **main-owned native dialog**, then clicks **Save** to persist it, or
**Clear** to remove the persisted value. The path is stored under
`settings.codexExecutable` and consulted only during the next bootstrap's
provider routing. It is:

- **not** a hot-switch: the running adapter is never replaced;
- **not** verification: `validateCodexExecutable` checks shape/name/file-type
  only — the program is never launched (no `--version`, no spawn);
- **not** authentication: nothing touches `CODEX_HOME` auth files,
  `config.toml` policy, the network, or user credentials;
- **not** a renderer-submitted path: the renderer can only request choose /
  save / clear / state; it cannot send a path, argv, env or command.

## IPC surface — narrow, empty payloads

`src/shared/ipc.ts` registers four request channels, all validated as
`vObject({})` — any payload key (including a path) is rejected:

| channel             | result (`CodexChooseResult` / `CodexWriteResult` / `CodexSetupState`) |
| ------------------- | ------------------------------------------------------------------- |
| `codex:setup-state` | live honest snapshot for the Settings UI                            |
| `codex:choose`      | opens the native dialog; returns `chosen` / `canceled` / `invalid` / `busy` / `superseded` / `unavailable` |
| `codex:save`        | persists the pending validated choice; `saved` (with `changed`) / `error` |
| `codex:clear`       | removes the persisted path; `cleared` (with `changed`) / `error`     |

The channel names carry no `exec`/`path`/`file`/`command`/`shell`/`eval`
vocabulary — the IPC guardrail test enforces this for every request channel.

## Path validation — `validateCodexExecutable`

Reused unchanged as the single gate for dialog results, saves, env candidates
and the persisted startup candidate. It rejects: non-string/non-finite
inputs, values over the length bound, NUL bytes, relative paths, script
wrappers (`.cmd`/`.bat`), wrong basenames (`win32` → `codex.exe` only;
POSIX → `codex` or `codex.exe`), non-regular files, and nonexistent paths.
Success returns the realpath-canonicalized absolute path. Validation is
file/path inspection only — the binary is never executed, on any platform.

## `CodexSetup` controller (main-owned state machine)

`src/main/codexRuntimeConfig.ts` → `CodexSetup`:

- **epoch ordering** — every chooser start and every clear bumps an epoch; a
  dialog result resolving under an older epoch is `superseded` and can never
  overwrite a newer decision (repeated clicks, late results, save/clear
  interleaving).
- **one chooser** — a second choose while the dialog is open returns `busy`.
- **mutability rechecked at every step** — before the dialog opens, after it
  resolves, and inside `commit` (`Engine.assertMutable` + `store.ownsWrites`).
  A window destroyed mid-choose or an engine in closing/read-only returns
  `unavailable`/`error` — nothing pending is minted.
- **pending ≠ persisted** — a validated pick becomes `pendingExecutable` only;
  Save is the separate durable step. A canceled dialog changes nothing.
- **save re-proves the path** — the file may have vanished since the dialog
  returned; validation runs again before commit.
- **same-value save is honest** — if the persisted value already equals the
  pick, `saved {changed:false}` clears the pending state without fabricating
  a pending-restart.
- **failed write keeps the choice** — commit failure returns `error` while
  `pendingExecutable` survives for an explicit retry; the persisted value is
  untouched.

## Durable write — `Engine.setCodexExecutable`

`src/main/engine.ts`: `assertMutable` gate → `store.update` → **`flushNow`**
(immediate durable write, not a scheduled one). A failed flush **reverts the
in-memory field** so no later scheduled flush can silently persist the failed
candidate, then the error propagates. Only `settings.codexExecutable` is
touched — every other settings/session field keeps its value. Success emits
`settings-changed`.

## Persistence — `storeDoc.ts`

`settings.codexExecutable` is `vOptional(vNonEmptyString(4000))` — strictly
structural validation only. Stores written before this field existed load
unchanged; a missing/absent field stays absent. A saved path that later
becomes invalid (file deleted, renamed…) **is not** structural corruption:
the document still loads, the value is preserved for the user to fix, and the
startup resolver reports the concrete reason.

## Startup routing — precedence (all pinned once at bootstrap)

`resolveCodexRuntime(env, dataRoot, { savedExecutable, treeCapability })`
keeps the existing order, with the saved value strictly below env routing:

1. `TIVANO_PROVIDER` present and ≠ `codex` → that provider (mock /
   synthetic-stdio / unknown values keep their behavior); the saved path is
   ignored entirely.
2. `TIVANO_PROVIDER=codex` (explicit) → Codex route; inside it:
   a. `TIVANO_CODEX_FIXTURE` + `TIVANO_CODEX_EXECUTABLE` both set → the
      pre-existing loud refusal; the saved value never resolves the conflict.
   b. `TIVANO_CODEX_FIXTURE` (+ `TIVANO_CODEX_NODE`) → `fixture`
      (`configuredFrom: "fixture"`); the saved value is not combined into a
      real run.
   c. `TIVANO_CODEX_EXECUTABLE` → `real` (`configuredFrom: "environment"`).
   d. neither → the saved value is the candidate.
3. `TIVANO_PROVIDER` absent + saved path present → Codex route with the saved
   value as the candidate.
4. No override and no saved path → unchanged default (mock).

Saved-candidate handling: full `validateCodexExecutable` again at startup —
structural store validation and live file validation stay separate steps. A
valid value yields `mode:"real"`, `configuredFrom:"saved"` (plus the
process-tree capability gate as with env). An invalid value yields
`mode:"unconfigured"`, `configuredFrom:"saved"`, `realUnavailableReason:
"saved executable no longer valid: …"` — honest, never substituted, never
deleted.

## `CodexSetupState` — the honest UI contract

`codex:setup-state` returns the full picture without mixing layers:

- `launchProvider` + `effectiveSource` (`fixture|environment|saved|none`) +
  `effectiveExecutable` — **the configuration selected for this launch**, not proof that the executable ran;
- `runtime` (`CodexInfo`) — the resolved runtime state/reason, identical to
  the About block;
- `savedExecutable` + `savedInvalidReason` — **the persisted value**;
- `savedEffect` — `active` only when the valid saved path matches this launch's
  selected executable, `pending-restart` when it differs, `blocked` for an
  explicit override (including an empty `TIVANO_PROVIDER`) or invalid path,
  or `none` after clearing. Changing A → B → A does not change the running
  adapter; only the saved effect changes;
- `pendingExecutable` + `chooserBusy` + `mutable` — **the in-flight choice**.

Under an environment/provider override the UI says exactly which variable
wins; it never promises the saved value will take effect. `configured-unverified`,
`unsupported`, `unconfigured` and fixture labels are preserved verbatim —
nothing claims installed, verified, or authenticated.

## Renderer

`SettingsModal` gains a Codex CLI block: launch source label, runtime
state/reason, executable in use, saved path (+ invalid reason), saved effect,
pending choice, error line, and Choose / Save / Clear buttons gated on
`mutable`, `chooserBusy`, loading and read failures. A synchronous operation
lock remains held through the subsequent state refresh; request identities
and unmount cleanup discard stale replies. Read failures expose Retry, and
Refresh status can recover after a native chooser closes.

UI labels and explanations are localized in `src/renderer/i18n.ts` (en +
zh-Hans); concrete main-process diagnostic reasons remain raw. Clearing
explains that this launch is unchanged and the next launch resolves its
remaining explicit settings before the default provider.

## Test seam

`TIVANO_TEST_CODEX_PICK` is accepted only in an unpackaged app with
`TIVANO_TEST_MODE=codex-setup`. Otherwise the normal native dialog is used.
The injected value still passes full `validateCodexExecutable` and the
epoch/mutable rules; a renderer cannot set env. The test marker is scoped to
this feature's E2E launches, not the general launcher.

## What this phase does NOT do

Choose/save/clear perform file inspection and persistence, not process
launching. The test executables are inert files and are never sent a turn. No live adapter/provider probing or hot-switch. No `CODEX_HOME`,
argv/env, `config.toml`, `providerThread`/`codexHomeId` or history changes.
No real Codex execution, authentication, network or credentials — on any
platform, including Windows.

## Maintainer validation — 2026-10-29

- Build, TypeScript and 48 unit suites / **919 tests** passed independently.
- Full desktop run: **172/172 checks**, no run error, all **25** owned
  instances exited. Existing crash tests deliberately kill their own app;
  the 11 Codex setup instances all closed normally.
- Real IPC and disk checks cover button-driven save/clear, restart, cancellation
  with an existing value, A → B → A, empty provider and executable/fixture
  overrides. Separate test-only IPC handlers cover renderer double clicks,
  busy-through-refresh, read/save retry and stale success/failure after reopening;
  those do not prove persistence.
- The maintainer viewed the seven final screenshots: English/Chinese pending restart,
  invalid selection, active-but-unsupported, explicit override, cleared and
  failed-read retry. Long paths wrap and the settings panel scrolls.
- The first desktop attempt failed in the new controlled-reply test: StrictMode
  replay issued another initial read, but the test answered only the first.
  Failure evidence was retained; the test now fails all initial reads until
  explicit retry and handles all new-mount requests. Product assertions and
  timeouts were not relaxed.
- A separate no-marker native-dialog run opened the actual macOS file panel,
  which the maintainer viewed. Desktop automation could not establish focus to
  select the fixture. The panel was canceled through its exact accessibility
  button; the bounded runner retained **failure**, then exited normally
  without rescue. Native select/save/cancel acceptance is **not complete**.
- No Windows run, package, real Codex launch, authentication or inference was
  performed.

Evidence is kept in the maintainer archive outside the repository. This is a
tested working-tree overlay, not a clean-commit or installer claim.

## Files

- `src/shared/types.ts` — `codexExecutable` setting + `CodexSetupState` /
  `CodexChooseResult` / `CodexWriteResult` types
- `src/shared/ipc.ts` — four channels, `vObject({})` validators
- `src/main/codexRuntimeConfig.ts` — `configuredFrom`, saved-candidate
  resolution, `CodexSetup` controller
- `src/main/engine.ts` — `setCodexExecutable` durable write + revert
- `src/main/storeDoc.ts` — optional field, structural validation
- `src/main/index.ts` — dialog wiring, routing, `codexSetupState` builder
- `src/main/ipc.ts` — `codexSetup` handler registration
- `src/renderer/components/SettingsModal.tsx` — Codex CLI block
- `src/renderer/i18n.ts` — en + zh-Hans strings
- `tests/codexSetup.test.ts` — unit coverage (validation, lifecycle,
  precedence, failure, no-spawn)
- `tests/ipc-validation.test.ts` — channel payload rejection
- `scripts/codexSetupChecks.mjs` + `scripts/e2e.mjs` — desktop E2E through
  the real bridge with en/zh screenshots
