# Phase 2a — Controlled synthetic stdio process

Scope: an explicitly controlled **synthetic local child process** behind a
small provider adapter. This document defines the wire contract, lifecycle,
budgets, isolation and failure semantics implemented in this phase. It is
NOT Codex JSON-RPC and claims nothing about real provider behaviour — the
real-CLI status stays `not-configured`, and no credentials, host CLIs,
network, PTY, Hydra, Git or production data are involved anywhere.

## 1. Identities and roles

- `src/main/provider.ts` — the adapter contract every turn provider
  satisfies: `descriptor` (id/label/mode/synthetic/runtimeInfo),
  `start(ctx, callbacks)` (synchronous, must not fire callbacks before
  returning the handle), `dispose()` (async, idempotent, never throws).
- `src/main/stdioFrames.ts` — byte-level NDJSON v1 framing.
- `src/main/stdioTransport.ts` — one spawned child: pipes, budgets,
  write queue, exit/close state machine, bounded escalation.
- `src/main/syntheticStdioProvider.ts` — the adapter: one child per turn,
  handshake correlation, event routing, cancellation isolation.
- `src/main/projectRuntimePaths.ts` — main-only projectId→directory grants.
- `tests/fixtures/synthetic-stdio.mjs` — the only process this build is
  allowed to spawn; finite, deterministic, no network, no descendants.
- `src/main/lifecycle.ts` — async single-flight close coordinator.

Modes: `mock` (in-process, default — Phase-1 behaviour unchanged) and
`synthetic-stdio` (this phase). There is no `real` mode.

## 2. Wire protocol — NDJSON v1

One LF-terminated UTF-8 JSON object per line on stdout (child→parent) and
stdin (parent→child). `stdioFrames.ts` decodes raw bytes before JSON:

- LF (`0x0A`) is the sole frame boundary — it cannot occur inside a
  multi-byte UTF-8 sequence, so byte-scanning is exact. A trailing CR is
  tolerated (CRLF).
- Frame size is counted in BYTES, capped at 256 KiB per frame.
- Empty lines, a leading UTF-8 BOM, invalid UTF-8 (fatal decode), non-object
  JSON, unexpected keys, unknown `v`/`type`, missing/oversized ids
  (>128 chars) and non-integer `seq` are all structural failures.
- Bytes remaining at EOF without a trailing LF are a TRUNCATED_TAIL —
  never guessed-complete.

Envelope (structural layer):

```
{ v: 1, type: "request" | "response" | "event", requestId: string,
  method?: string, params?: unknown,          // request
  turnId?: string, seq?: number,              // event (required)
  event?: string, payload?: unknown,          // event (required)
  result?: unknown, error?: {code, message} } // response: exactly one
```

### Requests (parent → child)

| method      | params                                        | response                         |
|-------------|-----------------------------------------------|----------------------------------|
| `handshake` | `{client, phase}`                             | `{fixture:"synthetic-stdio", protocolVersion:1, pid, scenario}` |
| `stream`    | `{prompt, threadId, turnId}`                  | `{accepted:true, turnId}`        |
| `resolve`   | `{turnId, optionId:"once"|"deny"}`            | `{resolved:true}`                |
| `cancel`    | `{turnId}`                                    | `{cancelled:true}` (best-effort) |

Every request/response is correlated by `requestId`, unique per process
lifetime (`<conn>-r<n>`). The pending set is bounded (32); a response for an
unknown/late requestId is dropped and counted — never applied.

**Business ACKs are validated synchronously at settle time** — before the
awaiting continuation resumes and before the batch's next frame is
routed, so a same-chunk `done` can never outrun a rejected ACK:

- `handshake` — `result` must be an object with
  `fixture:"synthetic-stdio"` and `protocolVersion:1`.
- `stream` — `result.accepted === true` AND `result.turnId ===` the
  current turn; false/missing/wrong-type/foreign all fail closed, once.
- `resolve` — `result.resolved === true` (the existing contract).
- `cancel` — best-effort; no ACK contract.

A correlated error response fails the turn before subsequent frames are
routed. Turn events other than `error` require a successful stream ACK;
after approval, they also wait for the successful resolve ACK.

### Events (child → parent, data plane)

Events ride on the stream request's `requestId` and carry `turnId` plus a
per-turn monotonic `seq`:

- `chunk` `{delta}` — text increment for the turn's assistant message.
- `approval` `{approval:{title,detail?,reason?,options}}` — the parent maps
  this to a fixed once/deny card; wire text never mints authorization.
- `done` `{outcome}` — business terminal; the child exits afterwards.
- `error` `{message}` — business-level turn failure.

Events with a foreign/stale `requestId`, wrong `turnId` or non-increasing
`seq` are dropped and counted (`stats.droppedLateFrames`), never replayed.

**Payload schema (validated on the CURRENT association, before seq is
consumed).** A frame that passed association checks but violates the
event's runtime schema or the wire state is a protocol error — the turn
fails once, it is never silently dropped and a later `done` cannot
resurrect it:

- `chunk` — `payload.delta` must be a string.
- `approval` — `payload.approval` must be an object with non-empty string
  `title`, optional string `detail`/`reason`, and `options` an array of
  objects each carrying a string `id`.
- `done` — `payload.outcome`, when present, must be a string.
- `error` — `payload.message`, when present, must be a string.
- Unknown event names with a valid envelope are bounded drops, not errors.
- While awaiting an approval resolution, the only legal turn event is
  `error`. A "successful" `done` during the wait is a protocol state
  error — it is never honoured as if the user approved. (a second
  `approval` or a `chunk` fails the turn too.)

The stream turn carries ONE absolute deadline measured from admission —
queueing, the admission ACK, chunk traffic and approval waits all consume
the same `requestMs` budget; individual events never re-arm it.

### Turn flow

```
parent                     child
  |--- request handshake ----->|
  |<-- response {fixture…} ----|   (5 s deadline; else HANDSHAKE_TIMEOUT)
  |--- request stream -------->|
  |<-- response {accepted} ----|   (10 s request deadline)
  |<-- event chunk ×N ---------|
  |<-- event approval? --------|   (optional; waits for resolve)
  |--- request resolve ------->|   (only when approving once)
  |<-- event done -------------|
  |     (child exits; close)   |
```

`cancel` is a best-effort notification sent AFTER the turn is locally
invalidated; it is never awaited and never gates teardown.

## 3. Process lifecycle (`stdioTransport.ts`)

State machine per child:

```
spawn → running → closing → closed
            │        ↑ dispose(): end stdin → grace 1 s
            │        │              → SIGTERM → observe 1 s
            │        │              → SIGKILL → observe 1 s
            │        └─ close event is the ONLY confirmation —
            └──────────   'exit' records code/signal but stdio may
                          still be open; kill() returning true is
                          never treated as exit proof.
```

- `spawn` with `shell:false`, `detached:false`, explicit
  `executable/args/cwd/env`; `.cmd`/`.bat` executables are refused
  (`UNSUPPORTED_WINDOWS_SCRIPT`) — no shell fallback.
- stdin is a single serialized write queue: byte-budgeted (1 MiB counting
  queued + in-flight bytes until the write callback), drain-aware
  backpressure correct under BOTH orderings (drain-before-callback and
  callback-before-drain — a persistent `drain` listener plus the callback
  each re-run the pump), a per-write watchdog (10 s) that fails a wedged
  child, and EPIPE/dead-stream detection that fails the queue and
  surfaces an error — writes are never silently reordered or resent.
- OS `close` records teardown truth, but the owner's `onClose` fires only
  after the bounded frame backlog has delivered every already-received
  frame — `exit`/`close` never pre-empt buffered protocol data, and the
  premature-exit judgement belongs to the delivered close, never to exit.
- stdout cumulative budget 8 MiB → `OUTPUT_LIMIT` + SIGKILL.
- stderr cumulative budget 1 MiB → `STDERR_LIMIT` + SIGKILL; only a 32 KiB
  tail is retained for diagnostics.
- `dispose()` is bounded and idempotent; a close that cannot be confirmed
  inside the escalation window returns `confirmed:false` with
  `problem:"CLEANUP_INCOMPLETE"` — the result preserves evidence instead
  of claiming teardown. A transport that never produced a child (refused
  executable, cancel/dispose before the deferred start, spawn rejected)
  is PROVABLY childless — `confirmed:true`, `pid:undefined`; it is never
  reported as an orphan or cleanup failure. `treeTermination` is
  explicitly unsupported; the fixture is contractually childless.

## 4. Workspace authorization (`projectRuntimePaths.ts`)

- Only main/test harness may register: `projectId → realpath(directory)`.
  Registration requires an absolute, NUL-free path that lstat()s as a real
  directory (never a symlink) and — when authorized roots are configured —
  stays physically inside one of them.
- `verify(grant)` re-checks registration and the physical path before
  handing the turn to the adapter. This is a preflight check, not an
  atomic filesystem guarantee; a directory can still change before the
  deferred OS spawn.
- No grant → `WORKSPACE_NOT_CONFIGURED`, surfaced as a normal turn error.
  The renderer can never name, choose or derive a cwd; project names are
  not paths.
- `deleteProject` revokes the grant immediately; the adapter still owns
  any spawned child until its close is observed.
- Grants are in-memory only — nothing about them is persisted.

## 5. Child environment

Each Electron instance also isolates its Chromium state inside the run's
data root (`chromium/user`, `chromium/session`, both configured before
`ready`) — two different data roots never share cookies, localStorage,
cache or network state.

The fixture child's env is rebuilt from a whitelist — never inherited:
`HOME`, `USERPROFILE`,
`APPDATA`, `TMP*` and `XDG_*` all point INSIDE the granted workspace.
On Windows only, `SystemRoot`/`SystemDrive`/`windir` pass through because
CreateProcess requires them. No `PATH` lookup (the executable is always
absolute), no proxy or credential variables.

## 6. Errors and budgets (all surfaced, none swallowed)

| condition | code / behaviour |
|---|---|
| frame > 256 KiB, no LF within cap | `FRAME_TOO_LARGE` |
| leading BOM | `BOM_REJECTED` |
| invalid UTF-8 | `BAD_UTF8` |
| empty line | `EMPTY_LINE` |
| bad JSON / envelope | `BAD_JSON` / `BAD_ENVELOPE` |
| EOF mid-frame | `TRUNCATED_TAIL` |
| stdout > 8 MiB | `OUTPUT_LIMIT` + kill |
| stderr > 1 MiB | `STDERR_LIMIT` + kill |
| stdin queue > 1 MiB | `send()` refuses (false) |
| handshake > 5 s | `HANDSHAKE_TIMEOUT` |
| request > 10 s | deadline reject + child disposed |
| > 32 pending requests | rejected |
| > 4 reserved or owned connections | `SYNTHETIC_CAPACITY` |
| exit before business terminal | `PREMATURE_EXIT` |
| close never confirmed | `CLEANUP_INCOMPLETE` in dispose result |
| no workspace grant | `WORKSPACE_NOT_CONFIGURED` |
| revoked/invalid grant | `WORKSPACE_REVOKED` / `WORKSPACE_INVALID` |
| `TIVANO_SYNTHETIC_NODE` unset | `SYNTHETIC_RUNTIME_NOT_CONFIGURED` |

Error strings carry the code as an `UPPER_SNAKE:` prefix so the renderer
can localize the head while preserving the raw detail.

## 7. Close ordering (close → cleanup → save)

`lifecycle.ts` is the single-flight coordinator:

1. `blockNewWork()` — synchronous; `engine.shutdown()` flips the work gate
   to `closing` (IPC mutations refuse) and marks in-flight turns
   interrupted before ANY await.
2. `disposeChildren()` — async; every child must reach a confirmed close.
   Only then is the store gate entered — no flush while a child is
   unaccounted for.
3. `saveStore()` — flush + lock release. A throw keeps ownership and
   retries are legal.
4. Success → `finishQuit()` re-issues the close/quit exactly once.
   Failure → async prompt: **Retry** re-runs only the still-unconfirmed
   steps (a pass that already confirmed every child is never re-run);
   **Keep open** → `enterReadOnly()`: the snapshot exposes `readOnly`,
   and the engine's mutation gate refuses EVERY persisted write —
   project/thread create/edit/delete, selection, settings, approvals,
   sends — not just new turns. Snapshot/reads stay live, and a later
   close re-runs only the unconfirmed gate.

The adapter is never "restarted" after a failed dispose — read-only stays.

## 8. Enabling the synthetic path (trusted main bootstrap only)

```
TIVANO_PROVIDER=synthetic-stdio       # select the adapter
TIVANO_SYNTHETIC_NODE=<abs node exe>  # runtime handed to the harness
TIVANO_WORKSPACE_ROOT=<dir>           # authorized root; projects get
                                      # auto-registered dirs under it
TIVANO_SYNTHETIC_SCENARIO=chat        # fixed scenario enum
```

Absent `TIVANO_SYNTHETIC_NODE`, the app still boots — a send fails with
`SYNTHETIC_RUNTIME_NOT_CONFIGURED`. The resolved executable and its
`--version` output are recorded in `info.syntheticRuntime` before any
spawn; that recording is diagnostic and is not provider probing.

## 9. Explicit non-goals for this phase

Real providers/models/tools, Codex JSON-RPC, terminal/PTY, Hydra, Git,
native modules, `taskkill`/process groups/tree termination, installers,
signing, updaters, host CLI scanning or discovery, provider login, and any
production credential/data access — all remain out of scope and unclaimed.
