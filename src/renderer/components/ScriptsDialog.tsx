// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Project scripts dialog (F12): frozen ScriptsMenu + ScriptsEditor.
// The list runs a persisted script — main resolves the command from the
// project record and types it into a sterile-shell terminal at the
// thread's execution directory. The editor replaces the whole list;
// like the frozen editor, Save stays disabled while any row lacks a
// command.

import { useState } from "react";
import type { ChatThread, Project, ProjectScript } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";

interface Draft {
  id?: string;
  name: string;
  command: string;
  icon: string;
  runOnWorktreeCreate: boolean;
}

const toDraft = (s: ProjectScript): Draft => ({
  id: s.id,
  name: s.name,
  command: s.command,
  icon: s.icon,
  runOnWorktreeCreate: s.runOnWorktreeCreate,
});

const incomplete = (s: Draft): boolean => s.command.trim().length === 0;

export function ScriptsDialog(props: {
  thread: ChatThread;
  project: Project;
  onClose: () => void;
  /** A script terminal was created — surface the terminal dock. */
  onRan: () => void;
}): React.JSX.Element {
  const t = useT();
  const { thread, project } = props;
  const scripts = project.scripts ?? [];
  const [editing, setEditing] = useState(scripts.length === 0);
  const [drafts, setDrafts] = useState<Draft[]>(scripts.map(toDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (script: ProjectScript) => {
    setBusy(true);
    setError(null);
    callApi("scripts:run", { threadId: thread.id, scriptId: script.id })
      .then((r) => {
        const res = r as { terminal?: unknown; unavailable?: string };
        if (res.unavailable) setError(res.unavailable);
        else {
          props.onRan();
          props.onClose();
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const save = () => {
    setBusy(true);
    setError(null);
    callApi("projects:scripts:set", {
      projectId: project.id,
      scripts: drafts.map((d) => ({
        ...(d.id ? { id: d.id } : {}),
        name: d.name,
        command: d.command,
        icon: d.icon || "play",
        runOnWorktreeCreate: d.runOnWorktreeCreate,
      })),
    })
      .then(() => {
        setDrafts([]);
        setEditing(false);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts((cur) => cur.map((d, j) => (j === i ? { ...d, ...p } : d)));

  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => e.key === "Escape" && props.onClose()}
    >
      <div
        className="modal wt-dialog scripts-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("Project scripts")}
      >
        <h2>{t("Project scripts")}</h2>
        <p className="ckpt-note">
          {t(
            "Scripts run in a terminal at the thread's execution directory. Tivano also picks up scripts from tivano.json at the project root.",
          )}
        </p>
        {!editing ? (
          <div className="scripts-list">
            {scripts.length === 0 && (
              <p className="ckpt-note">{t("No scripts yet")}</p>
            )}
            {scripts.map((s) => (
              <div key={s.id} className="script-row">
                <button
                  className="script-run"
                  disabled={busy}
                  title={s.command}
                  onClick={() => run(s)}
                >
                  ▶ {s.name}
                </button>
                {s.runOnWorktreeCreate && (
                  <span className="script-badge" title={t("Runs when a worktree is created")}>
                    ⎇
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="scripts-list">
            {drafts.map((d, i) => (
              <div key={d.id ?? `new-${i}`} className="script-card">
                <div className="script-card-head">
                  <input
                    className="wt-input"
                    value={d.name}
                    placeholder={t("Name")}
                    onChange={(e) => patch(i, { name: e.target.value })}
                    disabled={busy}
                    spellCheck={false}
                  />
                  <button
                    className="icon-btn"
                    aria-label={t("Delete script")}
                    title={t("Delete script")}
                    disabled={busy}
                    onClick={() => setDrafts((cur) => cur.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                <input
                  className={`wt-input mono ${incomplete(d) ? "invalid" : ""}`}
                  value={d.command}
                  placeholder={t("Command")}
                  onChange={(e) => patch(i, { command: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                />
                <label className="script-check">
                  <input
                    type="checkbox"
                    checked={d.runOnWorktreeCreate}
                    disabled={busy}
                    onChange={(e) => patch(i, { runOnWorktreeCreate: e.target.checked })}
                  />
                  {t("Run when a worktree is created")}
                </label>
              </div>
            ))}
            <button
              className="term-btn"
              disabled={busy}
              onClick={() =>
                setDrafts((cur) => [
                  ...cur,
                  { name: t("New script"), command: "", icon: "play", runOnWorktreeCreate: false },
                ])
              }
            >
              + {t("Add script")}
            </button>
          </div>
        )}
        {error && (
          <p className="ckpt-note error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {!editing ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setDrafts(scripts.map(toDraft));
                setEditing(true);
              }}
            >
              {scripts.length ? t("Edit scripts…") : t("Add a script…")}
            </button>
          ) : (
            <>
              <button
                className="primary"
                disabled={busy || drafts.some(incomplete)}
                title={drafts.some(incomplete) ? t("Every script needs a command.") : t("Save these scripts")}
                onClick={save}
              >
                {busy ? t("Saving…") : t("Save")}
              </button>
              {scripts.length > 0 && (
                <button disabled={busy} onClick={() => setEditing(false)}>
                  {t("Cancel")}
                </button>
              )}
            </>
          )}
          <button onClick={props.onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
