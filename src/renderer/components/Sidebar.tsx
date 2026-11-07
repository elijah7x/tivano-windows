// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Sidebar: project groups, thread rows with status marks, search, Settings.
// Electron has no window.prompt/confirm, so rename/create use inline fields
// and delete uses a two-tap armed confirmation on the row itself.

import { useMemo, useState } from "react";
import type { ChatThread, OpenDirectoryResult, Snapshot } from "../../shared/types";
import { compareThreads } from "../../shared/threadOrder";
import { useT } from "../locale";
import { api, callApi, clientStore, tryCall } from "../client";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { MiniSpinner } from "./SpinnerCells";
import { Skylight } from "./Skylight";

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
  // v2.2.x: the shelf popover + inline shelf rename (v2.2.22).
  const [shelfOpen, setShelfOpen] = useState(false);
  const [shelfRename, setShelfRename] = useState<string | null>(null);
  const { snapshot } = props;
  const q = search.trim().toLowerCase();
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
          {th.worktreeDir && (
            <button
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
          )}
          <button
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
          <button
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
          <button
            className="icon-btn"
            title={t("Archive thread")}
            aria-label={`${t("Archive thread")}: ${th.title}`}
            onClick={(e) => {
              e.stopPropagation();
              tryCall("threads:archive", { id: th.id });
            }}
          >
            ⤓
          </button>
          <button
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
        </span>
      )}
    </div>
  );

  return (
    <nav className="sidebar" aria-label={t("Thread list")}>
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
      {/* F26 (frozen SidebarHero): the skylight hero folds every visible
          thread into one weather and creates a thread on tap. Off under
          Performance Mode (frozen showsSkylightNow). */}
      {snapshot.settings.showsSkylight !== false &&
        snapshot.settings.performanceMode !== true && (
          <Skylight
            threads={snapshot.threads}
            onNewThread={() => tryCall("threads:create", { projectId: null })}
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
      <div className="thread-list" role="list">
        {snapshot.projects.length === 0 && snapshot.threads.length === 0 && (
          <div className="center-state">
            <span>{t("No projects yet")}</span>
          </div>
        )}
        {groups.projects.map(({ project, threads }) => (
          <div key={project.id}>
            <div
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
              {armedDeleteId === project.id ? (
                <button
                  className="icon-btn danger-arm"
                  aria-label={`${t("Delete project")}: ${project.name}`}
                  disabled={snapshot.readOnly === true}
                  autoFocus
                  onBlur={() => setArmedDeleteId(null)}
                  onClick={() => {
                    setArmedDeleteId(null);
                    tryCall("projects:delete", { id: project.id });
                  }}
                >
                  {t("Delete")}?
                </button>
              ) : (
                <button
                  className="icon-btn"
                  title={t("Delete project")}
                  aria-label={`${t("Delete project")}: ${project.name}`}
                  disabled={snapshot.readOnly === true}
                  onClick={() => setArmedDeleteId(project.id)}
                >
                  ×
                </button>
              )}
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
    </nav>
  );
}
