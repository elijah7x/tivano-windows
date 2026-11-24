// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-38/P1-09 (v3.0.0 parity): the independent Hydra review — frozen
// prompt, review message, finding counter and lead-verdict parser from
// upstream HydraPrompts+V2.swift / HydraReviewVerdicts.swift /
// AppSettings.HydraReviewChoice. Cross-provider reviewer CLIs are out
// of this build's scope (single provider; see docs/parity.md P1-38).

/** Frozen `HydraReviewChoice` — one reviewer pick; an empty provider is
 *  "off" (the slot never yields an engine). */
export interface HydraReviewChoice {
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

/** Frozen `HydraReviewChoice.providers` ∩ this build's providers. */
export const HYDRA_REVIEW_PROVIDERS = ["codex", "antigravity"] as const;

/** Frozen `HydraReviewChoice` defaults — `defaultFirst` is Codex at
 *  high effort; `defaultSecond` is Claude, which this build cannot run,
 *  so the bounded fallback defaults to Off. */
export const HYDRA_REVIEW_DEFAULT_FIRST: HydraReviewChoice = {
  provider: "codex",
  effort: "high",
};

/** Frozen `ModelOption.effortTitle` — "Extra High" for xhigh, otherwise
 *  the id capitalized. */
export function hydraReviewEffortTitle(effort: string): string {
  if (effort === "xhigh" || effort === "extra-high") return "Extra High";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The reviewer label the card and report name (frozen
 *  `hydraReviewEngine` composition: provider display name + model +
 *  effort title). The model id stands in for the display name — the
 *  engine has no catalog access (documented bound). */
export function hydraReviewerLabel(
  choice: HydraReviewChoice,
  providerLabel: (id: string) => string,
): string {
  let label = choice.provider?.trim()
    ? providerLabel(choice.provider)
    : providerLabel("codex");
  const model = choice.model?.trim();
  if (model) label += ` ${model}`;
  const effort = choice.effort?.trim();
  if (effort) label += ` · ${hydraReviewEffortTitle(effort)}`;
  return label;
}

/** Frozen `v2ReviewPrompt` — the detached reviewer's brief. The
 *  `# checkout:` headers and the read-only wording are verbatim; the
 *  review session honours them only where this build's provider can. */
export function hydraReviewPrompt(
  request: string,
  notes: string,
  patch: string,
): string {
  return `You are an independent reviewer from another vendor, reviewing this job's change. You may read files in the checkouts named by the \`# checkout:\` headers in the diff to confirm declarations, callers and surrounding code before you report; read only, change nothing and run nothing that writes. If you cannot read files, use only the material below.

Report only problems that would make the change behave wrongly or fail the user's request: bugs, broken callers, missing pieces of the request and unsafe operations. Report a problem only when the diff or the files you read show it; leave out claims about compiler, OS or library behaviour you have not confirmed. Report no style, naming or preference issues.

You do not see the lead's chat replies, the builds and checks it ran, deployments, or files outside Git, so do not report something as missing, unbuilt or unverified on that basis. The diff starts from the tree at the beginning of the job, so it can include commits the user asked to merge or earlier approved work; do not ask to revert them unless they break the request.

If there are none, output exactly NO FINDINGS. Otherwise output at most 8 lines, most severe first. Each line starts \`Finding N:\` and gives \`path:line\`, the concrete failure scenario and the fix. Add no introduction or summary.

## User request
${request}

## Heads' flags
${notes}

## Unified diff
~~~~diff
${patch}
~~~~`;
}

/** Frozen `v2ReviewMessage` — the `[Hydra] Review` findings turn. */
export function hydraReviewMessage(
  reviewer: string,
  findings: string,
): string {
  return `[Hydra] Review: an independent review by ${reviewer} of this job's changes.

${findings}

---
For the lead:
Check each finding against the checkout before acting, and reject any that is already handled, out of scope or false. For each finding, write one plain line, without bullets or bold, \`Finding N: accepted - <what you changed>\` or \`Finding N: rejected - <why>\`. Fix accepted findings yourself, send no heads out, and run the narrowest build if you changed code. Then answer the user in one or two lines about what the review changed.`;
}

/** Frozen finding counter — lines opening `Finding <digit>`. */
export function countReviewFindings(text: string): number {
  const re = /^[\s\-*>#_]*Finding\s*\d/i;
  return text.split(/\r?\n/).filter((l) => re.test(l)).length;
}

export interface HydraReviewVerdict {
  number: number;
  accepted: boolean;
  text: string;
}

const VERDICT_RE =
  /^[\s\-*>#_]*Finding\s*(\d+)[\s*_]*[:：][\s*_]*(?:partially\s+|partly\s+)?(accepted|接受|已接受|采纳|已采纳|部分采纳|rejected|驳回|已驳回|拒绝|不采纳)/i;
const REJECTED = new Set(["rejected", "驳回", "已驳回", "拒绝", "不采纳"]);

/** Frozen `HydraReviewVerdicts.items` — a verdict counts only when a
 *  line opens on it; a later verdict on the same finding replaces an
 *  earlier one; template placeholder lines are ignored. */
export function parseReviewVerdicts(reply: string): HydraReviewVerdict[] {
  const byNumber = new Map<number, HydraReviewVerdict>();
  for (const line of reply.split(/\r?\n/)) {
    if (line.includes("<what you changed>") || line.includes("<why>")) continue;
    const m = VERDICT_RE.exec(line);
    if (!m) continue;
    const number = Number.parseInt(m[1]!, 10);
    const accepted = !REJECTED.has(m[2]!.toLowerCase());
    const text = line
      .slice(m[0].length)
      .replace(/^[\s*_]*[\s\-–—:：*_]*/, "")
      .trim();
    byNumber.set(number, { number, accepted, text });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** A persisted review card on the lead thread (frozen job fields:
 *  reviewEngine + reviewFindings; verdict counts fill when the lead's
 *  answer is parsed). */
export interface HydraReview {
  id: string;
  batchId: string;
  reviewer: string;
  provider?: string | undefined;
  findings: string;
  findingCount: number;
  diffBytes: number;
  durationMs: number;
  accepted?: number | undefined;
  rejected?: number | undefined;
  createdAt: number;
}
