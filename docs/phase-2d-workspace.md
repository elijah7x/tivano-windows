# Phase 2d — user-selected project directories

Adds real project-folder attachment: a user can open an existing folder
as a project, reopen the app and keep that binding, see when the folder
is unavailable, and remove the project without touching its files. This
slice launches no shells/providers and initializes no Git repositories —
it is the directory-selection seam those slices will build on.

## What it does

- Sidebar **Open folder** action → `projects:open-directory` IPC with an
  intentionally EMPTY payload. The renderer can request the chooser but
  can never name a path; strict-object validation rejects any key.
- Main owns the chooser: `dialog.showOpenDialog(parentWindow,
  { properties: ["openDirectory", "multiSelections"] })` — directories
  only, never files. One chooser at a time; concurrent invocations
  coalesce onto the pending open. Window-usable and engine-mutable are
  checked before the dialog opens AND after it resolves — a destroyed
  window or a closing/read-only engine never materializes a late project.
- Selected paths are canonicalized in main (`realpathSync`; the selected
  entry must be a real non-symlink directory — a symlink is refused, not
  followed). Nothing inside the chosen directory is scanned, read or
  written; no marker file is ever created there.
- Host-semantics dedupe: selecting a directory already bound to a project
  (either grant kind) re-opens/expands that project instead of minting a
  second binding. The default name is the canonical folder basename.
- The project-row delete button requires a second click to confirm. Deleting
  revokes its grant only; every file inside the selected directory is preserved.
  If revocation cannot be saved, the project and its threads remain intact.

## Authorization model (unchanged boundary)

Grants stay in app-private `workspace-grants.json`, now with two
sections: `grants` (managed fixture roots — marker file + authorized-root
containment, unchanged rules) and `userGrants` (user-selected canonical
paths — no marker, no root requirement; a user dir may live anywhere and
does not depend on fixture roots). `project.directory` in the store is
DISPLAY metadata only: a forged value can never mint a grant — spawn
authorization consults the grants map keyed by projectId exclusively.

Ordering is explicit: canonicalize → dedupe → durable grant write →
persisted project (+`flushNow`). A failed grant write activates no
project and preserves every older grant; a crash that leaves an orphan
grant with no project restores nothing (restore drops entries whose
project no longer exists). A project-store write failure retains the visible
project and reports the error. Selecting it again retries the write before
returning success. Rebinding replaces any unrestored entry across grant kinds.

## Restore semantics

`ProjectRuntimePaths.restore()` validates both sections before one atomic
save + one in-memory commit. Unknown versions, malformed sections and unreadable
documents are preserved unchanged; grant writes remain blocked until a readable
document is restored or the app is reopened with repaired storage:


- Managed entries: real non-symlink dir, inside an authorized root,
  matching ownership marker (unchanged).
- User entries: real non-symlink dir whose recorded canonical path still
  resolves to itself — a missing/renamed folder or a path retargeted by
  a symlink is preserved and reported, never dropped, repointed or
  broadened.
- Empty authorized-roots restores nothing MANAGED; user entries are
  unaffected.

`snapshot().projects[].directoryStatus` is computed live: `available`
only when the grant exists, points at the SAME path the project displays,
and the folder is still a real canonical directory — so a forged display
path can never look bound.

## UI

- Open-folder icon button beside New project (folder-open glyph);
  disabled + `aria-busy` while the chooser is pending, disabled in
  read-only.
- Attached projects show a canonical-path hint under the group row;
  `Folder unavailable` / `文件夹不可用` badge when the binding is
  unavailable. Partial multi-select failures surface in the error banner.
- New strings localized en + zh-Hans; the dialog title follows the app
  language ("Open folder" / "打开文件夹").

## Verification status

- 29 focused unit tests (`tests/openDirectory.test.ts`): cancellation,
  path-bearing-payload rejection, coalesced concurrent opens,
  post-await close/destroyed-window races, persistence-failure ordering,
  restart restore, missing/renamed/retargeted preservation, forged
  display metadata, re-attach on display match, sentinel-file
  preservation, no writes into the user dir, visible project-store failure
  recovery, failed deletion preservation, and cross-kind grant replacement, and unrecognized-document preservation.
- IPC validator regressions for the empty-payload channel.
- E2E (macOS): seeded grants+store drive the real restore path —
  available/unavailable bindings render, unavailable grant preserved in
  the file, the two-click delete action revokes the grant while the sentinel file survives,
  zh-Hans badge renders.

**Not verified**: the native Windows folder dialog itself (this build ran
on macOS); the chooser API contract is `showOpenDialog` and identical on
Windows, but native execution evidence is absent until a Windows run.
No shells, providers, terminals or Git were launched by this slice.
