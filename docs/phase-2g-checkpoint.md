# Phase 2g — durable checkpoints and conservative undo preview

Backend foundation for per-turn file undo. Two main-only modules:

- `src/main/checkpointStore.ts` — durable storage under
  `<dataRoot>/checkpoints/`: content-addressed **raw blobs**
  (`blobs/<sha2>/<sha62>`), strictly-validated versioned manifests
  (`manifests/<id>.json`, published by tmp-write + fsync + rename), and
  `tmp/cap-*` scratch owned per operation. Confinement is physical, not
  just lexical: store, blob-prefix and issued scratch directories are pinned by device+inode
  and revalidated before every operation; a symlinked or replaced
  directory or leaf refuses, including after reopening. Scratch cleanup
  preserves any replacement directory. `putBlob` only accepts a scratch path this
  store itself issued. Nothing is ever written into the user's
  repository — no refs, objects, index or worktree bytes.
- `src/main/checkpointService.ts` — `capture(projectId, threadId,
  turnId, phase)` and `preview(projectId, threadId, baseId, endId,
  touchedPaths)`, plus `onProjectDeleted` / `onThreadDeleted` /
  `dispose`.

**This service is not instantiated in production yet** — no IPC channel
reaches it and nothing calls it from the app shell. Turn integration
(capturing around provider turns) and applying a preview are separate
future slices; a preview is data, not an authorization and not a lock.

## Capture contract

- Inputs are ids only — `projectId` must exist, `threadId` must belong
  to the project and `turnId` to the thread via the supplied ownership
  lookup. No path, executable, revision or flag ever enters.
- The project's registered grant is re-verified before every async
  step, before every spawn and before publication; its canonical
  directory is stored in the manifest. A revoked/rebound/deleted
  project can never adopt a pending capture.
- Repository listing runs inside the **controlled Git metadata view**
  from P2F (`probeRepo` + `buildView`): `git ls-files -z --cached
  --stage` for index identity and `--others --exclude-standard` for
  nonignored untracked files, both fixed-argv `shell:false` against the
  view — repo config can never trigger filters, hooks, fsmonitor or
  external diff. Object storage is a read-only alternate; the writable
  object dir is never used.
- Per path the manifest records: canonical repo-relative path,
  worktree kind (`file`/`symlink`/`absent`), raw bytes → SHA-256 blob,
  executable bit, and every index stage entry (mode/oid/stage). Index
  deletions and worktree deletions are recorded independently. Symlinks
  store link text, never target bytes. Ignored files are not captured
  (consistent with `ls-files --exclude-standard` semantics).
- Path hygiene: `..`, `.`, `.git`, empty components, absolute/drive/
  UNC paths and NUL/CR all reject the whole capture; every parent
  component must be a real directory — parent symlinks are refused.
  Non-regular/non-symlink entries (fifo, socket, directory at a tracked
  path) and submodule gitlinks (mode `160000`) reject the capture:
  a partial snapshot is never marked complete.
- Bounds: ≤ 5,000 paths, ≤ 16 MiB per file, ≤ 128 MiB total content,
  ≤ 32 MiB index/control output, 30 s whole-operation deadline, one
  active capture per project, ≤ 2 globally, queue ≤ 16 (overflow is an
  explicit `busy` rejection).
- Every file is read through `lstat`→`open`/`fstat`/`read` handles
  bounded by the actual stat size (a concurrently growing file is an
  error, never a silent truncation). After all reads the snapshot is
  re-verified by CONTENT, not just stat fields: per-path sha-256/link
  text re-reads, permission bits, deepest-existing-ancestor identity
  (a swapped/recreated parent invalidates), source index bytes vs the
  captured view copy, and a re-run bounded `ls-files` listing. Any
  drift invalidates the attempt (bounded retry) rather than publishing
  a mixed snapshot — a same-size edit with a restored mtime is caught
  by the hash. Missing ancestors are fine (the leaf records explicit
  `absent`); an existing symlink/non-directory ancestor refuses.
  File loops yield between entries so cancellation, deletion and
  read-only transitions can run — the main thread is never blocked
  for a whole 128 MiB / 5000-path loop.
- Content filters are never executed for normalization; when a repo
  configures them the checkpoint records `limitations: ["filters"]` —
  the raw bytes captured are still the exact bytes a restore would
  need, but index↔worktree equivalence is not guaranteed for
  filter-covered paths.

## Persistence

- Manifest schema `version: 1` is validated on every load (including object-format lengths and unique index stages):
  field types, uuid-shaped checkpoint id, path legality, sha-256/oid/mode
  shapes, entry-count and byte-sum consistency. A tmp or malformed file
  is never a checkpoint.
- Blobs are immutable and deduplicated across checkpoints/threads by
  hash; reads go through bounded handle-based reads (no unbounded
  `readFileSync`) and re-verify size + sha-256 — corruption, growth or
  a symlinked leaf is an honest failure. Manifest fields can never
  redirect I/O outside the store root — blob names derive from
  validated hex only. Republishing an existing manifest id refuses.
- Crash/restart guarantee, honestly: short writes are completed and payloads are fsync'd before the
  atomic rename and the containing directory is fsync'd best-effort, so
  a crash leaves either the previous state or a complete new entry —
  never a half-written manifest that validates. No stronger ordering
  is claimed, and there is no garbage collector: unknown directories
  are never touched, only this service's own `cap-*` scratch is
  removed. Deleting a thread never deletes shared blobs.
- Directory iteration is bounded by an open-dir handle (not
  readdir-then-slice); manifest serialization and load are
  size-bounded; `putBlob` enforces the per-file cap and a
  store-issued scratch path.

## Preview contract

`preview()` loads + validates both manifests and requires: same
project, same thread, same recorded grant directory, `before`/`after`
phases, and **turn ordering from the ownership lookup** — the base
turn must sit at or before the end turn in the thread's own message
order; an earlier-turn checkpoint captured later in wall-clock time is
rejected, as is a turn that no longer belongs to the thread. A missing
end checkpoint is `unavailable` — current files are never assumed
safe.

**Omission is not absence.** A path missing from a manifest is
UNKNOWN — it may never have been listed (ignored file, filtered path,
listing race). Destructive proposals require explicit evidence:
`remove` is proposed only when the base entry records
`worktree.kind:"absent"` together with index stage entries (a tracked
path proven missing at base time) AND the index fingerprints match.
A path omitted from base keeps with `base-unknown`; one omitted from
end keeps with `end-unknown`; a base-side `absent` without index
evidence keeps as `base-unknown` too. Pre-existing ignored files can
therefore never be proposed for deletion — this deliberately narrows
preview coverage (`limitations` records `omission-not-evidence`).

The touched-path union (supplied by main, validated + deduplicated,
≤ 1024) is compared per path:

- current worktree fingerprint (`file:sha256:size:exec` /
  `symlink:sha256(target)` / `absent`) AND current index fingerprint
  (`mode:oid:stage` list) are both recomputed inside a fresh controlled
  view, then compared with the end checkpoint.
- Only an exact double match proposes an action toward the base state:
  `restore` (base and end payloads verified present and intact, and only when
  the index fingerprints match — a differing index cannot be reached
  by a worktree-only action), `remove` (explicit base absence evidence
  as above), `noop` (identical in base and end).
- Any difference keeps the path: `worktree-changed`, `index-changed`,
  `changed-since-end`, `unsafe-path`, `index-differs`, `base-unknown`,
  `end-unknown`, `blob-corrupt`/`blob-bad`. Other threads' and users'
  later edits are never proposed for overwrite.
- Before returning `ready` the preview compares the actual source index
  bytes with its private view, re-runs the bounded listing and re-fingerprints
  every touched path — it is not an atomic
  lock, but a knowingly changed source index or worktree drift never
  yields a ready result.

`entries[].matched` records the current-state fingerprints a future
apply must re-prove — the preview grants no lock and no authorization.

## Lifecycle

Whole operations (probe → view → listings → reads → publish) are
tracked like the Git service: cancel propagates to children with
observed-exit escalation, `onProjectDeleted`/`onThreadDeleted` cancel
matching work before publication, and `dispose()` stops admission
synchronously, drains within a bounded wait (default 6 s) and reports
unconfirmed exits instead of inferring them.

## Verified

- `tests/checkpoint.test.ts` — 31 real-git fixture tests: durable
  capture + restart reload, crash-partial manifests never valid,
  manifest/blob corruption honest failure, source HEAD/index/refs/
  worktree byte-identical, symlink/exec-bit/newline/pathspec names,
  linked worktree, hostile filter/fsmonitor config never executed
  (marker file), oversized file, mid-capture mutation → consistent
  snapshot, grant-revoke/delete/dispose mid-operation, per-project +
  global concurrency + real queue overflow, and preview keeping later
  worktree/staged edits while proposing restore only on exact matches.
  R1 regressions: previously-ignored pre-existing files kept (never
  remove), same-size+restored-mtime edit caught by content re-hash,
  physical store confinement (symlinked dirs/leaves, foreign scratch),
  tracked files under a deleted directory captured as explicit
  `absent`, explicit-absence remove/no-op fixtures, thread-native turn
  ordering, mid-capture chmod/index/listing/parent-swap invalidation,
  grown/shrunk store files, manifest republish refusal, and mid-read
  cancellation.
- Plus the existing `npm run verify` suite for regression.

## Explicitly NOT verified / out of scope

- **Windows Git execution: NOT RUN** — macOS Apple Git-157 is the only
  executor exercised; the capture path is gated to darwin with an
  honest `unsupported` elsewhere.
- No restore/apply exists; no turn wiring, no UI, no IPC. Blob GC is
  deliberately absent (unbounded deletion would risk shared blobs).
- A byte-identical, inode-identical concurrent parent-directory swap
  inside the capture window is not distinguishable without kernel
  isolation — documented, not claimed.

Maintainer follow-up regressions cover reopened-store directory checks,
blob-prefix/scratch replacement, preserving foreign replacement data,
case-folded Git control paths, index schema consistency, short writes,
real source-index changes during preview, and missing end payloads.
Node filesystem contracts: https://nodejs.org/api/fs.html .

## Maintainer acceptance (2026-10-25)

Build, typecheck, 582 unit tests and 107 Electron regression checks passed; all 12 isolated instances exited. The four independent capture/preview probes passed after R1; nine additional maintainer regressions cover store confinement, short writes, manifest validity, source-index changes and missing end payloads. Evidence and source hashes are kept in the maintainer archive outside the repository.

Accepted scope: macOS development backend for private checkpoint capture and conservative preview. No production service wiring, automatic turn capture, actual restore, Windows integration, authentication or installer validation is claimed. Unknown omitted paths and changed index entries stay untouched.
