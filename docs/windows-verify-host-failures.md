# Expected Windows host failures in `npm run verify`

Repeat Windows-host verify runs (agent-characterized, not a
maintainer-confirmed baseline) show a stable failure set that does not
indicate a regression when it appears in isolation. A PR body that
reports a failing full-suite count is most useful when it either names
tests outside this set or labels its count *agent-characterized*.

- `tests/packaging.test.ts` — "builder config validation catches
  tampered identity / publishing / elevation" is load-timing
  sensitive: it has passed 3/3 in isolation while failing under
  parallel load.
- EPERM symlink failures (26 recorded on the autopilot host — every
  symlink fixture without Developer Mode or an elevated token) — see
  the count your own verify run reports before attributing extras to a
  change.
- `tests/windows/harness-control.test.ts` real-child deadline cases
  and `tests/codexAppServerProvider.test.ts` real-child session
  fixtures — socket/pipe and deadline timing on this host can exceed
  their budgets; they pass individually and in quieter runs.

Any failure outside these categories — or these tests failing
consistently rather than intermittently — is a real signal, not host
noise.
