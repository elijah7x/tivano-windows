// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F17: frozen ModelsSettingsPage — bounded port. Pins and section headings
// ORGANIZE the picker; the catalog itself stays provider-owned
// (models:list). Slice parity: "Your models" unified list (ungrouped +
// groups), collapse/rename/remove headings, Move-to-Group via right-click,
// per-pin effort/fast defaults (EffortSliderCard), drag reorder across
// rows and into groups, add-from-catalog rows, 30-pin cap. Out of slice:
// the frozen drag-into-gap animation metrics, provider icons for adapters
// this build does not ship, and the SwiftUI-only collapse affordance in a
// native <select> (the picker still lists every pin).

import { useEffect, useRef, useState } from "react";
import type {
  CodexModelCatalog,
  CodexModelOption,
} from "../../shared/types";
import {
  MODEL_LIST_LIMIT,
  addPin,
  addSection,
  itemId,
  modelListItems,
  moveModelListItem,
  moveModelSection,
  movePinToSection,
  pinId,
  prefKey,
  removePin,
  removeSection,
  renameSection,
  toggleSectionCollapsed,
  type ModelListItem,
  type ModelPin,
  type ModelPreference,
  type ModelSection,
} from "../../shared/modelList";
import { useT } from "../locale";
import { api, tryCall, clientStore } from "../client";

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
  /** Section the pin currently sits under (for "No Group"). */
  pinSection?: string | null;
}
interface EffortState {
  pin: ModelPin;
  x: number;
  y: number;
}

export function ModelListSettings(): React.JSX.Element {
  const t = useT();
  const settings = clientStore.snapshot?.settings;
  const pins: ModelPin[] = settings?.modelList ?? [];
  const sections: ModelSection[] = settings?.modelSections ?? [];
  const collapsed: string[] = settings?.collapsedModelSections ?? [];
  const prefs: Record<string, ModelPreference> = settings?.modelPreferences ?? {};

  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [effortPop, setEffortPop] = useState<EffortState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropHint, setDropHint] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  useEffect(() => {
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
  }, []);

  // Transient menus close on outside mousedown / Escape / scroll — the
  // same discipline the message popover uses.
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

  const items = modelListItems(pins, sections);
  const trimmed = query.trim().toLowerCase();
  const optionById = new Map(
    (catalog?.state === "ready" ? catalog.models : []).map((m) => [m.id, m]),
  );
  const pinMatches = (pin: ModelPin) => {
    if (trimmed === "") return true;
    const opt = optionById.get(pin.modelID);
    const name = opt?.name ?? pin.modelID;
    return (
      name.toLowerCase().includes(trimmed) ||
      pin.modelID.toLowerCase().includes(trimmed)
    );
  };

  // Split items into ungrouped head + group blocks (frozen modelBlocks).
  const ungrouped: ModelPin[] = [];
  const groups: { section: ModelSection; pins: ModelPin[] }[] = [];
  for (const item of items) {
    if (item.kind === "pin") {
      if (groups.length === 0) ungrouped.push(item.pin);
      else groups[groups.length - 1]!.pins.push(item.pin);
    } else groups.push({ section: item.section, pins: [] });
  }
  const visibleUngrouped = ungrouped.filter(pinMatches);
  const visibleGroups = groups
    .map((g) => ({ ...g, pins: g.pins.filter(pinMatches) }))
    .filter((g) => trimmed === "" || g.pins.length > 0);

  const catalogModels: CodexModelOption[] =
    catalog?.state === "ready" ? catalog.models : [];
  const pinnedIds = new Set(pins.map(pinId));
  const catalogMatches = catalogModels.filter(
    (m) =>
      trimmed === "" ||
      m.name.toLowerCase().includes(trimmed) ||
      m.id.toLowerCase().includes(trimmed),
  );

  const sectionOfPin = (pin: ModelPin): string | null => {
    let last: string | null = null;
    for (const item of items) {
      if (item.kind === "section") last = item.section.id;
      else if (pinId(item.pin) === pinId(pin)) return last;
    }
    return null;
  };

  const writeItems = (
    r: { modelList: ModelPin[]; modelSections: ModelSection[] } | null,
  ) => {
    if (r) write({ modelList: r.modelList, modelSections: r.modelSections });
  };

  const movePinTo = (pin: ModelPin, target: ModelListItem, after: boolean) =>
    writeItems(moveModelListItem(pins, sections, { kind: "pin", pin }, target, after));

  // HTML5 drag: a pin row drops before/after another row or onto a group
  // header (joins that group at its end — frozen toSection before:nil).
  const onPinDrop = (e: React.DragEvent, target: ModelListItem, after: boolean) => {
    e.preventDefault();
    const dragged = dragRef.current;
    dragRef.current = null;
    setDropHint(null);
    if (!dragged) return;
    if (dragged.startsWith("section/")) {
      // Section drag reorders whole groups — only onto another section.
      if (target.kind === "section") {
        writeItems(
          moveModelListItem(
            pins, sections,
            { kind: "section", section: sections.find((s) => `section/${s.id}` === dragged)! },
            target, after,
          ),
        );
      }
      return;
    }
    const pin = pins.find((p) => pinId(p) === dragged);
    if (pin) movePinTo(pin, target, after);
  };
  const onGroupDrop = (e: React.DragEvent, sectionId: string | null) => {
    e.preventDefault();
    const dragged = dragRef.current;
    dragRef.current = null;
    setDropHint(null);
    if (!dragged || dragged.startsWith("section/")) return;
    const pin = pins.find((p) => pinId(p) === dragged);
    if (pin) writeItems(movePinToSection(pins, sections, pin, sectionId));
  };

  const commitRename = (id: string) => {
    const name = draft.trim();
    if (name !== "") write({ modelSections: renameSection(sections, id, name) });
    setEditingId(null);
  };

  const summary = (pin: ModelPin): string => {
    const opt = optionById.get(pin.modelID);
    const pref = prefs[prefKey(pin.provider, pin.modelID)];
    const parts = [t("Codex")];
    if (opt && opt.efforts.length > 0) {
      const eff = pref?.effort ?? opt.defaultEffort;
      if (eff) parts.push(`${effortTitle(eff)} ${t("effort")}`);
    }
    if (pref?.fastMode === true && opt?.fastTier) parts.push(t("Fast"));
    return parts.join(" · ");
  };

  const pinRow = (pin: ModelPin, sectionId: string | null, first: boolean) => {
    const opt = optionById.get(pin.modelID);
    const name = opt?.name ?? pin.modelID;
    const id = pinId(pin);
    return (
      <div
        key={id}
        className={`ml-pin${first ? " first" : ""}${dropHint === `pin:${id}` ? " drop-hint" : ""}`}
        draggable
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
          if (!dragRef.current || dragRef.current === id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropHint(`pin:${id}`);
        }}
        onDragLeave={() => setDropHint((h) => (h === `pin:${id}` ? null : h))}
        onDrop={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          onPinDrop(e, { kind: "pin", pin }, after);
        }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu(null);
          setEffortPop({ pin, x: Math.min(rect.right - 330, window.innerWidth - 340), y: rect.bottom + 4 });
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
            setEffortPop({ pin, x: Math.min(rect.left, window.innerWidth - 340), y: rect.bottom + 4 });
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
            writeItems(removePin(pins, sections, pin));
          }}
        >
          ⊖
        </button>
      </div>
    );
  };

  return (
    <div className="ml-settings">
      <input
        className="ml-search"
        type="search"
        placeholder={t("Search models")}
        aria-label={t("Search models")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="ml-head">
        <span className="ml-head-title">{t("Your models")}</span>
        <span className="ml-head-count">{`${pins.length} / ${MODEL_LIST_LIMIT}`}</span>
        {trimmed === "" && (
          <button
            className="ml-newgroup"
            onClick={() => {
              const next = addSection(sections, t("New group"), pins.length);
              write({ modelSections: next });
              const added = next[next.length - 1];
              if (added) {
                setEditingId(added.id);
                setDraft(added.name);
              }
            }}
          >
            {t("New group")}
          </button>
        )}
      </div>

      {pins.length === 0 ? (
        <div className="ml-card">
          <div className="ml-row">
            <div className="ml-row-main">
              <span className="ml-name">{t("No models chosen yet")}</span>
              <span className="ml-detail">
                {t("Until you add some below, the picker shows every model from your providers.")}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <>
          {(visibleUngrouped.length > 0 || visibleGroups.length === 0) && (
            <div
              className={`ml-card${dropHint === "ungrouped" ? " drop-hint" : ""}`}
              onDragOver={(e) => {
                if (dragRef.current && !dragRef.current.startsWith("section/")) {
                  e.preventDefault();
                  setDropHint("ungrouped");
                }
              }}
              onDragLeave={() => setDropHint((h) => (h === "ungrouped" ? null : h))}
              onDrop={(e) => {
                if ((e.target as HTMLElement).closest(".ml-pin")) return;
                onGroupDrop(e, null);
              }}
            >
              {visibleUngrouped.map((p, i) => pinRow(p, null, i === 0))}
            </div>
          )}
          {visibleGroups.map((g) => {
            const isCollapsed = trimmed === "" && collapsed.includes(g.section.id);
            const gIdx = visibleGroups.findIndex((x) => x.section.id === g.section.id);
            return (
              <div
                key={g.section.id}
                className={`ml-card ml-group${dropHint === `grp:${g.section.id}` ? " drop-hint" : ""}`}
                onDragOver={(e) => {
                  if (dragRef.current && !dragRef.current.startsWith("section/")) {
                    e.preventDefault();
                    setDropHint(`grp:${g.section.id}`);
                  }
                }}
                onDragLeave={() =>
                  setDropHint((h) => (h === `grp:${g.section.id}` ? null : h))
                }
                onDrop={(e) => {
                  if ((e.target as HTMLElement).closest(".ml-pin")) return;
                  onGroupDrop(e, g.section.id);
                }}
              >
                <div
                  className="ml-group-head"
                  draggable={trimmed === ""}
                  onDragStart={(e) => {
                    dragRef.current = `section/${g.section.id}`;
                    e.dataTransfer.setData("text/plain", `section/${g.section.id}`);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    dragRef.current = null;
                    setDropHint(null);
                  }}
                  onClick={() => {
                    if (editingId === g.section.id) return;
                    write({
                      collapsedModelSections: toggleSectionCollapsed(collapsed, g.section.id),
                    });
                  }}
                  onDoubleClick={() => {
                    setEditingId(g.section.id);
                    setDraft(g.section.name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, kind: "section", sectionId: g.section.id });
                  }}
                >
                  <span className={`ml-chev${isCollapsed ? " closed" : ""}`} aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  {editingId === g.section.id ? (
                    <input
                      className="ml-rename"
                      value={draft}
                      autoFocus
                      aria-label={t("Group name")}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(g.section.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => commitRename(g.section.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="ml-group-name">{g.section.name}</span>
                  )}
                  <span className="ml-count">{g.pins.length}</span>
                  <span className="ml-group-actions">
                    <button
                      className="ml-icobtn"
                      title={t("Rename group")}
                      aria-label={t("Rename group")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(g.section.id);
                        setDraft(g.section.name);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="ml-icobtn"
                      title={t("Remove group heading. Models stay in the list.")}
                      aria-label={t("Remove group heading")}
                      onClick={(e) => {
                        e.stopPropagation();
                        write(removeSection(sections, collapsed, g.section.id));
                      }}
                    >
                      🗑
                    </button>
                  </span>
                </div>
                {!isCollapsed &&
                  (g.pins.length === 0 ? (
                    <div className="ml-empty-note">
                      {t("Empty. Right-click a model and choose Move to Group.")}
                    </div>
                  ) : (
                    g.pins.map((p, i) => pinRow(p, g.section.id, i === 0))
                  ))}
                {gIdx >= 0 && <span className="ml-ghost" aria-hidden="true" />}
              </div>
            );
          })}
        </>
      )}
      {trimmed === "" && (
        <p className="codex-note">
          {t(
            "Set this model's default reasoning effort and fast mode. New chats may inherit the current chat or a Hydra preset instead. Right-click to move the model to another group.",
          )}
        </p>
      )}

      <div className="ml-head">
        <span className="ml-head-title">{t("Codex")}</span>
      </div>
      <div className="ml-card">
        {catalog === null ? (
          <div className="ml-row"><span className="ml-detail">{t("Loading model list…")}</span></div>
        ) : catalog.state !== "ready" ? (
          <div className="ml-row"><span className="ml-detail">{catalog.reason}</span></div>
        ) : catalogMatches.length === 0 ? (
          <div className="ml-row">
            <span className="ml-detail">
              {trimmed === "" ? t("No models reported") : `${t("No models match")} “${query.trim()}”.`}
            </span>
          </div>
        ) : (
          catalogMatches.map((m) => {
            const pid = `codex/${m.id}`;
            const isPinned = pinnedIds.has(pid);
            const full = pins.length >= MODEL_LIST_LIMIT;
            return (
              <div key={m.id} className="ml-pin static">
                <span className="ml-provider" aria-hidden="true">◆</span>
                <span className="ml-name">
                  {m.name}
                  {m.isDefault ? " ★" : ""}
                </span>
                <span className="ml-summary">
                  {m.detail ?? ""}
                  {m.efforts.length > 0 ? ` · ${m.efforts.length} ${t("efforts")}` : ""}
                </span>
                <button
                  className={`ml-add${isPinned ? " pinned" : ""}`}
                  disabled={isPinned || full}
                  title={
                    isPinned
                      ? t("In the picker")
                      : full
                        ? t("The picker is full (30 models)")
                        : t("Add to the picker")
                  }
                  aria-label={isPinned ? t("In the picker") : t("Add to the picker")}
                  onClick={() =>
                    write({ modelList: addPin(pins, { provider: "codex", modelID: m.id }) })
                  }
                >
                  {isPinned ? "✓" : "+"}
                </button>
              </div>
            );
          })
        )}
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
                    writeItems(movePinToSection(pins, sections, menu.pin!, null));
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
                      writeItems(movePinToSection(pins, sections, menu.pin!, s.id));
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
                  writeItems(removePin(pins, sections, menu.pin!));
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
                    setEditingId(s.id);
                    setDraft(s.name);
                  }
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Rename")}</span>
              </button>
              <button
                role="menuitem"
                className="suggest-row msg-row"
                disabled={groups.findIndex((g) => g.section.id === menu.sectionId) <= 0}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  writeItems(moveModelSection(pins, sections, menu.sectionId!, -1));
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Move Up")}</span>
              </button>
              <button
                role="menuitem"
                className="suggest-row msg-row"
                disabled={
                  groups.findIndex((g) => g.section.id === menu.sectionId) ===
                  groups.length - 1
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  writeItems(moveModelSection(pins, sections, menu.sectionId!, 1));
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
                  write(removeSection(sections, collapsed, menu.sectionId!));
                  setMenu(null);
                }}
              >
                <span className="suggest-name">{t("Remove group heading")}</span>
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
          onPref={(p) => {
            const next = { ...prefs };
            const key = prefKey(effortPop.pin.provider, effortPop.pin.modelID);
            if (p.effort === undefined && p.fastMode !== true) delete next[key];
            else next[key] = p;
            write({ modelPreferences: next });
          }}
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
            {effortTitle(e)}
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
