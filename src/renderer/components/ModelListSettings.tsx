// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-56 / P2-20: frozen ModelsSettingsPage — two-column master-detail
// "Your models" (All chip wall with drag-to-reorder/move chips, group
// rail drop targets, per-group EffortCard) + two-column "Browse all
// models" (persistent provider list with selected-model counts, All
// models entry, non-folding catalog card).

import { useEffect, useRef, useState } from "react";
import type {
  CodexModelCatalog,
  CodexModelOption,
} from "../../shared/types";
import {
  MODEL_LIST_LIMIT,
  addPin,
  addSection,
  applyDraftRename,
  dropPinOnGroupEnd,
  dropPinOnPin,
  moveModelSection,
  movePinToSection,
  moveSectionToTarget,
  partitionModelBlocks,
  pinId,
  prefKey,
  protectedModelIds,
  removePin,
  removeSection,
  renameSection,
  sectionEditTargetAlive,
  simplifiedModels,
  type ModelGroupBlock,
  type ModelPin,
  type ModelPinProvider,
  type ModelPreference,
  type ModelSection,
} from "../../shared/modelList";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { api, tryCall, clientStore } from "../client";

export type SettingsGroupSelection =
  | { kind: "all" }
  | { kind: "ungrouped" }
  | { kind: "group"; sectionId: string };

export interface ModelListSettingsProps {
  initialGroup?: SettingsGroupSelection;
  initialCatalog?: CodexModelCatalog | null;
  initialQuery?: string;
}

const SELECTED_GROUP_STORAGE_KEY = "tivano.modelsSettingsSelectedGroup";

function readStoredGroup(): SettingsGroupSelection {
  try {
    if (typeof window === "undefined" || !window.localStorage) return { kind: "all" };
    const raw = window.localStorage.getItem(SELECTED_GROUP_STORAGE_KEY);
    if (!raw || raw === "all") return { kind: "all" };
    if (raw === "ungrouped") return { kind: "ungrouped" };
    return { kind: "group", sectionId: raw };
  } catch {
    return { kind: "all" };
  }
}

function writeStoredGroup(sel: SettingsGroupSelection): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const raw =
      sel.kind === "all" ? "all" : sel.kind === "ungrouped" ? "ungrouped" : sel.sectionId;
    window.localStorage.setItem(SELECTED_GROUP_STORAGE_KEY, raw);
  } catch {
    /* ignore storage errors */
  }
}

function sameSelection(a: SettingsGroupSelection, b: SettingsGroupSelection): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "group" || (b.kind === "group" && a.sectionId === b.sectionId);
}

function resolveGroupSelection(
  candidate: SettingsGroupSelection,
  groups: ModelGroupBlock[],
  showsUngrouped: boolean,
): SettingsGroupSelection {
  if (candidate.kind === "all") return candidate;
  if (candidate.kind === "ungrouped") return showsUngrouped ? candidate : { kind: "all" };
  return groups.some((g) => g.section.id === candidate.sectionId)
    ? candidate
    : { kind: "all" };
}

function effortTitle(effort: string): string {
  if (effort === "xhigh" || effort === "extra-high") return "Extra High";
  if (effort === "") return "Default";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
function effortRank(effort: string): number | undefined {
  return (
    {
      none: 0, minimal: 1, low: 2, medium: 3, high: 4,
      xhigh: 5, "extra-high": 5, extra_high: 5, "extra high": 5,
      max: 6, ultra: 6,
    } as Record<string, number>
  )[effort.toLowerCase()];
}
function orderedEfforts(values: string[]): string[] {
  const ranked = values.map((v, i) => ({ i, v, r: effortRank(v) }));
  if (ranked.filter((x) => x.r !== undefined).length <= 1) return values;
  return ranked
    .sort((a, b) =>
      a.r !== undefined && b.r !== undefined && a.r !== b.r ? a.r - b.r : a.i - b.i,
    )
    .map((x) => x.v);
}

interface MenuState {
  x: number;
  y: number;
  kind: "pin" | "section";
  pin?: ModelPin;
  sectionId?: string;
  pinSection?: string | null;
}
interface EffortState {
  pin: ModelPin;
  x: number;
  y: number;
}

export interface PendingSectionRename {
  id: string;
  name: string;
}

export interface ModelListControllerContext {
  getSnapshotSettings: () =>
    | {
        modelList?: ModelPin[];
        modelSections?: ModelSection[];
        collapsedModelSections?: string[];
        modelPreferences?: Record<string, ModelPreference>;
      }
    | undefined;
  fallback: {
    pins: ModelPin[];
    sections: ModelSection[];
    collapsed: string[];
    prefs: Record<string, ModelPreference>;
  };
  getEditingId: () => string | null;
  setEditingId: (id: string | null) => void;
  getDraft: () => string;
  setDraft: (draft: string) => void;
  getPendingNewId: () => string | null;
  setPendingNewId: (id: string | null) => void;
  pendingRenameRef: { current: PendingSectionRename | null };
  dragRef: { current: string | null };
  setDropHint: (hint: string | null) => void;
  setEffortPop: (pop: EffortState | null) => void;
  setSelectedGroup?: (target: SettingsGroupSelection) => void;
  writeStoredGroup?: (target: SettingsGroupSelection) => void;
  schedulePendingNewClear?: (id: string) => void;
  write: (patch: Record<string, unknown>) => void;
}

/** Coordinates snapshot-based mutations, blur-commit pending renames,
 *  mid-drag vanish guards, and edit-target cleanup so edits, removes,
 *  and reorders never resurrect deleted targets or lose in-flight renames
 *  while settings:set IPC writes are awaiting echo. */
export function createModelListController(ctx: ModelListControllerContext) {
  const freshLists = () => {
    const s = ctx.getSnapshotSettings();
    return {
      pins: s?.modelList ?? ctx.fallback.pins,
      sections: s?.modelSections ?? ctx.fallback.sections,
      collapsed: s?.collapsedModelSections ?? ctx.fallback.collapsed,
    };
  };

  const foldRename = (list: ModelSection[]): ModelSection[] => {
    const editingId = ctx.getEditingId();
    const pending = ctx.pendingRenameRef.current;
    let out = list;
    if (pending !== null && pending.id !== editingId) {
      out = applyDraftRename(out, pending.id, pending.name);
    }
    if (editingId !== null) {
      out = applyDraftRename(out, editingId, ctx.getDraft());
    }
    return out;
  };

  const writeItems = (
    r: { modelList: ModelPin[]; modelSections: ModelSection[] } | null,
  ) => {
    if (r) ctx.write({ modelList: r.modelList, modelSections: r.modelSections });
  };

  const findDraggedPin = (f: { pins: ModelPin[] }, dragged: string) =>
    f.pins.find((p) => pinId(p) === dragged);

  const commitRename = (id: string) => {
    const name = ctx.getDraft().trim();
    const f = freshLists();
    const pending = ctx.pendingRenameRef.current;
    const baseSections =
      pending !== null && pending.id !== id
        ? applyDraftRename(f.sections, pending.id, pending.name)
        : f.sections;
    const cur = baseSections.find((s) => s.id === id);
    if (cur && name !== "" && name !== cur.name) {
      ctx.pendingRenameRef.current = { id, name };
      ctx.write({ modelSections: renameSection(baseSections, id, name) });
    } else if (pending?.id === id) {
      ctx.pendingRenameRef.current = null;
    }
    ctx.setEditingId(null);
  };

  const cancelRename = (id: string) => {
    if (ctx.pendingRenameRef.current?.id === id) {
      ctx.pendingRenameRef.current = null;
    }
    ctx.setEditingId(null);
  };

  const startRename = (section: ModelSection) => {
    const curEditing = ctx.getEditingId();
    if (curEditing !== null && curEditing !== section.id) {
      commitRename(curEditing);
    }
    const pending = ctx.pendingRenameRef.current;
    const initial = pending?.id === section.id ? pending.name : section.name;
    if (pending?.id === section.id) {
      ctx.pendingRenameRef.current = null;
    }
    ctx.setEditingId(section.id);
    ctx.setDraft(initial);
  };

  const removePinAction = (pin: ModelPin) => {
    const f = freshLists();
    const folded = foldRename(f.sections);
    ctx.setEditingId(null);
    writeItems(removePin(f.pins, folded, pin));
  };

  const removeSectionAction = (sectionId: string) => {
    const f = freshLists();
    const folded = foldRename(f.sections);
    if (ctx.pendingRenameRef.current?.id === sectionId) {
      ctx.pendingRenameRef.current = null;
    }
    ctx.setEditingId(null);
    ctx.write(removeSection(folded, f.collapsed, sectionId));
  };

  const movePinToSectionAction = (pin: ModelPin, sectionId: string | null) => {
    const f = freshLists();
    writeItems(movePinToSection(f.pins, foldRename(f.sections), pin, sectionId));
  };

  const moveSectionAction = (sectionId: string, offset: number) => {
    const f = freshLists();
    writeItems(moveModelSection(f.pins, foldRename(f.sections), sectionId, offset));
  };

  const dropOnPin = (targetPin: ModelPin, isSearching: boolean) => {
    const dragged = ctx.dragRef.current;
    ctx.dragRef.current = null;
    ctx.setDropHint(null);
    if (!dragged || dragged.startsWith("section/") || isSearching) return;
    const f = freshLists();
    const pin = findDraggedPin(f, dragged);
    if (pin) writeItems(dropPinOnPin(f.pins, foldRename(f.sections), pin, targetPin));
  };

  const dropOnWallGroup = (sectionId: string | null, isSearching: boolean) => {
    const dragged = ctx.dragRef.current;
    ctx.dragRef.current = null;
    ctx.setDropHint(null);
    if (!dragged || dragged.startsWith("section/") || isSearching) return;
    const f = freshLists();
    const pin = findDraggedPin(f, dragged);
    if (pin) writeItems(dropPinOnGroupEnd(f.pins, foldRename(f.sections), pin, sectionId));
  };

  const dropOnRail = (targetSectionId: string | null, isSearching: boolean) => {
    const dragged = ctx.dragRef.current;
    ctx.dragRef.current = null;
    ctx.setDropHint(null);
    if (!dragged) return;
    const f = freshLists();
    const folded = foldRename(f.sections);
    if (dragged.startsWith("section/")) {
      if (isSearching || targetSectionId === null) return;
      const draggedId = dragged.slice("section/".length);
      writeItems(moveSectionToTarget(f.pins, folded, draggedId, targetSectionId));
      return;
    }
    const pin = findDraggedPin(f, dragged);
    if (pin) {
      writeItems(
        dropPinOnGroupEnd(f.pins, folded, pin, targetSectionId, {
          requireDifferentGroup: true,
        }),
      );
    }
  };

  const addNewGroup = (label: string) => {
    const f = freshLists();
    const next = addSection(foldRename(f.sections), label, f.pins.length);
    ctx.write({ modelSections: next });
    const added = next[next.length - 1];
    if (added) {
      ctx.setPendingNewId(added.id);
      ctx.schedulePendingNewClear?.(added.id);
      const target: SettingsGroupSelection = { kind: "group", sectionId: added.id };
      ctx.setSelectedGroup?.(target);
      ctx.writeStoredGroup?.(target);
      ctx.setEditingId(added.id);
      ctx.setDraft(added.name);
    }
  };

  const toggleCatalogPin = (pin: ModelPin, isPinned: boolean) => {
    const f = freshLists();
    if (isPinned) {
      writeItems(removePin(f.pins, foldRename(f.sections), pin));
    } else {
      ctx.write({ modelList: addPin(f.pins, pin) });
    }
  };

  const updatePref = (pin: ModelPin, pref: ModelPreference) => {
    const latest = ctx.getSnapshotSettings()?.modelPreferences ?? ctx.fallback.prefs;
    const next = { ...latest };
    const key = prefKey(pin.provider, pin.modelID);
    if (pref.effort === undefined && pref.fastMode !== true) delete next[key];
    else next[key] = pref;
    ctx.write({ modelPreferences: next });
  };

  const syncEffects = (
    pins: readonly ModelPin[],
    sections: readonly ModelSection[],
    effortPop: EffortState | null,
  ) => {
    const pendingNewId = ctx.getPendingNewId();
    if (pendingNewId !== null && sections.some((s) => s.id === pendingNewId)) {
      ctx.setPendingNewId(null);
    }
    const pendingRename = ctx.pendingRenameRef.current;
    if (pendingRename !== null) {
      const match = sections.find((s) => s.id === pendingRename.id);
      if (!match || match.name === pendingRename.name) {
        ctx.pendingRenameRef.current = null;
      }
    }
    if (!sectionEditTargetAlive(sections, ctx.getEditingId(), pendingNewId)) {
      ctx.setEditingId(null);
    }
    if (effortPop !== null && !pins.some((p) => pinId(p) === pinId(effortPop.pin))) {
      ctx.setEffortPop(null);
    }
  };

  return {
    freshLists,
    foldRename,
    commitRename,
    cancelRename,
    startRename,
    removePin: removePinAction,
    removeSection: removeSectionAction,
    movePinToSection: movePinToSectionAction,
    moveSection: moveSectionAction,
    dropOnPin,
    dropOnWallGroup,
    dropOnRail,
    addNewGroup,
    toggleCatalogPin,
    updatePref,
    syncEffects,
  };
}

export function ModelListSettings(props: ModelListSettingsProps): React.JSX.Element {
  const t = useT();
  const settings = clientStore.snapshot?.settings;
  const pins: ModelPin[] = settings?.modelList ?? [];
  const sections: ModelSection[] = settings?.modelSections ?? [];
  const collapsed: string[] = settings?.collapsedModelSections ?? [];
  const prefs: Record<string, ModelPreference> = settings?.modelPreferences ?? {};

  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(
    props.initialCatalog ?? null,
  );
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [selectedGroup, setSelectedGroup] = useState<SettingsGroupSelection>(
    () => props.initialGroup ?? readStoredGroup(),
  );
  const [searchGroupOverride, setSearchGroupOverride] =
    useState<SettingsGroupSelection | null>(null);
  const [catalogueSelection, setCatalogueSelection] =
    useState<ModelPinProvider | null>(null);
  const [highlightedPin, setHighlightedPin] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [effortPop, setEffortPop] = useState<EffortState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingNewId, setPendingNewId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropHint, setDropHint] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const editingIdRef = useRef<string | null>(editingId);
  const draftRef = useRef(draft);
  const pendingNewIdRef = useRef<string | null>(pendingNewId);
  const pendingRenameRef = useRef<PendingSectionRename | null>(null);
  editingIdRef.current = editingId;
  draftRef.current = draft;
  pendingNewIdRef.current = pendingNewId;
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (props.initialCatalog !== undefined) return;
    let live = true;
    api()
      .invoke("models:list", {})
      .then((c) => {
        if (live) setCatalog(c as CodexModelCatalog);
      })
      .catch((e) => {
        if (live)
          setCatalog({ state: "unavailable", reason: (e as Error)?.message ?? String(e) });
      });
    return () => {
      live = false;
    };
  }, [props.initialCatalog]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (menu === null && effortPop === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        setEffortPop(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".msg-menu") && !el.closest(".effort-pop")) {
        setMenu(null);
        setEffortPop(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [menu !== null || effortPop !== null]);

  const write = (patch: Record<string, unknown>) => tryCall("settings:set", patch);

  const ctrl = createModelListController({
    getSnapshotSettings: () => clientStore.snapshot?.settings,
    fallback: { pins, sections, collapsed, prefs },
    getEditingId: () => editingIdRef.current,
    setEditingId: (id) => {
      editingIdRef.current = id;
      setEditingId(id);
    },
    getDraft: () => draftRef.current,
    setDraft: (d) => {
      draftRef.current = d;
      setDraft(d);
    },
    getPendingNewId: () => pendingNewIdRef.current,
    setPendingNewId: (id) => {
      pendingNewIdRef.current = id;
      setPendingNewId(id);
    },
    pendingRenameRef,
    dragRef,
    setDropHint,
    setEffortPop,
    setSelectedGroup,
    writeStoredGroup,
    schedulePendingNewClear: (id) => {
      if (typeof window !== "undefined") {
        window.setTimeout(() => setPendingNewId((p) => (p === id ? null : p)), 3000);
      }
    },
    write,
  });

  useEffect(() => {
    ctrl.syncEffects(pins, sections, effortPop);
  }, [editingId, effortPop, pendingNewId, pins, sections]);

  const trimmed = query.trim().toLowerCase();
  const isSearching = trimmed !== "";
  const optionById = new Map(
    (catalog?.state === "ready" ? catalog.models : []).map((m) => [m.id, m]),
  );
  const pinMatches = (pin: ModelPin) => {
    if (!isSearching) return true;
    const opt = optionById.get(pin.modelID);
    const name = opt?.name ?? pin.modelID;
    return (
      name.toLowerCase().includes(trimmed) ||
      pin.modelID.toLowerCase().includes(trimmed) ||
      (opt?.detail?.toLowerCase().includes(trimmed) ?? false)
    );
  };

  const allBlocks = partitionModelBlocks(pins, sections);
  const filteredBlocks = isSearching
    ? {
        ungrouped: allBlocks.ungrouped.filter(pinMatches),
        groups: allBlocks.groups.map((g) => ({
          ...g,
          pins: g.pins.filter(pinMatches),
        })),
      }
    : allBlocks;
  const allVisiblePins = [
    ...allBlocks.ungrouped,
    ...allBlocks.groups.flatMap((g) => g.pins),
  ];
  const visiblePins = [
    ...filteredBlocks.ungrouped,
    ...filteredBlocks.groups.flatMap((g) => g.pins),
  ];
  const showsUngrouped = allBlocks.ungrouped.length > 0 || allBlocks.groups.length === 0;
  const activeSelection = isSearching
    ? resolveGroupSelection(
        searchGroupOverride ?? { kind: "all" },
        allBlocks.groups,
        showsUngrouped,
      )
    : resolveGroupSelection(selectedGroup, allBlocks.groups, showsUngrouped);

  const selectGroup = (target: SettingsGroupSelection) => {
    if (isSearching) {
      setSearchGroupOverride(target);
    } else {
      setSelectedGroup(target);
      writeStoredGroup(target);
    }
  };

  const jumpToModel = (pin: ModelPin, sectionId: string | null) => {
    const target: SettingsGroupSelection = sectionId
      ? { kind: "group", sectionId }
      : { kind: "ungrouped" };
    setSelectedGroup(target);
    writeStoredGroup(target);
    if (isSearching) setSearchGroupOverride(target);
    const id = pinId(pin);
    setHighlightedPin(id);
    if (typeof window !== "undefined") {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedPin((cur) => (cur === id ? null : cur));
      }, 1400);
    }
  };

  const catalogModels: CodexModelOption[] =
    catalog?.state === "ready" ? catalog.models : [];
  const pinnedIds = new Set(pins.map(pinId));
  const hideOutdated = settings?.hideOutdatedModels ?? true;
  const catalogProtected = protectedModelIds(
    { modelList: pins, hydraPairs: settings?.hydraPairs },
    "codex",
  );
  const visibleCatalog =
    hideOutdated && !isSearching
      ? simplifiedModels(catalogModels, {
          isProtected: (m) => catalogProtected.has(m.id),
        })
      : catalogModels;
  const catalogMatches = visibleCatalog.filter(
    (m) =>
      !isSearching ||
      m.name.toLowerCase().includes(trimmed) ||
      m.id.toLowerCase().includes(trimmed) ||
      (m.detail?.toLowerCase().includes(trimmed) ?? false) ||
      "codex".includes(trimmed),
  );

  const onChipOrPinDrop = (e: React.DragEvent, targetPin: ModelPin) => {
    e.preventDefault();
    e.stopPropagation();
    ctrl.dropOnPin(targetPin, isSearching);
  };

  const onWallGroupDrop = (e: React.DragEvent, sectionId: string | null) => {
    e.preventDefault();
    ctrl.dropOnWallGroup(sectionId, isSearching);
  };

  const onRailDrop = (e: React.DragEvent, targetSectionId: string | null) => {
    e.preventDefault();
    ctrl.dropOnRail(targetSectionId, isSearching);
  };

  const countText = (n: number) =>
    n === 1 ? t("1 model") : t("%d models").replace("%d", String(n));

  const summary = (pin: ModelPin): string => {
    const opt = optionById.get(pin.modelID);
    const pref = prefs[prefKey(pin.provider, pin.modelID)];
    const parts = [t("Codex")];
    if (opt && opt.efforts.length > 0) {
      const eff = pref?.effort ?? opt.defaultEffort;
      if (eff) parts.push(`${t(effortTitle(eff))} ${t("effort")}`);
    }
    if (pref?.fastMode === true && opt?.fastTier) parts.push(t("Fast"));
    return parts.join(" · ");
  };

  const activeSection =
    activeSelection.kind === "group"
      ? sections.find((s) => s.id === activeSelection.sectionId) ?? null
      : null;
  const activeGroupPins: ModelPin[] = (() => {
    const src = isSearching ? filteredBlocks : allBlocks;
    if (activeSelection.kind === "all") return isSearching ? visiblePins : allVisiblePins;
    if (activeSelection.kind === "ungrouped") return src.ungrouped;
    return src.groups.find((g) => g.section.id === activeSelection.sectionId)?.pins ?? [];
  })();

  const headerTitle =
    activeSelection.kind === "all"
      ? t("All")
      : activeSelection.kind === "ungrouped"
        ? t("Ungrouped")
        : (activeSection?.name ?? t("Group"));
  const headerSubtitle = isSearching
    ? countText(activeGroupPins.length)
    : activeSelection.kind === "all"
      ? `${countText(activeGroupPins.length)} · ${t("Click a model to jump to its group")}`
      : `${countText(activeGroupPins.length)} · ${t("Effort and fast mode apply immediately")}`;

  const pinRow = (pin: ModelPin, sectionId: string | null, first: boolean) => {
    const opt = optionById.get(pin.modelID);
    const name = opt?.name ?? pin.modelID;
    const id = pinId(pin);
    const isHi = highlightedPin === id;
    return (
      <div
        key={id}
        className={`ml-pin${first ? " first" : ""}${isHi ? " highlighted" : ""}${dropHint === `pin:${id}` ? " drop-hint" : ""}`}
        draggable={!isSearching}
        title={t("Drag to reorder or into another group")}
        onDragStart={(e) => {
          dragRef.current = id;
          e.dataTransfer.setData("text/plain", id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          dragRef.current = null;
          setDropHint(null);
        }}
        onDragOver={(e) => {
          if (isSearching || !dragRef.current || dragRef.current === id || dragRef.current.startsWith("section/")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropHint(`pin:${id}`);
        }}
        onDragLeave={() => setDropHint((h) => (h === `pin:${id}` ? null : h))}
        onDrop={(e) => onChipOrPinDrop(e, pin)}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu(null);
          setEffortPop({
            pin,
            x: Math.min(rect.right - 330, window.innerWidth - 340),
            y: rect.bottom + 4,
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setEffortPop(null);
          setMenu({ x: e.clientX, y: e.clientY, kind: "pin", pin, pinSection: sectionId });
        }}
      >
        <span className="ml-grip" aria-hidden="true">⠿</span>
        <span className="ml-provider" aria-hidden="true">◆</span>
        <span className="ml-name">{name}</span>
        <span className="ml-summary">{summary(pin)}</span>
        <button
          className="ml-tune"
          title={t("Default effort and fast mode")}
          aria-label={t("Default effort and fast mode")}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setEffortPop({
              pin,
              x: Math.min(rect.left, window.innerWidth - 340),
              y: rect.bottom + 4,
            });
          }}
        >
          ≡
        </button>
        <button
          className="ml-remove"
          title={t("Remove from the picker")}
          aria-label={t("Remove from the picker")}
          onClick={(e) => {
            e.stopPropagation();
            ctrl.removePin(pin);
          }}
        >
          ⊖
        </button>
      </div>
    );
  };

  const wallGroups: {
    id: string;
    title: string;
    selection: SettingsGroupSelection;
    sectionId: string | null;
    pins: ModelPin[];
  }[] = [];
  const wallSource = isSearching ? filteredBlocks : allBlocks;
  if (wallSource.ungrouped.length > 0) {
    wallGroups.push({
      id: "ungrouped",
      title: t("Ungrouped"),
      selection: { kind: "ungrouped" },
      sectionId: null,
      pins: wallSource.ungrouped,
    });
  }
  for (const b of wallSource.groups) {
    if (b.pins.length > 0) {
      wallGroups.push({
        id: b.section.id,
        title: b.section.name,
        selection: { kind: "group", sectionId: b.section.id },
        sectionId: b.section.id,
        pins: b.pins,
      });
    }
  }

  const codexPinCount = pins.filter((p) => p.provider === "codex").length;
  const showCodexCard =
    catalogueSelection === null || catalogueSelection === "codex";

  return (
    <div className="ml-settings">
      <input
        className="ml-search"
        type="search"
        placeholder={t("Search models")}
        aria-label={t("Search models")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSearchGroupOverride(null);
        }}
      />

      <div className="ml-head">
        <span className="ml-head-title">{t("Your models")}</span>
        <span className="ml-head-count">{`${pins.length} / ${MODEL_LIST_LIMIT}`}</span>
      </div>

      <div className="ml-two-col">
        <div className="ml-rail" role="navigation" aria-label={t("Model groups")}>
          <button
            type="button"
            className={`ml-rail-card${activeSelection.kind === "all" ? " active" : ""}${isSearching && visiblePins.length === 0 ? " dimmed" : ""}`}
            onClick={() => selectGroup({ kind: "all" })}
          >
            <div className="ml-rail-top">
              <span className="ml-rail-title">{t("All")}</span>
              <span className="ml-rail-badge">
                {isSearching ? visiblePins.length : allVisiblePins.length}
              </span>
            </div>
            <span className="ml-rail-sub">
              {(isSearching ? visiblePins.length : allVisiblePins.length) > 0
                ? t("Codex")
                : t("Empty")}
            </span>
          </button>

          <div className="ml-rail-sep" />

          {showsUngrouped && (() => {
            const ungroupedPins = isSearching
              ? filteredBlocks.ungrouped
              : allBlocks.ungrouped;
            return (
              <button
                type="button"
                data-rail-target="ungrouped"
                className={`ml-rail-card${activeSelection.kind === "ungrouped" ? " active" : ""}${dropHint === "rail:ungrouped" ? " drop-hint" : ""}${isSearching && ungroupedPins.length === 0 ? " dimmed" : ""}`}
                onClick={() => selectGroup({ kind: "ungrouped" })}
                onDragOver={(e) => {
                  if (!dragRef.current || dragRef.current.startsWith("section/")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropHint("rail:ungrouped");
                }}
                onDragLeave={() =>
                  setDropHint((h) => (h === "rail:ungrouped" ? null : h))
                }
                onDrop={(e) => onRailDrop(e, null)}
              >
                <div className="ml-rail-top">
                  <span className="ml-rail-title">{t("Ungrouped")}</span>
                  <span className="ml-rail-badge">{ungroupedPins.length}</span>
                </div>
                <span className="ml-rail-sub">
                  {ungroupedPins.length > 0 ? t("Codex") : t("Empty")}
                </span>
              </button>
            );
          })()}

          {allBlocks.groups.map((g) => {
            const displayPins = isSearching
              ? (filteredBlocks.groups.find((x) => x.section.id === g.section.id)?.pins ?? [])
              : g.pins;
            const isSel =
              activeSelection.kind === "group" &&
              activeSelection.sectionId === g.section.id;
            const hintKey = `rail:section/${g.section.id}`;
            return (
              <button
                key={g.section.id}
                type="button"
                data-rail-target={g.section.id}
                className={`ml-rail-card${isSel ? " active" : ""}${dropHint === hintKey ? " drop-hint" : ""}${isSearching && displayPins.length === 0 ? " dimmed" : ""}`}
                draggable={!isSearching}
                onClick={() => selectGroup({ kind: "group", sectionId: g.section.id })}
                onDragStart={(e) => {
                  dragRef.current = `section/${g.section.id}`;
                  e.dataTransfer.setData("text/plain", `section/${g.section.id}`);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  dragRef.current = null;
                  setDropHint(null);
                }}
                onDragOver={(e) => {
                  if (!dragRef.current) return;
                  if (dragRef.current === `section/${g.section.id}`) return;
                  if (isSearching && dragRef.current.startsWith("section/")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropHint(hintKey);
                }}
                onDragLeave={() => setDropHint((h) => (h === hintKey ? null : h))}
                onDrop={(e) => onRailDrop(e, g.section.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setEffortPop(null);
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    kind: "section",
                    sectionId: g.section.id,
                  });
                }}
              >
                <div className="ml-rail-top">
                  <span className="ml-rail-title">{g.section.name}</span>
                  <span className="ml-rail-badge">{displayPins.length}</span>
                </div>
                <span className="ml-rail-sub">
                  {displayPins.length > 0 ? t("Codex") : t("Empty")}
                </span>
              </button>
            );
          })}

          {!isSearching && (
            <button
              type="button"
              className="ml-newgroup-rail"
              onClick={() => ctrl.addNewGroup(t("New group"))}
            >
              + {t("New group")}
            </button>
          )}
        </div>

        <div className="ml-card ml-detail-card">
          <div
            className="ml-detail-head"
            onContextMenu={(e) => {
              if (!activeSection) return;
              e.preventDefault();
              setEffortPop(null);
              setMenu({
                x: e.clientX,
                y: e.clientY,
                kind: "section",
                sectionId: activeSection.id,
              });
            }}
          >
            <div className="ml-detail-head-text">
              <div className="ml-detail-title-row">
                {activeSection && editingId === activeSection.id ? (
                  <input
                    className="ml-rename"
                    value={draft}
                    maxLength={200}
                    autoFocus
                    aria-label={t("Group name")}
                    onChange={(e) => {
                      const val = e.target.value;
                      draftRef.current = val;
                      setDraft(val);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") ctrl.commitRename(activeSection.id);
                      if (e.key === "Escape") ctrl.cancelRename(activeSection.id);
                    }}
                    onBlur={() => ctrl.commitRename(activeSection.id)}
                  />
                ) : activeSection ? (
                  <>
                    <span
                      className="ml-group-name"
                      onDoubleClick={() => ctrl.startRename(activeSection)}
                    >
                      {activeSection.name}
                    </span>
                    <span className="ml-group-actions">
                      <button
                        className="ml-icobtn"
                        title={t("Rename group")}
                        aria-label={t("Rename group")}
                        onClick={() => ctrl.startRename(activeSection)}
                      >
                        ✎
                      </button>
                      <button
                        className="ml-icobtn"
                        title={t("Ungroup. Models stay in the list.")}
                        aria-label={t("Ungroup")}
                        onClick={() => ctrl.removeSection(activeSection.id)}
                      >
                        🗑
                      </button>
                    </span>
                  </>
                ) : (
                  <span className="ml-group-name">{headerTitle}</span>
                )}
              </div>
              <span className="ml-detail-sub">{headerSubtitle}</span>
            </div>
          </div>

          <div className="ml-detail-body">
            {pins.length === 0 ? (
              <div className="ml-row">
                <div className="ml-row-main">
                  <span className="ml-name">{t("No models chosen yet")}</span>
                  <span className="ml-detail">
                    {t("Until you add some below, the picker shows every model from your providers.")}
                  </span>
                </div>
              </div>
            ) : activeSelection.kind === "all" ? (
              isSearching && visiblePins.length === 0 ? (
                <div className="ml-empty-note">{t("No matching models")}</div>
              ) : (
                <div className="ml-wall">
                  {wallGroups.map((group) => {
                    const wallHintKey = `wall-group:${group.id}`;
                    return (
                      <div
                        key={group.id}
                        data-wall-group={group.id}
                        className={`ml-wall-group${dropHint === wallHintKey ? " drop-hint" : ""}`}
                        onDragOver={(e) => {
                          if (
                            isSearching ||
                            !dragRef.current ||
                            dragRef.current.startsWith("section/")
                          ) {
                            return;
                          }
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (!(e.target as HTMLElement).closest?.(".ml-chip")) {
                            setDropHint(wallHintKey);
                          }
                        }}
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            setDropHint((h) => (h === wallHintKey ? null : h));
                          }
                        }}
                        onDrop={(e) => {
                          if ((e.target as HTMLElement).closest?.(".ml-chip")) return;
                          onWallGroupDrop(e, group.sectionId);
                        }}
                      >
                        <button
                          type="button"
                          className="ml-wall-head"
                          onClick={() => selectGroup(group.selection)}
                        >
                          <span className="ml-wall-title">{group.title}</span>
                          <span className="ml-wall-count">{group.pins.length}</span>
                          <span className="ml-wall-chev" aria-hidden="true">›</span>
                        </button>
                        <div className="ml-chip-flow">
                          {group.pins.map((pin) => {
                            const opt = optionById.get(pin.modelID);
                            const displayName = opt?.name ?? pin.modelID;
                            const id = pinId(pin);
                            const pref = prefs[prefKey(pin.provider, pin.modelID)];
                            const showsFast = pref?.fastMode === true && !!opt?.fastTier;
                            return (
                              <button
                                key={id}
                                type="button"
                                data-pin-id={id}
                                className={`ml-chip${dropHint === `chip:${id}` ? " drop-hint" : ""}`}
                                draggable={!isSearching}
                                title={`${displayName} · ${t("Codex")}`}
                                onClick={() => jumpToModel(pin, group.sectionId)}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setEffortPop(null);
                                  setMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    kind: "pin",
                                    pin,
                                    pinSection: group.sectionId,
                                  });
                                }}
                                onDragStart={(e) => {
                                  dragRef.current = id;
                                  e.dataTransfer.setData("text/plain", id);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                onDragEnd={() => {
                                  dragRef.current = null;
                                  setDropHint(null);
                                }}
                                onDragOver={(e) => {
                                  if (
                                    isSearching ||
                                    !dragRef.current ||
                                    dragRef.current === id ||
                                    dragRef.current.startsWith("section/")
                                  ) {
                                    return;
                                  }
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = "move";
                                  setDropHint(`chip:${id}`);
                                }}
                                onDragLeave={() =>
                                  setDropHint((h) => (h === `chip:${id}` ? null : h))
                                }
                                onDrop={(e) => onChipOrPinDrop(e, pin)}
                              >
                                <span className="ml-provider" aria-hidden="true">◆</span>
                                <span className="ml-chip-name">{displayName}</span>
                                {showsFast && (
                                  <span className="ml-chip-fast" aria-hidden="true">⚡</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : activeGroupPins.length === 0 ? (
              <div className="ml-empty-note">
                {isSearching ? t("No matching models") : t("No models in this group")}
              </div>
            ) : (
              <div className="ml-detail-list">
                {activeGroupPins.map((p, i) =>
                  pinRow(
                    p,
                    activeSelection.kind === "group" ? activeSelection.sectionId : null,
                    i === 0,
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {!isSearching && (
        <p className="codex-note">
          {t(
            "Set this model's default reasoning effort and fast mode. New chats may inherit the current chat or a Hydra preset instead. Right-click to move the model to another group.",
          )}
        </p>
      )}

      <div className="ml-head">
        <span className="ml-head-title">{t("Browse all models")}</span>
      </div>

      {!isSearching && (
        <>
          <div className="choice-row">
            <button
              role="switch"
              aria-checked={hideOutdated}
              className={`choice${hideOutdated ? " active" : ""}`}
              onClick={() => write({ hideOutdatedModels: !hideOutdated })}
            >
              {t("Hide outdated models")}
            </button>
          </div>
          <p className="codex-note">
            {t(
              "Show the three newest versions of each model and one row per model instead of one per effort. Chosen and in-use models always show.",
            )}
          </p>
        </>
      )}

      <div className="ml-two-col">
        <div className="ml-rail ml-rail-sticky">
          <button
            type="button"
            className={`ml-rail-card${catalogueSelection === null ? " active" : ""}`}
            onClick={() => setCatalogueSelection(null)}
          >
            <div className="ml-rail-top">
              <span className="ml-rail-title">{t("All models")}</span>
              {pins.length > 0 && <span className="ml-rail-badge">{pins.length}</span>}
            </div>
          </button>
          <div className="ml-rail-sep" />
          <button
            type="button"
            className={`ml-rail-card${catalogueSelection === "codex" ? " active" : ""}`}
            onClick={() => setCatalogueSelection("codex")}
          >
            <div className="ml-rail-top">
              <span className="ml-rail-title">{t("Codex")}</span>
              {codexPinCount > 0 && (
                <span className="ml-rail-badge">{codexPinCount}</span>
              )}
            </div>
          </button>
        </div>

        <div className="ml-card ml-catalog-card">
          {showCodexCard && (
            <>
              <div className="ml-catalog-head">
                <span className="ml-provider" aria-hidden="true">◆</span>
                <span className="ml-catalog-title">{t("Codex")}</span>
              </div>
              {catalog === null ? (
                <div className="ml-row">
                  <span className="ml-detail">{t("Loading model list…")}</span>
                </div>
              ) : catalog.state !== "ready" ? (
                <div className="ml-row">
                  <span className="ml-detail">{translateError(t, catalog.reason)}</span>
                </div>
              ) : catalogMatches.length === 0 ? (
                <div className="ml-row">
                  <span className="ml-detail">
                    {!isSearching
                      ? t("No models reported")
                      : `${t("No models match")} “${query.trim()}”.`}
                  </span>
                </div>
              ) : (
                catalogMatches.map((m, idx) => {
                  const pid = `codex/${m.id}`;
                  const isPinned = pinnedIds.has(pid);
                  const full = pins.length >= MODEL_LIST_LIMIT;
                  return (
                    <div key={m.id} className={`ml-pin static${idx === 0 ? " first" : ""}`}>
                      <span className="ml-provider" aria-hidden="true">◆</span>
                      <span className="ml-name">
                        {m.name}
                        {m.isDefault ? " ★" : ""}
                      </span>
                      <span className="ml-summary">
                        {m.detail ? t(m.detail) : ""}
                        {m.efforts.length > 0 ? ` · ${m.efforts.length} ${t("efforts")}` : ""}
                      </span>
                      <button
                        className={`ml-add${isPinned ? " pinned" : ""}`}
                        disabled={!isPinned && full}
                        title={
                          isPinned
                            ? t("Remove from the picker")
                            : full
                              ? t("The picker is full (30 models)")
                              : t("Add to the picker")
                        }
                        aria-label={
                          isPinned ? t("Remove from the picker") : t("Add to the picker")
                        }
                        onClick={() => {
                          ctrl.toggleCatalogPin(
                            { provider: "codex", modelID: m.id },
                            isPinned,
                          );
                        }}
                      >
                        {isPinned ? "✓" : "+"}
                      </button>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      </div>

      {menu !== null && (
        <div
          className="link-pop msg-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, Math.max(8, window.innerWidth - 240)),
            top: Math.min(menu.y, Math.max(8, window.innerHeight - 200)),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.kind === "pin" && menu.pin ? (
            <>
              <div className="menu-caption">{t("Move to Group")}</div>
              {menu.pinSection != null && (
                <button
                  role="menuitem"
                  className="suggest-row msg-row"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    ctrl.movePinToSection(menu.pin!, null);
                    setMenu(null);
                  }}
                >
                  <span className="suggest-name">{t("No Group")}</span>
                </button>
              )}
              {sections
                .filter((s) => s.id !== menu.pinSection)
                .map((s) => (
                  <button
                    key={s.id}
                    role="menuitem"
                    className="suggest-row msg-row"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      ctrl.movePinToSection(menu.pin!, s.id);
                      setMenu(null);
                    }}
                  >
                    <span className="suggest-name">{s.name}</span>
                  </button>
                ))}
              <button
                role="menuitem"
                className="suggest-row msg-row group-start"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  ctrl.removePin(menu.pin!);
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Remove from the picker")}</span>
              </button>
            </>
          ) : menu.sectionId ? (
            <>
              <button
                role="menuitem"
                className="suggest-row msg-row"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const s = sections.find((x) => x.id === menu.sectionId);
                  if (s) {
                    selectGroup({ kind: "group", sectionId: s.id });
                    ctrl.startRename(s);
                  }
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Rename")}</span>
              </button>
              <button
                role="menuitem"
                className="suggest-row msg-row"
                disabled={allBlocks.groups.findIndex((g) => g.section.id === menu.sectionId) <= 0}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  ctrl.moveSection(menu.sectionId!, -1);
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Move Up")}</span>
              </button>
              <button
                role="menuitem"
                className="suggest-row msg-row"
                disabled={
                  allBlocks.groups.findIndex((g) => g.section.id === menu.sectionId) ===
                  allBlocks.groups.length - 1
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  ctrl.moveSection(menu.sectionId!, 1);
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Move Down")}</span>
              </button>
              <button
                role="menuitem"
                className="suggest-row msg-row group-start"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  ctrl.removeSection(menu.sectionId!);
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Ungroup")}</span>
              </button>
            </>
          ) : null}
        </div>
      )}

      {effortPop !== null && (
        <EffortCard
          pin={effortPop.pin}
          option={optionById.get(effortPop.pin.modelID)}
          x={Math.max(8, effortPop.x)}
          y={effortPop.y}
          pref={prefs[prefKey(effortPop.pin.provider, effortPop.pin.modelID)]}
          onPref={(p) => ctrl.updatePref(effortPop.pin, p)}
          onClose={() => setEffortPop(null)}
        />
      )}
    </div>
  );
}

/** Frozen EffortSliderCard — per-pin default effort + fast mode, Reset
 *  clears the whole preference. Effort choices come from the catalog
 *  option only; no catalog means the honest stored value plus nothing
 *  selectable. */
function EffortCard(props: {
  pin: ModelPin;
  option: CodexModelOption | undefined;
  x: number;
  y: number;
  pref: ModelPreference | undefined;
  onPref: (p: ModelPreference) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const opt = props.option;
  const efforts = orderedEfforts(opt?.efforts ?? []);
  const effort = props.pref?.effort;
  const fast = props.pref?.fastMode === true;
  return (
    <div className="link-pop effort-pop" style={{ left: props.x, top: props.y }}>
      <div className="effort-title">{opt?.name ?? props.pin.modelID}</div>
      <button
        role="radio"
        aria-checked={effort === undefined}
        className={`suggest-row msg-row${effort === undefined ? " chosen" : ""}`}
        onClick={() => props.onPref({ effort: undefined, fastMode: fast })}
      >
        <span className="suggest-name">{t("Default (provider decides)")}</span>
      </button>
      {efforts.map((e) => (
        <button
          key={e}
          role="radio"
          aria-checked={effort === e}
          className={`suggest-row msg-row${effort === e ? " chosen" : ""}`}
          onClick={() => props.onPref({ effort: e, fastMode: fast })}
        >
          <span className="suggest-name">
            {t(effortTitle(e))}
            {opt?.defaultEffort === e ? ` (${t("model default")})` : ""}
          </span>
        </button>
      ))}
      {opt?.fastTier && (
        <label className="effort-fast">
          <input
            type="checkbox"
            checked={fast}
            onChange={(e) => props.onPref({ effort, fastMode: e.target.checked })}
          />
          {t("Fast")}
        </label>
      )}
      <div className="effort-actions">
        <button
          className="ml-newgroup"
          onClick={() => props.onPref({ effort: undefined, fastMode: undefined })}
        >
          {t("Reset")}
        </button>
        <button className="ml-newgroup" onClick={props.onClose}>
          {t("Done")}
        </button>
      </div>
    </div>
  );
}
