// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Project scripts dialog (F12): frozen ScriptsMenu + ScriptsEditor.
// The list runs a persisted script — main resolves the command from the
// project record and types it into a sterile-shell terminal at the
// thread's execution directory. The editor replaces the whole list;
// like the frozen editor, Save stays disabled while any row lacks a
// command.

import { useRef, useState } from "react";
import type { ChatThread, Project, ProjectScript } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";
import {
  createScriptDraft,
  makeScriptDraftKeyGen,
  patchScriptDraft,
  removeScriptDraft,
  serializeScriptDrafts,
  toScriptDraft,
  type ScriptDraft as Draft,
} from "../scriptDrafts";

const incomplete = (s: Draft): boolean => s.command.trim().length === 0;

export function ScriptDraftList(props: {
  drafts: readonly Draft[];
  busy: boolean;
  t: (key: string) => string;
  onPatch: (key: string, patch: Partial<Draft>) => void;
  onDelete: (key: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const { drafts, busy, t, onPatch, onDelete, onAdd } = props;
  return (
    <div className="scripts-list">
      {drafts.map((d) => (
        <div key={d.key} data-script-key={d.key} className="script-card">
          <div className="script-card-head">
            <input
              className="wt-input"
              value={d.name}
              placeholder={t("Name")}
              onChange={(e) => onPatch(d.key, { name: e.target.value })}
              disabled={busy}
              spellCheck={false}
            />
            <button
              className="icon-btn"
              aria-label={t("Delete script")}
              title={t("Delete script")}
              disabled={busy}
              onClick={() => onDelete(d.key)}
            >
              ×
            </button>
          </div>
          <input
            className={`wt-input mono ${incomplete(d) ? "invalid" : ""}`}
            value={d.command}
            placeholder={t("Command")}
            onChange={(e) => onPatch(d.key, { command: e.target.value })}
            disabled={busy}
            spellCheck={false}
          />
          <label className="script-check">
            <input
              type="checkbox"
              checked={d.runOnWorktreeCreate}
              disabled={busy}
              onChange={(e) =>
                onPatch(d.key, { runOnWorktreeCreate: e.target.checked })
              }
            />
            {t("Run when a worktree is created")}
          </label>
        </div>
      ))}
      <button className="term-btn" disabled={busy} onClick={onAdd}>
        + {t("Add script")}
      </button>
    </div>
  );
}

export function ScriptsDialog(props: {
  thread: ChatThread;
  project: Project;
  onClose: () => void;
  /** A script terminal was created — surface the terminal dock. */
  onRan: () => void;
  /** Test seam: render the dialog initially in edit mode for saved scripts. */
  initialEditing?: boolean;
}): React.JSX.Element {
  const t = useT();
  const { thread, project } = props;
  const scripts = project.scripts ?? [];
  const [editing, setEditing] = useState(props.initialEditing ?? scripts.length === 0);
  const [drafts, setDrafts] = useState<Draft[]>(scripts.map(toScriptDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyGen = useRef(makeScriptDraftKeyGen());

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
      scripts: serializeScriptDrafts(drafts),
    })
      .then(() => {
        setDrafts([]);
        setEditing(false);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const patch = (key: string, p: Partial<Draft>) =>
    setDrafts((cur) => patchScriptDraft(cur, key, p));

  const remove = (key: string) =>
    setDrafts((cur) => removeScriptDraft(cur, key));

  const add = () =>
    setDrafts((cur) => [...cur, createScriptDraft(keyGen.current, t("New script"))]);

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
          <ScriptDraftList
            drafts={drafts}
            busy={busy}
            t={t}
            onPatch={patch}
            onDelete={remove}
            onAdd={add}
          />
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
                setDrafts(scripts.map(toScriptDraft));
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
