# Native Windows helper validation — 2026-10-24

Scope: the Job Object helper and its native harness, not an installer or
application-level provider acceptance. Real provider execution stays disabled.

- Input source: 4ad06e4065a032434153dba0ab8e385fe368ed7a, with the two
  corrections below. All five compiled source/header hashes match the input.
- Environment: Windows Server 2022 Standard 10.0.20348.5622, x64,
  elevated account; Node 20.19.0.
- Toolchain: MSVC 19.44.35229.0, toolset 14.44.35207, SDK 10.0.26100.0;
  /W4 /WX, static CRT, x64 PE output.
- Native selftest: 45/45, exit 0.
- Final full Windows harness: 24/24, exit 0; every case records clean
  teardown. Helper/fixture hashes match both build and harness manifests.
- Per-case creation identities and cleanup records are retained. The
  post-suite process query found no remaining task processes.

## Corrections tested on Windows

1. Prepend a UTF-8 BOM to scripts/build-job-helper.ps1. Its remaining bytes
   are unchanged. PowerShell 5.1 had misread UTF-8 text as ANSI and failed
   before compilation; the original failure log is preserved.
2. In the owner-death test, observe the child's exit code **or** terminating
   signal. The original test rejected code=null, signal=SIGTERM despite
   observing all descendants gone. The correction retains the identity and
   bounded all-dead checks. This follows the [Node 20 exit-event contract](https://github.com/nodejs/node/blob/v20.19.0/doc/api/child_process.md#event-exit).

The first suite ran 21 real cases: 20 passed and owner-death failed, then
the suite stopped before the last three. Its JSON also includes a stopped-suite
sentinel, giving 22 entries; that sentinel is not a second executed test.
After the scoped correction, all 24 real cases passed in one full run.
No helper C++ source, timeout, ownership or cleanup requirement was relaxed.

## Artifact identity

Evidence ZIP (kept in the maintainer archive outside the repository): 1,451,281 bytes, 101 entries,
SHA-256 c21d067d2919f79e3ba73321303cf41b52029648ade7940440991114d25c765c.
The maintainer checked ZIP integrity, compiled-source hashes, x64 PE headers,
binary/result binding, both suite records and the exact source corrections.
The full expected ZIP hash was not displayed by the service; its visible
prefix/suffix matched the downloaded file. The digest above identifies the
downloaded evidence, not an independent signature.

- Helper SHA-256: 1010d08ae1cba7be0b5c68ea12a65ccce3f37cc5ff34d3b0b956c845e6e01fae.
- Fixture SHA-256: e2b27c68662b562373dd73ca2c343d9ecd36f07856e65ef20cc0a054e4ccb009.
- Tested harness SHA-256: 59a3269da240f6b49a3fa27643141a9e560d4c6fa3a3836fd69a2e1789ac0dce.

These are unsigned test artifacts. Standard-user Windows 10/11 behavior,
Electron/provider integration, authentication, packaging, signing and updates
remain outside this evidence.
