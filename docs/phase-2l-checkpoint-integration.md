# Phase 2L — Checkpoint integration (per-turn capture, ledger, restore PREVIEW)

Base: `e0af84b97c5e32efd20f34ca4bfd2bfe669cd463`. Local verify on this
checkout: build + tsc clean, 43 test files / 801 unit tests, 125/125 e2e
checks (`tivano-win-e2e-Ww7lOJ`). This phase wires the existing P2G
checkpoint safety backend into the real turn lifecycle. It is **not**
undo: nothing is ever written into the user repository or index, chat is
never truncated, provider history is never rolled back, and there is no
Apply/Undo action anywhere.

## What exists now

- **`checkpointLedger.ts` (new)** — durable bounded per-turn ledger at
  `<dataRoot>/checkpoints/ledger.v1.json`. Atomic tmp+fsync+rename writes;
  strict per-record validation on load (version, identity, status/pairing
  rules, repo-path legality); missing/corrupt entries drop without
  poisoning the rest; 128-record / 1024-path bounds; non-terminal states
  are retained visibly, never silently deleted.
- **`checkpointTurns.ts` (new)** — `CheckpointCoordinator`, the single
  owner of the per-turn lifecycle. `beginTurn` reserves the ledger record
  and the cancel latch *before* the first await, runs the before-capture
  serialized per thread, then re-proves thread+turn identity, mutability
  and the grant before allowing `provider.start`. A cancel/delete/close
  during capture ⇒ the provider never starts. `turnEnded` captures the
  end snapshot only for a `"done"` turn whose ownership is re-verified
  (live message evidence + same grant dir); every other terminal state
  invalidates honestly. `recordEdits` accepts structured paths only for
  the live matching turn.
- **`checkpointService.ts`** — the darwin-only guard is replaced by a
  capability model identical to `GitService`: `unavailableReason` (pinned
  at bootstrap — e.g. Windows `git-containment` without the attested Job
  `--run` runner) makes every op honestly unavailable; a supplied
  `runner` (the Job-helper Git runner on Windows) is used for all Git
  work. Capture/preview safety refusals, bounded outputs, scratch
  ownership and dispose semantics are unchanged.
- **`engine.ts`** — `sendTurn` now starts the provider through
  `startProvider`, which re-verifies the live turn and the grant at call
  time; when a coordinator is attached and the turn has a project grant,
  provider start is deferred until `beginTurn` resolves. `cancelTurn`
  latches cancellation before `endTurn`; `endTurn` notifies the
  coordinator; `deleteThread`/`deleteProject`/`shutdown` invalidate and
  stop admission. `onFileChanges` is attributed only while the turn is
  live. New IPC-facing `listCheckpoints`/`previewCheckpoint` resolve
  strictly through thread+turn identity.
- **`provider.ts` / `codexAppServerProvider.ts`** — new optional
  `onFileChanges(paths)` callback: the *only* source of checkpoint
  touched paths. The Codex adapter extracts bounded `changes[].path`
  strings from `fileChange` items (started + completed). Assistant text
  is never parsed for edits, and a missing structured event never
  degrades into a full-repo diff.
- **IPC** — `checkpoints:list {threadId}` and
  `checkpoints:preview {threadId, turnId}` return ledger views /
  non-mutating preview results. Requests carry turn identity only —
  checkpoint ids, roots and touched paths come from the ledger inside
  main and can never be supplied by a caller. New `checkpoints-changed`
  event drives UI refresh.
- **UI** — per-turn `.ckpt-card` under assistant messages (captured /
  capturing / unavailable / invalidated + reason + bounded path list) and
  `CheckpointPreviewDialog`: loading, empty, unavailable and ready states;
  per-path `Would restore` / `Would delete` / `Kept unchanged` /
  `No change needed` + preserve reasons; the banner states
  **NO FILES HAVE BEEN CHANGED** and that no undo action exists. Close is
  the only control. English + zh-Hans strings; existing modal/banner
  styles only.
- **Fixture** — `codex-app-server.mjs` `ckptfile` scenario *really* writes
  `fixture-checkpoint.txt` and appends `tracked.txt` inside the granted
  workspace, then reports the same paths through a structured fileChange
  item.

## Lifecycle invariants enforced

- Reservation happens synchronously before provider start; capture pairs
  serialize per thread; identity (project/thread/turn/grant/mutable) is
  re-proven after every await.
- A complete record requires BOTH manifests; failed before/end capture,
  cancellation, deletion, closing, stale callbacks or cleanup
  uncertainty leave `unavailable`/`invalidated` states instead.
- Preview proposals require the CURRENT worktree+index to equal the end
  checkpoint exactly; anything after end — staging, partial staging,
  preview-time drift — classifies as `keep` with a reason. Omission from
  a manifest is unknown, never absence.
- Deletion, grant rebinding (`stale` flag + `grant-rebound` refusal),
  shutdown and dispose all cancel pending work and keep honest records.

## Verification coverage

- `tests/checkpoint-turns.test.ts` (10): pre-start cancellation never
  starts the provider; failed before → unavailable but chat proceeds;
  failed end → no complete mint; stale edit attribution dropped;
  cancellation invalidates without end capture; thread-deletion
  invalidates; preview resolves by ledger identity and rejects foreign
  ids; ledger reopen, malformed-entry tolerance, path-escape rejection.
- `tests/checkpoint.test.ts` — the old darwin-guard case now asserts the
  honest `unavailableReason` refusal for both capture and preview.
- e2e `checkpointPreviewChecks.mjs` (13 checks): real temp Git repo via
  user grant; fixture turn actually mutates files; durable complete
  record with exact attribution; app never touched HEAD/index; preview
  proposes `restore` for the modified tracked file and `base-unknown`
  keep for the created file; staging / partial staging / worktree drift
  all classify preserve; foreign turn id is refused; the dialog is
  visible, honest and has no Apply/Undo; restart on the same data root
  reloads the same recordId and still previews; clean closes with no
  scratch leak.

## Explicitly NOT RUN / not claimed

- Windows-native checkpoint operation (Job `--run` Git runner path is
  wired but exercised only by local POSIX Git), packaged/MSVC/Windows test-machine
  validation, real provider CLI or credentials — all NOT RUN. Local
  macOS results never stand in for Windows acceptance.
- No restore apply, no undo, no chat truncation, no provider-history
  rollback — none exist; the UI says so.

## Repair-1 — ledger durability and lifecycle rejection handling

Maintainer probes reproduced three real defects against the bundled ledger:
a symlinked root wrote `ledger.v1.json` outside the intended root; an
unknown-version document was silently replaced by an empty valid one;
a failed `update` persisted nothing yet the in-memory record reported
`complete`. Corrections:

- **Physical identity before any byte.** The checkpoint root is pinned
  by `lstat` (symlink / non-directory / dev-ino replaced → refuse, never
  followed, never repaired); the ledger leaf must be a plain regular
  file. Reads re-lstat then `open`+`fstat` so a leaf swapped mid-check
  still fails.
- **Missing ≠ unreadable.** Absent file ⇒ valid empty document. Any
  unreadable / corrupt / oversize (>8 MiB) / malformed-record /
  duplicate-identity / unknown-version document is preserved
  byte-for-byte, yields an empty view, and refuses every mutation via
  `LedgerUnavailableError` — nothing is partially adopted or truncated
  into "empty valid".
- **Candidate-only publish.** `reserve`/`update`/`invalidateWhere`
  build an immutable candidate, persist it (exclusive `wx` 0o600 tmp,
  complete-write loop, fsync, atomic rename, dir fsync, own-tmp-only
  cleanup), and publish the cache only after success. A failed persist
  marks the ledger unavailable — cached records keep their pre-mutation
  truth and no failing write loop is attempted.
- **Honest bounds.** >128-record documents refuse; duplicate
  recordIds and duplicate (threadId,turnId) refuse; a duplicate turn
  reserve refuses; an all-"capturing" full ledger refuses admission
  rather than growing unbounded. Accessors hand out copies only.
- **Reopen recovery.** "capturing" records surviving a restart recover
  ONCE to `unavailable: interrupted-by-restart` (persisted; if that one
  write fails the recovered view serves reads while mutations refuse).
- **Coordinator/engine.** `beginTurn` catches ledger/capture rejection —
  chat proceeds and the turn shows an `unavailable` shadow card even
  when the ledger cannot persist one; `captureEnd` is awaited with an
  explicit catch (no detached rejection); delete/close invalidations
  never throw through engine paths; the engine's start gate catches so
  a failed prepare can never strand a running turn.

Regressions: `tests/checkpoint-ledger.test.ts` (17 probes) +
coordinator rejection tests in `tests/checkpoint-turns.test.ts`.
`npm run verify`: 831 unit + 125/125 e2e incl. all checkpoint desktop
checks (`tivano-win-e2e-gl3Zrw`). NOT RUN: Windows-native, packaged,
MSVC, Windows test machine, real provider — unchanged boundaries.

### Repair-1 R2 — anchor confinement, leaf identity, input ownership

Maintainer R2 probes found: `reserve` retained the caller's touchedPaths
array (alias mutation reached the cache); `pinRoot` checked only the
final component so a symlinked ancestor wrote outside the intended
root; and a foreign regular file swapped in for `ledger.v1.json` was
silently overwritten. Corrections:

- **Explicit trusted anchor.** `new CheckpointLedger(dir, anchor)` now
  REQUIRES a caller-declared canonical ancestor (the app data root —
  `index.ts` passes `dataRoot`). The anchor is canonicalized once via
  `realpath` and pinned by path+dev/ino; every lexical component between
  anchor and the ledger root must be a real directory (symlink/junction
  ancestors refuse), and the canonicalized root must equal
  `anchorCanon + components` — a redirected destination is never
  authorized just because it resolves. Platform aliases ABOVE the
  anchor (e.g. `/var`→`/private/var`) are absorbed by anchor
  canonicalization. No anchor ⇒ every operation refuses.
- **Leaf object identity.** The ledger file is pinned by dev/ino — or
  by a proven-absent state. Loads compare `lstat`↔`fstat` identity on
  the opened object (a swap between them refuses). Mutations re-prove
  the pinned identity; a foreign file swapped in, an unexpected file
  created after proven absence, or a deletion is preserved and refuses.
  After our own atomic rename the pin is updated to the published
  object.
- **Owned inputs + candidate schema.** `reserve` copies caller fields
  and bounds `touchedPaths` at intake; `update` accepts only mutable
  whitelist fields (identity fields refuse), and every candidate
  document is revalidated against the exact load schema — including
  finite timestamps — before a single byte is written.
- **Honest durability reporting.** The atomic rename is the commit
  point; post-commit directory-fsync failures are recorded as bounded
  durability warnings on `availability()` — genuinely committed state
  is never pretended to be rolled back, and unsupported-fsync
  filesystems are distinguished from real failures.
- Residual limit, stated plainly: between the identity check and the
  rename a hostile concurrent writer could still swap the leaf; Node
  primitives cannot close that race — observed drift fails closed.
