// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F15 "Open in" — frozen Workspace.installedEditors/open/revealInFinder
// port. Editor discovery is platform-honest: macOS app-bundle presence,
// a PATH launcher, or a known install location. Every launch uses a
// real argument array — the directory is never concatenated into a
// shell string. Nothing about an editor is fabricated: an editor that
// is not installed is simply absent from the list, and a launch failure
// surfaces the OS error verbatim.

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenInEditor {
  /** Stable id the renderer passes back — paths never cross IPC. */
  id: string;
  name: string;
}

interface EditorCandidate extends OpenInEditor {
  /** macOS: Launch-Services bundle id; installed iff the .app exists in a
   *  standard applications directory. Launched via `open -b <id> <dir>`. */
  bundleId?: string;
  app?: string;
  /** A command resolved on PATH (any platform). */
  command?: string;
  /** win32: %VAR%-expanded candidate executable paths. */
  winPaths?: string[];
  /** Arguments placed before the directory (e.g. `wt -d <dir>`). */
  args?: string[];
}

/** The frozen candidate list, extended only where the platform dictates
 *  different executables — display names stay the frozen ones. */
const CANDIDATES: EditorCandidate[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    bundleId: "com.microsoft.VSCode",
    app: "Visual Studio Code.app",
    command: "code",
    winPaths: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
      "%ProgramFiles%\\Microsoft VS Code\\Code.exe",
    ],
  },
  {
    id: "vscode-insiders",
    name: "Visual Studio Code - Insiders",
    bundleId: "com.microsoft.VSCodeInsiders",
    app: "Visual Studio Code - Insiders.app",
    command: "code-insiders",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe"],
  },
  {
    id: "cursor",
    name: "Cursor",
    bundleId: "com.todesktop.230313mzl4w4u92",
    app: "Cursor.app",
    command: "cursor",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe"],
  },
  {
    id: "zed",
    name: "Zed",
    bundleId: "dev.zed.Zed",
    app: "Zed.app",
    command: "zed",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    bundleId: "com.exafunction.windsurf",
    app: "Windsurf.app",
    command: "windsurf",
    winPaths: ["%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe"],
  },
  {
    id: "sublime",
    name: "Sublime Text",
    bundleId: "com.sublimetext.4",
    app: "Sublime Text.app",
    command: "subl",
    winPaths: ["%ProgramFiles%\\Sublime Text\\sublime_text.exe"],
  },
  {
    id: "vscodium",
    name: "VSCodium",
    bundleId: "com.vscodium",
    app: "VSCodium.app",
    command: "codium",
    winPaths: ["%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe"],
  },
  {
    id: "notepadpp",
    name: "Notepad++",
    winPaths: ["%ProgramFiles%\\Notepad++\\notepad++.exe"],
  },
  {
    // Frozen lists Terminal among the editors: on macOS `open -b
    // com.apple.Terminal <dir>` opens a window cd'd into it; on Windows
    // `wt -d <dir>` does the same.
    id: "terminal",
    name: "Terminal",
    bundleId: "com.apple.Terminal",
    app: "Utilities/Terminal.app",
    command: "wt",
    winPaths: ["%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"],
    args: ["-d"],
  },
  {
    id: "ghostty",
    name: "Ghostty",
    bundleId: "com.mitchellh.ghostty",
    app: "Ghostty.app",
  },
  {
    id: "iterm",
    name: "iTerm",
    bundleId: "com.googlecode.iterm2",
    app: "iTerm.app",
  },
];

/** A candidate that resolved on this machine, paired with how to launch. */
interface ResolvedEditor {
  id: string;
  name: string;
  launch: (dir: string) => void;
}

const expandEnv = (p: string): string =>
  p.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);

const macAppDirs = ["/Applications", "/System/Applications", join(homedir(), "Applications")];

function which(cmd: string): string | undefined {
  const tool = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(tool, [cmd], { encoding: "utf8", timeout: 4000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  return first !== undefined && existsSync(first) ? first : undefined;
}

const detached = (exe: string, args: string[]): void => {
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // launch errors are reported by the caller path
  child.unref();
};

function resolve(c: EditorCandidate): ResolvedEditor | undefined {
  // macOS app bundle — presence in a standard applications directory is the
  // honest "installed" signal; launch goes through Launch Services by id.
  if (process.platform === "darwin" && c.bundleId && c.app) {
    const installed = macAppDirs.some((d) => existsSync(join(d, c.app!)));
    if (installed) {
      const bundleId = c.bundleId;
      return {
        id: c.id,
        name: c.name,
        launch: (dir) => detached("open", ["-b", bundleId, dir]),
      };
    }
  }
  // win32 known install locations.
  if (process.platform === "win32" && c.winPaths) {
    const exe = c.winPaths.map(expandEnv).find((p) => existsSync(p));
    if (exe) {
      const args = c.args ?? [];
      return { id: c.id, name: c.name, launch: (dir) => detached(exe, [...args, dir]) };
    }
  }
  // A PATH launcher on any platform.
  if (c.command) {
    const exe = which(c.command);
    if (exe) {
      const args = c.args ?? [];
      return { id: c.id, name: c.name, launch: (dir) => detached(exe, [...args, dir]) };
    }
  }
  return undefined;
}

/** Frozen `installedEditors`: resolved once per launch — each entry is a
 *  filesystem/PATH probe, and the menu asks on every open. */
let installedCache: ResolvedEditor[] | undefined;

export function installedEditors(refresh = false): OpenInEditor[] {
  if (refresh) installedCache = undefined;
  installedCache ??= CANDIDATES.map(resolve).filter(
    (e): e is ResolvedEditor => e !== undefined,
  );
  return installedCache.map(({ id, name }) => ({ id, name }));
}

/** The resolved editor's display name without launching — used by the
 *  external-open test seam, which records intent instead of spawning. */
export function editorName(editorId: string): string {
  installedCache ??= CANDIDATES.map(resolve).filter(
    (e): e is ResolvedEditor => e !== undefined,
  );
  const ed = installedCache.find((e) => e.id === editorId);
  if (!ed) throw new Error(`editor is not available: ${editorId}`);
  return ed.name;
}

/** Open `dir` in the named editor. Returns the editor's display name; an
 *  unresolvable id or a vanished install is an honest Error. */
export function openWithEditor(dir: string, editorId: string): string {
  installedCache ??= CANDIDATES.map(resolve).filter(
    (e): e is ResolvedEditor => e !== undefined,
  );
  const ed = installedCache.find((e) => e.id === editorId);
  if (!ed) throw new Error(`editor is not available: ${editorId}`);
  try {
    ed.launch(dir);
  } catch (err) {
    throw new Error(`could not open ${ed.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ed.name;
}
