// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Sidebar: project groups, thread rows with status marks, search, Settings.
// Electron has no window.prompt/confirm, so rename/create use inline fields,
// thread delete uses a two-tap armed confirmation on the row itself, and
// project removal opens an anchored confirmation popover beside the project row.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatThread, OpenDirectoryResult, Snapshot } from "../../shared/types";
import {
  isAnchorVisibleInContainer,
  pointToAnchor,
  rectToAnchor,
  sameAnchorRect,
  type AnchorRect,
} from "../../shared/popoverAnchor";
import { anchoredPopoverStyle, useAnchoredPopover } from "../useAnchoredPopover";
import { compareThreads } from "../../shared/threadOrder";
import { useT } from "../locale";
import { api, callApi, clientStore, tryCall, type WeatherFlashStatus } from "../client";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { RemoveProjectPopover } from "./RemoveProjectPopover";
import { MiniSpinner } from "./SpinnerCells";
import { Skylight } from "./Skylight";
import { resolveWeatherWindowMode } from "../../shared/skylight";

/** P2-34 (frozen SidebarView RowActionsButton): a thread row's hover strip
 *  keeps the immediate affordances but never a bare archive button — archive
 *  and delete live in the row menu so a stray click cannot archive. */
export type ThreadRowHoverAction = "reveal" | "pin" | "rename" | "menu" | "delete";
export const THREAD_ROW_HOVER_ACTIONS: readonly ThreadRowHoverAction[] = [
  "reveal",
  "pin",
  "rename",
  "menu",
  "delete",
];

export type ThreadRowMenuAction = "rename" | "pin" | "forward" | "reveal" | "archive" | "delete";

/** Frozen ThreadActions.make/makeContextMenu order: Rename, Pin (a helper
 *  keeps its place under its parent, so no pin item), Forward, Reveal
 *  worktree when one exists, then the destructive pair. */
export function threadRowMenuItems(opts: {
  isHelper: boolean;
  hasWorktree: boolean;
}): ThreadRowMenuAction[] {
  const items: ThreadRowMenuAction[] = ["rename"];
  if (!opts.isHelper) items.push("pin");
  items.push("forward");
  if (opts.hasWorktree) items.push("reveal");
  items.push("archive", "delete");
  return items;
}

function statusDot(t: ChatThread): string {
  const s = t.turn?.status;
  if (!s || s === "done") return "idle";
  return s;
}

/** Frozen ThreadStatusMark: a running turn wears the 2×3 perimeter
 *  spinner, not a static dot (SidebarView's MiniSpinner call site). */
function statusMark(t: ChatThread): React.JSX.Element {
  const s = statusDot(t);
  if (s === "running" || s === "waiting-approval") return <MiniSpinner />;
  return <span className={`dot ${s}`} aria-hidden="true" />;
}

export function Sidebar(props: {
  snapshot: Snapshot;
  finishFlashes?: Readonly<Record<string, WeatherFlashStatus>> | undefined;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}): React.JSX.Element {
  const t = useT();
  const [search, setSearch] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // F01/F02 drag state: a thread row reorders inside its affiliation or
  // drops onto a project header to change affiliation; a project row
  // reorders the project list itself. Disabled while searching.
  const [drag, setDrag] = useState<{ kind: "thread" | "project"; id: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const [projectHint, setProjectHint] = useState<{ id: string; mode: "before" | "after" | "into" } | null>(null);
  // F01: the project-icon popover, anchored at the clicked mark button.
  const [iconPop, setIconPop] = useState<{ projectId: string; x: number; y: number } | null>(null);
  // P2-78: Remove-this-project confirmation popover anchored beside the selected project row.
  const [pendingProjectDelete, setPendingProjectDelete] = useState<{
    projectId: string;
    anchor: AnchorRect;
  } | null>(null);
  const threadListRef = useRef<HTMLDivElement>(null);
  const projectRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const projectDeleteBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // v2.2.x: the shelf popover + inline shelf rename (v2.2.22).
  const [shelfOpen, setShelfOpen] = useState(false);
  const [shelfRename, setShelfRename] = useState<string | null>(null);
  const { snapshot } = props;
  const q = search.trim().toLowerCase();
  // P2-34 / P2-71: the thread-row ⋯/context menu (frozen RowActionsButton +
  // contextMenu). Captures anchor + optional trigger element so React
  // re-renders, async layout settling, and constrained viewports never jump.
  const [threadMenu, setThreadMenu] = useState<{
    th: ChatThread;
    anchor: AnchorRect;
    alignEnd: boolean;
    triggerEl: HTMLElement | null;
    rowEl: HTMLElement | null;
    rowTopAtOpen: number;
  } | null>(null);
  const getThreadMenuAnchor = useCallback((): AnchorRect | null => {
    if (!threadMenu) return null;
    if (!threadMenu.triggerEl) return threadMenu.anchor;
    if (!threadMenu.triggerEl.isConnected) return null;
    const btnRect = threadMenu.triggerEl.getBoundingClientRect();
    const listEl = threadListRef.current;
    if (btnRect.width > 0 && btnRect.height > 0) {
      const anchor = rectToAnchor(btnRect);
      if (listEl && !isAnchorVisibleInContainer(anchor, rectToAnchor(listEl.getBoundingClientRect()))) {
        return null;
      }
      return anchor;
    }
    // .row-actions switches to display:none once hover/focus leaves the row;
    // preserve the horizontal button anchor and track the visible owning row.
    const rowEl = threadMenu.rowEl;
    if (!rowEl || !rowEl.isConnected) return null;
    const rowRect = rowEl.getBoundingClientRect();
    if (rowRect.width <= 0 || rowRect.height <= 0) return null;
    if (listEl && !isAnchorVisibleInContainer(rectToAnchor(rowRect), rectToAnchor(listEl.getBoundingClientRect()))) {
      return null;
    }
    const dy = rowRect.top - threadMenu.rowTopAtOpen;
    if (Math.abs(dy) < 0.5) return threadMenu.anchor;
    return {
      ...threadMenu.anchor,
      top: threadMenu.anchor.top + dy,
      bottom: threadMenu.anchor.bottom + dy,
    };
  }, [threadMenu]);
  const closeThreadMenu = useCallback(() => setThreadMenu(null), []);
  const { popRef: threadMenuRef, position: threadMenuPos } = useAnchoredPopover<HTMLDivElement>({
    open: threadMenu !== null,
    targetKey: threadMenu
      ? `${threadMenu.th.id}:${threadMenu.anchor.left}:${threadMenu.anchor.top}:${threadMenu.alignEnd}`
      : null,
    initialAnchor: threadMenu?.anchor ?? null,
    getAnchorRect: getThreadMenuAnchor,
    estimatedSize: { width: 190, height: 210 },
    preferredSide: "bottom",
    align: threadMenu?.alignEnd ? "end" : "start",
    constrainSideHeight: true,
    gap: threadMenu?.triggerEl ? 4 : 0,
    scrollContainer: threadListRef.current,
    onAnchorLost: closeThreadMenu,
    layoutKey: threadMenu ? `${threadMenu.th.id}:${!!threadMenu.th.worktreeDir}:${!!threadMenu.th.parentThreadId}` : null,
  });
  useEffect(() => {
    if (!threadMenu) return;
    const down = (e: MouseEvent): void => {
      if (!threadMenuRef.current?.contains(e.target as Node)) setThreadMenu(null);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setThreadMenu(null);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [threadMenu, threadMenuRef]);
  // F15: frozen "Reveal in Finder" — the platform's file manager name.
  const fileManagerReveal =
    api().platform === "win32" ? t("Reveal in File Explorer") : t("Reveal in Finder");
  const worktreeReveal =
    api().platform === "win32"
      ? t("Reveal worktree in File Explorer")
      : t("Reveal worktree in Finder");
  // F02: frozen confirmBeforeDeleting (default on) — off means the ×
  // deletes immediately instead of arming the two-tap "Delete?" row.
  const confirmDelete = snapshot.settings.confirmBeforeDeleting !== false;
  const requestDelete = (id: string) => {
    if (confirmDelete) setArmedDeleteId(id);
    else tryCall("threads:delete", { id });
  };

  const rowMenuLabel = (a: ThreadRowMenuAction, th: ChatThread): string => {
    switch (a) {
      case "rename":
        return t("Rename");
      case "pin":
        return th.isPinned ? t("Unpin") : t("Pin");
      case "forward":
        return t("Forward to new thread");
      case "reveal":
        return worktreeReveal;
      case "archive":
        return t("Archive");
      case "delete":
        return `${t("Delete")}…`;
    }
  };
  const runRowMenuAction = (a: ThreadRowMenuAction, th: ChatThread): void => {
    switch (a) {
      case "rename":
        setRenameText(th.title);
        setRenamingId(th.id);
        break;
      case "pin":
        tryCall("threads:set-pinned", { threadId: th.id, pinned: !th.isPinned });
        break;
      case "forward":
        tryCall("threads:forward", { threadId: th.id });
        break;
      case "reveal":
        tryCall("openin:reveal", { threadId: th.id });
        break;
      case "archive":
        tryCall("threads:archive", { id: th.id });
        break;
      case "delete":
        requestDelete(th.id);
        break;
    }
  };

  const rowActionButton = (a: ThreadRowHoverAction, th: ChatThread): React.JSX.Element | null => {
    switch (a) {
      case "reveal":
        if (!th.worktreeDir) return null;
        return (
          <button
            key={a}
            className="icon-btn"
            title={worktreeReveal}
            aria-label={`${worktreeReveal}: ${th.title}`}
            onClick={(e) => {
              e.stopPropagation();
              tryCall("openin:reveal", { threadId: th.id });
            }}
          >
            ⎇
          </button>
        );
      case "pin":
        return (
          <button
            key={a}
            className="icon-btn"
            title={th.isPinned ? t("Unpin thread") : t("Pin thread")}
            aria-label={`${th.isPinned ? t("Unpin thread") : t("Pin thread")}: ${th.title}`}
            onClick={(e) => {
              e.stopPropagation();
              tryCall("threads:set-pinned", { threadId: th.id, pinned: !th.isPinned });
            }}
          >
            📌
          </button>
        );
      case "rename":
        return (
          <button
            key={a}
            className="icon-btn"
            title={t("Rename thread")}
            aria-label={`${t("Rename thread")}: ${th.title}`}
            onClick={(e) => {
              e.stopPropagation();
              setRenameText(th.title);
              setRenamingId(th.id);
            }}
          >
            ✎
          </button>
        );
      case "menu":
        return (
          <button
            key={a}
            className="icon-btn"
            title={t("Thread actions")}
            aria-label={`${t("Thread actions")}: ${th.title}`}
            onClick={(e) => {
              e.stopPropagation();
              const btn = e.currentTarget;
              const rowEl = btn.closest<HTMLElement>(".row");
              setThreadMenu({
                th,
                anchor: rectToAnchor(btn.getBoundingClientRect()),
                alignEnd: true,
                triggerEl: btn,
                rowEl,
                rowTopAtOpen: rowEl ? rowEl.getBoundingClientRect().top : 0,
              });
            }}
          >
            ⋯
          </button>
        );
      case "delete":
        return (
          <button
            key={a}
            className="icon-btn"
            title={t("Delete thread")}
            aria-label={`${t("Delete thread")}: ${th.title}`}
            onClick={(e) => {
              e.stopPropagation();
              requestDelete(th.id);
            }}
          >
            ×
          </button>
        );
    }
  };

  const groups = useMemo(() => {
    const byProject = new Map<string, ChatThread[]>();
    for (const p of snapshot.projects) byProject.set(p.id, []);
    const ungrouped: ChatThread[] = [];
    const archived: ChatThread[] = [];
    for (const th of snapshot.threads) {
      // Archived threads never appear in the main groups or search hits;
      // they only live in the Archived section at the bottom.
      if (th.isArchived) {
        archived.push(th);
        continue;
      }
      // F22: Hydra heads surface in the lead's head panel, never here.
      if (th.hydraHead) continue;
      // F25: a helper lives in its panel while it is open — only a
      // CLOSED helper drops to the sidebar, nested under its parent
      // (frozen isInPanel → smaller row under the spawning chat).
      if (th.isInPanel && th.parentThreadId) continue;
      if (th.projectId && byProject.has(th.projectId)) byProject.get(th.projectId)!.push(th);
      else if (!th.projectId) ungrouped.push(th);
    }
    archived.sort((a, b) => b.updatedAt - a.updatedAt);
    const matchThread = (th: ChatThread) => !q || th.title.toLowerCase().includes(q);
    // F01/F02 frozen order: pinned first, then manual sortOrder, threads
    // never reordered stay on top, newest createdAt last.
    const frozenOrder = (xs: ChatThread[]) => xs.slice().sort(compareThreads);
    // F25: closed helpers ride nested directly under their parent row
    // (frozen SidebarHero); an orphaned helper keeps its slot as an
    // ordinary row. While searching, helpers stand alone like any match.
    const nestHelpers = (xs: ChatThread[]): ChatThread[] => {
      if (q !== "") return xs;
      const ids = new Set(xs.map((x) => x.id));
      const byParent = new Map<string, ChatThread[]>();
      const mains: ChatThread[] = [];
      for (const th of xs) {
        if (th.parentThreadId && ids.has(th.parentThreadId))
          byParent.set(th.parentThreadId, [...(byParent.get(th.parentThreadId) ?? []), th]);
        else mains.push(th);
      }
      return mains.flatMap((th) => [th, ...(byParent.get(th.id) ?? [])]);
    };
    // v2.2.x frozen shelving: shelved projects leave the list for the
    // shelf row; their threads still show under search (finding a thread
    // never unshelves) but the project row itself stays in the shelf.
    const shelfProjects = snapshot.projects.filter((p) => p.isShelved);
    const shelfIds = new Set(shelfProjects.map((p) => p.id));
    const shelfHasUnread = snapshot.threads.some(
      (th) =>
        !th.isArchived &&
        th.hasUnread &&
        th.projectId !== null &&
        shelfIds.has(th.projectId),
    );
    return {
      // A group stays visible while searching when the project name matches
      // (showing all its threads) or when any child thread matches.
      projects: snapshot.projects
        .filter((p) => !p.isShelved)
        .map((p) => {
          const kids = byProject.get(p.id) ?? [];
          const nameMatch = !q || p.name.toLowerCase().includes(q);
          const threads = nestHelpers(
            frozenOrder(nameMatch ? kids : kids.filter(matchThread)),
          );
          return { project: p, threads, visible: !q || nameMatch || threads.length > 0 };
        })
        .filter((g) => g.visible),
      // Shelf popover contents: shelved projects with their live threads
      // (browse without unshelving — frozen 2.2.6 shelf panel).
      shelf: shelfProjects.map((p) => ({
        project: p,
        threads: nestHelpers(frozenOrder(byProject.get(p.id) ?? [])),
      })),
      shelfHasUnread,
      ungrouped: nestHelpers(frozenOrder(ungrouped.filter(matchThread))),
      archived,
    };
  }, [snapshot, q]);

  const pendingProjectId = pendingProjectDelete?.projectId ?? null;
  const pendingProject = useMemo(
    () =>
      pendingProjectId
        ? (snapshot.projects.find((p) => p.id === pendingProjectId && !p.isShelved) ?? null)
        : null,
    [snapshot.projects, pendingProjectId],
  );
  const pendingProjectThreadCount = useMemo(
    () =>
      pendingProject
        ? snapshot.threads.filter((th) => th.projectId === pendingProject.id).length
        : 0,
    [snapshot.threads, pendingProject],
  );

  const readProjectAnchor = useCallback(
    (projectId: string): { anchor: AnchorRect; visible: boolean } | null => {
      const rowEl = projectRowRefs.current.get(projectId);
      if (!rowEl) return null;
      const anchor = rectToAnchor(rowEl.getBoundingClientRect());
      const listEl = threadListRef.current;
      const visible = listEl
        ? isAnchorVisibleInContainer(anchor, rectToAnchor(listEl.getBoundingClientRect()))
        : true;
      return { anchor, visible };
    },
    [],
  );

  const getPendingTriggerEl = useCallback(
    () => (pendingProjectId ? (projectDeleteBtnRefs.current.get(pendingProjectId) ?? null) : null),
    [pendingProjectId],
  );

  const getPendingAnchorRect = useCallback(
    () => (pendingProjectId ? readProjectAnchor(pendingProjectId) : null),
    [pendingProjectId, readProjectAnchor],
  );

  const cancelProjectDelete = useCallback(
    (restoreFocus: boolean): void => {
      const targetId = pendingProjectId;
      setPendingProjectDelete(null);
      if (restoreFocus && targetId) {
        requestAnimationFrame(() => {
          projectDeleteBtnRefs.current.get(targetId)?.focus();
        });
      }
    },
    [pendingProjectId],
  );

  const confirmProjectDelete = useCallback((): void => {
    if (!pendingProject) return;
    const id = pendingProject.id;
    const projectIds = groups.projects.map((g) => g.project.id);
    const idx = projectIds.indexOf(id);
    const adjacentId =
      idx >= 0
        ? (projectIds[idx + 1] ?? projectIds[idx - 1])
        : projectIds.find((pid) => pid !== id);
    setPendingProjectDelete(null);
    tryCall("projects:delete", { id });
    requestAnimationFrame(() => {
      if (adjacentId) {
        const nextBtn = projectDeleteBtnRefs.current.get(adjacentId);
        if (nextBtn) {
          nextBtn.focus();
          return;
        }
      }
      threadListRef.current?.focus();
    });
  }, [pendingProject, groups.projects]);

  useEffect(() => {
    if (pendingProjectDelete && (!pendingProject || snapshot.readOnly === true)) {
      setPendingProjectDelete(null);
    }
  }, [pendingProjectDelete, pendingProject, snapshot.readOnly]);

  // Re-sync anchor coordinates if project collapse/expand, search, or sibling
  // updates shift the selected row's position while the popover is open.
  useLayoutEffect(() => {
    if (!pendingProjectId || !pendingProject) return;
    const next = readProjectAnchor(pendingProjectId);
    if (!next || !next.visible) {
      setPendingProjectDelete(null);
      return;
    }
    setPendingProjectDelete((prev) => {
      if (!prev || prev.projectId !== pendingProjectId) return prev;
      return sameAnchorRect(prev.anchor, next.anchor)
        ? prev
        : { projectId: pendingProjectId, anchor: next.anchor };
    });
  }, [pendingProjectId, pendingProject, groups.projects, q, readProjectAnchor]);

  const select = (id: string) => tryCall("threads:select", { id });

  const clearDrag = () => {
    setDrag(null);
    setDropHint(null);
    setProjectHint(null);
  };

  // Frozen moveThread: same affiliation → reorder at the drop half;
  // different affiliation → gated move first, then land at the drop half.
  const dropOnThread = (e: React.DragEvent<HTMLDivElement>, target: ChatThread) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const active = drag;
    clearDrag();
    if (!active || active.kind !== "thread" || active.id === target.id) return;
    const moving = snapshot.threads.find((x) => x.id === active.id);
    if (!moving) return;
    if (moving.projectId === target.projectId) {
      tryCall("threads:reorder", { id: moving.id, targetId: target.id, placeAfter: after });
      return;
    }
    callApi("threads:move-affiliation", { id: moving.id, projectId: target.projectId })
      .then((r) => {
        if ((r as { moved: boolean }).moved)
          tryCall("threads:reorder", { id: moving.id, targetId: target.id, placeAfter: after });
        else clientStore.reportError(t("Could not change thread location"));
      })
      .catch(() => {
        /* callApi already surfaced the banner */
      });
  };

  const dropOnProject = (e: React.DragEvent<HTMLDivElement>, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const active = drag;
    clearDrag();
    if (!active) return;
    if (active.kind === "thread") {
      const moving = snapshot.threads.find((x) => x.id === active.id);
      if (!moving || moving.projectId === projectId) return;
      callApi("threads:move-affiliation", { id: moving.id, projectId })
        .then((r) => {
          if (!(r as { moved: boolean }).moved)
            clientStore.reportError(t("Could not change thread location"));
        })
        .catch(() => {
          /* callApi already surfaced the banner */
        });
      return;
    }
    if (active.id !== projectId)
      tryCall("projects:reorder", { id: active.id, targetId: projectId, placeAfter: after });
  };

  const dropOnUngrouped = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const active = drag;
    clearDrag();
    if (!active || active.kind !== "thread") return;
    const moving = snapshot.threads.find((x) => x.id === active.id);
    if (!moving || moving.projectId === null) return;
    callApi("threads:move-affiliation", { id: moving.id, projectId: null })
      .then((r) => {
        if (!(r as { moved: boolean }).moved)
          clientStore.reportError(t("Could not change thread location"));
      })
      .catch(() => {
        /* callApi already surfaced the banner */
      });
  };

  // Ask main for the directory chooser — the empty payload is deliberate:
  // the renderer can never name a path. The result only tells us which
  // projects main created/bound; partial failures surface in the banner.
  const openFolder = () => {
    setOpeningFolder(true);
    callApi("projects:open-directory", {})
      .then((r) => {
        const res = r as OpenDirectoryResult;
        if (res.errors?.length) clientStore.reportError(res.errors.join("\n"));
      })
      .catch(() => {
        /* callApi already surfaced the banner */
      })
      .finally(() => setOpeningFolder(false));
  };

  const submitProject = () => {
    const name = projectName.trim();
    if (name) tryCall("projects:create", { name });
    setProjectName("");
    setCreatingProject(false);
  };

  const submitRename = (id: string) => {
    const title = renameText.trim();
    if (title) tryCall("threads:rename", { id, title });
    setRenamingId(null);
  };

  const threadRow = (th: ChatThread) => (
    <div
      key={th.id}
      data-thread-id={th.id}
      className={`row${th.parentThreadId ? " helper-row" : ""}${snapshot.selectedThreadId === th.id ? " selected" : ""}${th.isPinned ? " pinned" : ""}${
        drag?.kind === "thread" && drag.id === th.id ? " dragging" : ""
      }${dropHint?.id === th.id ? (dropHint.after ? " drop-after" : " drop-before") : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => select(th.id)}
      onKeyDown={(e) => e.key === "Enter" && select(th.id)}
      title={th.title}
      draggable={q === ""}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", th.id);
        e.dataTransfer.effectAllowed = "move";
        setDrag({ kind: "thread", id: th.id });
      }}
      onDragEnd={clearDrag}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setDropHint({ id: th.id, after: e.clientY > rect.top + rect.height / 2 });
        setProjectHint(null);
      }}
      onDrop={(e) => dropOnThread(e, th)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setThreadMenu({
          th,
          anchor: pointToAnchor(e.clientX, e.clientY),
          alignEnd: false,
          triggerEl: null,
          rowEl: null,
          rowTopAtOpen: 0,
        });
      }}
    >
      {statusMark(th)}
      {th.hasUnread && (
        <span
          className={`unread-mark ${th.unreadStatus ?? "done"}`}
          title={
            th.unreadStatus === "error"
              ? t("Finished with an error")
              : th.unreadStatus === "interrupted"
                ? t("Interrupted")
                : t("Finished")
          }
          aria-label={
            th.unreadStatus === "error"
              ? t("Unread: finished with an error")
              : th.unreadStatus === "interrupted"
                ? t("Unread: interrupted")
                : t("Unread: finished")
          }
        />
      )}
      {th.isPinned && <span className="pin-mark" aria-hidden="true">📌</span>}
      {renamingId === th.id ? (
        <input
          className="inline-edit"
          aria-label={t("Rename thread")}
          autoFocus
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitRename(th.id);
            if (e.key === "Escape") setRenamingId(null);
          }}
          onBlur={() => setRenamingId(null)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="title">{th.title}</span>
      )}
      {armedDeleteId === th.id ? (
        <button
          className="icon-btn danger-arm"
          onClick={(e) => {
            e.stopPropagation();
            setArmedDeleteId(null);
            tryCall("threads:delete", { id: th.id });
          }}
          onBlur={() => setArmedDeleteId(null)}
          autoFocus
        >
          {t("Delete")}?
        </button>
      ) : (
        <span className="row-actions">
          {THREAD_ROW_HOVER_ACTIONS.map((a) => rowActionButton(a, th))}
        </span>
      )}
    </div>
  );

  return (
    <nav className="sidebar sidebar-tray" aria-label={t("Thread list")}>
      <div className="sidebar-head">
        <span className="grow">
          {t("Thread list")}
          {snapshot.threads.some((th) => th.hasUnread && !th.isArchived) && (
            <span
              className="unread-count"
              aria-label={t("Unread results")}
              title={t("Unread results")}
            >
              {snapshot.threads.filter((th) => th.hasUnread && !th.isArchived).length}
            </span>
          )}
        </span>
        <button
          className="icon-btn"
          title={t("Command palette")}
          aria-label={t("Command palette")}
          onClick={props.onOpenPalette}
        >
          ⌘
        </button>
        <button
          className="icon-btn"
          title={t("New thread")}
          aria-label={t("New thread")}
          onClick={() => tryCall("threads:create", { projectId: null })}
        >
          ＋
        </button>
        <button
          className="icon-btn folder-new"
          title={t("New project")}
          aria-label={t("New project")}
          onClick={() => setCreatingProject(true)}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
            <path
              d="M1 3.4a1 1 0 0 1 1-1h3.1L6.3 4H11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3.4Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <path
              d="M6.5 5.8v3.4M4.8 7.5h3.4"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className="icon-btn folder-open"
          title={openingFolder ? t("Opening…") : t("Open folder")}
          aria-label={t("Open folder")}
          aria-busy={openingFolder || undefined}
          disabled={openingFolder || snapshot.readOnly === true}
          onClick={openFolder}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
            <path
              d="M1 3.4a1 1 0 0 1 1-1h3.1L6.3 4H11a1 1 0 0 1 1 1v1.2H4.1a1.6 1.6 0 0 0-1.5 1.1L1 11V3.4Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <path
              d="M2.8 10.5a.6.6 0 0 0 .55.38h7.1a1.4 1.4 0 0 0 1.32-.95l.75-2.28a.6.6 0 0 0-.57-.77H4.55a1 1 0 0 0-.95.68L2.8 10.5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {/* P2-47 (frozen SidebarPorthole): non-interactive weather porthole
          above the thread list when Weather window is set to Porthole. */}
      {resolveWeatherWindowMode(snapshot.settings) === "porthole" && (
        <Skylight
          threads={snapshot.threads}
          projects={snapshot.projects}
          finishFlashes={props.finishFlashes}
        />
      )}
      {creatingProject && (
        <div className="search">
          <input
            aria-label={t("Project name")}
            placeholder={t("Project name")}
            autoFocus
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitProject();
              if (e.key === "Escape") setCreatingProject(false);
            }}
            onBlur={submitProject}
          />
        </div>
      )}
      <div className="search">
        <input
          type="search"
          placeholder={t("Search threads")}
          aria-label={t("Search threads")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="thread-list" role="list" ref={threadListRef} tabIndex={-1}>
        {snapshot.projects.length === 0 && snapshot.threads.length === 0 && (
          <div className="center-state">
            <span>{t("No projects yet")}</span>
          </div>
        )}
        {groups.projects.map(({ project, threads }) => (
          <div key={project.id}>
            <div
              ref={(el) => {
                if (el) projectRowRefs.current.set(project.id, el);
                else projectRowRefs.current.delete(project.id);
              }}
              data-project-id={project.id}
              className={`group-row${
                projectHint?.id === project.id
                  ? projectHint.mode === "into"
                    ? " drop-into"
                    : projectHint.mode === "after"
                      ? " drop-after"
                      : " drop-before"
                  : ""
              }${drag?.kind === "project" && drag.id === project.id ? " dragging" : ""}`}
              draggable={q === ""}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", project.id);
                e.dataTransfer.effectAllowed = "move";
                setDrag({ kind: "project", id: project.id });
              }}
              onDragEnd={clearDrag}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                setProjectHint({
                  id: project.id,
                  mode: drag.kind === "thread" ? "into" : after ? "after" : "before",
                });
                setDropHint(null);
              }}
              onDragLeave={() => setProjectHint((h) => (h?.id === project.id ? null : h))}
              onDrop={(e) => dropOnProject(e, project.id)}
            >
              <button
                className="proj-icon"
                title={t("Choose this project's icon")}
                aria-label={`${t("Project icon")}: ${project.name}`}
                disabled={snapshot.readOnly === true}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setIconPop((p) =>
                    p?.projectId === project.id ? null : { projectId: project.id, x: r.left, y: r.bottom },
                  );
                }}
              >
                {project.icon ?? "📁"}
              </button>
              <button
                className={`group-name${project.expanded ? "" : " closed"}`}
                onClick={() =>
                  tryCall("projects:toggle", {
                    id: project.id,
                    expanded: !project.expanded,
                  })
                }
              >
                <span className="chevron">▾</span>
                <span className="title">{project.name}</span>
              </button>
              {project.directory && (
                <button
                  className="icon-btn"
                  title={`${fileManagerReveal} — ${project.directory}`}
                  aria-label={`${fileManagerReveal}: ${project.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    tryCall("openin:reveal", { projectId: project.id });
                  }}
                >
                  ⌂
                </button>
              )}
              <button
                className="icon-btn"
                title={t("Shelve project")}
                aria-label={`${t("Shelve project")}: ${project.name}`}
                disabled={snapshot.readOnly === true}
                onClick={(e) => {
                  e.stopPropagation();
                  tryCall("projects:set-shelved", { id: project.id, shelved: true });
                }}
              >
                ⇩
              </button>
              <button
                className="icon-btn group-add"
                title={t("New thread in %@", project.name)}
                aria-label={t("New thread in %@", project.name)}
                onClick={() => tryCall("threads:create", { projectId: project.id })}
              >
                ＋
              </button>
              <button
                ref={(el) => {
                  if (el) projectDeleteBtnRefs.current.set(project.id, el);
                  else projectDeleteBtnRefs.current.delete(project.id);
                }}
                type="button"
                className={`icon-btn${pendingProjectDelete?.projectId === project.id ? " active" : ""}`}
                title={t("Delete project")}
                aria-label={`${t("Delete project")}: ${project.name}`}
                aria-haspopup="dialog"
                aria-expanded={pendingProjectDelete?.projectId === project.id}
                aria-controls={
                  pendingProjectDelete?.projectId === project.id
                    ? "project-delete-popover"
                    : undefined
                }
                disabled={snapshot.readOnly === true}
                onClick={(e) => {
                  e.stopPropagation();
                  if (pendingProjectDelete?.projectId === project.id) {
                    setPendingProjectDelete(null);
                    return;
                  }
                  const rowEl =
                    projectRowRefs.current.get(project.id) ??
                    e.currentTarget.closest(".group-row") ??
                    e.currentTarget;
                  setPendingProjectDelete({
                    projectId: project.id,
                    anchor: rectToAnchor(rowEl.getBoundingClientRect()),
                  });
                }}
              >
                ×
              </button>
            </div>
            {project.directory && (
              <div className="dir-hint" title={project.directory}>
                <span className="dir-path">{project.directory}</span>
                {project.directoryStatus === "unavailable" && (
                  <span className="dir-badge">{t("Folder unavailable")}</span>
                )}
              </div>
            )}
            {/* While searching, matching child rows show regardless of the
                saved collapsed state; the stored expanded flag is never
                mutated by the filter. */}
            {(project.expanded || q !== "") && threads.map(threadRow)}
            {project.expanded && threads.length === 0 && !q && (
              <div className="group-empty">{t("No threads yet")}</div>
            )}
          </div>
        ))}
        {/* v2.2.x frozen shelf row — sits at the end of the project list,
            opens the shelf popover (browse without unshelving), carries
            an unread dot and a custom name (v2.2.22). */}
        {groups.shelf.length > 0 && (
          <div className="shelf-wrap">
            <div
              className="group-row shelf-row"
              onContextMenu={(e) => {
                e.preventDefault();
                setShelfRename(
                  snapshot.settings.shelvedGroupName ?? t("Shelved projects"),
                );
              }}
            >
              <button
                className="group-name shelf-toggle"
                aria-expanded={shelfOpen}
                onClick={() => setShelfOpen((v) => !v)}
              >
                <span className="chevron">{shelfOpen ? "▾" : "▸"}</span>
                <span className="shelf-icon" aria-hidden="true">▤</span>
                <span className="title">
                  {snapshot.settings.shelvedGroupName ?? t("Shelved projects")} (
                  {groups.shelf.length})
                </span>
                {groups.shelfHasUnread && <span className="shelf-unread" aria-label={t("Unread")} />}
              </button>
            </div>
            {shelfRename !== null && (
              <div className="shelf-rename">
                <input
                  autoFocus
                  aria-label={t("Rename shelf")}
                  value={shelfRename}
                  onChange={(e) => setShelfRename(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      tryCall("settings:set", {
                        shelvedGroupName: shelfRename.trim() || null,
                      });
                      setShelfRename(null);
                    }
                    if (e.key === "Escape") setShelfRename(null);
                  }}
                  onBlur={() => {
                    tryCall("settings:set", {
                      shelvedGroupName: shelfRename.trim() || null,
                    });
                    setShelfRename(null);
                  }}
                />
              </div>
            )}
            {shelfOpen && (
              <div className="shelf-pop">
                {groups.shelf.map(({ project, threads }) => (
                  <div key={project.id} className="shelf-proj">
                    <div className="shelf-proj-head">
                      <span className="shelf-proj-icon" aria-hidden="true">
                        {project.icon ?? "📁"}
                      </span>
                      <span className="shelf-proj-name" title={project.name}>
                        {project.name}
                      </span>
                      <button
                        className="icon-btn"
                        title={t("Unshelve project")}
                        aria-label={`${t("Unshelve project")}: ${project.name}`}
                        disabled={snapshot.readOnly === true}
                        onClick={() =>
                          tryCall("projects:set-shelved", { id: project.id, shelved: false })
                        }
                      >
                        ⇧
                      </button>
                    </div>
                    {threads.length === 0 && (
                      <div className="shelf-empty">{t("No shelved projects")}</div>
                    )}
                    {threads.map(threadRow)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div
          className={`ungrouped-zone${projectHint?.id === "__ungrouped__" ? " drop-into" : ""}`}
          onDragOver={(e) => {
            // Only a thread coming FROM a project can drop here to become
            // standalone — same-affiliation drags are handled on the rows.
            if (drag?.kind !== "thread") return;
            const moving = snapshot.threads.find((x) => x.id === drag.id);
            if (!moving || moving.projectId === null) return;
            e.preventDefault();
            setProjectHint({ id: "__ungrouped__", mode: "into" });
            setDropHint(null);
          }}
          onDragLeave={() => setProjectHint((h) => (h?.id === "__ungrouped__" ? null : h))}
          onDrop={dropOnUngrouped}
        >
          {groups.ungrouped.map(threadRow)}
        </div>
      </div>
      {groups.archived.length > 0 && (
        <div className="archived-block">
          <button
            className="archived-toggle"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
          >
            <span className="chevron">{showArchived ? "▾" : "▸"}</span>
            <span className="title">
              {t("Archived")} ({groups.archived.length})
            </span>
          </button>
          {showArchived &&
            groups.archived.map((th) => (
              <div key={th.id} className="row archived" title={th.title}>
                {statusMark(th)}
                <span className="title">{th.title}</span>
                {armedDeleteId === th.id ? (
                  <button
                    className="icon-btn danger-arm"
                    autoFocus
                    onBlur={() => setArmedDeleteId(null)}
                    onClick={() => {
                      setArmedDeleteId(null);
                      tryCall("threads:delete", { id: th.id });
                    }}
                  >
                    {t("Delete")}?
                  </button>
                ) : (
                  <span className="row-actions">
                    <button
                      className="icon-btn"
                      title={t("Restore thread")}
                      aria-label={`${t("Restore thread")}: ${th.title}`}
                      onClick={() => tryCall("threads:unarchive", { id: th.id })}
                    >
                      ↺
                    </button>
                    <button
                      className="icon-btn"
                      title={t("Delete thread")}
                      aria-label={`${t("Delete thread")}: ${th.title}`}
                      onClick={() => requestDelete(th.id)}
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
            ))}
        </div>
      )}
      <div className="sidebar-foot">
        <button className="row" onClick={props.onOpenSettings}>
          <span className="title">{t("Settings")}</span>
        </button>
      </div>
      {iconPop &&
        (() => {
          const project = snapshot.projects.find((p) => p.id === iconPop.projectId);
          if (!project) return null;
          return (
            <ProjectIconPicker
              icon={project.icon}
              anchor={iconPop}
              onPick={(icon) => {
                setIconPop(null);
                tryCall("projects:set-icon", { id: project.id, icon });
              }}
              onClose={() => setIconPop(null)}
            />
          );
        })()}
      {threadMenu &&
        // The sidebar and chat stack share z-index 1, so a fixed menu inside
        // nav paints under the chat pane on right-click; portal it to the
        // app root like the frozen native context menu (always on top).
        createPortal(
        <div
          ref={threadMenuRef}
          className={`row-menu${threadMenu.alignEnd ? " align-end" : ""}`}
          role="menu"
          style={anchoredPopoverStyle(threadMenuPos)}
        >
          {threadRowMenuItems({
            isHelper: !!threadMenu.th.parentThreadId,
            hasWorktree: !!threadMenu.th.worktreeDir,
          }).map((a) => (
            <button
              key={a}
              type="button"
              role="menuitem"
              className={a === "delete" ? "danger" : ""}
              onClick={() => {
                const th = threadMenu.th;
                setThreadMenu(null);
                runRowMenuAction(a, th);
              }}
            >
              {rowMenuLabel(a, threadMenu.th)}
            </button>
          ))}
        </div>,
        document.body,
      )}
      {pendingProject &&
        pendingProjectDelete &&
        (() => {
          const pop = (
            <RemoveProjectPopover
              projectId={pendingProject.id}
              projectName={pendingProject.name}
              threadCount={pendingProjectThreadCount}
              anchor={pendingProjectDelete.anchor}
              getAnchorRect={getPendingAnchorRect}
              scrollContainer={threadListRef.current}
              getTriggerEl={getPendingTriggerEl}
              readOnly={snapshot.readOnly === true}
              onRemove={confirmProjectDelete}
              onCancel={cancelProjectDelete}
            />
          );
          return typeof document !== "undefined" && document.body
            ? createPortal(pop, document.body)
            : pop;
        })()}
    </nav>
  );
}
