// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F02 archive management: bounded port of the frozen
// `ArchiveSettingsPage` + `ArchiveFilter` — search, project scope and
// chat-type pickers, grouped rows with Restore/Delete per row, and a
// Delete-all that deletes exactly the set the filter shows. Thread
// deletes honour settings.confirmBeforeDeleting (frozen default on);
// the confirmation itself is the sidebar's two-tap armed pattern, the
// honest Electron equivalent of the frozen confirmationDialog.

import { useMemo, useState } from "react";
import type { ChatThread, Project, Settings } from "../../shared/types";
import { useT } from "../locale";
import { tryCall } from "../client";

type ChatType = "all" | "heads" | "chats";
/** Frozen ArchiveFilter.ProjectScope: all | a known project | none. */
type ProjectScope = "all" | "none" | string;

export function ArchiveSection(props: {
  threads: ChatThread[];
  projects: Project[];
  settings: Settings;
}): React.JSX.Element {
  const t = useT();
  const [query, setQuery] = useState("");
  const [chatType, setChatType] = useState<ChatType>("all");
  const [project, setProject] = useState<ProjectScope>("all");
  const [armedId, setArmedId] = useState<string | null>(null);
  const [armedAll, setArmedAll] = useState(false);
  const confirmDelete = props.settings.confirmBeforeDeleting !== false;

  const archived = useMemo(
    () =>
      props.threads
        .filter((th) => th.isArchived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [props.threads],
  );

  // Frozen ArchiveFilter.projects(in:from:) — only projects that actually
  // appear in the archive, sorted by name.
  const known = useMemo(() => {
    const ids = new Set(
      archived.map((th) => th.projectId).filter((id): id is string => !!id),
    );
    return props.projects
      .filter((p) => ids.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [archived, props.projects]);

  const knownIds = useMemo(() => new Set(known.map((p) => p.id)), [known]);
  const scopeOf = (th: ChatThread): ProjectScope =>
    th.projectId && knownIds.has(th.projectId) ? th.projectId : "none";

  const search = query.trim().toLowerCase();
  const isActive = search !== "" || chatType !== "all" || project !== "all";
  const visible = useMemo(
    () =>
      archived.filter((th) => {
        // Frozen matches isHydraHead; head threads do not exist in this
        // port (A41 config only), so "heads" honestly matches nothing.
        const isHead = false;
        if (chatType !== "all" && (chatType === "heads") !== isHead) return false;
        if (project !== "all" && scopeOf(th) !== project) return false;
        if (search && !th.title.toLowerCase().includes(search)) return false;
        return true;
      }),
    [archived, chatType, project, search, knownIds],
  );

  const groups = useMemo(() => {
    const by = new Map<ProjectScope, ChatThread[]>();
    for (const th of visible) {
      const s = scopeOf(th);
      const arr = by.get(s) ?? [];
      arr.push(th);
      by.set(s, arr);
    }
    const ordered: { scope: ProjectScope; title: string; rows: ChatThread[] }[] = [];
    for (const p of known) {
      const rows = by.get(p.id);
      if (rows?.length) ordered.push({ scope: p.id, title: p.name, rows });
    }
    const none = by.get("none");
    if (none?.length) ordered.push({ scope: "none", title: t("No project"), rows: none });
    return ordered;
  }, [visible, known, knownIds, t]);

  const deleteAllLabel = isActive
    ? t("Delete matching chats (%lld)").replace("%lld", String(visible.length))
    : t("Delete all archived chats (%lld)").replace("%lld", String(visible.length));

  return (
    <div className="archive-section" data-testid="archive-section">
      <div className="archive-chrome">
        <input
          type="search"
          className="archive-search"
          placeholder={t("Search archived chats")}
          aria-label={t("Search archived chats")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="choice archive-delete-all"
          disabled={visible.length === 0}
          data-armed={armedAll ? "true" : "false"}
          onClick={() => {
            if (!armedAll) {
              setArmedAll(true);
              return;
            }
            setArmedAll(false);
            tryCall("threads:delete-archived", { ids: visible.map((th) => th.id) });
          }}
          onBlur={() => setArmedAll(false)}
        >
          {armedAll
            ? isActive
              ? t("Delete matching archived chats?")
              : t("Delete all archived threads?")
            : deleteAllLabel}
        </button>
      </div>
      <div className="archive-filters" role="group">
        <select
          className="archive-picker"
          aria-label={t("Chat type")}
          value={chatType}
          onChange={(e) => setChatType(e.target.value as ChatType)}
        >
          <option value="all">{t("All chats")}</option>
          <option value="heads">{t("Heads")}</option>
          <option value="chats">{t("Chats")}</option>
        </select>
        <select
          className="archive-picker"
          aria-label={t("Project")}
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="all">{t("All projects")}</option>
          {known.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="none">{t("No project")}</option>
        </select>
      </div>
      {groups.length === 0 && <p className="archive-empty">{t("No matching chats")}</p>}
      {groups.map((g) => (
        <div className="archive-group" key={g.scope} data-scope={g.scope === "none" ? "none" : "project"}>
          <div className="archive-group-head">
            <span className="archive-group-title">{g.title}</span>
            <span className="archive-group-count">
              {t("%lld chats").replace("%lld", String(g.rows.length))}
            </span>
          </div>
          {g.rows.map((th) => (
            <div className="archive-row" key={th.id}>
              <span className="archive-row-title" title={th.title}>
                {th.title}
              </span>
              {armedId === th.id ? (
                <button
                  className="icon-btn danger-arm"
                  autoFocus
                  onBlur={() => setArmedId(null)}
                  onClick={() => {
                    setArmedId(null);
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
                    onClick={() =>
                      confirmDelete ? setArmedId(th.id) : tryCall("threads:delete", { id: th.id })
                    }
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
