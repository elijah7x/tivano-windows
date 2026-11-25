// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Per-thread Codex model/effort picker (P2-56 / F17). The catalog is
// provider-owned state fetched via models:list — pending until a Codex
// session binds, honest when unavailable. Follows Settings > Models
// groups both in `<select>` optgroups and in the two-column group-aware
// popover when user groups exist. Selections persist on the thread and
// apply to the NEXT turn only; a running turn is never retargeted.

import { useEffect, useRef, useState } from "react";
import type { ChatThread, CodexModelCatalog, CodexModelOption } from "../../shared/types";
import {
  defaultPickerCategory,
  partitionPickerModels,
  pickerCategoryKey,
  prefKey,
  protectedModelIds,
  resolvePickerCategory,
  simplifiedModels,
  type ModelPin,
  type PickerCategory,
  type PickerEntry,
} from "../../shared/modelList";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { api, tryCall, clientStore } from "../client";

/** Frozen Provider.swift effortRank — low to high ordering whatever
 *  order the agent lists levels in; unknown levels keep their place. */
function effortRank(effort: string): number | undefined {
  return (
    {
      none: 0,
      minimal: 1,
      low: 2,
      medium: 3,
      high: 4,
      xhigh: 5,
      "extra-high": 5,
      extra_high: 5,
      "extra high": 5,
      max: 6,
      ultra: 6,
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
function effortTitle(effort: string): string {
  if (effort === "xhigh" || effort === "extra-high") return "Extra High";
  if (effort === "") return "Default";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export interface ModelPickerProps {
  thread: ChatThread;
  readOnly?: boolean;
  initialCatalog?: CodexModelCatalog | null;
  initialOpen?: boolean;
  initialQuery?: string;
}

export function ModelPicker(props: ModelPickerProps): React.JSX.Element | null {
  const t = useT();
  const { thread } = props;
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(
    props.initialCatalog ?? null,
  );
  const [groupOpen, setGroupOpen] = useState(props.initialOpen ?? false);
  const [pickerQuery, setPickerQuery] = useState(props.initialQuery ?? "");
  const [selectedCategory, setSelectedCategory] = useState<PickerCategory | null>(null);
  const gen = useRef(0);
  const popRef = useRef<HTMLDivElement | null>(null);
  const settings = clientStore.snapshot?.settings;

  const refresh = () => {
    if (props.initialCatalog !== undefined) return;
    if (clientStore.snapshot?.settings?.codexProviderEnabled === false) return;
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

  // First fetch on mount/thread switch; the dropdown ALSO refreshes on
  // open so "no session yet" self-heals once a turn binds one.
  useEffect(refresh, [thread.id, props.initialCatalog, settings?.codexProviderEnabled]);

  useEffect(() => {
    if (settings?.codexProviderEnabled === false) setGroupOpen(false);
  }, [settings?.codexProviderEnabled]);

  useEffect(() => {
    if (!groupOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setGroupOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setGroupOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [groupOpen]);

  const models: CodexModelOption[] = catalog?.state === "ready" ? catalog.models : [];
  const pinnedList: ModelPin[] = settings?.modelList ?? [];
  const pinnedSections = settings?.modelSections ?? [];
  const usePins = pinnedList.length > 0;
  const hasUserGroups = pinnedSections.length > 0;
  const selected0 = thread.codexModel ?? "";
  // P1-25: frozen hidesOutdatedModels — the unpinned catalog trims to
  // each vendor's three newest versions; the thread's own model, pins
  // and Hydra pair models always stay (frozen protectedModelIDs).
  const protectedIds = protectedModelIds(
    { modelList: pinnedList, hydraPairs: settings?.hydraPairs },
    "codex",
    selected0 === "" ? [] : [selected0],
  );
  const visibleModels =
    (settings?.hideOutdatedModels ?? true) && !usePins
      ? simplifiedModels(models, { isProtected: (m) => protectedIds.has(m.id) })
      : models;
  const optionById = new Map(models.map((m) => [m.id, m]));
  const partition = partitionPickerModels(pinnedList, pinnedSections, visibleModels, optionById);

  const selected = thread.codexModel ?? "";
  const initialCat = defaultPickerCategory(partition, selected);
  const activeCategory =
    resolvePickerCategory(selectedCategory, partition) ?? initialCat;
  const currentGroupMatch = partition.groups.find((g) =>
    g.items.some((i) => i.modelId === selected),
  );
  const activeGroupLabel = currentGroupMatch ? currentGroupMatch.section.name : t("All");

  // P1-36: the sub-agent mode row from the frozen picker's
  // SubagentModeRow set, bounded to a select in the model menu — shown
  // while Hydra runs for app and chat; heads never get a mode.
  const subagentVisible =
    settings?.hydraEnabled !== false &&
    thread.hydraEnabled !== false &&
    !thread.hydraHead;
  const subagentMode =
    thread.subagentMode ?? (thread.hydraPairId ? "preset" : "same");
  const providerEnabled = settings?.codexProviderEnabled !== false;
  if (!providerEnabled && !subagentVisible) return null;
  const selectedModel = models.find((m) => m.id === selected);
  const efforts = orderedEfforts(selectedModel?.efforts ?? []);
  const selectedEffort = thread.codexEffort ?? "";
  const reported = thread.codexModelReported
    ? `${thread.codexModelReported}${thread.codexEffortReported ? ` / ${thread.codexEffortReported}` : ""}`
    : null;
  const tierId = thread.codexServiceTier ?? selectedModel?.fastTier ?? null;
  const set = (model: string | null, effort: string | null, fastTier: string | null) =>
    tryCall("threads:set-model", { threadId: thread.id, model, effort, fastTier });

  const chooseModel = (nextModel: string | null) => {
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
    set(nextModel, nextEffort, nextTier);
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

  const totalModelCount =
    partition.groups.reduce((sum, g) => sum + g.items.length, 0) +
    partition.ungrouped.length;

  const renderPopRow = (entry: PickerEntry<CodexModelOption>) => {
    const isSel = selected === entry.modelId;
    const pref = settings?.modelPreferences?.[prefKey("codex", entry.modelId)];
    const showsFast = pref?.fastMode === true && !!entry.option?.fastTier;
    return (
      <button
        key={entry.modelId}
        type="button"
        role="option"
        aria-selected={isSel}
        className={`model-pop-row${isSel ? " selected" : ""}`}
        title={entry.option?.detail ? t(entry.option.detail) : undefined}
        onClick={() => {
          chooseModel(entry.modelId);
          setGroupOpen(false);
        }}
      >
        <span className="model-pop-check" aria-hidden="true">
          {isSel ? "✓" : ""}
        </span>
        <span className="model-pop-name">
          {entry.option?.name ?? entry.modelId}
          {entry.option?.isDefault ? " ★" : ""}
        </span>
        {showsFast && (
          <span className="model-pop-fast" aria-hidden="true">
            ⚡
          </span>
        )}
      </button>
    );
  };

  const renderPopListBody = () => {
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
      if (blocks.length === 0) {
        return <div className="model-pop-empty">{t("No models match")}</div>;
      }
      return blocks.map((b) => (
        <div key={b.id} className="model-pop-sec">
          <div className="model-pop-head">{b.title}</div>
          {b.items.map(renderPopRow)}
        </div>
      ));
    }

    if (activeCategory.kind === "group") {
      const grp = partition.groups.find((g) => g.section.id === activeCategory.sectionId);
      const items = grp?.items ?? [];
      if (items.length === 0) {
        return <div className="model-pop-empty">{t("No models in this group")}</div>;
      }
      return items.map(renderPopRow);
    }

    if (activeCategory.kind === "ungrouped") {
      if (partition.ungrouped.length === 0) {
        return <div className="model-pop-empty">{t("No models in this group")}</div>;
      }
      return partition.ungrouped.map(renderPopRow);
    }

    // "all" category: Default row + each non-empty group + ungrouped.
    return (
      <>
        <button
          type="button"
          role="option"
          aria-selected={selected === ""}
          className={`model-pop-row${selected === "" ? " selected" : ""}`}
          onClick={() => {
            chooseModel(null);
            setGroupOpen(false);
          }}
        >
          <span className="model-pop-check" aria-hidden="true">
            {selected === "" ? "✓" : ""}
          </span>
          <span className="model-pop-name">{t("Default (provider decides)")}</span>
        </button>
        {partition.groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.section.id} className="model-pop-sec">
              <div className="model-pop-head">{g.section.name}</div>
              {g.items.map(renderPopRow)}
            </div>
          ))}
        {partition.ungrouped.length > 0 && (
          <div className="model-pop-sec">
            {partition.groups.some((g) => g.items.length > 0) && (
              <div className="model-pop-head">{t("Ungrouped")}</div>
            )}
            {partition.ungrouped.map(renderPopRow)}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="model-picker" data-cat={providerEnabled ? (catalog?.state ?? "loading") : "hidden"}>
      {providerEnabled && (
      <select
        className="model-select"
        aria-label={t("Model")}
        title={t("Model — applies to the next turn")}
        value={selected}
        disabled={!!props.readOnly}
        onFocus={refresh}
        onChange={(e) => chooseModel(e.target.value === "" ? null : e.target.value)}
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
      )}

      {providerEnabled && hasUserGroups && (
        <div className="model-pop-wrap" ref={popRef}>
          <button
            type="button"
            className="model-groups-btn"
            disabled={!!props.readOnly}
            aria-haspopup="dialog"
            aria-expanded={groupOpen}
            aria-label={t("Model groups")}
            title={t("Model groups")}
            onClick={() => {
              const next = !groupOpen;
              if (next) {
                refresh();
                setPickerQuery("");
                setSelectedCategory(defaultPickerCategory(partition, selected));
              }
              setGroupOpen(next);
            }}
          >
            <span className="model-groups-btn-label">{activeGroupLabel}</span>
            <span aria-hidden="true">▾</span>
          </button>

          {groupOpen && (
            <div
              className="model-picker-pop"
              role="dialog"
              aria-label={t("Model groups")}
            >
              <input
                type="search"
                className="model-pop-search"
                placeholder={t("Search models")}
                aria-label={t("Search models")}
                value={pickerQuery}
                autoFocus
                onChange={(e) => setPickerQuery(e.target.value)}
              />
              <div className="model-pop-cols">
                <div
                  className={`model-pop-rail${isSearching ? " disabled" : ""}`}
                  aria-label={t("Model groups")}
                >
                  <button
                    type="button"
                    disabled={isSearching}
                    data-picker-cat="all"
                    className={`model-pop-cat${pickerCategoryKey(activeCategory) === "all" ? " active" : ""}`}
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
                        className={`model-pop-cat${pickerCategoryKey(activeCategory) === key ? " active" : ""}`}
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
                      className={`model-pop-cat${pickerCategoryKey(activeCategory) === "ungrouped" ? " active" : ""}`}
                      onClick={() => setSelectedCategory({ kind: "ungrouped" })}
                    >
                      <span className="model-pop-cat-name">{t("Ungrouped")}</span>
                      <span className="model-pop-cat-count">{partition.ungrouped.length}</span>
                    </button>
                  )}
                </div>
                <div className="model-pop-list" role="listbox" aria-label={t("Models")}>
                  {renderPopListBody()}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {providerEnabled && (
      <select
        className="effort-select"
        aria-label={t("Effort")}
        title={t("Reasoning effort — applies to the next turn")}
        value={selectedEffort}
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
        {selectedEffort !== "" && !efforts.includes(selectedEffort) && (
          <option value={selectedEffort}>{`${t(effortTitle(selectedEffort))} (${t("saved")})`}</option>
        )}
        {efforts.map((e) => (
          <option key={e} value={e}>
            {t(effortTitle(e))}
            {selectedModel?.defaultEffort === e ? ` (${t("model default")})` : ""}
          </option>
        ))}
      </select>
      )}
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
      {providerEnabled && tierId !== null && (
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
      {providerEnabled && (
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
      )}
    </div>
  );
}
