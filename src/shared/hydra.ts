// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// F21 Hydra configuration layer — frozen `Tivano/Core/Models/Hydra.swift`,
// `HydraCookbook.swift` and `HydraCookbook+Resolve.swift` port. Pure data and
// rules only: no runtime, no provider process, no store. Scheduling, reports
// and landing (F22–F24) consume these models; nothing here claims heads can
// run.
//
// Provider identity: frozen `ProviderKind` is a closed enum; this build only
// has the bound adapter's id ("codex", "mock", "synthetic-stdio"). Pair
// provider fields stay open strings so recipes and stored pairs keep their
// frozen key space — readiness simply answers not-ready for any provider
// this build cannot run.

const newId = (): string => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------
// HydraHeadProfile — a purpose-tuned head configuration on a pair ("quick",
// "deep"): the lead routes a delegation to it by name. Undefined fields
// inherit the pair's shared worker choices.

export interface HydraHeadProfile {
  id: string;
  /** The name the lead writes in a delegation's `profile` field; free-form,
   *  the name itself carries the purpose. */
  name: string;
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

export function newHeadProfile(name: string): HydraHeadProfile {
  return { id: newId(), name };
}

/** The profile in words for the lead's brief: "deep (opus on Anthropic)". */
export function headProfileBriefLabel(
  p: HydraHeadProfile,
  providerName: (id: string) => string,
): string {
  const on = [p.model, p.provider ? providerName(p.provider) : undefined]
    .filter((s): s is string => !!s)
    .join(" on ");
  return on ? `${p.name} (${on})` : p.name;
}

/** The name as it appears in agent names ("Deep Work" → "deep-work"), so a
 *  profile named in that form still matches whatever the spacing or case. */
export function headProfileAgentSlug(p: HydraHeadProfile): string {
  return p.name
    .toLowerCase()
    .split("")
    .map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : "-"))
    .join("");
}

/** Whether a delegation's `profile` names this one: case-insensitive, and
 *  blind to the whitespace a name typed in Settings or written in a lead's
 *  JSON can carry. An agent slug matches the same way. */
export function headProfileMatches(p: HydraHeadProfile, name: string): boolean {
  const wanted = name.trim();
  return (
    p.name.trim().toLowerCase() === wanted.toLowerCase() ||
    headProfileAgentSlug(p) === wanted
  );
}

// ---------------------------------------------------------------------------
// HydraPair — which model runs the heads when a chat on this provider leads.
// orchestratorModel undefined = any model on the provider; a missing worker
// field means the heads inherit the chat's own model/effort; workerProvider
// undefined keeps the heads on the lead's provider.

export interface HydraPair {
  id: string;
  provider: string;
  orchestratorModel?: string | undefined;
  orchestratorEffort?: string | undefined;
  workerProvider?: string | undefined;
  workerModel?: string | undefined;
  workerEffort?: string | undefined;
  /** How many heads may work at once; undefined puts no cap on them. */
  maxHeads?: number | undefined;
  /** The user's name for the pair; undefined or blank is none. */
  name?: string | undefined;
  /** The pair's purpose-tuned heads (its advanced mode). */
  headProfiles: HydraHeadProfile[];
}

export const HYDRA_MAX_HEADS_RANGE = { lower: 1, upper: 8 } as const;

export function newHydraPair(provider: string): HydraPair {
  return { id: newId(), provider, headProfiles: [] };
}

/** A cap kept inside the range, or none. */
export function clampedHydraCap(cap: number | undefined): number | undefined {
  if (cap === undefined) return undefined;
  return Math.min(
    Math.max(Math.trunc(cap), HYDRA_MAX_HEADS_RANGE.lower),
    HYDRA_MAX_HEADS_RANGE.upper,
  );
}

/** The provider the heads run on: the lead's, unless the pair sends them
 *  elsewhere. */
export function pairHeadsProvider(pair: HydraPair): string {
  return pair.workerProvider ?? pair.provider;
}

/** Whether the heads run on another provider than the lead. */
export function pairSendsHeadsElsewhere(pair: HydraPair): boolean {
  return pair.workerProvider !== undefined && pair.workerProvider !== pair.provider;
}

/** The user's name for the pair, trimmed, or undefined when there is none. */
export function pairCustomName(pair: HydraPair): string | undefined {
  const trimmed = (pair.name ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The pair a project's new chats start on — only when Hydra is on, the
 *  project names a pair, and that pair is in `available`. */
export function projectHydraPair(
  id: string | undefined,
  hydraOn: boolean,
  available: HydraPair[],
): HydraPair | undefined {
  if (!hydraOn || !id) return undefined;
  return available.find((p) => p.id === id);
}

/** The pair a chat leads with — frozen AppModel.hydraPair(for:): the one
 *  picked for the chat, for as long as the chat stays on that pair's
 *  provider. A pair stored against another provider applies to nothing
 *  here (every thread runs on this build's one provider). */
export function hydraPairForLead(
  pairId: string | undefined,
  pairs: HydraPair[],
  providerId: string,
): HydraPair | undefined {
  if (!pairId) return undefined;
  return pairs.find((p) => p.id === pairId && p.provider === providerId);
}

/**
 * What the lead's heads launch with in THIS build — the slice of
 * `hydraLaunch(for:)` a single-provider engine can honour. Heads always
 * run on the lead's own provider here: a pair that names a different
 * heads-provider falls back to it with `headsFallbackNote` (frozen
 * AppModel.hydraHeadsProvider + hydraHeadsFallbackNote), and its foreign
 * worker model/effort mean nothing — the heads inherit the chat's own.
 */
export interface ResolvedHydraLaunch {
  /** The lower of the pair's cap and the Hydra page's; undefined = the
   *  uncapped bound the engine applies itself. */
  maxHeads?: number | undefined;
  /** Heads' model/effort on the lead's provider; dropped when the pair
   *  sends heads elsewhere, which this build cannot run (frozen
   *  keepsModel). */
  workerModel?: string | undefined;
  workerEffort?: string | undefined;
  headProfiles: HydraHeadProfile[];
  /** One line for the lead's timeline when the pair's heads would run
   *  on a provider this build cannot (frozen hydraHeadsFallbackNote). */
  headsFallbackNote?: string | undefined;
  /** Frozen settings.hydraIsolateHeads — heads work in copies of their
   *  own when the checkout can be copied (a git repo with commits). */
  isolatesHeads: boolean;
}

export function resolveHydraLaunch(
  pair: HydraPair | undefined,
  pageCap: number | undefined,
  providerId: string,
  providerLabel: (id: string) => string,
  isolatesHeads = false,
): ResolvedHydraLaunch {
  const caps = [
    pair ? clampedHydraCap(pair.maxHeads) : undefined,
    clampedHydraCap(pageCap),
  ].filter((x): x is number => x !== undefined);
  // The heads' provider as far as this build can run it: only the bound
  // provider exists, so a pair that sends heads elsewhere falls back to
  // the lead's — exactly the frozen not-installed/switched-off path.
  const foreign =
    pair !== undefined &&
    pairSendsHeadsElsewhere(pair) &&
    pairHeadsProvider(pair) !== providerId;
  const keepsModel = !foreign;
  return {
    ...(caps.length ? { maxHeads: Math.min(...caps) } : {}),
    workerModel: keepsModel ? pair?.workerModel : undefined,
    workerEffort: keepsModel ? pair?.workerEffort : undefined,
    headProfiles: pair?.headProfiles ?? [],
    ...(foreign && pair
      ? {
          headsFallbackNote: `The pair's heads run on ${providerLabel(pair.provider)} for now: ${providerLabel(pairHeadsProvider(pair))} is not available in this build.`,
        }
      : {}),
    isolatesHeads,
  };
}

// ---------------------------------------------------------------------------
// HydraLaunch — what a session launches with while Hydra is on: where the
// heads run and on what, resolved from the pair, and how many may run at once.

export interface HydraLaunch {
  headsProvider: string;
  /** The heads' model+provider in words for the lead's brief, when they run
   *  on another provider than the lead. */
  headsLabel?: string | undefined;
  workerModel?: string | undefined;
  workerEffort?: string | undefined;
  /** The lower of the pair's and the Hydra page's caps; undefined = uncapped
   *  (bounded by uncappedConcurrency below). */
  maxHeads?: number | undefined;
  headProfiles: HydraHeadProfile[];
  /** Whether Tivano-run heads get copies of the checkout of their own. */
  isolatesHeads: boolean;
  autoMerges: boolean;
  reviewsHeads: boolean;
  projects: HydraProjectRef[];
}

/** How many Tivano-run heads may work at once for a pair with no cap of its
 *  own (frozen: 21 at once kept the main thread and GPU busy past answering;
 *  the app had to be force quit). */
export const HYDRA_UNCAPPED_CONCURRENCY = 8;

export function hydraHasRoom(launch: HydraLaunch, running: number): boolean {
  return running < (launch.maxHeads ?? HYDRA_UNCAPPED_CONCURRENCY);
}

/** The profile a delegation asked for; undefined when the name matches none —
 *  the head then runs on the worker fields like any unrouted one. */
export function hydraProfileNamed(
  launch: HydraLaunch,
  name: string,
): HydraHeadProfile | undefined {
  return launch.headProfiles.find((p) => headProfileMatches(p, name));
}

// ---------------------------------------------------------------------------
// HydraBudget — how much a Tivano-run head gets for one turn (verbatim).

export const HYDRA_BUDGET = {
  /** Tools without a change before the head is asked to act. */
  pacingTools: 24,
  wrapUpTools: 120,
  maxTools: 160,
  wrapUpSeconds: 25 * 60,
  maxSeconds: 35 * 60,
  /** What a stopped head gets to write its report in. */
  reportSeconds: 3 * 60,
  pacingNote:
    "[Tivano] You have run 24 tools without changing a file. If the task is research, reply with your findings now. Otherwise act on what you know: make the change, or reply with what blocks you.",
  wrapUpNote:
    "[Tivano] Your budget is nearly spent. Finish now: complete the smallest correct version of the task, then reply with your report.",
  finalNote:
    "[Tivano] Your budget is spent and your tools are gone. Reply now with your report: what you changed, how far it got, and what is left.",
} as const;

// ---------------------------------------------------------------------------
// HydraPersona + HydraRoster — a head's identity: name, colour, glyph asset.
// The Mac glyph images are not ported (per-asset qualification pending); the
// asset id is kept as data so roster order/names stay frozen-faithful.

export interface HydraPersona {
  name: string;
  /** Frozen asset id (e.g. "hydra-head-01") — data only, no image shipped. */
  asset: string;
  /** The colour as 0xRRGGBB. */
  hex: number;
}

function persona(name: string, asset: string, hex: number): HydraPersona {
  return { name, asset, hex };
}

export const HYDRA_PERSONAS: readonly HydraPersona[] = [
  persona("Hank", "hydra-head-01", 0xff8a3d),
  persona("Walter", "hydra-head-02", 0x3d8bff),
  persona("Ada", "hydra-head-03", 0x34c46a),
  persona("Otto", "hydra-head-04", 0xa35be0),
  persona("Nova", "hydra-head-05", 0xf25c9a),
  persona("Remy", "hydra-head-06", 0x2bb5b0),
  persona("Iris", "hydra-head-07", 0xe8b430),
  persona("Milo", "hydra-head-08", 0xe84f4f),
  persona("Juno", "hydra-head-09", 0x6a5cff),
  persona("Ezra", "hydra-head-10", 0x4fd1a1),
  persona("Lena", "hydra-head-11", 0x2fb8e6),
  persona("Bo", "hydra-head-12", 0xb0784a),
  persona("Kai", "hydra-head-13", 0x8fd14f),
  persona("Vera", "hydra-head-14", 0xd946ef),
  persona("Finn", "hydra-head-15", 0xf97316),
  persona("Mira", "hydra-head-16", 0xc084fc),
  persona("Odin", "hydra-head-17", 0xb45309),
  persona("Suki", "hydra-head-18", 0xf472b6),
  persona("Rex", "hydra-head-19", 0x2563eb),
  persona("Zola", "hydra-head-20", 0x65a30d),
  persona("Pip", "hydra-head-21", 0x94a3b8),
  persona("Ivo", "hydra-head-22", 0x0d9488),
  persona("Lux", "hydra-head-23", 0xfacc15),
  persona("Tova", "hydra-head-24", 0x059669),
  persona("Gus", "hydra-head-25", 0x7dd3fc),
];

/** Past the roster the names start over with a number after the name. */
export function hydraPersonaAt(index: number): HydraPersona {
  const count = HYDRA_PERSONAS.length;
  const base = HYDRA_PERSONAS[((index % count) + count) % count]!;
  const round = Math.floor(Math.max(0, index) / count);
  if (round === 0) return base;
  return { name: `${base.name} ${round + 1}`, asset: base.asset, hex: base.hex };
}

/** The roster index for an announced head name, case-insensitive, without any
 *  round suffix ("otto", "Otto 2"). Undefined when the name is not on the
 *  roster — only exact roster names are authoritative; anything else falls
 *  back to the next sequential head. */
export function hydraIndexNamed(name: string): number | undefined {
  let bare = name.trim();
  const space = bare.lastIndexOf(" ");
  if (space >= 0 && /^\d+$/.test(bare.slice(space + 1))) {
    bare = bare.slice(0, space).trim();
  }
  const idx = HYDRA_PERSONAS.findIndex(
    (p) => p.name.toLowerCase() === bare.toLowerCase(),
  );
  return idx < 0 ? undefined : idx;
}

/** The roster persona for an announced head name, its round kept: "Nova 3" is
 *  the third Nova, "otto" the first Otto. Undefined off the roster. */
export function hydraPersonaNamed(name: string): HydraPersona | undefined {
  const index = hydraIndexNamed(name);
  if (index === undefined) return undefined;
  const bare = name.trim();
  const space = bare.lastIndexOf(" ");
  if (space >= 0) {
    const round = parseInt(bare.slice(space + 1), 10);
    if (Number.isFinite(round) && round > 1) {
      return hydraPersonaAt(index + (round - 1) * HYDRA_PERSONAS.length);
    }
  }
  return hydraPersonaAt(index);
}

// ---------------------------------------------------------------------------
// HydraHeadInfo — a head thread's place in its lead's team. Persisted on the
// head thread (F22 writes these; the record shape is defined now so storage
// and UI agree on it). Unreadable status decodes as stopped, never completed.

export type HydraHeadKind = "native" | "tivano";
export type HydraHeadOrigin = "delegated" | "queued" | "sent";
export type HydraHeadStatus = "running" | "completed" | "failed" | "stopped";

export interface HydraLandingFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Where a Tivano-run head's work went when it reported: into the lead's
 *  checkout, into it with conflicts left to settle, or into a patch file when
 *  it would not apply. */
export interface HydraLanding {
  files: HydraLandingFile[];
  conflicts: string[];
  /** Build-output diff sections left out before the patch was parsed. */
  droppedBuildOutputFiles: number;
  patchPath?: string;
  error?: string;
}

export function hydraLandingIsEmpty(l: HydraLanding): boolean {
  return l.files.length === 0 && l.patchPath === undefined && l.error === undefined;
}

export function hydraLandingLanded(l: HydraLanding): boolean {
  return l.files.length > 0 && l.patchPath === undefined && l.error === undefined;
}

export interface HydraHeadInfo {
  index: number;
  task: string;
  kind: HydraHeadKind;
  origin: HydraHeadOrigin;
  status: HydraHeadStatus;
  summary?: string;
  /** The provider's one-line progress note, or the last tool the head used. */
  activity?: string;
  toolCalls: number;
  tokens: number;
  startedAt: number;
  finishedAt?: number;
  /** When the task entered the wait-for-a-slot queue (queued work only). */
  queuedAt?: number;
  /** When the brief was handed to the head's session — queue wait time is
   *  not counted as work. */
  executionStartedAt?: number;
  executionFinishedAt?: number;
  landingStartedAt?: number;
  landingFinishedAt?: number;
  /** The provider's id for a native head. */
  nativeID?: string;
  /** The provider's task id — what stops a running native head. */
  nativeTaskID?: string;
  /** The tool row in the lead's timeline that stands for this head. */
  toolUseID?: string;
  /** The delegation a Tivano-run head belongs to: its report waits for the
   *  others. */
  batchID?: string;
  /** The head profile the delegation routed this head to. */
  profile?: string;
  /** Whether Tivano can stop this head where it runs. */
  canStop: boolean;
  isBackground: boolean;
  /** The tree the head's own copy started from; moves on with every landing. */
  baseTree?: string;
  targetCheckout?: string;
  pendingProjectReference?: string;
  landing?: HydraLanding;
  /** When the auto-merge took this head's work out. */
  mergedAt?: number;
  /** Explicit provenance — persona names or prompt text never establish
   *  ownership. */
  tracksProviderHistory: boolean;
  ownedCodexSessionID?: string;
  ownedCodexWorkingDirectory?: string;
  codexHistoryArchived: boolean;
  providerHistoryIssue?: string;
}

export function hydraHeadDisplayName(head: HydraHeadInfo): string {
  return hydraPersonaAt(head.index).name;
}

export function hydraHeadIsFinished(head: HydraHeadInfo): boolean {
  return head.status !== "running";
}

// ---------------------------------------------------------------------------
// Supporting records — HydraProjectRef, HydraReport, HydraDelegation,
// HydraMergeStage (verbatim).

export interface HydraProjectRef {
  name: string;
  path: string;
}

/** What a head sends back to its lead. */
export interface HydraReport {
  headIndex: number;
  task: string;
  origin: HydraHeadOrigin;
  status: HydraHeadStatus;
  text: string;
  landing?: HydraLanding;
  /** The head's own copy of the checkout, for work that did not land. */
  checkoutPath?: string;
}

/** A head the lead asked for through the delegation block. `name` is the
 *  head's announced name when the lead gave one — authoritative, so the
 *  spawned head carries exactly that roster name. */
export interface HydraDelegation {
  task: string;
  prompt: string;
  name?: string;
  /** The project the head works in when the lead named one (a sidebar
   *  project's name or an absolute path). */
  project?: string;
  /** The head profile the lead routed the task to. */
  profile?: string;
}

export const HYDRA_MERGE_STAGES = [
  "gathering",
  "committing",
  "describing",
  "pushing",
  "opening",
  "merging",
  "syncing",
] as const;
export type HydraMergeStage = (typeof HYDRA_MERGE_STAGES)[number];

/** The stage in words, as the pill and the sidebar show it. */
export function hydraMergeStageWords(stage: HydraMergeStage): string {
  switch (stage) {
    case "gathering": return "Gathering the team's files";
    case "committing": return "Writing the commit";
    case "describing": return "Writing the commit message";
    case "pushing": return "Pushing the branch";
    case "opening": return "Opening the merge request";
    case "merging": return "Merging";
    case "syncing": return "Bringing the checkout up to date";
  }
}

// ---------------------------------------------------------------------------
// HydraPairRecipe + cookbook resolve (frozen HydraCookbook +
// HydraCookbook+Resolve). A recipe names models, not providers: each side
// lists the providers that serve its model, best first; the first ready one
// whose catalog lists the model is the one the pair runs on.

export interface HydraRecipeSide {
  providers: string[];
  models: string[];
  effort?: string | undefined;
}

export interface HydraPairRecipe {
  id: string;
  title: string;
  tagline: string;
  lead: HydraRecipeSide;
  heads: HydraRecipeSide;
  maxHeads?: number | undefined;
}

/** The catalog view the resolver needs — supplied by the engine, which owns
 *  the real provider adapter. Everything it cannot answer honestly is
 *  not-ready/empty, which simply makes a recipe not offered. */
export interface HydraCatalog {
  /** Whether the provider is set up and switched on here. */
  isReady(provider: string): boolean;
  /** The provider's catalog models, exactly as reported (empty = none known). */
  models(provider: string): { id: string; name: string; efforts: string[] }[];
  /** The provider's own default model id, when it reports one. */
  defaultModel(provider: string): string | undefined;
  /** The provider's display name for briefs. */
  displayName(provider: string): string;
}

/** The frozen recipe table verbatim — provider keys kept so future provider
 *  adapters resolve the same rows without re-editing the cookbook. */
export const HYDRA_RECIPES: readonly HydraPairRecipe[] = [
  {
    id: "claude-fable-opus",
    title: "Fable 5.1 leads Opus 5.5",
    tagline:
      "The deepest lead over the strongest builders: Fable plans and checks, Opus heads build. Set the thinking effort of each side yourself.",
    lead: { providers: ["claude", "commandcode"], models: ["Fable"] },
    heads: { providers: ["claude", "commandcode"], models: ["Opus"] },
  },
  {
    id: "claude-opus-gemini-flash",
    title: "Opus 5.5 leads Gemini 3.8 Flash",
    tagline:
      "A careful lead and a wide, fast team: Opus writes the briefs, six Gemini Flash heads sprint through them.",
    lead: { providers: ["claude", "commandcode"], models: ["Opus"], effort: "high" },
    heads: {
      providers: ["antigravity", "commandcode"],
      models: ["Gemini 3.8 Flash", "Gemini", "Flash"],
      effort: "medium",
    },
    maxHeads: 6,
  },
  {
    id: "claude-opus-deepseek",
    title: "Opus 5.5 leads DeepSeek V4.1",
    tagline:
      "Opus keeps the plan tight; DeepSeek V4.1 Flash heads keep the bill small on the routine parts.",
    lead: { providers: ["claude", "commandcode"], models: ["Opus"], effort: "high" },
    heads: {
      providers: ["deepseek", "commandcode"],
      models: ["V4.1 Flash", "V4.1", "DeepSeek"],
      effort: "high",
    },
  },
  {
    id: "claude-opus-glm",
    title: "Opus 5.5 leads GLM-5.3 Flash",
    tagline:
      "Opus keeps the plan tight; GLM-5.3 Flash heads on a Z.ai Coding Plan keep the bill flat.",
    lead: { providers: ["claude", "commandcode"], models: ["Opus"], effort: "high" },
    heads: {
      providers: ["zai", "commandcode"],
      models: ["5.3 Flash", "GLM"],
      effort: "high",
    },
  },
  {
    id: "claude-fable-composer",
    title: "Fable 5.1 leads Composer 2.5",
    tagline: "Fable thinks; Cursor's Composer heads type at the speed Composer is known for.",
    lead: { providers: ["claude", "commandcode"], models: ["Fable"], effort: "high" },
    heads: { providers: ["cursor"], models: ["Composer"] },
  },
  {
    id: "astra-spark",
    title: "Astra 6 leads Spark 1.3 Contributor",
    tagline:
      "GPT-6 Astra orchestrates at high; Muse Spark Contributor heads build at medium.",
    lead: { providers: ["codex", "commandcode"], models: ["Astra"], effort: "high" },
    heads: { providers: ["meta", "commandcode"], models: ["Contributor"], effort: "medium" },
  },
  {
    id: "astra-terra",
    title: "Astra 6 leads Terra 5.6",
    tagline:
      "OpenAI top to bottom: Astra plans and reviews, Terra does the work at medium.",
    lead: { providers: ["codex", "commandcode"], models: ["Astra"], effort: "high" },
    heads: { providers: ["codex", "commandcode"], models: ["Terra"], effort: "medium" },
  },
  {
    id: "astra-sol",
    title: "Astra 6 leads Sol 5.6",
    tagline: "Astra plans and reviews; Sol heads take the complex building at medium.",
    lead: { providers: ["codex", "commandcode"], models: ["Astra"], effort: "high" },
    heads: { providers: ["codex", "commandcode"], models: ["Sol"], effort: "medium" },
  },
  {
    id: "sol-luna",
    title: "Sol 5.6 leads Luna 5.6",
    tagline: "Sol keeps the plan; quick Luna heads get through the routine parts.",
    lead: { providers: ["codex", "commandcode"], models: ["Sol"], effort: "high" },
    heads: { providers: ["codex", "commandcode"], models: ["Luna"], effort: "medium" },
  },
  {
    id: "astra-astra",
    title: "Astra 6 high, Astra 6 medium",
    tagline:
      "One model, two efforts: Astra thinks hard about the plan and the review, and Astra heads build at a working effort.",
    lead: { providers: ["codex", "commandcode"], models: ["Astra"], effort: "high" },
    heads: { providers: ["codex", "commandcode"], models: ["Astra"], effort: "medium" },
  },
  {
    id: "claude-opus-opus",
    title: "Opus 5.5 max, Opus 5.5 medium",
    tagline:
      "Opus thinks as hard as it can where it counts; Opus heads at medium do the building.",
    lead: { providers: ["claude", "commandcode"], models: ["Opus"], effort: "max" },
    heads: { providers: ["claude", "commandcode"], models: ["Opus"], effort: "medium" },
  },
  {
    id: "claude-fable-fable",
    title: "Fable 5.1 high, Fable 5.1 medium",
    tagline:
      "For the hardest, longest jobs: every seat on the most capable model, the lead at high and the heads at medium.",
    lead: { providers: ["claude", "commandcode"], models: ["Fable"], effort: "high" },
    heads: { providers: ["claude", "commandcode"], models: ["Fable"], effort: "medium" },
  },
];

/** The effort asked for when the model offers it; undefined otherwise, which
 *  keeps the default. */
export function recipeEffort(
  wanted: string | undefined,
  forOption: { efforts: string[] } | undefined,
): string | undefined {
  if (!wanted || !forOption || !forOption.efforts.includes(wanted)) return undefined;
  return wanted;
}

/** Whether a pair like this one is already set up: same providers and models. */
export function isPairAdded(pair: HydraPair, pairs: HydraPair[]): boolean {
  return pairs.some(
    (p) =>
      p.provider === pair.provider &&
      pairHeadsProvider(p) === pairHeadsProvider(pair) &&
      p.orchestratorModel === pair.orchestratorModel &&
      p.workerModel === pair.workerModel,
  );
}

/** The provider a side runs on here: the first of its providers that is ready
 *  and lists the model, or undefined while none does. */
export function recipeSideProvider(
  side: HydraRecipeSide,
  catalog: HydraCatalog,
): string | undefined {
  return side.providers.find(
    (p) =>
      catalog.isReady(p) &&
      (side.models.length === 0 || recipeModel(side.models, p, catalog) !== undefined),
  );
}

/** The provider a recipe still needs: the first side's first choice that is
 *  not ready, as the one to set up. */
export function recipeMissingProvider(
  recipe: HydraPairRecipe,
  catalog: HydraCatalog,
): string | undefined {
  for (const side of [recipe.lead, recipe.heads]) {
    if (!side.providers.some((p) => catalog.isReady(p))) {
      return side.providers[0];
    }
  }
  return undefined;
}

/** The pair a recipe makes here, or undefined while a side has no ready
 *  provider that lists its model. */
export function resolveRecipe(
  recipe: HydraPairRecipe,
  catalog: HydraCatalog,
): HydraPair | undefined {
  const leadProvider = recipeSideProvider(recipe.lead, catalog);
  const headsProvider = recipeSideProvider(recipe.heads, catalog);
  if (!leadProvider || !headsProvider) return undefined;
  const pair = newHydraPair(leadProvider);
  const lead = recipeModel(recipe.lead.models, leadProvider, catalog);
  pair.orchestratorModel = lead?.id;
  pair.orchestratorEffort = recipeEffort(
    recipe.lead.effort,
    lead ?? catalogModel(catalog, leadProvider, catalog.defaultModel(leadProvider)),
  );
  if (headsProvider !== leadProvider) pair.workerProvider = headsProvider;
  const heads = recipeModel(recipe.heads.models, headsProvider, catalog);
  pair.workerModel = heads?.id;
  pair.workerEffort = recipeEffort(
    recipe.heads.effort,
    heads ?? catalogModel(catalog, headsProvider, catalog.defaultModel(headsProvider)),
  );
  pair.maxHeads = recipe.maxHeads;
  return pair;
}

function catalogModel(
  catalog: HydraCatalog,
  provider: string,
  id: string | undefined,
): { id: string; name: string; efforts: string[] } | undefined {
  if (!id) return undefined;
  return catalog.models(provider).find((m) => m.id === id);
}

/** A fragment names a family; the newest member the catalog lists wins, so a
 *  new release moves a recipe up on its own. */
export function recipeModel(
  names: string[],
  provider: string,
  catalog: HydraCatalog,
): { id: string; name: string; efforts: string[] } | undefined {
  const options = catalog.models(provider);
  for (const name of names) {
    const needle = name.toLowerCase();
    const matches = options.filter(
      (o) =>
        o.name.toLowerCase().includes(needle) ||
        o.id.toLowerCase().includes(needle),
    );
    if (matches.length === 0) continue;
    return matches.reduce((best, cur) => {
      const bv = modelVersion(best.name) ?? -1;
      const cv = modelVersion(cur.name) ?? -1;
      if (bv !== cv) return cv > bv ? cur : best;
      return options.indexOf(cur) > options.indexOf(best) ? cur : best;
    });
  }
  return undefined;
}

/** The first version number in a catalog name ('Gemini 3.8 Flash' → 3.8). */
function modelVersion(name: string): number | undefined {
  const m = /[0-9]+(?:\.[0-9]+)?/.exec(name);
  return m ? parseFloat(m[0]) : undefined;
}

// ---------------------------------------------------------------------------
// A76: frozen HydraCookbookPanel support — provider display names
// (ProviderKind.displayName verbatim) and the row effort phrase
// (HydraPairSummary.efforts). Waiting recipes name a provider that is not in
// this build's catalog, so the names live here rather than behind the
// provider-owned catalog view.

/** Frozen ProviderKind.displayName — every kind the recipes reference. */
export const HYDRA_PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
  deepseek: "DeepSeek",
  meta: "Meta",
  zai: "Z.ai",
  devin: "Devin",
  antigravity: "Antigravity",
  copilot: "Copilot",
  commandcode: "Command Code",
  pi: "Pi",
  omp: "omp",
  kimi: "Kimi Code",
  dsh: "DeepSeek Harness",
  minimaxCode: "MiniMax Code",
};

export function hydraProviderName(id: string): string {
  return HYDRA_PROVIDER_NAMES[id] ?? id;
}

/** Frozen HydraPairSummary.efforts — "High effort" when both sides share one,
 *  "Lead high, heads medium effort" when they differ, one side alone when only
 *  it is set, and nothing when neither is. Pass the effort title through `t`. */
export function pairEffortsPhrase(
  pair: HydraPair,
  effortTitle: (effort: string) => string,
): { kind: "same" | "split" | "lead" | "heads" | "none"; lead?: string; heads?: string } {
  const lead = pair.orchestratorEffort?.toLowerCase();
  const heads = pair.workerEffort?.toLowerCase();
  if (lead !== undefined && heads !== undefined) {
    return lead === heads
      ? { kind: "same", lead: effortTitle(lead) }
      : { kind: "split", lead: effortTitle(lead), heads: effortTitle(heads) };
  }
  if (lead !== undefined) return { kind: "lead", lead: effortTitle(lead) };
  if (heads !== undefined) return { kind: "heads", heads: effortTitle(heads) };
  return { kind: "none" };
}
