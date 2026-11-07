// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F13/F22 bounded detection slice (frozen GitHubConnection.githubCLI):
// which forge CLIs the merge/PR handoffs could actually run. Presence
// and `--version` output ONLY — sign-in state is never probed and
// `gh auth token`-style credential extraction is never run: the frozen
// flow reads the user's real CLI token, which this port does not do.
// Spawns go through the same bounded runner as Git: fixed binary name,
// fixed args, shell:false, minimal env (the app's own PATH so "found"
// means what the user means by "on PATH", plus the Windows system vars
// a CreateProcess child needs), hard byte/time bounds.

import { makeGitRunner, type GitRunner } from "./gitExec";

export interface ForgeCliStatus {
  /** Stable id: the binary stem users type. */
  id: "gh" | "glab" | "origin" | "tea";
  label: string;
  forge: "github" | "gitlab" | "gitea" | "origin";
  found: boolean;
  /** First line of `<bin> --version`, when the CLI answered. */
  version?: string;
  /** Set when no candidate spawned (ENOENT and friends). */
  error?: string;
}

interface ForgeCliDef {
  id: ForgeCliStatus["id"];
  label: string;
  forge: ForgeCliStatus["forge"];
  /** Binary names tried in order — Windows resolves `x.exe`, not `x`. */
  bins: readonly string[];
}

const FORGE_CLIS: readonly ForgeCliDef[] = [
  { id: "gh", label: "GitHub CLI", forge: "github", bins: ["gh", "gh.exe"] },
  { id: "glab", label: "GitLab CLI", forge: "gitlab", bins: ["glab", "glab.exe"] },
  { id: "tea", label: "Gitea CLI", forge: "gitea", bins: ["tea", "tea.exe"] },
  // Frozen SourceControlSettingsPage lists gh/glab/origin/tea as the
  // PR-opening CLIs and probes `origin auth status` for the Cursor
  // Origin row — the auth half stays unported by design (see header).
  { id: "origin", label: "Cursor Origin CLI", forge: "origin", bins: ["origin", "origin.exe"] },
];

/** Minimal child env: the app's own PATH (what "on PATH" means to the
 *  user) and the system vars a Windows child needs. No HOME — the CLIs
 *  get no config path to read, and nothing user-private is forwarded. */
function forgeChildEnv(path: string): Record<string, string> {
  const env: Record<string, string> = { PATH: path, LANG: "C", LC_ALL: "C" };
  for (const key of ["SystemRoot", "windir", "SystemDrive", "ComSpec"]) {
    const hit = Object.keys(process.env).find(
      (k) => k.toLowerCase() === key.toLowerCase(),
    );
    const v = hit ? process.env[hit] : undefined;
    if (v) env[hit!] = v;
  }
  return env;
}

const TIMEOUT_MS = 3000;
const MAX_BYTES = 64 * 1024;

async function probeOne(
  def: ForgeCliDef,
  env: Record<string, string>,
  makeRunner: (bin: string) => GitRunner,
): Promise<ForgeCliStatus> {
  let lastError: string | undefined;
  for (const bin of def.bins) {
    const runner = makeRunner(bin);
    try {
      const h = runner.run(["--version"], {
        env,
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      });
      // The runner's own kill bound fires on the child — but a hung CLI
      // can leave a grandchild holding its pipes, and `close` waits for
      // stdio EOF. The probe promise races a hard deadline so the IPC
      // itself can never hang; a child that outlives it still counts as
      // present (it did spawn) with no version.
      const r = await Promise.race([
        h.done,
        new Promise<null>((res) =>
          setTimeout(() => res(null), TIMEOUT_MS + 2000),
        ),
      ]);
      if (r === null) {
        return { id: def.id, label: def.label, forge: def.forge, found: true };
      }
      if (r.spawnError !== undefined) {
        lastError = r.spawnError;
        continue;
      }
      if (r.code === 0) {
        const line = r.stdout.split(/\r?\n/, 1)[0]!.trim();
        return { id: def.id, label: def.label, forge: def.forge, found: true, version: line };
      }
      // Ran but answered oddly — still "found", version stays unknown.
      return { id: def.id, label: def.label, forge: def.forge, found: true };
    } catch {
      lastError = "spawn failed";
    }
  }
  return {
    id: def.id,
    label: def.label,
    forge: def.forge,
    found: false,
    ...(lastError !== undefined ? { error: lastError } : {}),
  };
}

/** Probe every forge CLI once — bounded, never cached forever (the
 *  settings page re-probes on open; PATH can change mid-session). */
export async function probeForgeClis(opts?: {
  path?: string;
  makeRunner?: (bin: string) => GitRunner;
}): Promise<ForgeCliStatus[]> {
  const env = forgeChildEnv(opts?.path ?? process.env.PATH ?? "");
  const makeRunner = opts?.makeRunner ?? makeGitRunner;
  return Promise.all(FORGE_CLIS.map((d) => probeOne(d, env, makeRunner)));
}
