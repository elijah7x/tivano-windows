// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F27 command palette (bounded): Ctrl+K opens an overlay that searches
// threads, projects and local actions — arrow keys navigate, Enter runs,
// Esc/backdrop closes, hover keeps pointer and keyboard in agreement.
// Actions are local UI operations only; no remappable-shortcut store yet.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";

interface Item {
  id: string;
  title: string;
  subtitle?: string | undefined;
  kind: "action" | "thread" | "project";
  shortcut?: string | undefined;
  run: () => void;
}

const CAP = 12;

export function CommandPalette(props: {
  snapshot: Snapshot;
  selectedThreadId: string | null;
  onClose: () => void;
  onToggleDock: (name: "terminal" | "git") => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const t = useT();
  const { snapshot, selectedThreadId } = props;
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setSelection(0), [query]);

  const selected = snapshot.threads.find((x) => x.id === selectedThreadId) ?? null;

  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase();
    const close = props.onClose;
    const actions: Item[] = [
      {
        id: "new-thread",
        kind: "action",
        title: t("New thread"),
        run: () => {
          // Frozen newThreadLocation — the ordinary new-thread action is
          // a .current-affiliation create; "standalone" detaches it. The
          // decision resolves main-side (locationDefault) so the palette
          // never acts on a just-superseded settings copy.
          void callApi("threads:create", {
            projectId: selected?.projectId ?? null,
            locationDefault: true,
          }).then((r) => {
            const made = r as { id: string };
            void callApi("threads:select", { id: made.id });
          });
        },
      },
      {
        id: "new-project",
        kind: "action",
        title: t("New project"),
        run: () => void callApi("projects:open-directory", {}),
      },
      {
        id: "settings",
        kind: "action",
        title: t("Settings"),
        run: props.onOpenSettings,
      },
    ];
    if (selected) {
      actions.splice(1, 0,
        {
          id: "terminal",
          kind: "action",
          title: t("Toggle terminal"),
          run: () => props.onToggleDock("terminal"),
        },
        {
          id: "changes",
          kind: "action",
          title: t("Toggle changes"),
          run: () => props.onToggleDock("git"),
        },
        {
          id: "plan-mode",
          kind: "action",
          title:
            selected.interactionMode === "plan" ? t("Switch to build mode") : t("Switch to plan mode"),
          run: () =>
            void callApi("threads:set-interaction-mode", {
              threadId: selected.id,
              mode: selected.interactionMode === "plan" ? "build" : "plan",
            }),
        },
        {
          id: "archive",
          kind: "action",
          title: t("Archive thread"),
          run: () => void callApi("threads:archive", { id: selected.id }),
        },
      );
    }
    const matchingActions = needle
      ? actions.filter((a) => a.title.toLowerCase().includes(needle))
      : actions;
    const threads: Item[] = snapshot.threads
      .filter((x) => !x.isArchived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((x) => !needle || x.title.toLowerCase().includes(needle))
      .slice(0, needle ? 10 : 6)
      .map((x) => ({
        id: `thread-${x.id}`,
        kind: "thread" as const,
        title: x.title,
        subtitle: x.projectId
          ? (snapshot.projects.find((p) => p.id === x.projectId)?.name ?? undefined)
          : t("Task"),
        run: () => void callApi("threads:select", { id: x.id }),
      }));
    const projects: Item[] = !needle
      ? []
      : snapshot.projects
          .filter((p) => p.name.toLowerCase().includes(needle))
          .slice(0, 12)
          .map((p) => ({
            id: `project-${p.id}`,
            kind: "project" as const,
            title: t("New thread in %@", p.name),
            subtitle: p.directory,
            run: () => {
              void callApi("threads:create", { projectId: p.id }).then((r) => {
                const made = r as { id: string };
                void callApi("threads:select", { id: made.id });
              });
            },
          }));
    const ordered = needle
      ? [...matchingActions, ...threads, ...projects]
      : [...threads, ...matchingActions];
    return ordered.slice(0, CAP);
  }, [query, snapshot, selectedThreadId, selected, t]);

  const run = () => {
    const item = items[selection];
    if (!item) return;
    props.onClose();
    item.run();
  };

  return (
    <div className="palette-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-label={t("Command palette")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search threads, projects and actions")}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelection((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelection((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run();
              } else if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              }
            }}
          />
        </div>
        {items.length === 0 ? (
          <div className="palette-empty">
            {t("Nothing matches “%@”", query)}
          </div>
        ) : (
          <div className="palette-items" role="listbox">
            {items.map((item, i) => (
              <div
                key={item.id}
                role="option"
                aria-selected={i === selection}
                className={`palette-item${i === selection ? " sel" : ""}`}
                onMouseEnter={() => setSelection(i)}
                onClick={() => {
                  setSelection(i);
                  run();
                }}
              >
                <span className="palette-item-title">{item.title}</span>
                {item.subtitle && (
                  <span className="palette-item-sub">{item.subtitle}</span>
                )}
                {item.shortcut && (
                  <span className="palette-item-key">{item.shortcut}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
