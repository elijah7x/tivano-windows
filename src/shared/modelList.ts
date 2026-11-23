// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17: frozen AppSettings modelList / modelSections / collapsedModelSections /
// modelPreferences ported as pure functions over persisted Settings slices.
// The catalog stays provider-owned (models:list) — pins only ORGANIZE the
// picker; a pin whose model never appeared in a catalog still shows by id.

import { pairHeadsProvider } from "./hydra";

/** Frozen ProviderKind — ported provider adapters supported in pins. */
export type ModelPinProvider = "codex" | "zcode";

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

/** Section id — UUID shape so stored sections stay frozen-compatible. */
export function newSectionId(): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
