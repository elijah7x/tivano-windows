// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-42 Toolbox changes (v3.0.26 UtilityChestPanel Changes tab): the chat's
// changes panel carries inline Commit, Push and Create pull request actions
// gated on the LIVE Git snapshot. Nothing fires on its own: every action is
// an explicit click, and every disabled state names its reason. Commit and
// push reuse the F13 GitService seams; the pull request opens the forge's
// own page for the pushed branch (no token is read).

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitPushResult, GitSnapshot } from "../../shared/types";
import { pullRequestUrl } from "../../shared/pullRequestUrl";
import { api, callApi } from "../client";
import { useT } from "../locale";
import { CommitDialog } from "./CommitDialog";

type T = (k: string, ...vars: string[]) => string;

export type ToolboxAction = { enabled: true } | { enabled: false; reason: string };
export interface ToolboxGitGate {
  /** Set when the whole section is unavailable; every action is then off. */
  blocked?: string;
  commit: ToolboxAction;
  push: ToolboxAction;
  pullRequest: ToolboxAction & { url?: string };
}

/** Pure gate: which inline actions the snapshot allows, and why not.
 *  Reasons are English catalog keys, translated by the caller. */
export function toolboxGitGate(
  snap: GitSnapshot | null,
  opts: { readOnly?: boolean; worktree?: boolean; running?: boolean },
): ToolboxGitGate {
  const off = (reason: string): ToolboxGitGate => ({
    blocked: reason,
    commit: { enabled: false, reason },
    push: { enabled: false, reason },
    pullRequest: { enabled: false, reason },
  });
  if (opts.worktree) return off("Inline Git actions are not available for worktree chats yet");
  if (!snap) return off("Loading");
  if (snap.kind !== "ready") return off("Git is not available for this project");
  if (opts.readOnly) return off("This window is read-only");
  if (opts.running) return off("Wait for the reply to finish");

  const b = snap.branch;
  const branch = b && !b.detached && !b.unborn ? b.name : null;
  const commit: ToolboxAction =
    snap.entries.length > 0 ? { enabled: true } : { enabled: false, reason: "No changes to commit" };

  let push: ToolboxAction;
  if (!branch) push = { enabled: false, reason: "Switch to a branch first" };
  else if (!snap.remoteUrl) push = { enabled: false, reason: "Add an origin remote first" };
  else if (b?.upstream && b.ahead === 0) push = { enabled: false, reason: "Nothing to push" };
  else push = { enabled: true };

  let pullRequest: ToolboxGitGate["pullRequest"];
  const url = pullRequestUrl(snap.remoteUrl, branch);
  if (!branch) pullRequest = { enabled: false, reason: "Switch to a branch first" };
  else if (!snap.remoteUrl) pullRequest = { enabled: false, reason: "Add an origin remote first" };
  else if (!url)
    pullRequest = {
      enabled: false,
      reason: "Pull requests can be opened for GitHub and GitLab remotes only",
    };
  else if (!b?.upstream) pullRequest = { enabled: false, reason: "Push this branch first" };
  else if ((b.ahead ?? 0) > 0) pullRequest = { enabled: false, reason: "Push your commits first" };
  else pullRequest = { enabled: true, url };

  return { commit, push, pullRequest };
}

export type ToolboxNote = { kind: "ok" | "err"; text: string } | null;

/** Presentational row — no IPC, so the gating copy is testable directly. */
export function ToolboxGitActions(props: {
  t: T;
  gate: ToolboxGitGate;
  busy: boolean;
  note: ToolboxNote;
  onCommit(): void;
  onPush(): void;
  onPullRequest(url: string): void;
}): React.JSX.Element {
  const { t, gate } = props;
  const title = (a: ToolboxAction): string | undefined => (a.enabled ? undefined : t(a.reason));
  const pr = gate.pullRequest;
  return (
    <div className="toolbox-git" role="group" aria-label={t("Git actions")}>
      <div className="toolbox-git-row">
        <button
          type="button"
          className="toolbox-git-btn"
          disabled={!gate.commit.enabled || props.busy}
          title={title(gate.commit)}
          onClick={props.onCommit}
        >
          {t("Commit…")}
        </button>
        <button
          type="button"
          className="toolbox-git-btn"
          disabled={!gate.push.enabled || props.busy}
          title={title(gate.push)}
          onClick={props.onPush}
        >
          {props.busy ? `${t("Pushing")}…` : t("Push")}
        </button>
        <button
          type="button"
          className="toolbox-git-btn"
          disabled={!pr.enabled || props.busy}
          title={title(pr)}
          onClick={() => {
            if (pr.enabled && pr.url) props.onPullRequest(pr.url);
          }}
        >
          {t("Create pull request")}
        </button>
      </div>
      {gate.blocked && gate.blocked !== "Loading" && (
        <p className="toolbox-git-note" role="status">
          {t(gate.blocked)}
        </p>
      )}
      {props.note && (
        <p
          className={`toolbox-git-note ${props.note.kind}`}
          role={props.note.kind === "err" ? "alert" : "status"}
        >
          {props.note.text}
        </p>
      )}
    </div>
  );
}

/** Live section: hydrates the project's Git snapshot, follows git-snapshot
 *  events, and runs an action only when its button is clicked. */
export function ToolboxChanges(props: {
  projectId: string;
  readOnly?: boolean;
  worktree?: boolean;
  running?: boolean;
}): React.JSX.Element {
  const t = useT();
  const { projectId } = props;
  const [snap, setSnap] = useState<GitSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [note, setNote] = useState<ToolboxNote>(null);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setSnap(null);
    setNote(null);
    const off = api().onEvent((e) => {
      if (e.type === "git-snapshot" && e.snapshot.projectId === projectId && g === gen.current)
        setSnap(e.snapshot);
    });
    callApi("git:overview", { projectId })
      .then((s) => {
        if (g === gen.current) setSnap((cur) => cur ?? (s as GitSnapshot));
      })
      .catch(() => {});
    return () => {
      off();
      gen.current++;
    };
  }, [projectId]);

  const refresh = useCallback((): void => {
    const g = gen.current;
    callApi("git:refresh", { projectId })
      .then((s) => {
        if (g === gen.current) setSnap(s as GitSnapshot);
      })
      .catch(() => {});
  }, [projectId]);

  const push = (): void => {
    const g = gen.current;
    setBusy(true);
    setNote(null);
    callApi("git:push", { projectId })
      .then((r) => {
        if (g !== gen.current) return;
        const res = r as GitPushResult;
        if (res.kind === "pushed") {
          setNote({ kind: "ok", text: t("Pushed") });
          refresh();
        } else setNote({ kind: "err", text: `${t("Push failed")}: ${res.reason}` });
      })
      .catch((e) => {
        if (g === gen.current)
          setNote({
            kind: "err",
            text: `${t("Push failed")}: ${e instanceof Error ? e.message : String(e)}`,
          });
      })
      .finally(() => {
        if (g === gen.current) setBusy(false);
      });
  };

  const openPullRequest = (url: string): void => {
    setNote(null);
    callApi("links:open-external", { url })
      .then(() => setNote({ kind: "ok", text: t("Opened the pull request page") }))
      .catch((e) =>
        setNote({
          kind: "err",
          text: `${t("Couldn't open the pull request page")}: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
  };

  const gate = toolboxGitGate(snap, {
    readOnly: props.readOnly === true,
    worktree: props.worktree === true,
    running: props.running === true,
  });

  return (
    <>
      <ToolboxGitActions
        t={t}
        gate={gate}
        busy={busy}
        note={note}
        onCommit={() => {
          setNote(null);
          setSheet(true);
        }}
        onPush={push}
        onPullRequest={openPullRequest}
      />
      {sheet && (
        <CommitDialog
          projectId={projectId}
          snap={snap}
          onClose={() => setSheet(false)}
          onCommitted={refresh}
        />
      )}
    </>
  );
}
