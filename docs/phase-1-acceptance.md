# Phase 1 synthetic foundation — maintainer review

Reviewed on 2026-10-23 against the frozen Tivano v2.0.0 baseline (`d31e093b356846ff538dd8ba0dc22d62598e4427`). This is a development checkpoint, not Windows or full-feature acceptance.

## Independently exercised

- `npm run verify`: build, TypeScript, 138 unit tests and 17 isolated Electron end-to-end checks passed on macOS arm64.
- Shared zh-Hans fixture values were compared with the frozen source catalog using `TIVANO_UPSTREAM_XCSTRINGS`.
- Isolated UI interaction confirmed drafts survive thread changes and delayed send responses, matching children remain visible under collapsed project search, and the project button renders its icon. English chrome, Chinese About and interrupted-turn screenshots were viewed.
- Process exits were observed before successful-run synthetic data cleanup. Failed probe/run evidence was preserved outside source.

## Maintainer corrections after the two implementation repair rounds

- `store.ts`: keep write ownership when lock release fails or its guard is busy; reject a dangling store link before treating a missing target as a new store.
- `storeDoc.ts`: capacity refusal does not classify a valid large history as corrupt or reset its file. This build still has explicit read limits (10,000 projects, 50,000 threads, 1,000,000 messages/thread); exceeding them requires a capacity/migration change, not deleting history.
- `client.ts`: advance the applied event revision so older events cannot roll current state back.
- `scripts/e2e.mjs`: await IPC snapshots on the Node side. The installed Playwright implementation treats a Promise returned by `waitForFunction` as truthy, so async predicates were not reliable polling gates. New-thread and new-approval checks bind to object identity.
- Added five targeted regression tests.

## Remaining boundaries

- The only provider remains synthetic. No real provider authentication, model request, tool execution, PTY, Git integration or Hydra support has been accepted.
- Real Windows runtime, junction/permissions behavior, packaging, installation and updater validation remain unperformed. macOS tests and `path.win32` assertions are not substitutes.
- A process crash inside the short mkdir-guard critical section can leave `store.lock.guard`; recovery must establish ownership/death before any manual removal. No automatic removal of unknown guards.
- Full frozen-feature/provider inventory and visual parity with the Mac product remain unfinished. Screenshots establish the current shell, not full Mac parity.
- No new remote, push, publication, production credential access or Mac application changes were performed.

Next work: complete the frozen provider/feature inventory and prepare bounded provider/process integration tasks. Use isolated synthetic protocol executables until a separate development identity is explicitly authorized.
