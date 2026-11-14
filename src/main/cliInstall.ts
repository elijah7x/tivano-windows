// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// CLI command installation (frozen ControlCLIInstaller port, honest
// scope): writes a thin `tivano` shim into a user-owned bin directory
// that execs the bundled Node client. Deliberate boundaries kept:
//   - never enables local control (the gates stay the app's own)
//   - never edits shell configuration or PATH — reported to the user
//   - never replaces or removes a foreign `tivano` (conflict refusal)
//   - status distinguishes healthy from needs-repair: a shim of ours
//     pointing at a stale or missing client is reported `repair`, which
//     the settings surface words as Repair CLI (frozen needsRepair)
//   - uninstall removes every shim file proven ours via its marker
//     line (win32 writes a `.cmd` sibling next to the sh shim)
//   - the receipt (`cliInstallationTarget` setting) records the client
//     path the installed shim points at

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chmodSync, lstatSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const CLI_COMMAND_NAME = "tivano";
const MARKER = "# tivano-cli-shim:";

export type CliInstallState =
  | { state: "absent" }
  | { state: "installed"; path: string; target: string }
  | { state: "repair"; path: string; target: string }
  | { state: "foreign"; path: string };

/** Default install directory — user-owned, never a system dir.
 *  POSIX: ~/.local/bin (frozen). Windows: %LOCALAPPDATA%\Tivano Windows\bin. */
export function cliBinDir(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "win32")
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Tivano Windows", "bin");
  return join(homedir(), ".local", "bin");
}

/** Shim text: POSIX shell; win32 additionally gets a .cmd sibling. */
function shimText(cliPath: string): string {
  return (
    `#!/bin/sh\n${MARKER} ${cliPath}\n` +
    `exec node "${cliPath.replace(/"/g, '\\"')}" "$@"\n`
  );
}

function cmdShimText(cliPath: string): string {
  return `@echo off\r\nrem ${MARKER} ${cliPath}\r\nnode "${cliPath}" %*\r\n`;
}

function readMarker(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    const line = text.split("\n").find((l) => l.includes(MARKER));
    return line ? line.slice(line.indexOf(MARKER) + MARKER.length).trim() : "";
  } catch {
    return null;
  }
}

/** State of the command on disk, read from the shim itself. When
 *  `currentTarget` (this launch's bundled client path) is given, a shim
 *  of ours pointing elsewhere — an older copy after a move or update —
 *  or at a path that no longer exists reports `repair` instead of
 *  `installed` (frozen needsRepair). Callers that only need ownership
 *  (install/uninstall) omit it and see plain `installed`. */
export function cliStatus(dir: string, currentTarget?: string): CliInstallState {
  const file = join(dir, process.platform === "win32" ? `${CLI_COMMAND_NAME}.cmd` : CLI_COMMAND_NAME);
  const posixFile = join(dir, CLI_COMMAND_NAME);
  const present = existsSync(file) ? file : existsSync(posixFile) ? posixFile : null;
  if (!present) return { state: "absent" };
  const target = readMarker(present);
  if (target === null || target === "") return { state: "foreign", path: present };
  if (currentTarget !== undefined && (target !== currentTarget || !existsSync(target)))
    return { state: "repair", path: present, target };
  return { state: "installed", path: present, target };
}

export class CliInstallError extends Error {
  constructor(
    readonly code: "conflict" | "io",
    message: string,
  ) {
    super(message);
  }
}

/** Install or repair: overwrite only our own shim or a missing file.
 *  Every sibling under a command name must be absent or ours before a
 *  byte is written — win32 installs write `tivano` and `tivano.cmd`,
 *  so a foreign file under either name refuses the whole operation. */
export function installCli(
  dir: string,
  cliPath: string,
): Extract<CliInstallState, { state: "installed" }> {
  for (const name of [CLI_COMMAND_NAME, `${CLI_COMMAND_NAME}.cmd`]) {
    const p = join(dir, name);
    if (existsSync(p) && !readMarker(p))
      throw new CliInstallError("conflict", `a different ${CLI_COMMAND_NAME} already exists at ${p}`);
  }
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, CLI_COMMAND_NAME);
    writeFileSync(file, shimText(cliPath), { mode: 0o755 });
    if (platform() !== "win32") chmodSync(file, 0o755);
    if (platform() === "win32")
      writeFileSync(join(dir, `${CLI_COMMAND_NAME}.cmd`), cmdShimText(cliPath));
    return { state: "installed", path: file, target: cliPath };
  } catch (e) {
    if (e instanceof CliInstallError) throw e;
    throw new CliInstallError("io", (e as Error).message);
  }
}

/** Remove the command only when the installed shim is proven ours.
 *  Every sibling proven ours goes — win32 installs write `tivano` and
 *  `tivano.cmd` — while a foreign file under a command name is left
 *  untouched and still refuses the whole operation. */
export function uninstallCli(
  dir: string,
): Extract<CliInstallState, { state: "absent" }> {
  const st = cliStatus(dir);
  if (st.state === "foreign")
    throw new CliInstallError("conflict", `refusing to remove a foreign ${CLI_COMMAND_NAME} at ${st.path}`);
  if (st.state === "installed") {
    try {
      for (const name of [CLI_COMMAND_NAME, `${CLI_COMMAND_NAME}.cmd`]) {
        const p = join(dir, name);
        if (!existsSync(p) || !readMarker(p)) continue;
        const l = lstatSync(p);
        if (l.isFile() || l.isSymbolicLink()) unlinkSync(p);
      }
    } catch (e) {
      throw new CliInstallError("io", (e as Error).message);
    }
  }
  return { state: "absent" };
}
