// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-42 inline pull-request action (v3.0.26 Git.swift / GitHubAPI.swift
// seam): turn the checkout's origin remote plus the pushed branch into the
// forge's own "open a pull request" web page. No token is read and no API
// is called; the user finishes the request in their signed-in browser.
// Credentials embedded in a remote URL are always dropped.

export type PullRequestForge = "github" | "gitlab";

export interface ForgeRemote {
  forge: PullRequestForge;
  /** `https://<host>` without userinfo or port-only ssh noise. */
  origin: string;
  /** Repository path without a leading slash or trailing `.git`. */
  repoPath: string;
}

function forgeForHost(host: string): PullRequestForge | undefined {
  const h = host.toLowerCase();
  if (h === "github.com" || h === "www.github.com") return "github";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "gitlab";
  return undefined;
}

/** Parse https, ssh:// and scp-style (`git@host:owner/repo.git`) remotes.
 *  Local paths, `file://` and unknown hosts are not forges here. */
export function parseForgeRemote(remoteUrl: string | undefined): ForgeRemote | undefined {
  if (!remoteUrl) return undefined;
  const raw = remoteUrl.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\\\s]+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    const scheme = url.protocol.toLowerCase();
    if (scheme !== "https:" && scheme !== "http:" && scheme !== "ssh:" && scheme !== "git+ssh:")
      return undefined;
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else if (scp && scp[1]!.includes(".")) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return undefined;
  }
  const forge = forgeForHost(host);
  if (!forge) return undefined;
  const parts = path
    .replace(/\.git\/?$/i, "")
    .split("/")
    .filter((s) => s !== "");
  if (parts.length < 2 || parts.some((s) => s === "." || s === "..")) return undefined;
  if (forge === "github" && parts.length !== 2) return undefined;
  return { forge, origin: `https://${host.toLowerCase()}`, repoPath: parts.join("/") };
}

const encodePath = (s: string): string => s.split("/").map(encodeURIComponent).join("/");

/** The forge page that starts a pull/merge request from `branch`, or
 *  undefined when the remote is not a supported forge or the branch is
 *  missing. The default branch is left for the forge to choose. */
export function pullRequestUrl(
  remoteUrl: string | undefined,
  branch: string | null | undefined,
): string | undefined {
  const remote = parseForgeRemote(remoteUrl);
  if (!remote || !branch || !branch.trim()) return undefined;
  const repo = encodePath(remote.repoPath);
  if (remote.forge === "github")
    return `${remote.origin}/${repo}/compare/${encodePath(branch)}?expand=1`;
  return `${remote.origin}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}
