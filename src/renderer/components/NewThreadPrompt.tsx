// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Frozen NewThreadPrompt: the centred question and editable affiliation
// before a thread's first message. "What should we build in <project>?"
// where the name is a dotted-underline button opening the location menu:
// work without a project, every project with its icon and a check on the
// current one, and "Add project…". Moves go through
// threads:move-affiliation — the engine only allows them before the first
// message and main closes the thread's terminals, matching frozen.
// Bounded: "Add project…" uses the same name-first inline field the
// sidebar offers (projects:create auto-binds a managed directory); the
// frozen folder panel is not ported. Entrance animation is CSS-only.

import { useEffect, useRef, useState } from "react";
import type { ChatThread, Project } from "../../shared/types";
import { useT } from "../locale";
import { callApi, clientStore } from "../client";

export function NewThreadPrompt(props: {
  thread: ChatThread;
  project: Project | null;
  projects: Project[];
}): React.JSX.Element {
  const t = useT();
  const { thread, project, projects } = props;
  const [choosing, setChoosing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!choosing) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setChoosing(false);
        setAdding(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChoosing(false);
        setAdding(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [choosing]);

  const move = (projectId: string | null) => {
    if ((thread.projectId ?? null) === projectId) {
      setChoosing(false);
      return;
    }
    void callApi("threads:move-affiliation", { id: thread.id, projectId }).then((r) => {
      const res = r as { moved?: boolean } | undefined;
      if (res?.moved === false) clientStore.reportError(t("Could not change thread location"));
    });
    setChoosing(false);
    setAdding(false);
  };

  const submitNew = () => {
    const name = newName.trim();
    if (!name) return;
    void callApi("projects:create", { name }).then((r) => {
      const made = r as { project?: { id: string } } | { id?: string } | undefined;
      const id = (made as { project?: { id: string } })?.project?.id ?? (made as { id?: string })?.id;
      if (id) move(id);
    });
  };

  const question = project
    ? t("What should we build in %@?", "@@split@@").split("@@split@@")
    : null;

  const menu = (
    <div className="ntp-menu" role="menu" aria-label={t("Choose thread location")}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!thread.projectId}
        className="ntp-item"
        onClick={() => move(null)}
      >
        <span className="ntp-check" aria-hidden="true">{!thread.projectId ? "✓" : ""}</span>
        <span>{t("Work without a project")}</span>
      </button>
      <div className="ntp-sep" />
      <div className="ntp-head">{t("Projects")}</div>
      {projects.map((p) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={thread.projectId === p.id}
          key={p.id}
          className="ntp-item"
          onClick={() => move(p.id)}
        >
          <span className="ntp-check" aria-hidden="true">{thread.projectId === p.id ? "✓" : ""}</span>
          <span className="ntp-icon" aria-hidden="true">{p.icon ?? "📁"}</span>
          <span className="ntp-name">{p.name}</span>
        </button>
      ))}
      <div className="ntp-sep" />
      {adding ? (
        <div className="ntp-add">
          <input
            className="ntp-input"
            autoFocus
            value={newName}
            placeholder={t("Project name")}
            aria-label={t("Project name")}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNew();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button type="button" className="btn" onClick={submitNew} disabled={!newName.trim()}>
            {t("Add")}
          </button>
        </div>
      ) : (
        <button type="button" className="ntp-item" onClick={() => setAdding(true)}>
          <span className="ntp-check" aria-hidden="true" />
          <span>{t("Add project…")}</span>
        </button>
      )}
    </div>
  );

  const affilBtn = (title: string) => (
    <span className="ntp-affil" ref={wrapRef}>
      <button
        type="button"
        className="ntp-link"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={choosing}
        onClick={() => setChoosing((c) => !c)}
      >
        {title}
      </button>
      {choosing && menu}
    </span>
  );

  return (
    <div className="center-state ntp">
      {project ? (
        <p className="ntp-q">
          {question![0]}
          {affilBtn(project.name)}
          {question![1]}
        </p>
      ) : (
        <>
          <p className="ntp-q">{t("What should we build?")}</p>
          <p className="ntp-sub">
            {thread.projectId === null
              ? affilBtn(t("Work without a project"))
              : affilBtn(t("Choose another project"))}
          </p>
        </>
      )}
    </div>
  );
}
