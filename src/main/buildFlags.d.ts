// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Compile-time build flags injected by esbuild `define` (scripts/build.mjs).
// These identifiers are REPLACED BY LITERALS at bundle time — they are not
// environment variables, runtime config or persisted settings, and no code
// path may read them from process.env. An ordinary build leaves the
// identifier undefined; `typeof` guards keep those builds honest.

/**
 * true ONLY in a bundle built with `--terminal-candidate`: the Windows
 * terminal validation candidate. It does NOT itself enable terminals —
 * the attested packaged helper must also report terminalCapable, and the
 * platform must be win32. Ordinary builds compile this to `undefined`.
 */
declare const TIVANO_TERMINAL_CANDIDATE: boolean | undefined;
