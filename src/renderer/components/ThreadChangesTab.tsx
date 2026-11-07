// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Whole-thread changes tab (frozen ThreadChangesTab / FileChangeSummary):
// one summary row above the composer — "N files +A −D" — opening a
// popover that lists each touched path with its own +/− and an inline
// whole-thread diff (first checkpoint base → latest end, stored blobs
// only). Nothing here touches the worktree; in-place restore stays
// disabled service-side (A17).

import { useEffect, useRef, useState } from "react";
import type { CheckpointDiffView } from "../../shared/types";
import { api, callApi } from "../client";
import { useT } from "../locale";

type Summary = {
  files: {
    path: string;
    additions: number;
    deletions: number;
    binary: boolean;
    reason?: string;
  }[];
  additions: number;
  deletions: number;
};

type DiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: CheckpointDiffView };

export function ThreadChangesTab(props: { threadId: string }): React.JSX.Element | null {
  const t = useT();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const gen = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const { threadId } = props;

  useEffect(() => {
    setSummary(null);
    setOpen(false);
    setDiffs({});
    const g = ++gen.current;
    const refetch = () => {
      const mine = g;
      callApi("checkpoints:changes", { threadId })
        .then((r) => {
          if (mine === gen.current) setSummary((r as Summary | null) ?? null);
        })
        .catch(() => {});
    };
    refetch();
    return api().onEvent((e) => {
      if (e.type === "checkpoints-changed" && e.threadId === threadId) refetch();
    });
  }, [threadId]);

  // Outside-click closes the popover, same as the other chat popovers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!summary || summary.files.length === 0) return null;

  const toggleDiff = (path: string): void => {
    if (diffs[path]) {
      setDiffs((d) => {
        const n = { ...d };
        delete n[path];
        return n;
      });
      return;
    }
    const g = gen.current;
    setDiffs((d) => ({ ...d, [path]: { kind: "loading" } }));
    callApi("checkpoints:changes-diff", { threadId, path })
      .then((r) => {
        if (g !== gen.current) return;
        setDiffs((d) => ({ ...d, [path]: { kind: "ready", view: r as CheckpointDiffView } }));
      })
      .catch((e) => {
        if (g !== gen.current) return;
        setDiffs((d) => ({
          ...d,
          [path]: { kind: "error", message: e instanceof Error ? e.message : String(e) },
        }));
      });
  };

  const diffBody = (d: DiffState): React.JSX.Element => {
    if (d.kind === "loading") return <p className="ckpt-note">{t("Loading diff…")}</p>;
    if (d.kind === "error")
      return (
        <p className="ckpt-note error" role="alert">
          {t("Diff unavailable")}: {d.message}
        </p>
      );
    const v = d.view;
    if (v.kind === "unavailable")
      return (
        <p className="ckpt-note" role="status">
          {t("Diff unavailable")}: {v.reason}
        </p>
      );
    if (v.kind === "empty")
      return <p className="ckpt-note">{t("No recorded change for this file.")}</p>;
    if (v.kind === "binary")
      return <p className="ckpt-note">{t("Binary file — no text diff")}</p>;
    if (v.kind === "oversized")
      return <p className="ckpt-note">{t("Diff is too large to display")}</p>;
    if (v.kind !== "text") return <></>;
    return (
      <pre className="git-patch ckpt-diff">
        {v.patch.split("\n").map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "pl"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "mi"
                  : line.startsWith("@@")
                    ? "hn"
                    : "ctx"
            }
          >
            {line || " "}
          </div>
        ))}
      </pre>
    );
  };

  return (
    <div className="thread-changes" ref={rootRef}>
      <button
        type="button"
        className="thread-changes-tab"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tc-plusminus" aria-hidden="true">
          ±
        </span>
        <span className="tc-count">
          {summary.files.length} {t(summary.files.length === 1 ? "file" : "files")}
        </span>
        <span className="tc-add">+{summary.additions}</span>
        <span className="tc-del">−{summary.deletions}</span>
      </button>
      {open && (
        <div className="thread-changes-pop" role="dialog" aria-label={t("Thread changes")}>
          <div className="tc-pop-head">{t("Changes in this thread")}</div>
          <ul className="tc-files">
            {summary.files.map((f) => (
              <li key={f.path} className="tc-file">
                <button
                  type="button"
                  className="tc-file-row"
                  aria-expanded={!!diffs[f.path]}
                  onClick={() => toggleDiff(f.path)}
                >
                  <code className="ckpt-path">{f.path}</code>
                  {f.reason ? (
                    <span className="tc-bin">{t("diff n/a")}: {f.reason}</span>
                  ) : f.binary ? (
                    <span className="tc-bin">{t("binary")}</span>
                  ) : (
                    <>
                      <span className="tc-add">+{f.additions}</span>
                      <span className="tc-del">−{f.deletions}</span>
                    </>
                  )}
                </button>
                {diffs[f.path] && <div className="ckpt-diff-wrap">{diffBody(diffs[f.path]!)}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
