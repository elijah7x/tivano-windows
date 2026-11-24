# Expected Windows host failures in `npm run verify`

Repeat Windows-host verify runs (agent-characterized, not a
maintainer-confirmed baseline) show a stable failure set that does not
indicate a regression when it appears in isolation. A PR body that
reports a failing full-suite count **must** either name the failing
tests that fall outside this set or label its count
*agent-characterized* — see the Verification checklist in
`.github/pull_request_template.md`, which requires this.

- EPERM symlink failures (~30 privilege-requiring symlink fixtures
  across 13 test files — every `mklink`-style fixture fails without
  Developer Mode or an elevated token; e.g. `tests/store.test.ts`,
  `tests/checkpoint-ledger.test.ts`, `tests/workspaceAuto.test.ts`) —
  check the count your own verify run reports before attributing
  extras to a change.
- `tests/windows/harness-control.test.ts` real-child deadline cases
  (`:158`, `:237`) and `tests/codexAppServerProvider.test.ts`
  real-child session fixtures (e.g. `:299`) — spawned-child pipe and
  deadline timing on this host can exceed their budgets under load;
  they pass individually and in quieter runs.

A failure outside these categories — or one of these tests failing
**consistently** (on the PR *and* on the base commit, the gate's own
rule) — is a real signal, not host noise.

## Retired entries

- `tests/packaging.test.ts` — "builder config validation catches
  tampered identity / publishing / elevation" was load-timing
  sensitive (it compiled the electron-builder schema afresh on every
  `validateBuilderSchema` call). The compiled validator is now cached
  in `scripts/lib/package-plan.mjs`, so the case is retired from the
  set; a recurrence is a real failure, not noise.
