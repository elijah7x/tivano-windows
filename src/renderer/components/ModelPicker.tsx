// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Per-thread Codex model/effort picker (P2-56 / F17). The catalog is
// provider-owned state fetched via models:list — pending until a Codex
// session binds, honest when unavailable. Follows Settings > Models
// groups both in `<select>` optgroups and in the two-column group-aware
// popover when user groups exist. Selections persist on the thread and
// apply to the NEXT turn only; a running turn is never retargeted.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ChatThread, CodexModelCatalog, CodexModelOption } from "../../shared/types";
import { rectToAnchor, type AnchorRect } from "../../shared/popoverAnchor";
import { anchoredPopoverStyle, useAnchoredPopover } from "../useAnchoredPopover";
import {
  pairCustomName,
  pairHeadsProvider,
  pairSendsHeadsElsewhere,
  type HydraPair,
} from "../../shared/hydra";
import {
  PickerModelsCache,
  cachedPickerModels,
  defaultPickerCategory,
  partitionPickerModels,
  pickerCategoryKey,
  pickerPairMatches,
  pickerPairModelsTitle,
  pickerPairTitle,
  prefKey,
  protectedModelIds,
  resolvePickerCategory,
  resolveRecentPickerModel,
  resolveRecentPickerPair,
  sharedPickerModelsCache,
  type ModelPin,
  type PickerCategory,
  type PickerEntry,
} from "../../shared/modelList";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { api, callApi, tryCall, clientStore } from "../client";

/** Canonical effort key normalizing casing and Extra High aliases. */
function canonicalEffortKey(effort: string): string {
  const lower = effort.trim().toLowerCase();
  if (
    lower === "xhigh" ||
    lower === "x-high" ||
    lower === "extra-high" ||
    lower === "extra_high" ||
    lower === "extra high"
  ) {
    return "xhigh";
  }
  return lower;
}

const EFFORT_RANKS = new Map<string, number>([
  ["none", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
  ["ultra", 6],
]);

/** Frozen Provider.swift effortRank — low to high ordering whatever
 *  order the agent lists levels in; unknown levels keep their place. */
function effortRank(effort: string): number | undefined {
  return EFFORT_RANKS.get(canonicalEffortKey(effort));
}
function findEffortIndex(
  efforts: readonly string[],
  candidate: string | undefined | null,
): number {
  if (!candidate) return -1;
  const exact = efforts.indexOf(candidate);
  if (exact >= 0) return exact;
  const canonical = canonicalEffortKey(candidate);
  if (canonical === "") return -1;
  return efforts.findIndex((e) => canonicalEffortKey(e) === canonical);
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
function effortTitle(effort: string): string {
  const canonical = canonicalEffortKey(effort);
  if (canonical === "xhigh") {
    return "Extra High";
  }
  if (canonical === "") return "Default";
  if (effortRank(canonical) !== undefined) {
    return canonical.charAt(0).toUpperCase() + canonical.slice(1);
  }
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

const EMPTY_MODELS: CodexModelOption[] = [];
const EMPTY_PINS: ModelPin[] = [];
const EMPTY_SECTIONS: NonNullable<
  NonNullable<typeof clientStore.snapshot>["settings"]["modelSections"]
> = [];

export interface ModelPickerProps {
  thread: ChatThread;
  readOnly?: boolean;
  initialCatalog?: CodexModelCatalog | null;
  initialOpen?: boolean;
  initialModelsExpanded?: boolean;
  initialQuery?: string;
  trimCache?: PickerModelsCache<CodexModelOption>;
  onTrimCompute?: () => void;
}

export function ModelPicker(props: ModelPickerProps): React.JSX.Element {
  const t = useT();
  const { thread } = props;
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(
    props.initialCatalog ?? null,
  );
  const [popOpen, setPopOpen] = useState(props.initialOpen ?? false);
  const [modelsExpanded, setModelsExpanded] = useState(
    props.initialModelsExpanded ?? (props.initialOpen ? true : false),
  );
  const [pickerQuery, setPickerQuery] = useState(props.initialQuery ?? "");
  const [selectedCategory, setSelectedCategory] = useState<PickerCategory | null>(null);
  const [activeLeftKey, setActiveLeftKey] = useState<string | null>(null);
  const [activeRightKey, setActiveRightKey] = useState<string | null>(null);
  const [popTrigger, setPopTrigger] = useState<"model" | "effort">("model");
  const [openAnchor, setOpenAnchor] = useState<AnchorRect | null>(null);
  const gen = useRef(0);
  const popRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lastTriggerRef = useRef<"model" | "effort">("model");
  const prevOpenExpandedRef = useRef(
    (props.initialOpen ?? false) &&
      (props.initialModelsExpanded ?? ((props.initialOpen ?? false) ? true : false)),
  );
  const searchRef = useRef<HTMLInputElement | null>(null);
  const leftColRef = useRef<HTMLDivElement | null>(null);
  const rightColRef = useRef<HTMLDivElement | null>(null);

  const refresh = () => {
    if (props.initialCatalog !== undefined) return;
    const g = ++gen.current;
    api()
      .invoke("models:list", {})
      .then((c) => {
        if (gen.current === g) setCatalog(c as CodexModelCatalog);
      })
      .catch((e) => {
        if (gen.current === g)
          setCatalog({ state: "unavailable", reason: (e as Error)?.message ?? String(e) });
      });
  };

  const focusTrigger = () =>
    (lastTriggerRef.current === "effort" ? effortTriggerRef.current : triggerRef.current)?.focus();

  // First fetch on mount/thread switch; the dropdown ALSO refreshes on
  // open so "no session yet" self-heals once a turn binds one.
  useEffect(refresh, [thread.id, props.initialCatalog]);

  useEffect(() => {
    if (!popOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPopOpen(false);
        focusTrigger();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setPopOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [popOpen]);

  const models: CodexModelOption[] =
    catalog?.state === "ready" ? catalog.models : EMPTY_MODELS;
  const settings = clientStore.snapshot?.settings;
  const pinnedList: ModelPin[] = settings?.modelList ?? EMPTY_PINS;
  const pinnedSections = settings?.modelSections ?? EMPTY_SECTIONS;
  const usePins = pinnedList.length > 0;
  const hasUserGroups = pinnedSections.length > 0;
  const selected = thread.codexModel ?? "";
  const hideOutdated = settings?.hideOutdatedModels ?? true;
  const recentModelId = settings?.lastNewChatModel?.provider === "codex"
    ? settings.lastNewChatModel.modelID
    : "";
  // P1-25 / P1-24: frozen hidesOutdatedModels + PickerModelsCache —
  // the unpinned catalog trims once per change of models or settings
  // (never on keystrokes or unrelated renders); the thread's own model,
  // recent model, pins and Hydra pair models always stay (frozen protectedModelIDs).
  const protectedIds = useMemo(
    () => {
      const extra: string[] = [];
      if (selected !== "") extra.push(selected);
      if (recentModelId !== "" && recentModelId !== selected) extra.push(recentModelId);
      return protectedModelIds(
        { modelList: pinnedList, hydraPairs: settings?.hydraPairs },
        "codex",
        extra,
      );
    },
    [pinnedList, settings?.hydraPairs, selected, recentModelId],
  );
  const visibleModels = useMemo(() => {
    if (usePins) return models;
    return cachedPickerModels(models, {
      provider: "codex",
      hideOutdatedModels: hideOutdated,
      protectedIds,
      cache:
        props.trimCache ??
        (sharedPickerModelsCache as unknown as PickerModelsCache<CodexModelOption>),
      onCompute: props.onTrimCompute,
    });
  }, [usePins, models, hideOutdated, protectedIds, props.trimCache, props.onTrimCompute]);
  const optionById = useMemo(
    () => new Map(models.map((m) => [m.id, m])),
    [models],
  );
  const partition = useMemo(
    () => partitionPickerModels(pinnedList, pinnedSections, visibleModels, optionById, selected),
    [pinnedList, pinnedSections, visibleModels, optionById, selected],
  );

  // P1-36: the sub-agent mode row from the frozen picker's
  // SubagentModeRow set, bounded to a select in the model menu — shown
  // while Hydra runs for app and chat; heads never get a mode.
  const hydraOn =
    settings?.hydraEnabled !== false &&
    thread.hydraEnabled !== false &&
    !thread.hydraHead;
  const subagentVisible = hydraOn;
  const subagentMode =
    thread.subagentMode ?? (thread.hydraPairId ? "preset" : "same");
  const pairs: HydraPair[] = hydraOn ? (settings?.hydraPairs ?? []) : [];
  const activePair =
    hydraOn && subagentMode === "preset" && thread.hydraPairId
      ? pairs.find((p) => p.id === thread.hydraPairId)
      : undefined;
  const leadsWithPair = activePair !== undefined;
  const showsPairs = pairs.length > 0;
  const twoColumns = !hasUserGroups && showsPairs;

  const initialCat = defaultPickerCategory(partition, selected, {
    leadsWithPair,
    hasPairs: showsPairs,
  });
  const activeCategory =
    resolvePickerCategory(selectedCategory, partition, { hasPairs: showsPairs }) ?? initialCat;

  const activeTriggerRef = popTrigger === "effort" ? effortTriggerRef : triggerRef;
  const pickerEstimatedSize = useMemo(
    () =>
      !modelsExpanded
        ? { width: 310, height: 140 }
        : hasUserGroups
          ? { width: 390, height: 400 }
          : twoColumns
            ? { width: 520, height: 420 }
            : { width: 320, height: 400 },
    [modelsExpanded, hasUserGroups, twoColumns],
  );
  const { popRef: dialogRef, position: dialogPos } = useAnchoredPopover<HTMLDivElement>({
    open: popOpen,
    targetKey: popOpen ? `${thread.id}:${popTrigger}` : null,
    initialAnchor: openAnchor,
    anchorRef: activeTriggerRef,
    estimatedSize: pickerEstimatedSize,
    preferredSide: "top",
    align: "start",
    constrainSideHeight: true,
    gap: 6,
    layoutKey: `${modelsExpanded}:${hasUserGroups}:${twoColumns}:${models.length}:${pairs.length}:${pickerQuery}:${pickerCategoryKey(activeCategory)}:${catalog?.state ?? "null"}`,
  });

  const isOpenExpanded = popOpen && modelsExpanded;
  useLayoutEffect(() => {
    if (isOpenExpanded && !prevOpenExpandedRef.current) {
      searchRef.current?.focus({ preventScroll: true });
    }
    prevOpenExpandedRef.current = isOpenExpanded;
  }, [isOpenExpanded]);
  const currentGroupMatch = partition.groups.find((g) =>
    g.items.some((i) => i.modelId === selected),
  );

  const modelLabelById = (_provider: string, id: string | undefined): string | undefined =>
    id ? (optionById.get(id)?.name ?? id) : undefined;
  const providerLabel = (provider: string): string =>
    provider === "codex" ? "Codex" : provider;
  const pairTitle = (pair: HydraPair): string =>
    pickerPairTitle(
      pair,
      modelLabelById,
      providerLabel,
      (prov) => t("Any %@ model", prov),
      (lead) => t("%@ + itself", lead),
    );
  const pairModelsSub = (pair: HydraPair): string =>
    pickerPairModelsTitle(
      pair,
      modelLabelById,
      providerLabel,
      (prov) => t("Any %@ model", prov),
      (lead) => t("%@ + itself", lead),
    );
  const pairDetail = (pair: HydraPair): string => {
    const parts: string[] = [];
    if (pairCustomName(pair)) parts.push(pairModelsSub(pair));
    if (pairSendsHeadsElsewhere(pair)) {
      parts.push(
        t("%@ lead, %@ heads", providerLabel(pair.provider), providerLabel(pairHeadsProvider(pair))),
      );
    }
    const effortParts: string[] = [];
    if (pair.orchestratorEffort) effortParts.push(t(effortTitle(pair.orchestratorEffort)));
    if (
      pair.workerEffort &&
      (!pair.orchestratorEffort ||
        canonicalEffortKey(pair.workerEffort) !== canonicalEffortKey(pair.orchestratorEffort))
    ) {
      effortParts.push(t(effortTitle(pair.workerEffort)));
    }
    if (effortParts.length > 0) parts.push(effortParts.join(" / "));
    if (pair.maxHeads !== undefined) parts.push(t("Up to %d", String(pair.maxHeads)));
    if (parts.length === 0) parts.push(providerLabel(pair.provider));
    return parts.join(" · ");
  };

  const activeGroupLabel = activePair
    ? pairTitle(activePair)
    : currentGroupMatch
      ? currentGroupMatch.section.name
      : t("All");
  const selectedModel = models.find((m) => m.id === selected);
  const efforts = orderedEfforts(selectedModel?.efforts ?? []);
  const selectedEffort = thread.codexEffort ?? "";
  const selectedEffortIndex = findEffortIndex(efforts, selectedEffort);
  const defaultEffortIndex = findEffortIndex(efforts, selectedModel?.defaultEffort);
  const resolvedIndex = (() => {
    if (efforts.length === 0) return -1;
    if (selectedEffortIndex >= 0) return selectedEffortIndex;
    if (defaultEffortIndex >= 0) return defaultEffortIndex;
    const medIdx = findEffortIndex(efforts, "medium");
    return medIdx >= 0 ? medIdx : 0;
  })();
  const resolvedEffort =
    resolvedIndex >= 0
      ? efforts[resolvedIndex]!
      : selectedEffort !== ""
        ? selectedEffort
        : "";
  const selectEffortValue =
    selectedEffortIndex >= 0 ? efforts[selectedEffortIndex]! : selectedEffort;
  const reasoningLabel =
    resolvedEffort !== ""
      ? t(effortTitle(resolvedEffort))
      : catalog?.state === "ready" && selectedModel
        ? t("Standard")
        : t("Default");
  const isMaxEffort = efforts.length > 1 && resolvedIndex === efforts.length - 1;
  const reported = thread.codexModelReported
    ? `${thread.codexModelReported}${thread.codexEffortReported ? ` / ${thread.codexEffortReported}` : ""}`
    : null;
  const tierId = thread.codexServiceTier ?? selectedModel?.fastTier ?? null;
  const isFastOn = tierId !== null && thread.codexServiceTier === tierId;
  const set = (
    model: string | null,
    effort: string | null,
    fastTier: string | null,
    hydraPairId?: string | null,
  ) =>
    tryCall("threads:set-model", {
      threadId: thread.id,
      model,
      effort,
      fastTier,
      ...(hydraPairId !== undefined ? { hydraPairId } : {}),
    });

  const applyModelChoice = (
    model: string | null,
    effort: string | null,
    fastTier: string | null,
    hydraPairId: string | null,
  ) =>
    callApi("threads:set-model", {
      threadId: thread.id,
      model,
      effort,
      fastTier,
      hydraPairId,
    });

  const chooseModel = async (nextModel: string | null): Promise<boolean> => {
    const nextOption = models.find((m) => m.id === nextModel);
    // A stored fast tier only survives a model switch when the new
    // model advertises the SAME tier id — never guessed.
    let nextTier =
      nextOption?.fastTier && nextOption.fastTier === thread.codexServiceTier
        ? thread.codexServiceTier
        : null;
    let nextEffort = thread.codexEffort ?? null;
    // F17: a pinned model's stored defaults seed the selection
    // (frozen "how a model starts in new chats").
    const pref = nextModel
      ? settings?.modelPreferences?.[prefKey("codex", nextModel)]
      : undefined;
    if (pref?.effort !== undefined) nextEffort = pref.effort;
    if (pref?.fastMode === true && nextOption?.fastTier)
      nextTier = nextOption.fastTier;
    try {
      await applyModelChoice(nextModel, nextEffort, nextTier, null);
    } catch {
      return false;
    }
    if (
      nextModel !== null &&
      (settings?.lastNewChatModel?.provider !== "codex" ||
        settings?.lastNewChatModel?.modelID !== nextModel)
    ) {
      tryCall("settings:set", {
        lastNewChatModel: { provider: "codex", modelID: nextModel },
      });
    }
    return true;
  };

  const choosePair = async (pair: HydraPair): Promise<boolean> => {
    const leadModel = pair.orchestratorModel ?? (thread.codexModel ?? null);
    const leadOption = leadModel ? models.find((m) => m.id === leadModel) : undefined;
    const pref = leadModel ? settings?.modelPreferences?.[prefKey("codex", leadModel)] : undefined;
    let leadEffort = thread.codexEffort ?? null;
    if (pair.orchestratorEffort) leadEffort = pair.orchestratorEffort;
    else if (pref?.effort !== undefined) leadEffort = pref.effort;
    let leadTier =
      leadOption?.fastTier && leadOption.fastTier === thread.codexServiceTier
        ? thread.codexServiceTier
        : null;
    if (pref?.fastMode === true && leadOption?.fastTier) leadTier = leadOption.fastTier;

    try {
      await applyModelChoice(leadModel, leadEffort, leadTier, pair.id);
    } catch {
      return false;
    }
    return true;
  };

  const renderSelectOption = (entry: PickerEntry<CodexModelOption>) => (
    <option
      key={entry.modelId}
      value={entry.modelId}
      title={entry.option?.detail ? t(entry.option.detail) : undefined}
    >
      {entry.option?.name ?? entry.modelId}
      {entry.option?.isDefault ? " ★" : ""}
    </option>
  );

  const trimmedQuery = pickerQuery.trim().toLowerCase();
  const isSearching = trimmedQuery !== "";
  const matchesEntry = (entry: PickerEntry<CodexModelOption>) => {
    if (!isSearching) return true;
    const name = entry.option?.name ?? entry.modelId;
    return (
      name.toLowerCase().includes(trimmedQuery) ||
      entry.modelId.toLowerCase().includes(trimmedQuery) ||
      (entry.option?.detail?.toLowerCase().includes(trimmedQuery) ?? false)
    );
  };

  const allEntries: PickerEntry<CodexModelOption>[] = usePins
    ? [...partition.groups.flatMap((g) => g.items), ...partition.ungrouped]
    : models.map((option) => ({ modelId: option.id, option }));
  const visibleEntries: PickerEntry<CodexModelOption>[] = usePins
    ? allEntries
    : partition.ungrouped;
  const recentPair =
    resolveRecentPickerPair(pairs, settings?.lastNewChatPairId) ??
    resolveRecentPickerPair(pairs, settings?.lastHydraPairId);
  const recentModel = resolveRecentPickerModel(visibleEntries, settings?.lastNewChatModel);

  const totalModelCount =
    partition.groups.reduce((sum, g) => sum + g.items.length, 0) +
    partition.ungrouped.length;

  const filteredPairs = isSearching
    ? pairs.filter((p) => pickerPairMatches(p, pickerQuery, pairTitle(p), pairDetail(p)))
    : pairs;

  const ungroupedSearchHits: PickerEntry<CodexModelOption>[] = isSearching
    ? (() => {
        const hits: PickerEntry<CodexModelOption>[] = models
          .map((m): PickerEntry<CodexModelOption> => ({ modelId: m.id, option: m }))
          .filter(matchesEntry);
        if (selected !== "" && !selectedModel && matchesEntry({ modelId: selected })) {
          hits.unshift({ modelId: selected });
        }
        return hits;
      })()
    : [];

  const groupedShownIds = new Set<string>();
  if (hasUserGroups && isSearching) {
    for (const g of partition.groups) {
      for (const item of g.items) groupedShownIds.add(item.modelId);
    }
    for (const item of partition.ungrouped) groupedShownIds.add(item.modelId);
  }
  const groupedExtraHits: PickerEntry<CodexModelOption>[] =
    hasUserGroups && isSearching
      ? (() => {
          const extra: PickerEntry<CodexModelOption>[] = models
            .filter((m) => !groupedShownIds.has(m.id))
            .map((m): PickerEntry<CodexModelOption> => ({ modelId: m.id, option: m }))
            .filter(matchesEntry);
          if (
            selected !== "" &&
            !selectedModel &&
            !groupedShownIds.has(selected) &&
            matchesEntry({ modelId: selected })
          ) {
            extra.unshift({ modelId: selected });
          }
          return extra;
        })()
      : [];

  // Roving tabIndex keys so Tab jumps column-to-column and Arrows move inside a column.
  const leftKeys: string[] = [];
  if (hasUserGroups) {
    leftKeys.push("all");
    for (const g of partition.groups) leftKeys.push(`group/${g.section.id}`);
    if (partition.ungrouped.length > 0) leftKeys.push("ungrouped");
    if (showsPairs) leftKeys.push("combos");
  } else if (twoColumns) {
    if (!isSearching && recentPair) leftKeys.push(`recent-pair:${recentPair.id}`);
    for (const p of filteredPairs) leftKeys.push(`pair:${p.id}`);
  }
  const preferredLeftKey = hasUserGroups
    ? pickerCategoryKey(activeCategory)
    : activePair
      ? `pair:${activePair.id}`
      : (leftKeys[0] ?? null);
  const resolvedLeftKey =
    activeLeftKey && leftKeys.includes(activeLeftKey)
      ? activeLeftKey
      : preferredLeftKey && leftKeys.includes(preferredLeftKey)
        ? preferredLeftKey
        : (leftKeys[0] ?? null);

  const rightKeys: string[] = [];
  if (hasUserGroups) {
    if (isSearching) {
      for (const g of partition.groups) {
        for (const e of g.items.filter(matchesEntry)) rightKeys.push(`model:${e.modelId}`);
      }
      for (const e of partition.ungrouped.filter(matchesEntry)) rightKeys.push(`model:${e.modelId}`);
      for (const e of groupedExtraHits) rightKeys.push(`model:${e.modelId}`);
      if (showsPairs) {
        for (const p of filteredPairs) rightKeys.push(`pair:${p.id}`);
      }
    } else if (activeCategory.kind === "combos") {
      if (recentPair) rightKeys.push(`recent-pair:${recentPair.id}`);
      for (const p of pairs) rightKeys.push(`pair:${p.id}`);
    } else if (activeCategory.kind === "group") {
      const grp = partition.groups.find((g) => g.section.id === activeCategory.sectionId);
      for (const e of grp?.items ?? []) rightKeys.push(`model:${e.modelId}`);
    } else if (activeCategory.kind === "ungrouped") {
      for (const e of partition.ungrouped) rightKeys.push(`model:${e.modelId}`);
    } else {
      if (recentPair) rightKeys.push(`recent-pair:${recentPair.id}`);
      if (recentModel) rightKeys.push(`recent-model:${recentModel.modelId}`);
      rightKeys.push("model:__default__");
      if (selected !== "" && !selectedModel) rightKeys.push(`model:${selected}`);
      for (const g of partition.groups) {
        for (const e of g.items) rightKeys.push(`model:${e.modelId}`);
      }
      for (const e of partition.ungrouped) rightKeys.push(`model:${e.modelId}`);
    }
  } else {
    if (isSearching) {
      for (const e of ungroupedSearchHits) rightKeys.push(`model:${e.modelId}`);
    } else {
      if (recentModel) rightKeys.push(`recent-model:${recentModel.modelId}`);
      rightKeys.push("model:__default__");
      if (selected !== "" && !selectedModel) rightKeys.push(`model:${selected}`);
      for (const e of visibleEntries) rightKeys.push(`model:${e.modelId}`);
    }
  }
  const preferredRightKey = leadsWithPair
    ? activePair && rightKeys.includes(`pair:${activePair.id}`)
      ? `pair:${activePair.id}`
      : (rightKeys[0] ?? null)
    : selected === ""
      ? rightKeys.includes("model:__default__")
        ? "model:__default__"
        : (rightKeys[0] ?? null)
      : rightKeys.includes(`model:${selected}`)
        ? `model:${selected}`
        : (rightKeys[0] ?? null);
  const resolvedRightKey =
    activeRightKey && rightKeys.includes(activeRightKey)
      ? activeRightKey
      : preferredRightKey && rightKeys.includes(preferredRightKey)
        ? preferredRightKey
        : (rightKeys[0] ?? null);

  const focusItemInCol = (
    col: HTMLDivElement | null,
    which: "first" | "last" | "active",
  ): boolean => {
    if (!col) return false;
    const items = [...col.querySelectorAll<HTMLButtonElement>("[data-pop-item]:not(:disabled)")];
    if (items.length === 0) return false;
    let target: HTMLButtonElement | undefined;
    if (which === "first") target = items[0];
    else if (which === "last") target = items[items.length - 1];
    else target = items.find((el) => el.tabIndex === 0) ?? items[0];
    if (!target) return false;
    const key = target.dataset.popItem ?? null;
    if (col === leftColRef.current) setActiveLeftKey(key);
    else if (col === rightColRef.current) setActiveRightKey(key);
    target.focus();
    target.scrollIntoView?.({ block: "nearest" });
    return true;
  };

  const moveInCol = (col: HTMLDivElement | null, delta: 1 | -1): boolean => {
    if (!col) return false;
    const items = [...col.querySelectorAll<HTMLButtonElement>("[data-pop-item]:not(:disabled)")];
    if (items.length === 0) return false;
    const idx = items.findIndex((el) => el === document.activeElement);
    const nextIdx =
      idx < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.min(Math.max(0, idx + delta), items.length - 1);
    const next = items[nextIdx];
    if (!next) return false;
    const key = next.dataset.popItem ?? null;
    if (col === leftColRef.current) setActiveLeftKey(key);
    else if (col === rightColRef.current) setActiveRightKey(key);
    next.focus();
    next.scrollIntoView?.({ block: "nearest" });
    return true;
  };

  const onPopKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPopOpen(false);
      focusTrigger();
      return;
    }
    const activeEl = document.activeElement;
    const inSearch = searchRef.current === activeEl;
    const inLeft = !!(leftColRef.current && activeEl && leftColRef.current.contains(activeEl));
    const inRight = !!(rightColRef.current && activeEl && rightColRef.current.contains(activeEl));

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const delta: 1 | -1 = e.key === "ArrowDown" ? 1 : -1;
      if (inSearch) {
        e.preventDefault();
        const primary = twoColumns && filteredPairs.length > 0 ? leftColRef.current : rightColRef.current;
        if (!focusItemInCol(primary, delta > 0 ? "first" : "last")) {
          focusItemInCol(rightColRef.current, delta > 0 ? "first" : "last");
        }
      } else if (inLeft) {
        e.preventDefault();
        moveInCol(leftColRef.current, delta);
      } else if (inRight) {
        e.preventDefault();
        moveInCol(rightColRef.current, delta);
      }
      return;
    }

    if (e.key === "ArrowRight") {
      if (inSearch && pickerQuery !== "") return;
      if (inSearch || inLeft) {
        if (focusItemInCol(rightColRef.current, "active")) e.preventDefault();
      }
      return;
    }

    if (e.key === "ArrowLeft") {
      if (inSearch && pickerQuery !== "") return;
      if (inSearch || inRight) {
        if (focusItemInCol(leftColRef.current, "active")) e.preventDefault();
      }
      return;
    }

    if (e.key === "Enter" && inSearch) {
      e.preventDefault();
      const firstLeft = twoColumns
        ? leftColRef.current?.querySelector<HTMLButtonElement>("[data-pop-item]:not(:disabled)")
        : null;
      const firstRight =
        rightColRef.current?.querySelector<HTMLButtonElement>("[data-pop-item]:not(:disabled)") ?? null;
      (firstLeft ?? firstRight)?.click();
    }
  };

  const renderPairRow = (pair: HydraPair, isRecent: boolean, col: "left" | "right") => {
    const key = `${isRecent ? "recent-pair" : "pair"}:${pair.id}`;
    const isSel = activePair?.id === pair.id;
    const title = pairTitle(pair);
    const detail = pairDetail(pair);
    const isTabTarget =
      col === "left" ? resolvedLeftKey === key : resolvedRightKey === key;
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={isSel}
        data-pop-item={key}
        tabIndex={isTabTarget ? 0 : -1}
        className={`model-pop-row model-pop-pair-row${isSel ? " selected" : ""}`}
        title={detail}
        onFocus={() =>
          col === "left" ? setActiveLeftKey(key) : setActiveRightKey(key)
        }
        onClick={() => {
          void choosePair(pair).then((ok) => {
            if (ok) setPopOpen(false);
          });
        }}
      >
        <span className="model-pop-check" aria-hidden="true">
          {isSel ? "✓" : ""}
        </span>
        <span className="model-pop-pair-main">
          <span className="model-pop-name">{title}</span>
          <span className="model-pop-detail">{detail}</span>
        </span>
      </button>
    );
  };

  const renderPopRow = (
    entry: PickerEntry<CodexModelOption>,
    isRecent = false,
    labelOverride?: string,
  ) => {
    const key = `${isRecent ? "recent-model" : "model"}:${entry.modelId}`;
    const isSel = !leadsWithPair && selected === entry.modelId;
    const pref = settings?.modelPreferences?.[prefKey("codex", entry.modelId)];
    const showsFast = pref?.fastMode === true && !!entry.option?.fastTier;
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={isSel}
        data-pop-item={key}
        tabIndex={resolvedRightKey === key ? 0 : -1}
        className={`model-pop-row${isSel ? " selected" : ""}`}
        title={entry.option?.detail ? t(entry.option.detail) : undefined}
        onFocus={() => setActiveRightKey(key)}
        onClick={() => {
          void chooseModel(entry.modelId).then((ok) => {
            if (ok) setPopOpen(false);
          });
        }}
      >
        <span className="model-pop-check" aria-hidden="true">
          {isSel ? "✓" : ""}
        </span>
        <span className="model-pop-name">
          {labelOverride ?? entry.option?.name ?? entry.modelId}
          {!labelOverride && entry.option?.isDefault ? " ★" : ""}
        </span>
        {showsFast && (
          <span className="model-pop-fast" aria-hidden="true">
            ⚡
          </span>
        )}
      </button>
    );
  };

  const renderSavedSelectedRow = () =>
    selected !== "" && !selectedModel
      ? renderPopRow({ modelId: selected }, false, `${selected} (${t("saved")})`)
      : null;

  const renderDefaultModelRow = () => {
    const key = "model:__default__";
    const isSel = !leadsWithPair && selected === "";
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={isSel}
        data-pop-item={key}
        tabIndex={resolvedRightKey === key ? 0 : -1}
        className={`model-pop-row${isSel ? " selected" : ""}`}
        onFocus={() => setActiveRightKey(key)}
        onClick={() => {
          void chooseModel(null).then((ok) => {
            if (ok) setPopOpen(false);
          });
        }}
      >
        <span className="model-pop-check" aria-hidden="true">
          {isSel ? "✓" : ""}
        </span>
        <span className="model-pop-name">{t("Default (provider decides)")}</span>
      </button>
    );
  };

  const renderPairsColumnBody = () => {
    if (isSearching) {
      if (filteredPairs.length === 0) {
        return <div className="model-pop-empty">{t("No pairs match")}</div>;
      }
      return filteredPairs.map((pair) => renderPairRow(pair, false, "left"));
    }
    return (
      <>
        {recentPair && (
          <div className="model-pop-sec">
            <div className="model-pop-head">{t("Recent")}</div>
            {renderPairRow(recentPair, true, "left")}
          </div>
        )}
        <div className="model-pop-sec">
          <div className="model-pop-head">{t("Pairs")}</div>
          {pairs.map((pair) => renderPairRow(pair, false, "left"))}
        </div>
      </>
    );
  };

  const renderFlatModelsBody = () => {
    if (isSearching) {
      if (ungroupedSearchHits.length === 0) {
        return <div className="model-pop-empty">{t("No models match")}</div>;
      }
      return ungroupedSearchHits.map((entry) =>
        renderPopRow(
          entry,
          false,
          entry.option ? undefined : `${entry.modelId} (${t("saved")})`,
        ),
      );
    }
    return (
      <>
        {recentModel && (
          <div className="model-pop-sec">
            <div className="model-pop-head">{t("Recent")}</div>
            {renderPopRow(recentModel, true)}
          </div>
        )}
        <div className="model-pop-sec">
          {(twoColumns || recentModel) && (
            <div className="model-pop-head">{t("Models")}</div>
          )}
          {renderDefaultModelRow()}
          {renderSavedSelectedRow()}
          {visibleEntries.map((entry) => renderPopRow(entry))}
          {models.length === 0 && (
            <div className="model-pop-empty">
              {catalog === null || catalog.state === "ready"
                ? t("Loading model list…")
                : translateError(t, catalog.reason)}
            </div>
          )}
        </div>
      </>
    );
  };

  const renderPopListBody = () => {
    if (!hasUserGroups) return renderFlatModelsBody();

    if (isSearching) {
      const blocks: { id: string; title: string; items: PickerEntry<CodexModelOption>[] }[] = [];
      for (const g of partition.groups) {
        const hits = g.items.filter(matchesEntry);
        if (hits.length > 0) {
          blocks.push({ id: g.section.id, title: g.section.name, items: hits });
        }
      }
      const ungroupedHits = partition.ungrouped.filter(matchesEntry);
      if (ungroupedHits.length > 0) {
        blocks.push({ id: "ungrouped", title: t("Ungrouped"), items: ungroupedHits });
      }
      if (groupedExtraHits.length > 0) {
        blocks.push({ id: "other-models", title: t("Other models"), items: groupedExtraHits });
      }
      if (blocks.length === 0 && (!showsPairs || filteredPairs.length === 0)) {
        return <div className="model-pop-empty">{t("No models match")}</div>;
      }
      return (
        <>
          {blocks.map((b) => (
            <div key={b.id} className="model-pop-sec">
              <div className="model-pop-head">{b.title}</div>
              {b.items.map((item) =>
                renderPopRow(
                  item,
                  false,
                  item.option ? undefined : `${item.modelId} (${t("saved")})`,
                ),
              )}
            </div>
          ))}
          {showsPairs && filteredPairs.length > 0 && (
            <div key="pairs" className="model-pop-sec">
              <div className="model-pop-head">{t("Pairs")}</div>
              {filteredPairs.map((p) => renderPairRow(p, false, "right"))}
            </div>
          )}
        </>
      );
    }

    if (activeCategory.kind === "combos") {
      if (pairs.length === 0) {
        return <div className="model-pop-empty">{t("No pairs match")}</div>;
      }
      return (
        <>
          {recentPair && (
            <div className="model-pop-sec">
              <div className="model-pop-head">{t("Recent")}</div>
              {renderPairRow(recentPair, true, "right")}
            </div>
          )}
          <div className="model-pop-sec">
            <div className="model-pop-head">{t("Pairs")}</div>
            {pairs.map((p) => renderPairRow(p, false, "right"))}
          </div>
        </>
      );
    }

    if (activeCategory.kind === "group") {
      const grp = partition.groups.find((g) => g.section.id === activeCategory.sectionId);
      const items = grp?.items ?? [];
      if (items.length === 0) {
        return <div className="model-pop-empty">{t("No models in this group")}</div>;
      }
      return items.map((item) => renderPopRow(item));
    }

    if (activeCategory.kind === "ungrouped") {
      if (partition.ungrouped.length === 0) {
        return <div className="model-pop-empty">{t("No models in this group")}</div>;
      }
      return partition.ungrouped.map((item) => renderPopRow(item));
    }

    // "all" category: optional Recent section + Default row + saved-only chosen model + each non-empty group + ungrouped.
    return (
      <>
        {(recentPair || recentModel) && (
          <div className="model-pop-sec">
            <div className="model-pop-head">{t("Recent")}</div>
            {recentPair && renderPairRow(recentPair, true, "right")}
            {recentModel && renderPopRow(recentModel, true)}
          </div>
        )}
        <div className="model-pop-sec">
          {(recentPair || recentModel) && <div className="model-pop-head">{t("Models")}</div>}
          {renderDefaultModelRow()}
          {renderSavedSelectedRow()}
        </div>
        {partition.groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.section.id} className="model-pop-sec">
              <div className="model-pop-head">{g.section.name}</div>
              {g.items.map((item) => renderPopRow(item))}
            </div>
          ))}
        {partition.ungrouped.length > 0 && (
          <div className="model-pop-sec">
            {partition.groups.some((g) => g.items.length > 0) && (
              <div className="model-pop-head">{t("Ungrouped")}</div>
            )}
            {partition.ungrouped.map((item) => renderPopRow(item))}
          </div>
        )}
      </>
    );
  };

  const popTriggerClass = hasUserGroups ? "model-groups-btn" : "model-picker-btn";
  const popTriggerLabel = hasUserGroups
    ? activeGroupLabel
    : activePair
      ? pairTitle(activePair)
      : twoColumns
        ? t("Pairs & models")
        : t("Browse models");
  const popTriggerAria = hasUserGroups
    ? t("Model groups")
    : twoColumns
      ? t("Pairs & models")
      : t("Browse models");

  const currentModelDisplayName = activePair
    ? pairTitle(activePair)
    : selectedModel
      ? selectedModel.name
      : selected !== ""
        ? `${selected} (${t("saved")})`
        : t("Default (provider decides)");

  const openPopover = (expanded: boolean, source: "model" | "effort") => {
    lastTriggerRef.current = source;
    const triggerEl = source === "effort" ? effortTriggerRef.current : triggerRef.current;
    setPopTrigger(source);
    setOpenAnchor(triggerEl ? rectToAnchor(triggerEl.getBoundingClientRect()) : null);
    refresh();
    setPickerQuery("");
    setActiveLeftKey(null);
    setActiveRightKey(null);
    if (hasUserGroups) {
      setSelectedCategory(
        defaultPickerCategory(partition, selected, {
          leadsWithPair,
          hasPairs: showsPairs,
        }),
      );
    }
    setModelsExpanded(expanded);
    setPopOpen(true);
  };

  return (
    <div className="model-picker" data-cat={catalog?.state ?? "loading"}>
      <select
        className="model-select"
        aria-label={t("Model")}
        title={t("Model — applies to the next turn")}
        value={selected}
        disabled={!!props.readOnly}
        onFocus={refresh}
        onChange={(e) => {
          void chooseModel(e.target.value === "" ? null : e.target.value);
        }}
      >
        <option value="">{t("Default (provider decides)")}</option>
        {selected !== "" && !selectedModel && (
          <option value={selected}>{`${selected} (${t("saved")})`}</option>
        )}
        {usePins
          ? (
              <>
                {partition.ungrouped.map(renderSelectOption)}
                {partition.groups
                  .filter((g) => g.items.length > 0)
                  .map((g) => (
                    <optgroup key={g.section.id} label={g.section.name}>
                      {g.items.map(renderSelectOption)}
                    </optgroup>
                  ))}
              </>
            )
          : visibleModels.map((m) => (
              <option key={m.id} value={m.id} title={m.detail ? t(m.detail) : undefined}>
                {m.name}
                {m.isDefault ? " ★" : ""}
              </option>
            ))}
      </select>

      <div className="model-pop-wrap" ref={popRef}>
        <button
          ref={triggerRef}
          type="button"
          className={popTriggerClass}
          disabled={!!props.readOnly}
          aria-haspopup="dialog"
          aria-expanded={popOpen && modelsExpanded}
          aria-label={popTriggerAria}
          title={popTriggerAria}
          onClick={() => {
            if (popOpen && modelsExpanded) {
              setPopOpen(false);
              return;
            }
            openPopover(true, "model");
          }}
        >
          <span className={hasUserGroups ? "model-groups-btn-label" : "model-picker-btn-label"}>
            {popTriggerLabel}
          </span>
          <span aria-hidden="true">▾</span>
        </button>
        <button
          ref={effortTriggerRef}
          type="button"
          className="effort-picker-btn"
          disabled={!!props.readOnly}
          aria-haspopup="dialog"
          aria-expanded={popOpen && !modelsExpanded}
          aria-label={t("Reasoning effort")}
          title={t("Reasoning effort — applies to the next turn")}
          onClick={() => {
            if (popOpen && !modelsExpanded) {
              setPopOpen(false);
              return;
            }
            openPopover(false, "effort");
          }}
        >
          <span className="effort-picker-btn-label">{reasoningLabel}</span>
          <span aria-hidden="true">▾</span>
        </button>

        {popOpen && (
          <div
            ref={dialogRef}
            className={`model-picker-pop${
              !modelsExpanded
                ? " effort-only"
                : hasUserGroups
                  ? ""
                  : twoColumns
                    ? " two-col"
                    : " single-col"
            }`}
            style={anchoredPopoverStyle(dialogPos)}
            role="dialog"
            aria-label={modelsExpanded ? popTriggerAria : t("Reasoning effort")}
            onKeyDown={onPopKeyDown}
          >
            <div
              className="effort-card"
              data-state={modelsExpanded ? "expanded" : "collapsed"}
            >
              <div className="effort-card-head">
                {tierId !== null ? (
                  <button
                    type="button"
                    className={`effort-fast-btn${isFastOn ? " active" : ""}`}
                    disabled={!!props.readOnly}
                    aria-pressed={isFastOn}
                    aria-label={t("Fast mode")}
                    title={isFastOn ? t("Fast mode is on") : t("Fast mode")}
                    onClick={() =>
                      set(
                        thread.codexModel ?? null,
                        thread.codexEffort ?? null,
                        isFastOn ? null : tierId,
                      )
                    }
                  >
                    ⚡
                  </button>
                ) : (
                  <span className="effort-head-spacer" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="effort-model-btn"
                  aria-expanded={modelsExpanded}
                  aria-label={t("Choose a model")}
                  title={currentModelDisplayName}
                  onClick={() => setModelsExpanded((was) => !was)}
                >
                  <span className="effort-model-name">{currentModelDisplayName}</span>
                  <span
                    className={`effort-model-chev${modelsExpanded ? " open" : ""}`}
                    aria-hidden="true"
                  >
                    {modelsExpanded ? "▾" : "›"}
                  </span>
                </button>
                <span className="effort-head-spacer" aria-hidden="true" />
              </div>

              <div
                className="effort-level-label"
                data-effort-level={
                  resolvedEffort || (catalog?.state === "ready" && selectedModel ? "standard" : "default")
                }
                data-max={isMaxEffort ? "true" : undefined}
                data-fast={isFastOn ? "true" : undefined}
              >
                {reasoningLabel}
              </div>

              {efforts.length > 0 ? (
                <div className="effort-slider-wrap">
                  <div className="effort-slider-track" aria-hidden="true">
                    <div className="effort-slider-bar">
                      <div
                        className={`effort-slider-fill${isMaxEffort ? " max" : ""}${isFastOn ? " fast" : ""}`}
                        style={{
                          width:
                            efforts.length > 1
                              ? `${(resolvedIndex / (efforts.length - 1)) * 100}%`
                              : "100%",
                        }}
                      />
                    </div>
                    <div
                      className="effort-slider-stops"
                      style={{
                        justifyContent: efforts.length === 1 ? "center" : "space-between",
                      }}
                    >
                      {efforts.map((eff, idx) => (
                        <span
                          key={eff}
                          className={`effort-slider-stop${idx <= resolvedIndex ? " active" : ""}`}
                        />
                      ))}
                    </div>
                    <span
                      className="effort-slider-thumb"
                      style={{
                        left:
                          efforts.length > 1
                            ? `calc(9px + (100% - 18px) * ${resolvedIndex / (efforts.length - 1)})`
                            : "50%",
                      }}
                    />
                  </div>
                  <input
                    type="range"
                    className="effort-slider"
                    min={0}
                    max={efforts.length - 1}
                    step={1}
                    value={resolvedIndex}
                    disabled={!!props.readOnly}
                    aria-label={t("Reasoning effort")}
                    aria-valuetext={reasoningLabel}
                    onChange={(e) => {
                      const idx = Number(e.target.value);
                      const nextEffort = efforts[idx];
                      if (nextEffort !== undefined) {
                        set(
                          thread.codexModel ?? null,
                          nextEffort,
                          thread.codexServiceTier ?? null,
                        );
                      }
                    }}
                  />
                </div>
              ) : (
                <div className="effort-single-note">
                  {catalog === null
                    ? t("Loading model list…")
                    : catalog.state !== "ready"
                      ? translateError(t, catalog.reason)
                      : selectedModel
                        ? t("This model has one reasoning level.")
                        : t("Applies to the next turn")}
                </div>
              )}
            </div>

            {modelsExpanded && <div className="effort-divider" />}
            {modelsExpanded && (
              <>
            <div className="model-pop-search-row">
              <input
                ref={searchRef}
                type="search"
                className="model-pop-search"
                placeholder={t("Search models")}
                aria-label={t("Search models")}
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
              />
              {pickerQuery !== "" && (
                <button
                  type="button"
                  className="model-pop-clear"
                  aria-label={t("Clear search")}
                  title={t("Clear search")}
                  onClick={() => {
                    setPickerQuery("");
                    searchRef.current?.focus({ preventScroll: true });
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {hasUserGroups ? (
              <div className="model-pop-cols">
                <div
                  ref={leftColRef}
                  className={`model-pop-rail${isSearching ? " disabled" : ""}`}
                  aria-label={t("Model groups")}
                >
                  <button
                    type="button"
                    disabled={isSearching}
                    data-picker-cat="all"
                    data-pop-item="all"
                    tabIndex={resolvedLeftKey === "all" ? 0 : -1}
                    className={`model-pop-cat${pickerCategoryKey(activeCategory) === "all" ? " active" : ""}`}
                    onFocus={() => setActiveLeftKey("all")}
                    onClick={() => setSelectedCategory({ kind: "all" })}
                  >
                    <span className="model-pop-cat-name">{t("All")}</span>
                    <span className="model-pop-cat-count">{totalModelCount}</span>
                  </button>
                  {partition.groups.map((g) => {
                    const key = `group/${g.section.id}`;
                    return (
                      <button
                        key={g.section.id}
                        type="button"
                        disabled={isSearching}
                        data-picker-cat={key}
                        data-pop-item={key}
                        tabIndex={resolvedLeftKey === key ? 0 : -1}
                        className={`model-pop-cat${pickerCategoryKey(activeCategory) === key ? " active" : ""}`}
                        onFocus={() => setActiveLeftKey(key)}
                        onClick={() =>
                          setSelectedCategory({ kind: "group", sectionId: g.section.id })
                        }
                      >
                        <span className="model-pop-cat-name">{g.section.name}</span>
                        <span className="model-pop-cat-count">{g.items.length}</span>
                      </button>
                    );
                  })}
                  {partition.ungrouped.length > 0 && (
                    <button
                      type="button"
                      disabled={isSearching}
                      data-picker-cat="ungrouped"
                      data-pop-item="ungrouped"
                      tabIndex={resolvedLeftKey === "ungrouped" ? 0 : -1}
                      className={`model-pop-cat${pickerCategoryKey(activeCategory) === "ungrouped" ? " active" : ""}`}
                      onFocus={() => setActiveLeftKey("ungrouped")}
                      onClick={() => setSelectedCategory({ kind: "ungrouped" })}
                    >
                      <span className="model-pop-cat-name">{t("Ungrouped")}</span>
                      <span className="model-pop-cat-count">{partition.ungrouped.length}</span>
                    </button>
                  )}
                  {showsPairs && (
                    <button
                      type="button"
                      disabled={isSearching}
                      data-picker-cat="combos"
                      data-pop-item="combos"
                      tabIndex={resolvedLeftKey === "combos" ? 0 : -1}
                      className={`model-pop-cat${pickerCategoryKey(activeCategory) === "combos" ? " active" : ""}`}
                      onFocus={() => setActiveLeftKey("combos")}
                      onClick={() => setSelectedCategory({ kind: "combos" })}
                    >
                      <span className="model-pop-cat-name">{t("Pairs")}</span>
                      <span className="model-pop-cat-count">{pairs.length}</span>
                    </button>
                  )}
                </div>
                <div
                  ref={rightColRef}
                  className="model-pop-list"
                  role="listbox"
                  aria-label={
                    activeCategory.kind === "combos" && !isSearching ? t("Pairs") : t("Models")
                  }
                >
                  {renderPopListBody()}
                </div>
              </div>
            ) : twoColumns ? (
              <div className="model-pop-cols two-col">
                <div
                  ref={leftColRef}
                  className="model-pop-pairs-col"
                  role="listbox"
                  aria-label={t("Pairs")}
                >
                  {renderPairsColumnBody()}
                </div>
                <div
                  ref={rightColRef}
                  className="model-pop-list"
                  role="listbox"
                  aria-label={t("Models")}
                >
                  {renderPopListBody()}
                </div>
              </div>
            ) : (
              <div className="model-pop-cols single-col">
                <div
                  ref={rightColRef}
                  className="model-pop-list"
                  role="listbox"
                  aria-label={t("Models")}
                >
                  {renderPopListBody()}
                </div>
              </div>
            )}
              </>
            )}
          </div>
        )}
      </div>

      <select
        className="effort-select"
        aria-label={t("Effort")}
        title={t("Reasoning effort — applies to the next turn")}
        value={selectEffortValue}
        disabled={!!props.readOnly || (efforts.length === 0 && selectedEffort === "")}
        onChange={(e) =>
          set(
            thread.codexModel ?? null,
            e.target.value === "" ? null : e.target.value,
            thread.codexServiceTier ?? null,
          )
        }
      >
        <option value="">{t("Default effort")}</option>
        {selectedEffort !== "" && selectedEffortIndex < 0 && (
          <option value={selectedEffort}>{`${t(effortTitle(selectedEffort))} (${t("saved")})`}</option>
        )}
        {efforts.map((e, idx) => (
          <option key={e} value={e}>
            {t(effortTitle(e))}
            {idx === defaultEffortIndex ? ` (${t("model default")})` : ""}
          </option>
        ))}
      </select>
      {subagentVisible && (
        <select
          className="subagent-mode-select"
          aria-label={t("Sub-agents")}
          title={t("Sub-agent mode — applies to the next turn")}
          value={subagentMode}
          disabled={!!props.readOnly}
          onChange={(e) =>
            tryCall("threads:set-subagent-mode", {
              threadId: thread.id,
              mode: e.target.value,
            })
          }
        >
          <option
            value="same"
            title={t(
              "This model splits the work and hands parts to sub-agents running the same model.",
            )}
          >
            {t("Same-model sub-agents")}
          </option>
          <option
            value="preset"
            title={t(
              "A saved lead and sub-agent combo; sub-agents run the combo's models.",
            )}
          >
            {t("Preset sub-agents")}
          </option>
          <option
            value="adaptive"
            title={t(
              "The lead splits the work into roles and matches each to a model across providers.",
            )}
          >
            {t("Adaptive sub-agents")}
          </option>
        </select>
      )}
      {subagentVisible && subagentMode === "adaptive" && (
        <label
          className="fast-tier"
          title={t("Adaptive heads go out at once; off, each role's model is confirmed first.")}
        >
          <input
            type="checkbox"
            className="fast-tier-check"
            checked={settings?.chimeraAutoDispatch === true}
            disabled={!!props.readOnly}
            onChange={(e) =>
              tryCall("settings:set", { chimeraAutoDispatch: e.target.checked })
            }
          />
          {t("Auto-dispatch")}
        </label>
      )}
      {tierId !== null && (
        <label
          className="fast-tier"
          title={t("Fast service tier — applies to the next turn")}
        >
          <input
            type="checkbox"
            className="fast-tier-check"
            checked={thread.codexServiceTier === tierId}
            disabled={!!props.readOnly}
            onChange={(e) =>
              set(
                thread.codexModel ?? null,
                thread.codexEffort ?? null,
                e.target.checked ? tierId : null,
              )
            }
          />
          {t("Fast tier")}
        </label>
      )}
      <span className="model-note">
        {catalog === null
          ? t("Loading model list…")
          : catalog.state === "pending" || catalog.state === "unavailable"
            ? translateError(t, catalog.reason)
            : catalog.state === "unsupported"
              ? translateError(t, catalog.reason)
              : reported
                ? `${t("Provider reports")}: ${reported}`
                : t("Applies to the next turn")}
      </span>
    </div>
  );
}
