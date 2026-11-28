// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-21.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-37 (v3.0.0 parity): adaptive sub-agent identities — the bounded
// port of upstream Chimera.swift: six built-in identities plus custom
// presets, identity prompts that ride the delegation into the head's
// brief, and the auto-dispatch switch. Casting cards and cross-provider
// picks are out of this build's scope (see docs/parity.md P1-37).

export type ChimeraBuiltinId =
  | "scout"
  | "builder"
  | "reviewer"
  | "designer"
  | "researcher"
  | "writer";

export interface ChimeraBuiltin {
  id: ChimeraBuiltinId;
  /** English catalog key; the UI localizes it. */
  title: string;
  /** English catalog prompt; sent to heads verbatim. */
  defaultPrompt: string;
}

/** Frozen `ChimeraBuiltin.allCases` order and default prompts. */
export const CHIMERA_BUILTINS: readonly ChimeraBuiltin[] = [
  {
    id: "scout",
    title: "Scout",
    defaultPrompt:
      "You explore the codebase fast. Read only, edit nothing. Return the relevant files, entry points and a short summary.",
  },
  {
    id: "builder",
    title: "Builder",
    defaultPrompt:
      "You implement a clearly specified feature or fix. Keep the change narrow and follow the project's existing patterns.",
  },
  {
    id: "reviewer",
    title: "Reviewer",
    defaultPrompt:
      "You review changes before merge. Read only, edit nothing. List real bugs by severity with file and line.",
  },
  {
    id: "designer",
    title: "Designer",
    defaultPrompt:
      "You build and polish UI and interactions. Reuse the project's existing components and styles.",
  },
  {
    id: "researcher",
    title: "Researcher",
    defaultPrompt:
      "You research libraries and APIs from source code and official docs. Read only. Answer with sources.",
  },
  {
    id: "writer",
    title: "Writer",
    defaultPrompt:
      "You polish copy, summarize and organize reasoning. Keep it clear and concise.",
  },
];

/** Frozen `ChimeraPick` — the model/effort a role runs on; absent means
 *  Follow the lead. `provider` is kept for file compatibility but this
 *  build runs heads on its one provider only. */
export interface ChimeraPick {
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

/** Frozen `ChimeraPreset`: `name`/`specialty` override the built-in;
 *  `builtin` names the catalog identity it is based on. A preset with
 *  no builtin is fully custom. */
export interface ChimeraPreset {
  id: string;
  name?: string | undefined;
  specialty?: string | undefined;
  pick?: ChimeraPick | undefined;
  builtin?: ChimeraBuiltinId | undefined;
  enabled?: boolean | undefined;
}

/** Frozen `ChimeraPrompts.roleKey` — normalized key for remembered per-role picks. */
export function chimeraRoleKey(role: string): string {
  return role.trim().toLowerCase();
}

export function chimeraBuiltin(id: string): ChimeraBuiltin | undefined {
  return CHIMERA_BUILTINS.find((b) => b.id === id);
}

/** Frozen `effectivePrompt`. */
export function chimeraEffectivePrompt(p: ChimeraPreset): string {
  return (
    p.specialty?.trim() || chimeraBuiltin(p.builtin ?? "")?.defaultPrompt || ""
  );
}

/** Frozen `isUsable`. */
export function chimeraIsUsable(p: ChimeraPreset): boolean {
  return p.enabled !== false && chimeraEffectivePrompt(p).trim() !== "";
}

/** Frozen `briefName`. */
export function chimeraBriefName(p: ChimeraPreset): string {
  return p.name?.trim() || chimeraBuiltin(p.builtin ?? "")?.title || "";
}

/** Frozen `briefLabel` on the pick — Follow the lead reads as your own
 *  model in the identity list (upstream "your own model"). */
export function chimeraPickLabel(pick: ChimeraPick | undefined): string {
  if (!pick?.model?.trim()) return "your own model";
  return pick.provider?.trim()
    ? `${pick.model} on ${pick.provider}`
    : pick.model;
}

/** How the engine resolves an identity pick for the one provider this
 *  build runs. A saved foreign provider discards the whole pick, while
 *  an absent or matching provider lets the model/effort ride the head. */
export type ChimeraPickProviderResolution =
  | { kind: "follow" }
  | { kind: "runs"; providerId: string }
  | { kind: "unavailable"; providerId: string };

export function chimeraPickProviderResolution(
  pick: ChimeraPick | undefined,
  activeProviderId: string,
): ChimeraPickProviderResolution {
  if (!pick?.model?.trim()) return { kind: "follow" };
  if (pick.provider === undefined || pick.provider === activeProviderId) {
    return { kind: "runs", providerId: activeProviderId };
  }
  return { kind: "unavailable", providerId: pick.provider };
}

/** The list the lead and the editor see: the six built-ins whenever no
 *  stored list exists, custom rows appended after (frozen seed
 *  semantics — an absent settings field means the default roster). */
export function chimeraPresets(
  stored: ChimeraPreset[] | undefined,
): ChimeraPreset[] {
  if (stored === undefined)
    return CHIMERA_BUILTINS.map((b) => ({ id: `builtin-${b.id}`, builtin: b.id }));
  return stored;
}

/** Frozen `identityLine`: "n. Name: what it does, model". Only usable
 *  presets are numbered, matching upstream's enumerated compactMap. */
export function chimeraIdentityLines(
  stored: ChimeraPreset[] | undefined,
): string[] {
  return chimeraPresets(stored)
    .map((p) => {
      if (!chimeraIsUsable(p)) return null;
      const prompt = chimeraEffectivePrompt(p)
        .split(/\n+/)
        .join(" ")
        .trim()
        .slice(0, 240);
      return `${chimeraBriefName(p) || "Unnamed"}: ${prompt}, ${chimeraPickLabel(p.pick)}`;
    })
    .filter((l): l is string => l !== null)
    .map((l, i) => `${i + 1}. ${l}`);
}

/** The 1-based identity number a lead writes resolves only against
 *  usable presets — the same numbering the policy listed. */
export function chimeraPresetAt(
  stored: ChimeraPreset[] | undefined,
  number: number | undefined,
): ChimeraPreset | undefined {
  if (number === undefined || !Number.isInteger(number) || number < 1)
    return undefined;
  const usable = chimeraPresets(stored).filter(chimeraIsUsable);
  return usable[number - 1];
}

/** The adaptive mode's policy additions (frozen ChimeraPrompts.policy,
 *  bounded): role requirement, the identity suggestion, the dispatch
 *  note and the numbered identity list. This build keeps the ```hydra
 *  fence as the delegation contract, so the upstream ```chimera rename
 *  is not ported. */
export function chimeraAdaptivePolicy(
  stored: ChimeraPreset[] | undefined,
  autoDispatch: boolean,
): string {
  const lines = chimeraIdentityLines(stored);
  const presets =
    lines.length === 0
      ? ""
      : `\nThe user's sub-agent identities (number. name: what it does, model):\n${lines.join("\n")}`;
  const suggestions =
    ' Give every entry a short role title. When one of the user\'s identities fits that role, add "identity": <its number> and use the identity\'s name as the role title; combine different identities across roles as the job needs. Omit identity when none fits; that role runs on your own model. Never name models elsewhere.';
  const dispatch = autoDispatch
    ? "\nHeads go out at once without the user's confirmation, so pick identities carefully."
    : "\nThe user confirms or changes each role's model in a casting card before heads start.";
  return (
    'Every new entry needs a short clear job title in "role"; never include model or profile fields. A continue entry keeps the head\'s earlier model.' +
    suggestions +
    dispatch +
    presets +
    "\nThis Chimera policy replaces any Hydra delegation rules given earlier in this conversation."
  );
}
