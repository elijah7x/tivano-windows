// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Per-thread Codex model/effort picker (F17). The catalog is provider-
// owned state fetched via models:list — pending until a Codex session
// binds, honest when unavailable. Selections persist on the thread and
// apply to the NEXT turn only; a running turn is never retargeted.

import { useEffect, useRef, useState } from "react";
import type { ChatThread, CodexModelCatalog, CodexModelOption } from "../../shared/types";
import {
  modelListItems,
  pinId,
  prefKey,
  type ModelPin,
} from "../../shared/modelList";
import { useT } from "../locale";
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

export function ModelPicker(props: {
  thread: ChatThread;
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useT();
  const { thread } = props;
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);
  const gen = useRef(0);

  const refresh = () => {
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
  useEffect(refresh, [thread.id]);

  const models: CodexModelOption[] = catalog?.state === "ready" ? catalog.models : [];
  // F17: frozen modelList — when pins exist the picker shows ONLY the
  // pinned models in layout order with their group headings (frozen
  // "the picker shows every model" until the user pins). Sections are
  // optgroups — a native select can't fold like the frozen panel, so
  // collapsed sections still list their pins.
  const settings = clientStore.snapshot?.settings;
  const pinnedList: ModelPin[] = settings?.modelList ?? [];
  const pinnedSections = settings?.modelSections ?? [];
  const pinnedIds = new Set(pinnedList.map(pinId));
  const usePins = pinnedList.length > 0;
  const optionById = new Map(models.map((m) => [m.id, m]));
  const groups: { label: string | null; pins: ModelPin[] }[] = [];
  for (const item of modelListItems(pinnedList, pinnedSections)) {
    if (item.kind === "pin") {
      if (groups.length === 0) groups.push({ label: null, pins: [] });
      groups[groups.length - 1]!.pins.push(item.pin);
    } else groups.push({ label: item.section.name, pins: [] });
  }
  const selected = thread.codexModel ?? "";
  const selectedModel = models.find((m) => m.id === selected);
  const efforts = orderedEfforts(selectedModel?.efforts ?? []);
  const selectedEffort = thread.codexEffort ?? "";
  const reported = thread.codexModelReported
    ? `${thread.codexModelReported}${thread.codexEffortReported ? ` / ${thread.codexEffortReported}` : ""}`
    : null;
  // A stored tier is ACTIVE for the next turn even before the catalog
  // resolves (pending after restart) — show it honestly rather than hide
  // it; fall back to the model's advertised tier for a fresh selection.
  const tierId = thread.codexServiceTier ?? selectedModel?.fastTier ?? null;
  const set = (model: string | null, effort: string | null, fastTier: string | null) =>
    tryCall("threads:set-model", { threadId: thread.id, model, effort, fastTier });

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
          const nextModel = e.target.value === "" ? null : e.target.value;
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
        }}
      >
        <option value="">{t("Default (provider decides)")}</option>
        {selected !== "" && !selectedModel && (
          <option value={selected}>{`${selected} (${t("saved")})`}</option>
        )}
        {usePins
          ? groups.map((g, gi) =>
              g.label === null ? (
                g.pins.map((p) => {
                  const opt = optionById.get(p.modelID);
                  return (
                    <option key={p.modelID} value={p.modelID} title={opt?.detail}>
                      {opt?.name ?? p.modelID}
                      {opt?.isDefault ? " ★" : ""}
                    </option>
                  );
                })
              ) : (
                <optgroup key={`g${gi}`} label={g.label}>
                  {g.pins.map((p) => {
                    const opt = optionById.get(p.modelID);
                    return (
                      <option key={p.modelID} value={p.modelID} title={opt?.detail}>
                        {opt?.name ?? p.modelID}
                        {opt?.isDefault ? " ★" : ""}
                      </option>
                    );
                  })}
                </optgroup>
              ),
            )
          : models.map((m) => (
              <option key={m.id} value={m.id} title={m.detail}>
                {m.name}
                {m.isDefault ? " ★" : ""}
              </option>
            ))}
      </select>
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
          <option value={selectedEffort}>{`${effortTitle(selectedEffort)} (${t("saved")})`}</option>
        )}
        {efforts.map((e) => (
          <option key={e} value={e}>
            {effortTitle(e)}
            {selectedModel?.defaultEffort === e ? ` (${t("model default")})` : ""}
          </option>
        ))}
      </select>
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
            ? catalog.reason
            : catalog.state === "unsupported"
              ? catalog.reason
              : reported
                ? `${t("Provider reports")}: ${reported}`
                : t("Applies to the next turn")}
      </span>
    </div>
  );
}
