// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17: frozen AppSettings modelList / modelSections / collapsedModelSections /
// modelPreferences ported as pure functions over persisted Settings slices.
// The catalog stays provider-owned (models:list) — pins only ORGANIZE the
// picker; a pin whose model never appeared in a catalog still shows by id.

import {
  pairCustomName,
  pairHeadsProvider,
  pairSendsHeadsElsewhere,
  type HydraPair,
} from "./hydra";

/** Frozen ProviderKind — this build ships one provider adapter. The field
 *  rides along so stored pins keep the frozen identity shape. */
export type ModelPinProvider = "codex";

/** Frozen ModelPin — `id` is "provider/modelID". */
export interface ModelPin {
  provider: ModelPinProvider;
  modelID: string;
}

/** Frozen ModelSection — a heading that sits before the pin at `position`
 *  (or after the last pin when position == list length) and holds the pins
 *  down to the next heading. */
export interface ModelSection {
  id: string;
  name: string;
  position: number;
}

/** Frozen ModelListItem — a row of the picker's list as Settings arranges it. */
export type ModelListItem = { kind: "pin"; pin: ModelPin } | { kind: "section"; section: ModelSection };

/** Frozen ModelPreference — how a model starts in new chats. */
export interface ModelPreference {
  effort?: string | undefined;
  fastMode?: boolean | undefined;
}

/** Frozen AppSettings.modelListLimit. */
export const MODEL_LIST_LIMIT = 30;

// ── P1-25: frozen ModelFamilies visibility trim (ModelVisibility.swift) ──
// "Hide outdated models" (frozen hidesOutdatedModels, default ON) keeps a
// picker's list short: each vendor shows its three newest versions, and an
// effort/Fast spelling listed as a row of its own folds behind the row that
// names its base. Chosen, pinned, Hydra and in-use models always show;
// versionless rows always stay. Bounded port: no Fusion fold (this build
// ships no Devin provider) and no collapsed() merge — the catalog already
// carries efforts on one row (CodexModelOption.efforts).
//
// The version ordering rule: a row's version is the FIRST dotted number
// run in its name ("Claude Opus 5.5" → [5,5], "claude-opus-4-8" → [4,8]);
// a trailing size token ("256K", "1.5m", "120B") never counts. Versions
// compare per VENDOR (a line key's first word — "opus"/"sonnet"/"haiku"/
// "fable" stand for claude, "codex" for gpt), so "GPT-5.4 Mini" hides
// when the catalogue holds three newer GPT versions even though its own
// line is newest. A line the vendor rule would empty still keeps its
// newest row while that row's major is the vendor's newest major (a
// current small model is not outdated for lagging the flagship).

/** The row shape the trim needs — CodexModelOption satisfies it. */
export interface ModelRowLike {
  id: string;
  name: string;
  isDefault?: boolean | undefined;
}

interface ParsedName {
  base: string;
  effort: string | undefined;
  isFast: boolean;
}

const EFFORT_WORDS: Record<string, string> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  max: "max",
};

/** Frozen parse(): the variant words a provider appends, read from the end.
 *  No "Fusion (LEAD + SIDEKICK)" branch — this build has no Devin catalog. */
export function parseVariantName(name: string): ParsedName {
  const words = name.split(" ").filter((w) => w !== "");
  let isFast = false;
  let effort: string | undefined;
  if (words.length > 1 && words[words.length - 1]!.toLowerCase() === "fast") {
    isFast = true;
    words.pop();
  }
  const pair = words.length - (words[words.length - 1]?.toLowerCase() === "thinking" ? 3 : 2);
  if (pair > 0 && words[pair]!.toLowerCase() === "extra" && words[pair + 1]!.toLowerCase() === "high") {
    words[pair] = "xhigh";
    words.splice(pair + 1, 1);
  }
  if (words.length > 2 && words[words.length - 1]!.toLowerCase() === "thinking") {
    const before = words[words.length - 2]!.toLowerCase();
    const level = before === "no" ? "none" : EFFORT_WORDS[before];
    if (level !== undefined) {
      effort = level;
      words.splice(words.length - 2, 2);
    }
  } else if (words.length > 1) {
    const level = EFFORT_WORDS[words[words.length - 1]!.toLowerCase()];
    if (level !== undefined) {
      effort = level;
      words.pop();
    }
  }
  return { base: words.join(" "), effort, isFast };
}

const TRIAL_WORDS = new Set(["free", "preview", "exp", "experimental"]);
const CHANNEL_WORDS = new Set([
  "free", "preview", "exp", "experimental", "new", "beta",
  "highspeed", "contributor", "thinking",
]);

/** Frozen bareName: lowercased, minus the catalogue prefix and
 *  parentheticals. */
function bareName(name: string): string {
  let text = name.toLowerCase();
  const slash = text.lastIndexOf("/");
  if (slash >= 0) text = text.slice(slash + 1);
  let result = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") {
      depth += 1;
      result += " ";
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) result += ch;
  }
  return result;
}

const splitWords = (text: string): string[] => text.split(/[ \-_]+/).filter((w) => w !== "");

/** A context window written into a name: "1M", "256k". */
function isContextSize(word: string): boolean {
  const last = word[word.length - 1];
  if ((last !== "m" && last !== "k") || word.length <= 1) return false;
  return /^[0-9.]+$/.test(word.slice(0, -1)) && /[0-9]/.test(word[0]!);
}

/** Digits with an optional dot, then k/m/b: a size in a name, not a
 *  version ("256k", "1.5m", "120b"); also the dash-joined tail of a
 *  word ("k3-256k"). */
function isSizeWord(word: string): boolean {
  const last = word[word.length - 1];
  if (last === undefined || !"kmb".includes(last) || word.length <= 1) return false;
  return /^[0-9.]+$/.test(word.slice(0, -1)) && /[0-9]/.test(word[0]!);
}

/** Frozen lineageKey(): the line a name belongs to — catalogue prefix,
 *  variant words, versions, context sizes, parentheticals and channel
 *  words removed. "Claude Opus 4.8" and "Claude Opus 4.6 Thinking 1M"
 *  are both "claude opus"; "Kimi K2.7" and "Kimi K3" are "kimi";
 *  "GLM-5.3 Flash" stays apart as "glm flash". */
export function modelLineageKey(name: string): string {
  const spaced = bareName(name)
    .split(" ")
    .filter((w) => w !== "")
    .map((word) => {
      // A size at the end of a dashed word is not part of the line:
      // "k3-256k" keys like "k3".
      let w = word;
      for (;;) {
        const cut = Math.max(w.lastIndexOf("-"), w.lastIndexOf("_"));
        if (cut >= 0 && isSizeWord(w.slice(cut + 1))) w = w.slice(0, cut);
        else break;
      }
      return w;
    })
    .filter((w) => !isContextSize(w))
    .join(" ");
  const base = parseVariantName(spaced).base;
  const kept = splitWords(base)
    .map((word) => {
      if (/^[0-9]/.test(word)) return null;
      const stem = word.match(/^[^0-9]*/)?.[0] ?? word;
      // "k3", "m2.7" and "v4.1" are versions; "qwen3.8" is qwen.
      if (stem.length < word.length && ["k", "m", "v"].includes(stem)) return null;
      return CHANNEL_WORDS.has(stem) ? null : stem;
    })
    .filter((w): w is string => w !== null);
  const key = kept.join(" ");
  return key === "" ? (base === "" ? name.toLowerCase() : base) : key;
}

/** Frozen isTrial — free, preview and experimental rows are channels,
 *  not versions of a line. */
export function isTrialModel(name: string): boolean {
  return splitWords(bareName(name)).some((w) => TRIAL_WORDS.has(w));
}

/** The index after a size token starting at `at` in `text`, or -1 when the
 *  digits there are not a size ("120b", "1.5m" right before a word end). */
function sizeEndAt(text: string, at: number): number {
  let cursor = at;
  let dot = false;
  while (cursor < text.length) {
    const ch = text[cursor]!;
    if (/[0-9]/.test(ch)) cursor++;
    else if (ch === "." && !dot && cursor + 1 < text.length && /[0-9]/.test(text[cursor + 1]!)) {
      dot = true;
      cursor++;
    } else break;
  }
  if (cursor <= at || cursor >= text.length || !"kmb".includes(text[cursor]!)) return -1;
  const end = cursor + 1;
  if (end !== text.length && !" -_()[]".includes(text[end]!)) return -1;
  return end;
}

/** Frozen version(): the first version number in a name, as its parts.
 *  "Claude Opus 5.5" → [5,5], "claude-opus-4-8" → [4,8], "GLM-5.3" and
 *  "glm-5p3" → [5,3]. A size token is skipped and a run stops before one,
 *  so "GPT-OSS 120B" → [] and "K3-256K" → [3]. Parentheticals are left
 *  out. [] means versionless — the row always stays. */
export function modelNameVersion(name: string): number[] {
  const text = bareName(name);
  let index = 0;
  while (index < text.length) {
    if (!/[0-9]/.test(text[index]!)) {
      index++;
      continue;
    }
    const sizeEnd = sizeEndAt(text, index);
    if (sizeEnd >= 0) {
      index = sizeEnd;
      continue;
    }
    const parts: number[] = [];
    let digits = "";
    let cursor = index;
    while (cursor < text.length) {
      const ch = text[cursor]!;
      if (/[0-9]/.test(ch)) {
        digits += ch;
      } else if (
        ".-p".includes(ch) &&
        digits !== "" &&
        cursor + 1 < text.length &&
        /[0-9]/.test(text[cursor + 1]!) &&
        sizeEndAt(text, cursor + 1) < 0
      ) {
        parts.push(parseInt(digits, 10));
        digits = "";
      } else break;
      cursor++;
    }
    if (digits !== "") parts.push(parseInt(digits, 10));
    return parts;
  }
  return [];
}

/** Missing parts compare as 0 (frozen compareVersions). */
export function compareModelVersions(lhs: number[], rhs: number[]): number {
  const len = Math.max(lhs.length, rhs.length);
  for (let i = 0; i < len; i++) {
    const l = i < lhs.length ? lhs[i]! : 0;
    const r = i < rhs.length ? rhs[i]! : 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** The vendor a line belongs to: its key's first word. Claude's lines go
 *  by their own names in some catalogues, and a "Codex …" name answers
 *  for gpt (frozen vendor()). */
function vendorOf(lineage: string): string {
  const word = lineage.split(" ")[0]!;
  if (word === "opus" || word === "sonnet" || word === "haiku" || word === "fable")
    return "claude";
  if (word === "codex") return "gpt";
  return word;
}

const versionKey = (v: number[]): string => v.join(".");

/** Frozen vendorVersions(): each vendor's distinct versions in a list —
 *  the "known versions" another catalogue contributes so a catalogue
 *  whose newest is long superseded elsewhere does not keep it as
 *  current. Keys are joined version strings ("5.5"). */
export function vendorModelVersions(list: ModelRowLike[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const option of list) {
    const version = modelNameVersion(option.name);
    if (version.length === 0) continue;
    const vendor = vendorOf(modelLineageKey(option.name));
    const key = versionKey(version);
    const set = result.get(vendor) ?? new Set<string>();
    set.add(key);
    result.set(vendor, set);
  }
  return result;
}

/** Frozen simplified(): the rows a list keeps in view when
 *  hidesOutdatedModels is on, in the provider's order. A protected or
 *  default row always stays; otherwise:
 *  - an effort or Fast variant row whose base is another row's own name
 *    hides behind that row;
 *  - a versioned row stays while its version is among its vendor's
 *    newest `keepingVersions` distinct versions, or it leads a line of
 *    the vendor's newest major version;
 *  - versionless rows always stay.
 *  `knownVersions` folds in other catalogues' versions (vendorModelVersions). */
export function simplifiedModels<T extends ModelRowLike>(
  list: T[],
  options?: {
    keepingVersions?: number | undefined;
    knownVersions?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    isProtected?: ((option: T) => boolean) | undefined;
  },
): T[] {
  const keeping = options?.keepingVersions ?? 3;
  const isProtected = options?.isProtected ?? (() => false);
  const entries = list.map((option) => ({
    option,
    parsed: parseVariantName(option.name),
    lineage: modelLineageKey(option.name),
    version: modelNameVersion(option.name),
  }));
  const names = new Set(list.map((o) => o.name.toLowerCase()));

  // Versions count per vendor, not per line.
  const versionsByVendor = new Map<string, number[][]>();
  for (const e of entries) {
    if (e.version.length === 0) continue;
    const vendor = vendorOf(e.lineage);
    const arr = versionsByVendor.get(vendor) ?? [];
    arr.push(e.version);
    versionsByVendor.set(vendor, arr);
  }
  for (const [vendor, versions] of options?.knownVersions ?? []) {
    const arr = versionsByVendor.get(vendor);
    if (arr === undefined) continue; // only vendors this list carries
    for (const key of versions) arr.push(key.split(".").map(Number));
  }
  const keptVersions = new Map<string, Set<string>>();
  const newestMajor = new Map<string, number>();
  for (const [vendor, versions] of versionsByVendor) {
    const seen = new Set<string>();
    const distinct = versions
      .filter((v) => {
        const k = versionKey(v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => compareModelVersions(b, a));
    keptVersions.set(vendor, new Set(distinct.slice(0, keeping).map(versionKey)));
    const first = distinct[0]?.[0];
    if (first !== undefined) newestMajor.set(vendor, first);
  }
  // A line the vendor rule would empty keeps its newest row while that
  // row is of the vendor's newest major version.
  const survivors = new Set<string>();
  const lineNewest = new Map<string, { id: string; version: number[] }>();
  const lineKept = new Set<string>();
  for (const e of entries) {
    if (e.version.length === 0) continue;
    const vendor = vendorOf(e.lineage);
    if (keptVersions.get(vendor)?.has(versionKey(e.version))) lineKept.add(e.lineage);
    const cur = lineNewest.get(e.lineage);
    if (cur === undefined || compareModelVersions(e.version, cur.version) > 0)
      lineNewest.set(e.lineage, { id: e.option.id, version: e.version });
  }
  for (const [lineage, newest] of lineNewest) {
    if (!lineKept.has(lineage) && newest.version[0] === newestMajor.get(vendorOf(lineage)))
      survivors.add(newest.id);
  }

  return entries
    .filter((e) => {
      if (e.option.isDefault === true || isProtected(e.option)) return true;
      if (
        (e.parsed.effort !== undefined || e.parsed.isFast) &&
        names.has(e.parsed.base.toLowerCase())
      )
        return false;
      if (
        e.version.length > 0 &&
        !survivors.has(e.option.id) &&
        !keptVersions.get(vendorOf(e.lineage))!.has(versionKey(e.version))
      )
        return false;
      return true;
    })
    .map((e) => e.option);
}

export const PICKER_MODELS_CACHE_LIMIT = 48;

/** Bounded cache for `simplifiedModels` results (frozen `PickerModelsCache`
 *  in `ModelVisibility.swift`), keyed by provider, hideOutdated flag,
 *  protected ids, catalog signature, and knownVersions signature. */
export class PickerModelsCache<T extends ModelRowLike = ModelRowLike> {
  private values = new Map<string, T[]>();
  private order: string[] = [];
  private readonly limit: number;

  constructor(limit = PICKER_MODELS_CACHE_LIMIT) {
    this.limit = Math.max(1, limit);
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): T[] | undefined {
    return this.values.get(key);
  }

  set(key: string, value: T[]): void {
    if (!this.values.has(key)) {
      this.order.push(key);
    }
    this.values.set(key, value);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
    this.order = [];
  }
}

export const sharedPickerModelsCache = new PickerModelsCache<ModelRowLike>();

function catalogSignature(models: readonly ModelRowLike[]): string {
  return `${models.length}\0${models
    .map((m) => `${m.id}\u0001${m.name}\u0001${m.isDefault ? "1" : "0"}`)
    .join("\0")}`;
}

function knownVersionsSignature(
  knownVersions?: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  if (!knownVersions || knownVersions.size === 0) return "";
  return [...knownVersions.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([vendor, versions]) => `${vendor}:${[...versions].sort().join(",")}`)
    .join("\0");
}

/** Returns the trimmed model list for a picker, reusing cached results
 *  when the catalog, protection set, and `hideOutdatedModels` are unchanged. */
export function cachedPickerModels<T extends ModelRowLike>(
  models: T[],
  options: {
    provider: string;
    hideOutdatedModels?: boolean | undefined;
    protectedIds?: ReadonlySet<string> | undefined;
    keepingVersions?: number | undefined;
    knownVersions?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    cache?: PickerModelsCache<T> | undefined;
    onCompute?: (() => void) | undefined;
  },
): T[] {
  const hideOutdated = options.hideOutdatedModels ?? true;
  if (!hideOutdated || models.length === 0) return models;
  const protectedSet = options.protectedIds ?? new Set<string>();
  const keeping = options.keepingVersions ?? 3;
  const protectedKey = [...protectedSet].sort().join("\0");
  const key = [
    options.provider,
    "1",
    String(keeping),
    protectedKey,
    catalogSignature(models),
    knownVersionsSignature(options.knownVersions),
  ].join("\u0002");
  const cache = options.cache ?? (sharedPickerModelsCache as unknown as PickerModelsCache<T>);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  options.onCompute?.();
  const result = simplifiedModels(models, {
    keepingVersions: keeping,
    knownVersions: options.knownVersions,
    isProtected: (m) => protectedSet.has(m.id),
  });
  cache.set(key, result);
  return result;
}

/** Frozen protectedModelIDs(): the ids a trimmed picker keeps anyway —
 *  the caller's extras (the picker's own choice, the open chat's model),
 *  the settings' pins, and every pair's lead and heads models on
 *  `provider` (a head profile's model counts on its own provider, else
 *  the pair's heads provider). Not every thread's model: old chats
 *  would keep every outdated model in view. */
export function protectedModelIds(
  slices: {
    modelList?: ModelPin[] | undefined;
    hydraPairs?: import("./hydra").HydraPair[] | undefined;
  },
  provider: string,
  extra: Iterable<string> = [],
): Set<string> {
  const out = new Set<string>(extra);
  for (const pin of slices.modelList ?? []) {
    if (pin.provider === provider) out.add(pin.modelID);
  }
  for (const pair of slices.hydraPairs ?? []) {
    if (pair.provider === provider && pair.orchestratorModel)
      out.add(pair.orchestratorModel);
    const headsProvider = pairHeadsProvider(pair);
    if (headsProvider === provider && pair.workerModel) out.add(pair.workerModel);
    for (const profile of pair.headProfiles ?? []) {
      if ((profile.provider ?? headsProvider) === provider && profile.model)
        out.add(profile.model);
    }
  }
  return out;
}

export function pinId(pin: ModelPin): string {
  return `${pin.provider}/${pin.modelID}`;
}

export function itemId(item: ModelListItem): string {
  return item.kind === "pin" ? pinId(item.pin) : `section/${item.section.id}`;
}

/** Key under which modelPreferences stores a model's defaults — the pin id. */
export function prefKey(provider: ModelPinProvider, modelID: string): string {
  return `${provider}/${modelID}`;
}

/** Frozen modelListItems: pins and headings in the order Settings shows them. */
export function modelListItems(pins: ModelPin[], sections: ModelSection[]): ModelListItem[] {
  const items: ModelListItem[] = [];
  const ordered = sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.position - b.s.position) || (a.i - b.i))
    .map((x) => x.s);
  let next = 0;
  for (let index = 0; index < pins.length; index++) {
    while (next < ordered.length && ordered[next]!.position <= index) {
      items.push({ kind: "section", section: ordered[next++]! });
    }
    items.push({ kind: "pin", pin: pins[index]! });
  }
  while (next < ordered.length) items.push({ kind: "section", section: ordered[next++]! });
  return items;
}

/** Frozen setModelListItems: splits items back into pins and heading positions. */
export function setModelListItems(items: ModelListItem[]): {
  modelList: ModelPin[];
  modelSections: ModelSection[];
} {
  const modelList: ModelPin[] = [];
  const modelSections: ModelSection[] = [];
  for (const item of items) {
    if (item.kind === "pin") modelList.push(item.pin);
    else modelSections.push({ ...item.section, position: modelList.length });
  }
  return { modelList, modelSections };
}

/** Frozen addToModelList — append unless already pinned or the cap is hit. */
export function addPin(pins: ModelPin[], pin: ModelPin): ModelPin[] {
  if (pins.some((p) => pinId(p) === pinId(pin)) || pins.length >= MODEL_LIST_LIMIT) return pins;
  return [...pins, pin];
}

/** Frozen removeFromModelList — drops the pin; its group's other pins stay. */
export function removePin(
  pins: ModelPin[],
  sections: ModelSection[],
  pin: ModelPin,
): { modelList: ModelPin[]; modelSections: ModelSection[] } {
  return setModelListItems(
    modelListItems(pins, sections).filter((i) => itemId(i) !== pinId(pin)),
  );
}

/** Frozen moveModelListItem — a pin or heading sits right before/after another
 *  row; returns null when nothing changed. */
export function moveModelListItem(
  pins: ModelPin[],
  sections: ModelSection[],
  item: ModelListItem,
  target: ModelListItem,
  placeAfter: boolean,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  const items = modelListItems(pins, sections);
  const iid = itemId(item);
  const tid = itemId(target);
  if (iid === tid) return null;
  const from = items.findIndex((i) => itemId(i) === iid);
  const to = items.findIndex((i) => itemId(i) === tid);
  if (from < 0 || to < 0) return null;
  let dest = to + (placeAfter ? 1 : 0);
  if (from < dest) dest -= 1;
  if (from === dest) return null;
  const [moved] = items.splice(from, 1);
  items.splice(dest, 0, moved!);
  return setModelListItems(items);
}

/** Frozen moveModel(_:toSection:before:) — pin goes into the group (nil: the
 *  ungrouped top), right before `before` when it is in the group, else at end. */
export function movePinToSection(
  pins: ModelPin[],
  sections: ModelSection[],
  pin: ModelPin,
  sectionId: string | null,
  before?: ModelPin,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  const items = modelListItems(pins, sections).filter((i) => itemId(i) !== pinId(pin));
  const start =
    sectionId === null
      ? undefined
      : items.findIndex((i) => i.kind === "section" && i.section.id === sectionId);
  if (sectionId !== null && start === undefined) return null;
  if (sectionId !== null && start! < 0) return null;
  const afterStart = start === undefined ? 0 : start + 1;
  let end = items.length;
  for (let i = afterStart; i < items.length; i++) {
    if (items[i]!.kind === "section") {
      end = i;
      break;
    }
  }
  let slot = end;
  if (before) {
    const bi = items.findIndex(
      (i, idx) => idx >= afterStart && idx < end && i.kind === "pin" && pinId(i.pin) === pinId(before),
    );
    if (bi >= 0) slot = bi;
  }
  items.splice(slot, 0, { kind: "pin", pin });
  return setModelListItems(items);
}

/** Frozen moveModelSection(_:by:) — the group, with its models, one group up
 *  (-1) or down (+1); ungrouped models always stay on top. */
export function moveModelSection(
  pins: ModelPin[],
  sections: ModelSection[],
  id: string,
  offset: number,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  const items = modelListItems(pins, sections);
  const head: ModelListItem[] = [];
  const blocks: ModelListItem[][] = [];
  for (const item of items) {
    if (item.kind === "section") blocks.push([item]);
    else if (blocks.length === 0) head.push(item);
    else blocks[blocks.length - 1]!.push(item);
  }
  const from = blocks.findIndex(
    (b) => b[0]!.kind === "section" && (b[0] as { section: ModelSection }).section.id === id,
  );
  const to = from + offset;
  if (from < 0 || to < 0 || to >= blocks.length) return null;
  [blocks[from], blocks[to]] = [blocks[to]!, blocks[from]!];
  return setModelListItems([...head, ...blocks.flat()]);
}

/** Frozen addModelSection — a heading at the end of the list; the next models
 *  added fall under it. */
export function addSection(sections: ModelSection[], name: string, pinCount: number): ModelSection[] {
  return [...sections, { id: newSectionId(), name, position: pinCount }];
}

export function renameSection(sections: ModelSection[], id: string, name: string): ModelSection[] {
  return sections.map((s) => (s.id === id ? { ...s, name } : s));
}

/** P2-33 (frozen commitRename-on-mutation): fold an in-flight rename
 *  into the list a mutation is about to write — the edit lands in the
 *  same write instead of racing two whole-array updates from different
 *  bases. A missing/blank edit leaves the list untouched. */
export function applyDraftRename(
  sections: ModelSection[],
  editingId: string | null,
  draft: string,
): ModelSection[] {
  const name = draft.trim();
  if (editingId === null || name === "") return sections;
  return renameSection(sections, editingId, name);
}

/** P2-33: an edit target is alive while the section list echoes it, or
 *  while it is a just-written row whose echo has not landed yet — the
 *  settings write is fire-and-forget, so checking only the echoed list
 *  clears the inline editor the click just opened (the "New group"
 *  regression). Once the echo lands, `pendingId` must be released. */
export function sectionEditTargetAlive(
  sections: readonly ModelSection[],
  editingId: string | null,
  pendingId: string | null,
): boolean {
  if (editingId === null) return false;
  if (sections.some((s) => s.id === editingId)) return true;
  return editingId === pendingId;
}

/** Frozen removeModelSection — the heading goes away; its models join the
 *  heading above, or the top of the list. */
export function removeSection(sections: ModelSection[], collapsed: string[], id: string) {
  return {
    modelSections: sections.filter((s) => s.id !== id),
    collapsedModelSections: collapsed.filter((c) => c !== id),
  };
}

export function toggleSectionCollapsed(collapsed: string[], id: string): string[] {
  return collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id];
}

// ── P2-56 / P2-20: model groups, chip drag-reorder, and group-aware picker ──

export interface ModelGroupBlock {
  section: ModelSection;
  pins: ModelPin[];
}

/** Splits `modelListItems` into the ungrouped head and ordered group blocks. */
export function partitionModelBlocks(
  pins: ModelPin[],
  sections: ModelSection[],
): { ungrouped: ModelPin[]; groups: ModelGroupBlock[] } {
  const ungrouped: ModelPin[] = [];
  const groups: ModelGroupBlock[] = [];
  for (const item of modelListItems(pins, sections)) {
    if (item.kind === "pin") {
      if (groups.length === 0) ungrouped.push(item.pin);
      else groups[groups.length - 1]!.pins.push(item.pin);
    } else {
      groups.push({ section: item.section, pins: [] });
    }
  }
  return { ungrouped, groups };
}

/** Returns the section id containing `pin`, or `null` when ungrouped / absent. */
export function sectionIdOfPin(
  pins: ModelPin[],
  sections: ModelSection[],
  pin: ModelPin,
): string | null {
  const target = pinId(pin);
  let current: string | null = null;
  for (const item of modelListItems(pins, sections)) {
    if (item.kind === "section") current = item.section.id;
    else if (pinId(item.pin) === target) return current;
  }
  return null;
}

function sameModelLayout(
  aPins: ModelPin[],
  aSections: ModelSection[],
  bPins: ModelPin[],
  bSections: ModelSection[],
): boolean {
  if (aPins.length !== bPins.length || aSections.length !== bSections.length) return false;
  for (let i = 0; i < aPins.length; i++) {
    if (pinId(aPins[i]!) !== pinId(bPins[i]!)) return false;
  }
  for (let i = 0; i < aSections.length; i++) {
    if (
      aSections[i]!.id !== bSections[i]!.id ||
      aSections[i]!.position !== bSections[i]!.position
    ) {
      return false;
    }
  }
  return true;
}

/** Frozen AvatarChipDropDelegate / ModelCardReorderDropDelegate:
 *  - Same group: reorder `dragged` before or after `target` based on index order.
 *  - Different group: move `dragged` into `target`'s group right before `target`.
 *  Returns `null` when nothing changed. */
export function dropPinOnPin(
  pins: ModelPin[],
  sections: ModelSection[],
  dragged: ModelPin,
  target: ModelPin,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  if (pinId(dragged) === pinId(target)) return null;
  if (
    !pins.some((p) => pinId(p) === pinId(dragged)) ||
    !pins.some((p) => pinId(p) === pinId(target))
  ) {
    return null;
  }
  const fromSection = sectionIdOfPin(pins, sections, dragged);
  const toSection = sectionIdOfPin(pins, sections, target);
  if (fromSection === toSection) {
    const blocks = partitionModelBlocks(pins, sections);
    const groupPins =
      toSection === null
        ? blocks.ungrouped
        : (blocks.groups.find((g) => g.section.id === toSection)?.pins ?? []);
    const fromIdx = groupPins.findIndex((p) => pinId(p) === pinId(dragged));
    const toIdx = groupPins.findIndex((p) => pinId(p) === pinId(target));
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;
    return moveModelListItem(
      pins,
      sections,
      { kind: "pin", pin: dragged },
      { kind: "pin", pin: target },
      fromIdx < toIdx,
    );
  }
  const next = movePinToSection(pins, sections, dragged, toSection, target);
  if (!next || sameModelLayout(pins, sections, next.modelList, next.modelSections)) {
    return null;
  }
  return next;
}

/** Moves `dragged` to the end of `sectionId` (`null` = Ungrouped), returning
 *  `null` when nothing changed or when `requireDifferentGroup` forbids a
 *  same-group drop (e.g. dropping onto the model's current left-rail card). */
export function dropPinOnGroupEnd(
  pins: ModelPin[],
  sections: ModelSection[],
  dragged: ModelPin,
  sectionId: string | null,
  options?: { requireDifferentGroup?: boolean },
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  if (!pins.some((p) => pinId(p) === pinId(dragged))) return null;
  if (sectionId !== null && !sections.some((s) => s.id === sectionId)) return null;
  if (
    options?.requireDifferentGroup &&
    sectionIdOfPin(pins, sections, dragged) === sectionId
  ) {
    return null;
  }
  const next = movePinToSection(pins, sections, dragged, sectionId);
  if (!next || sameModelLayout(pins, sections, next.modelList, next.modelSections)) {
    return null;
  }
  return next;
}

export type ModelDragTarget =
  | { kind: "pin"; id: string }
  | { kind: "section"; id: string };

/** Parses the renderer's drag token without trusting it as a live model id.
 *  Drop planning then re-resolves the target against the freshest settings
 *  snapshot, so a row removed mid-drag cannot be recreated by the drop. */
export function parseModelDragTarget(dragged: string | null): ModelDragTarget | null {
  if (!dragged) return null;
  if (dragged.startsWith("section/")) {
    const id = dragged.slice("section/".length);
    return id === "" ? null : { kind: "section", id };
  }
  return { kind: "pin", id: dragged };
}

function liveDraggedPin(pins: readonly ModelPin[], id: string): ModelPin | null {
  return pins.find((p) => pinId(p) === id) ?? null;
}

/** Pure drop-on-pin plan: searching and non-pin drags are inert, and a pin
 *  missing from the fresh snapshot produces no write. */
export function planModelDropOnPin(
  pins: ModelPin[],
  sections: ModelSection[],
  dragged: string | null,
  target: ModelPin,
  isSearching: boolean,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  const drag = parseModelDragTarget(dragged);
  if (!drag || drag.kind !== "pin" || isSearching) return null;
  const pin = liveDraggedPin(pins, drag.id);
  return pin ? dropPinOnPin(pins, sections, pin, target) : null;
}

/** Pure drop-on-wall-group plan with the same fresh-snapshot guard. */
export function planModelDropOnWallGroup(
  pins: ModelPin[],
  sections: ModelSection[],
  dragged: string | null,
  sectionId: string | null,
  isSearching: boolean,
  options?: { requireDifferentGroup?: boolean },
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  const drag = parseModelDragTarget(dragged);
  if (!drag || drag.kind !== "pin" || isSearching) return null;
  const pin = liveDraggedPin(pins, drag.id);
  return pin ? dropPinOnGroupEnd(pins, sections, pin, sectionId, options) : null;
}

/** Pure rail-drop plan: section-on-section reorder or pin-to-group end. A
 *  dragged section/pin that vanished after the drag started yields null —
 *  the caller must make no write. */
export function planModelDropOnRail(
  pins: ModelPin[],
  sections: ModelSection[],
  dragged: string | null,
  targetSectionId: string | null,
  isSearching: boolean,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  const drag = parseModelDragTarget(dragged);
  if (!drag) return null;
  if (drag.kind === "section") {
    if (isSearching || targetSectionId === null) return null;
    return moveSectionToTarget(pins, sections, drag.id, targetSectionId);
  }
  const pin = liveDraggedPin(pins, drag.id);
  return pin
    ? dropPinOnGroupEnd(pins, sections, pin, targetSectionId, { requireDifferentGroup: true })
    : null;
}

/** Frozen RailCardDropDelegate (.group on .group): moves `draggedId` directly
 *  to `targetId`'s slot, carrying its models; ungrouped models stay on top. */
export function moveSectionToTarget(
  pins: ModelPin[],
  sections: ModelSection[],
  draggedId: string,
  targetId: string,
): { modelList: ModelPin[]; modelSections: ModelSection[] } | null {
  if (draggedId === targetId) return null;
  const items = modelListItems(pins, sections);
  const head: ModelListItem[] = [];
  const blocks: ModelListItem[][] = [];
  for (const item of items) {
    if (item.kind === "section") blocks.push([item]);
    else if (blocks.length === 0) head.push(item);
    else blocks[blocks.length - 1]!.push(item);
  }
  const from = blocks.findIndex(
    (b) => b[0]!.kind === "section" && (b[0] as { section: ModelSection }).section.id === draggedId,
  );
  const to = blocks.findIndex(
    (b) => b[0]!.kind === "section" && (b[0] as { section: ModelSection }).section.id === targetId,
  );
  if (from < 0 || to < 0 || from === to) return null;
  const [moved] = blocks.splice(from, 1);
  blocks.splice(to, 0, moved!);
  return setModelListItems([...head, ...blocks.flat()]);
}

export type PickerCategory =
  | { kind: "all" }
  | { kind: "ungrouped" }
  | { kind: "group"; sectionId: string }
  | { kind: "combos" };

export function pickerCategoryKey(cat: PickerCategory): string {
  if (cat.kind === "all") return "all";
  if (cat.kind === "ungrouped") return "ungrouped";
  if (cat.kind === "combos") return "combos";
  return `group/${cat.sectionId}`;
}

export interface PickerEntry<T extends ModelRowLike> {
  modelId: string;
  pin?: ModelPin | undefined;
  option?: T | undefined;
}

export interface PickerPartition<T extends ModelRowLike> {
  groups: { section: ModelSection; items: PickerEntry<T>[] }[];
  ungrouped: PickerEntry<T>[];
}

/** Partitions models for the group-aware picker (frozen partitionedGroups).
 *  When pins exist, only pinned models appear in their group / ungrouped order
 *  (plus `selectedModelId` if it is in the catalog and not already pinned, so
 *  the chosen model always stays visible); otherwise `visibleModels` sit under
 *  ungrouped while sections stay visible. */
export function partitionPickerModels<T extends ModelRowLike>(
  pins: ModelPin[],
  sections: ModelSection[],
  visibleModels: T[],
  optionById: ReadonlyMap<string, T>,
  selectedModelId?: string,
): PickerPartition<T> {
  if (pins.length === 0) {
    const orderedSections = [...sections]
      .map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.position - b.s.position || a.i - b.i)
      .map((x) => x.s);
    return {
      groups: orderedSections.map((section) => ({ section, items: [] })),
      ungrouped: visibleModels.map((option) => ({ modelId: option.id, option })),
    };
  }
  const blocks = partitionModelBlocks(pins, sections);
  const ungrouped: PickerEntry<T>[] = blocks.ungrouped.map((pin) => ({
    modelId: pin.modelID,
    pin,
    option: optionById.get(pin.modelID),
  }));
  const groups = blocks.groups.map((g) => ({
    section: g.section,
    items: g.pins.map((pin) => ({
      modelId: pin.modelID,
      pin,
      option: optionById.get(pin.modelID),
    })),
  }));
  if (
    selectedModelId &&
    !blocks.ungrouped.some((p) => p.modelID === selectedModelId) &&
    !blocks.groups.some((g) => g.pins.some((p) => p.modelID === selectedModelId))
  ) {
    const selectedOpt = optionById.get(selectedModelId);
    if (selectedOpt) {
      ungrouped.unshift({ modelId: selectedModelId, option: selectedOpt });
    }
  }
  return { groups, ungrouped };
}

/** Frozen defaultCategory: opens on Combos when leading with a pair,
 *  else the group holding `currentModelId`, else All. */
export function defaultPickerCategory<T extends ModelRowLike>(
  partition: PickerPartition<T>,
  currentModelId: string,
  opts?: { leadsWithPair?: boolean | undefined; hasPairs?: boolean | undefined },
): PickerCategory {
  if (opts?.leadsWithPair && opts?.hasPairs) return { kind: "combos" };
  if (currentModelId !== "") {
    const match = partition.groups.find((g) =>
      g.items.some((entry) => entry.modelId === currentModelId),
    );
    if (match) return { kind: "group", sectionId: match.section.id };
  }
  return { kind: "all" };
}

/** Validates a selected category against live groups/ungrouped/pairs items. */
export function resolvePickerCategory<T extends ModelRowLike>(
  candidate: PickerCategory | null,
  partition: PickerPartition<T>,
  opts?: { hasPairs?: boolean | undefined },
): PickerCategory | null {
  if (candidate === null) return null;
  if (candidate.kind === "all") return candidate;
  if (candidate.kind === "combos") {
    return opts?.hasPairs ? candidate : { kind: "all" };
  }
  if (candidate.kind === "ungrouped") {
    return partition.ungrouped.length > 0 ? candidate : { kind: "all" };
  }
  return partition.groups.some((g) => g.section.id === candidate.sectionId)
    ? candidate
    : { kind: "all" };
}

/** P2-03: model-based fallback title for a Hydra pair in the picker. */
export function pickerPairModelsTitle(
  pair: HydraPair,
  modelName: (provider: string, modelId: string | undefined) => string | undefined,
  providerLabel: (provider: string) => string,
  formatAnyModel: (providerName: string) => string,
  formatWithItself: (leadName: string) => string,
): string {
  const lead =
    modelName(pair.provider, pair.orchestratorModel) ??
    formatAnyModel(providerLabel(pair.provider));
  const headsProv = pairHeadsProvider(pair);
  const worker =
    modelName(headsProv, pair.workerModel) ??
    (pairSendsHeadsElsewhere(pair) ? providerLabel(headsProv) : undefined);
  return worker === undefined ? formatWithItself(lead) : `${lead} + ${worker}`;
}

/** P2-03: display title for a Hydra pair (user custom name or models title). */
export function pickerPairTitle(
  pair: HydraPair,
  modelName: (provider: string, modelId: string | undefined) => string | undefined,
  providerLabel: (provider: string) => string,
  formatAnyModel: (providerName: string) => string,
  formatWithItself: (leadName: string) => string,
): string {
  return (
    pairCustomName(pair) ??
    pickerPairModelsTitle(pair, modelName, providerLabel, formatAnyModel, formatWithItself)
  );
}

/** P2-03: case-insensitive search match for a Hydra pair (name, models, detail). */
export function pickerPairMatches(
  pair: HydraPair,
  query: string,
  title: string,
  detail: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    title.toLowerCase().includes(q) ||
    detail.toLowerCase().includes(q) ||
    (pairCustomName(pair)?.toLowerCase().includes(q) ?? false) ||
    (pair.orchestratorModel?.toLowerCase().includes(q) ?? false) ||
    (pair.workerModel?.toLowerCase().includes(q) ?? false)
  );
}

/** P2-03: resolve the most recently selected Hydra pair if still present. */
export function resolveRecentPickerPair(
  pairs: readonly HydraPair[],
  lastHydraPairId: string | undefined,
): HydraPair | undefined {
  if (!lastHydraPairId) return undefined;
  return pairs.find((p) => p.id === lastHydraPairId);
}

/** P2-03: resolve the most recently selected model entry if present in the picker list. */
export function resolveRecentPickerModel<T extends ModelRowLike>(
  entries: readonly PickerEntry<T>[],
  lastNewChatModel: ModelPin | undefined,
): PickerEntry<T> | undefined {
  if (!lastNewChatModel || lastNewChatModel.provider !== "codex") return undefined;
  return entries.find((e) => e.modelId === lastNewChatModel.modelID);
}

/** Section id — UUID shape so stored sections stay frozen-compatible. */
export function newSectionId(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
