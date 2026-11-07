# Phase 2b — Codex app-server protocol adapter

Status: **implemented against the offline fixture; real launches remain gated
and unverified.** This document is the protocol/behavior contract for
`WIN-P2B-CODEX-01`.

## Pin

- Protocol: Codex CLI / app-server **0.164.0**, upstream commit `6aaac694`
  (`CODEX_SCHEMA_PIN = "0.164.0+6aaac694"`).
- Pinned schema copy for fixtures/tests: read-only, kept outside the source
  tree. Evidence is kept in the maintainer archive outside the repository.
- Wire-format catalog: `tests/fixtures/codex-app-server/protocol-messages.json`
  (source + coverage metadata per message).

## Wire layer — independent from the synthetic protocol

Codex traffic is JSON-RPC 2.0 over NDJSON. It is **not** wrapped in the
synthetic `Envelope` and never passes through `NdjsonDecoder`.

- `stdioFrames.ts` exposes `NdjsonLineDecoder` (byte-level LF framing, UTF-8
  boundaries, frame cap, BOM policy) plus `WireCodec<F>` — bytes ↔ frames only.
- `StdioTransport<F>` is generic over the frame type and takes a codec. It
  still owns: spawn rules (`shell:false`, `.cmd/.bat` refused), stdin write
  queue + drain backpressure + in-flight byte budget + write watchdog, bounded
  stdout/stderr, exit≠close, delivered-close ordering, bounded escalation
  dispose. It knows nothing about JSON-RPC.
- `codexAppServerProtocol.ts` provides `codexWireCodec` (line → classified
  request/response/notification) and `CodexRpc`:
  - typed request ids — `{kind:"int"|"string", value}` — correlated strictly
    (`"1"` never settles `1`); responses with `id:null`, unknown ids,
    malformed result shapes or duplicate settles are protocol errors/drops;
  - client→server `request`/`notify`, server→client requests dispatched to a
    hook (never enter the pending table), `respond`/`respondError`;
  - per-RPC deadlines; **mutating** requests (`initialize`, `thread/*`,
    `turn/*`) that time out are fatal — wire state is unknowable, so the
    connection is poisoned instead of silently retried;
  - `failAllPending` on delivered close; drop counters for late/malformed
    traffic.

## Provider — `codexAppServerProvider.ts`

One app-server **session per local chat thread** (a Codex thread maps 1:1 to a
session; the session respawns after death and resumes via binding).

Flow: `initialize` → `initialized` → (`thread/start` | `thread/resume`) →
persist binding → `turn/start` → notifications → `turn/completed`.

Recovery rules:

- Binding (`ProviderThreadBinding` on the local `ChatThread.providerThread`)
  is persisted **before** `turn/start` via `engine.bindProviderThread` (which
  `flushNow`s). Local thread identity is never replaced.
- Existing binding → `thread/resume`, and the returned `thread.id` MUST equal
  the binding's; a mismatch or a server error is `CODEX_RESUME_FAILED` —
  never a silent adopt/retry.
- `binding.codexHomeId !== config.codexHomeId` refuses to resume (a different
  `CODEX_HOME` means a different history).
- Connection death at any point = fatal (`CODEX_CONNECTION_CLOSED` + stderr
  tail), pending turn terminated. Dead session + later turn → respawn and
  resume the persisted binding.
- No automatic retry of mutating RPCs.

Turn admission (authoritative):

- `ActiveTurn.providerTurnId` stays `null` until a **correlated successful
  `turn/start` response** admits it — the `turn/started` notification only
  records a candidate id and can never admit on its own. Candidate/response
  id mismatch is a fatal protocol error.
- Frames arriving before admission (same-chunk or early notifications and
  server requests) are buffered in wire order and replayed after admission.
- Responses are correlated by typed id (`pendingMethodFor`); a `null`-id
  error may map to the sole pending request, but a `null`-id success is
  never attributed.
- Server requests must name THIS thread + turn + item; missing/foreign ids
  get `-32602` and never reach a card.

Streaming/terminal:

- `item/agentMessage/delta` → assistant chunks (bounded; the terminal
  whole-composition `onMessageText` reconcile replaces, never duplicates). Tool `item/started`/
  `item/completed` and `item/commandExecution/outputDelta` → `onToolActivity`
  status — never assistant text.
- `turn/completed`: `completed` → done; `interrupted` → interrupted;
  `failed`/`status:"failed"` or `error` → provider error with the server
  message.
- Cancel → `turn/interrupt` (mutating, bounded); the turn ends interrupted and
  late events for it are dropped.
- Process death surfaces stderr diagnostics in the error.

Approvals (server→client requests):

- `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
  become the existing approval card — **only once/deny** is exposed
  (`{decision:"accept"}` / `{decision:"decline"}`); the card title carries the
  command or file-change description.
- `item/permissions/requestApproval` answers `{permissions, scope:"turn"}` on
  accept — turn scope only, never session/global. Every requested entry is
  rendered (bounded); a request that cannot be fully displayed or verified is
  declined whole rather than partially presented.
- Queued server requests present **one at a time**; the next shows only after
  the front answer's transport write is confirmed.
- Approval tickets stay pending until the answer's stdio write is
  acknowledged (write callback settles: queued → written | failed). Engine
  persistence/state transition happens only from the provider's
  `onApprovalAnswerWritten(providerKey)` confirmation — never from a queued
  boolean. A write failure expires the ticket visibly; a late ack after
  withdrawal or turn termination cannot resurrect it.
- `serverRequest/resolved` (and request-withdrawal notifications) expire the
  pending card via `onApprovalWithdrawn(providerKey)` — never fabricate a user
  answer.
- Any other server request method is answered JSON-RPC `-32601` AND surfaces a
  visible provider notice — it is never ignored.

## Runtime config — `codexRuntimeConfig.ts`

Resolved once in main; the renderer has no channel to it.

- `fixture` — `TIVANO_CODEX_FIXTURE=<abs .mjs>` + `TIVANO_CODEX_NODE=<abs>`;
  explicitly synthetic, never presented as a real CLI.
- `real` — `TIVANO_CODEX_EXECUTABLE=<abs codex.exe>`; validated native path
  (`.cmd/.bat`/shell/PATH probing refused), fixed argv `[-c, cli_auth_credentials_store="file", app-server]`.
  **Launch additionally requires `treeCapability.supported`** — see below.
- `unconfigured` — neither set; sends fail `CODEX_NOT_CONFIGURED`.
- Both fixture and real set → refuse to guess (unconfigured + reason).
- `CODEX_HOME` is app-private (`<dataRoot>/codex-home`, realpath-pinned),
  persistent across restarts, never `~/.codex`; symlink/escape/config-link/
  tmp-link CODEX_HOMEs are refused. `config.toml` gets a restricted
  safe-format `cli_auth_credentials_store = "file"` policy — any table header,
  single-quoted value, duplicate/conflicting key or non-top-level form makes
  the file incompatible (`CODEX_CONFIG_INCOMPATIBLE`), never silently patched.
  Child env is a whitelist:
  `CODEX_HOME` + HOME-ish roots + `SystemRoot/SystemDrive/windir` on win32 —
  no `PATH`, no API keys, no proxies.

## Process-tree gate — `providerProcessLifecycle.ts`

A real Codex child can spawn descendants, so "direct pid exited" is never
proof of teardown. The only accepted mechanism is a Windows Job Object owned
by a dedicated helper (`helpers/win32/tivano-job-helper.cpp`) — whose source
is now **implemented but Windows-unverified**: spec validation, atomic
Job-list assignment, pump threads and job-empty proof exist as reviewed
source, yet no Windows machine has ever executed it.

- `probeProcessTreeSupport` therefore reports **unsupported on every
  platform**, including win32 with a helper path configured and a real file
  on disk — file existence is not launch evidence, and no env var, renderer
  flag or persisted value can mint it. When a verified, versioned helper
  exists this probe gains a real attestation step.
- When unsupported, real mode stays configured-but-blocked:
  `AppInfo.codex.state = "unsupported"` + reason; `start()` throws
  `CODEX_REAL_UNAVAILABLE`. The offline fixture does not use this layer.
- `makeJobHelperSpawnImpl` wraps the payload spec as one base64url `--serve`
  argument; the helper owns the Job and proxies stdio (design only).

## Engine/UI surface

- `ProviderDescriptor.mode` gains `"codex"`; `AppInfo.codex` reports
  `{state, protocolPin, codexHomeId, executable?, reason?, cliVersion}` —
  states: `fixture | unconfigured | configured-unverified | unsupported`.
- Engine: `bindProviderThread`/`lookupProviderThread`, tool-activity → system
  activity rows, `onProviderNotice` → system notice, `onApprovalWithdrawn` →
  approval expired without an answer, `provider.endSession` on thread delete.
- UI: badge shows `Codex fixture` / `Codex` (+ state tooltip) — never "Mock";
  Composer labels the Codex provider; SettingsModal shows codex state, pin and
  `codexHomeId`. All new strings exist in en + zh-Hans.

## Explicitly NOT done / unverified

- No real Codex CLI, real model, production credential, keyring or network
  was used or verified. The job-helper source is implemented but has never
  executed on Windows; real mode is disabled on every platform — no
  Windows launch has been attempted or validated.
- Approval surface intentionally exposes only accept/decline; upstream
  command-approval decisions beyond that are not reachable from the UI.
- Permission grants are constrained to `scope:"turn"` and displayed as
  "Allow for this turn".
- Workspace grants persist via `<dataRoot>/workspace-grants.json` and are
  fully revalidated at bootstrap (real dir, non-symlink, inside the
  authorized root, live project). An empty authorized-roots set restores
  NOTHING (fail closed); registration persists the candidate map first and
  commits only on success — a failed write cannot mint an unpersisted
  capability. The fixture preserves its synthetic thread table as per-thread
  files in CODEX_HOME (instance-tagged ids, tmp+rename), so a restart runs a
  real thread/resume and concurrent fixture processes cannot collide.
- No PTY, Git, Hydra, installer, signing or update claims.

Maintainer integration: restored workspace grants activate only after the atomic save
succeeds. Unavailable entries survive unrelated registrations and revocations
until explicitly revoked. Managed directories require a project/data-root marker;
legacy unmarked directories are left untouched and are not restored. Approval
write callbacks check both the RPC instance and the original ticket identity.
