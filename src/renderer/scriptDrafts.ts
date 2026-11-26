// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-33 (frozen row identity): a script row's React key is its own —
// removing or reordering a sibling mid-edit must not remount this row.
// New rows get keys from a monotonically increasing local counter so an
// insert's key can never collide with a saved row's id or another new
// row's key after removals.

import type { ProjectScript } from "../shared/types";

export interface ScriptDraft {
  /** Stable row identity while editing. */
  key: string;
  id?: string;
  name: string;
  command: string;
  icon: string;
  runOnWorktreeCreate: boolean;
}

export const toScriptDraft = (s: ProjectScript): ScriptDraft => ({
  key: s.id,
  id: s.id,
  name: s.name,
  command: s.command,
  icon: s.icon,
  runOnWorktreeCreate: s.runOnWorktreeCreate === true,
});

/** One counter per dialog mount — `new-N` keys are unique for the
 *  session and never reuse a removed row's number. */
export function makeScriptDraftKeyGen(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

export function createScriptDraft(
  keyGen: () => string,
  name: string,
): ScriptDraft {
  return {
    key: keyGen(),
    name,
    command: "",
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

export function patchScriptDraft(
  drafts: readonly ScriptDraft[],
  key: string,
  patch: Partial<ScriptDraft>,
): ScriptDraft[] {
  return drafts.map((d) => (d.key === key ? { ...d, ...patch } : d));
}

export function removeScriptDraft(
  drafts: readonly ScriptDraft[],
  key: string,
): ScriptDraft[] {
  return drafts.filter((d) => d.key !== key);
}

export function serializeScriptDrafts(drafts: readonly ScriptDraft[]) {
  return drafts.map((d) => ({
    ...(d.id ? { id: d.id } : {}),
    name: d.name,
    command: d.command,
    icon: d.icon || "play",
    runOnWorktreeCreate: d.runOnWorktreeCreate,
  }));
}
