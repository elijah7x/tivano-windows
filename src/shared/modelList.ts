// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17: frozen AppSettings modelList / modelSections / collapsedModelSections /
// modelPreferences ported as pure functions over persisted Settings slices.
// The catalog stays provider-owned (models:list) — pins only ORGANIZE the
// picker; a pin whose model never appeared in a catalog still shows by id.

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
