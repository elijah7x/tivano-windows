// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F15 "Open in" menu (frozen OpenInMenu): the file manager, every
// editor actually installed, then Copy path. The menu asks main for
// real data — a missing directory disables actions and a failed open
// surfaces the engine's error in place, like the frozen alert.

import { useEffect, useRef, useState } from "react";
import { api, callApi } from "../client";
import { useT } from "../locale";

interface EditorEntry {
  id: string;
  name: string;
}

export function OpenInMenu(props: {
  threadId: string;
  hasDirectory: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editors, setEditors] = useState<EditorEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // Editor discovery is cached per app launch (frozen); ask again on each
  // menu open so a fresh install mid-session still appears.
  useEffect(() => {
    if (!open) return;
    callApi("openin:editors", {})
      .then((r) => setEditors((r as { editors: EditorEntry[] }).editors))
      .catch(() => setEditors([]));
  }, [open]);

  const fileManager =
    api().platform === "win32" ? t("File Explorer") : t("Finder");

  const act = (fn: () => Promise<unknown>): void => {
    setNote(null);
    fn()
      .then(() => setOpen(false))
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="openin" ref={rootRef}>
      <button
        className="openin-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("Open in another app")}
        aria-label={t("Open in another app")}
        disabled={props.readOnly === true}
        onClick={() => {
          setNote(null);
          setOpen((o) => !o);
        }}
      >
        ↗ ▾
      </button>
      {open && (
        <div className="openin-menu" role="menu" aria-label={t("Open in")}>
          <div className="openin-section">{t("Open in")}</div>
          <button
            type="button"
            role="menuitem"
            disabled={!props.hasDirectory}
            onClick={() => act(() => callApi("folder:reveal", { threadId: props.threadId }))}
          >
            {fileManager}
          </button>
          {editors.map((ed) => (
            <button
              key={ed.id}
              type="button"
              role="menuitem"
              disabled={!props.hasDirectory}
              data-editor={ed.id}
              onClick={() =>
                act(() => callApi("openin:open", { threadId: props.threadId, editorId: ed.id }))
              }
            >
              {ed.name}
            </button>
          ))}
          <div className="openin-divider" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            disabled={!props.hasDirectory}
            onClick={() => act(() => callApi("folder:copy", { threadId: props.threadId }))}
          >
            {t("Copy path")}
          </button>
          {note && <div className="openin-note">{note}</div>}
        </div>
      )}
    </div>
  );
}
