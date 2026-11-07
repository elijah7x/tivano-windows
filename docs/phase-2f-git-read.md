# Phase 2f — read-only Git panel

Adds a per-project Git panel showing branch identity, working-tree/index
status and bounded staged/worktree diffs. Everything the panel shows is
produced inside an ephemeral **controlled Git metadata view**: the app's
Git probes repository metadata and configuration as data, then runs status
and diff in a controlled view. These operations do not intentionally write
the original index, HEAD, refs, object store or worktree files.

This slice performs **zero** Git mutations — no add/commit/checkout/branch/
push/fetch exists anywhere in the code path.

## Why a controlled view

Repository `.git/config` can name executable programs: `core.fsmonitor`,
`core.hooksPath`, `filter.<name>.{clean,smudge}`, `diff.<name>.{command,
textconv}`, external credential helpers, `include.path` chains. A naive
`git status`/`git diff` in an untrusted repo can therefore run arbitrary
commands. The view removes the entire class:

- Each refresh builds a fresh per-refresh directory under app-private
  storage containing **copies** of `index`, `HEAD`, the HEAD loose ref,
  `packed-refs`, per-worktree refs (`refs/{bisect,worktree,rewritten}`)
  and bounded `info/{exclude,attributes}` — plus a **rewritten** `config`
  that keeps only normalizing values (`core.bare`, `objectformat`,
  `repositoryformatversion` 0/1 for sha1/sha256, `fsmonitor=false`,
  `untrackedcache=false`, `hooksPath=<view>/hooks` which is always
  empty, `renames=true`). Only allowlisted core normalization values are
  copied. Config includes may be read during probing, but are not copied
  into the view or executed as commands.
- **Bounded capture:** every source file is read through
  `open`/`fstat`/`read` with a cap+1 probe — oversized, non-regular,
  symlinked, unreadable or concurrently-changed control/index files fail
  explicitly; only `ENOENT` means "absent". A single 32 MiB total budget
  covers all copied control bytes. Ref traversal is `lstat`-checked,
  depth/entry/byte bounded, and never follows symlinks; the HEAD loose
  ref is fingerprinted once and a later unverified copy may never
  overwrite it. Captured index/HEAD/ref file identities are revalidated across the copy
  window. The service rechecks the project grant before each command;
  this is not an atomic filesystem snapshot or a sandbox against concurrent
  replacement of parent directories.
- Objects are reached read-only via `GIT_ALTERNATE_OBJECT_DIRECTORIES`
  pointing at the real object store — never copied, never written.
  Alternate paths use Git’s C-style quoting in the environment, so colons
  and quotes in macOS paths remain part of one path. Writable objects stay
  under the private view. See https://git-scm.com/docs/git.
- Captured source bytes are hashed pre-copy and re-read post-copy; any
  change inside the copy window invalidates the attempt (bounded retry).
- **Racy-index preservation:** Git's racily-clean detection compares the
  index *file's own mtime* with each entry's stored stat mtime — a fresh
  copy would carry a new mtime, mark nothing racy, and silently miss
  same-second edits of identical size. The copied index keeps the source
  mtime (`utimesSync`), so racy detection behaves exactly as in the real
  repository. A deterministic regression test forces stat-equality and
  proves the edit is still reported.
- Views are deleted when a snapshot retires (next refresh replaces it,
  project deleted, or service disposed); a view being built inside an
  operation is tracked as operation-owned and cleaned even when the
  operation is cancelled mid-build. e2e proves cleanup on quit.

## Execution model (`src/main/gitExec.ts`)

Git is spawned exactly one way: `spawn(executable, fixedArgv,
{ shell:false, cwd, env })` —

- Fresh environment: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, isolated HOME/
  TMPDIR/XDG_CONFIG_HOME, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_SYSTEM=/dev/
  null`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS`/`SSH_ASKPASS`/`GIT_SSH_COMMAND=/bin/false`,
  `GIT_LITERAL_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_OPTIONAL_LOCKS=0`,
  pagers pinned to `cat`.
- Async only; stdout/stderr carry a **hard retained-byte bound** per
  stream: once the cap is reached the child keeps draining but nothing
  further is appended, so a TERM-ignoring child can never grow memory.
- Timeout + overflow trigger SIGTERM → bounded SIGKILL escalation.
  Cancellation and escalation are idempotent — repeated `cancel()` never
  postpones the SIGKILL deadline — and a completed handle can never
  signal a reused PID. Resolution requires an observed `close`, never an
  inferred kill; spawn failures (ENOENT etc.) surface as spawn errors,
  not exit codes, and leave no unhandled promise rejections.
- Live children are tracked for disposal; `--no-optional-locks` and
  `--no-lazy-fetch` are pinned into every invocation.

## Probe → view → status

`probeRepo` runs only `rev-parse`/`symbolic-ref`/`config --get-regexp` reads.
A probe command that times out, overflows, is cancelled or fails is an
explicit `unavailable`/`unsupported` — never interpreted as detached
HEAD, unborn branch, missing config or success:
- Discovery is ceiling-bounded (`GIT_CEILING_DIRECTORIES=<grant>`), and
  the discovered worktree root is verified against the grant — a grant
  nested inside an outer repository resolves `not-repository`, never
  silently reads the parent.
- Linked worktrees keep their own `gitdir`/`commondir` split: HEAD/index
  from the worktree dir, shared objects from `commondir/objects`.
- Config is scanned as *data only*: helper-bearing keys
  (`filter.*`, `diff.*.command|textconv|cachetextconv`,
  filter and diff drivers) raise `helpersPresent`
  which lands in `snapshot.limitations` — their values are never used
  and never printed.
- Bare repos, non-`files` ref storage, split/sparse index signatures
  (parsed from the index binary itself) and unknown object formats are
  explicit `unsupported` states — never guessed. SHA-256 repositories
  work: the view config declares `repositoryformatversion=1` +
  `objectformat=sha256`.

`status` runs as `git --git-dir=<view> --work-tree=<grant> status
--porcelain=v2 -z --branch --untracked-files=all --ignore-submodules=all`
inside the view. The v2 `-z` parser is structural: NUL-separated records,
fixed-field prefixes split on space, filenames (newlines, `:(glob)`,
`*.txt`…) never split on whitespace. Entries cap at 5000 →
`entries-truncated`.

## Diffs — restricted, opaque, bounded

- IPC (`git:overview` / `git:refresh` / `git:diff`) carries only opaque
  UUIDs — `projectId`, `snapshotId`, `entryId`, `side`. The renderer can
  never supply a path, revision, executable or argument; strict-object
  validators reject unknown keys.
- The service resolves ids against the **captured** snapshot — a stale
  snapshot/entry id is an honest `unavailable("stale")`, not a re-read.
- Staged = `diff --cached -M`; worktree = `diff -M` — both with
  `--patch --no-color --numstat -z` for pre-diff binary detection.
  Binary diffs report `binary` and never emit bytes; patches over the
  cap report `oversized`; rename diffs use the literal two-pathspec form.
- `check-attr filter` is consulted per path before a worktree diff — a
  configured filter driver is never executed, but worktree diff of an
  affected file is refused (`reason: "filters"`); unrelated files stay
  diffable.
- Untracked and unmerged entries have no safe diff — refused honestly.

## Operation tracking, queue and shutdown

The service tracks whole logical operations — probe + capture + status +
diff chains — not just the awaited command:

- Every operation carries its project/grant identity, owned view, live
  children and a single finite overall deadline. The gate
  runs before every spawn and after every await: closing/read-only,
  missing project, changed grant directory or
  expired deadline all stop the chain — a dispose during the HEAD probe
  prevents the later view/status spawns, verified by the maintainer probe.
- `onProjectDeleted` cancels queued and running operations; late
  completions can never publish a stale snapshot.
- A queued diff pins its snapshot's view (refcount) so a landing refresh
  cannot delete it, then re-validates snapshot identity, grant identity
  and diff-ability after the wait. Semaphore capacity is handed off
  atomically between queue head and waiter; the pending queue caps at 32
  and rejects overflow explicitly.
- `dispose()` stops admission synchronously, cancels queues and running
  operations, awaits the whole ownership set for at most 6 s, and
  reports any child whose exit was never observed; unresolved records
  and views are retained for a later retry — dispose never reports
  success because an earlier call forgot ownership. No commands or
  events can start afterwards.

## UI

Shared bottom dock now offers Chat / Terminal / **Git**; the Git panel
shows branch (+detached/unborn state), limitation badges
(`filters`, `entries-truncated`, `unsupported`), grouped
Staged/Unstaged/Untracked rows, per-side tabs, and honest center states
(binary / oversized / filtered / no-diff / not-a-repository /
unavailable). All strings bilingual (EN / zh-Hans).

## Validation

The maintainer ran the combined build, TypeScript check, **542 unit tests** and
**107 Electron E2E checks** successfully on macOS arm64. All 12 isolated
Electron instances exited; intentional crash cases are identified in the
E2E evidence. Three independent process/index probes also passed.

Maintainer corrections include capacity release on rejected diffs, read-only
object alternates with quoted paths, bounded auxiliary metadata reads,
failed-view cleanup, and renderer request ordering/error/contrast handling.
The E2E checks cover real Git diffs and unchanged source index/HEAD bytes;
a separate renderer fixture covers delayed replies and escaped patch text.
Neither substitutes for Windows or real provider validation.

Evidence is kept in the maintainer archive outside the repository. Final
source hashes and acceptance commit are recorded there by the maintainer
after screenshot review.

## Explicitly NOT verified / out of scope

- **Windows Git execution: NOT RUN** — macOS `/usr/bin/git` (Apple
  Git-157) is the only executor exercised; the Windows path/git.exe
  story is unvalidated.
- No mutating Git operations by design; no push/fetch/remote behavior.
- Diff coverage is the porcelain-visible set; `intent-to-add`, intent-to-
  delete edge cases and split-index repos surface as ordinary entries or
  honest `unsupported` rather than guaranteed fidelity.
