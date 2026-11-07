// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F25: frozen MergeRequestLink port — a merge/pull-request link inside a
// chat is recognized per forge, carries the popover's "Merge" row title,
// and produces the helper chat's complete brief. The prompt is provider
// input (not UI copy) so it stays in English like the frozen strings.

export type MergeRequestForge = "gitlab" | "github" | "cursorOrigin" | "gitea";

export interface MergeRequestLink {
  url: string;
  forge: MergeRequestForge;
  number: number;
  /** How each forge writes its own: "!95" on GitLab, "#95" elsewhere. */
  label: string;
  /** The helper's title — the same words as the popover's row. */
  title: string;
  /** The helper's brief (frozen prompt verbatim). */
  prompt: string;
}

/** Swift Int(_:) — an optional sign and ASCII digits only; "0x10",
 *  "5.5" and "5x" are not numbers here. */
const strictInt = (s: string): number | undefined =>
  /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : undefined;

/**
 * Frozen init?(url:):
 *  - cursor.com / www.cursor.com `…/codebase/{owner}/{repo}/pull/{n}`
 *    (any other cursor.com link is never a merge request),
 *  - `…/{group}/…/-/merge_requests/{n}` on ANY host → GitLab,
 *  - `/{owner}/{repo}/pull/{n}` → GitHub,
 *  - `/{owner}/{repo}/pulls/{n}` → Gitea/Forgejo/Codeberg.
 */
export function parseMergeRequestLink(raw: string): MergeRequestLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter((s) => s !== "");
  const host = url.host.toLowerCase();
  const isCursor = host === "cursor.com" || host === "www.cursor.com";

  let forge: MergeRequestForge;
  let number: number | undefined;
  if (isCursor) {
    if (parts.length < 5 || parts[0] !== "codebase" || parts[3] !== "pull") return undefined;
    number = strictInt(parts[4]!);
    forge = "cursorOrigin";
  } else {
    const mri = parts.indexOf("merge_requests");
    if (mri >= 1 && mri + 1 < parts.length) {
      number = strictInt(parts[mri + 1]!);
      forge = "gitlab";
    } else if (parts.length >= 4 && parts[2] === "pull") {
      number = strictInt(parts[3]!);
      forge = "github";
    } else if (parts.length >= 4 && parts[2] === "pulls") {
      number = strictInt(parts[3]!);
      forge = "gitea";
    } else {
      return undefined;
    }
  }
  if (number === undefined || !(number > 0)) return undefined;

  const label = forge === "gitlab" ? `!${number}` : `#${number}`;
  const title = `Merge ${label}`;

  const originRepository =
    forge === "cursorOrigin" ? `${parts[1]}/${parts[2]}` : undefined;
  const land =
    forge === "gitlab"
      ? `Use glab from this directory: \`glab mr merge ${number} --yes\`. If GitLab answers that the request is still being checked (a 405), wait a few seconds and try again; if it reports conflicts, stop and say so instead of resolving them.`
      : forge === "github"
        ? `Use gh from this directory: \`gh pr merge ${number} --merge\`. If GitHub reports the pull request is not mergeable, stop and say so instead of resolving it.`
        : forge === "cursorOrigin"
          ? `Use origin from this directory: \`origin pr merge ${number} -R ${originRepository ?? ""}\`. Confirm this repository matches the checkout's origin remote before merging. If origin is not installed or not signed in, tell the user to install it and run \`origin auth login\`, then stop. If the change is not mergeable, stop and say so instead of working around it. Never push to the base branch directly. Confirm the request is merged with \`origin pr view ${number} -R ${originRepository ?? ""} --json status,mergedAt\` before syncing.`
          : `Use tea from this directory: \`tea pulls merge ${number}\`. If tea is not installed or signed in to this host, or the pull request is not mergeable, stop and say so instead of working around it.`;

  const prompt = `Merge ${label} now: ${url.href}

${land} Once it is merged, sync the checkout: if this directory is on main with a clean working tree, run \`git pull --ff-only\`; otherwise leave the working tree alone and say so. Do not rebuild, install or relaunch anything. Reply in a few lines with the merged commit and the request's link.`;

  return { url: url.href, forge, number, label, title, prompt };
}
