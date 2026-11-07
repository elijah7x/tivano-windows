// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F13 detection slice (frozen GitHubSettingsSection): which forge CLIs
// the merge/PR handoffs could actually run — presence and --version
// only. Sign-in state is never probed and no credential command is
// ever run; merge/PR flows that need a real forge CLI or OAuth stay
// honestly reported as unavailable.

import { useEffect, useState } from "react";
import { useT } from "../locale";
import { api } from "../client";

interface ForgeCliStatus {
  id: "gh" | "glab" | "origin" | "tea";
  label: string;
  forge: "github" | "gitlab" | "gitea" | "origin";
  found: boolean;
  version?: string;
  error?: string;
}

export function ForgeSection(props: {
  worktreesDir: string;
}): React.JSX.Element {
  const t = useT();
  const [rows, setRows] = useState<ForgeCliStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const probe = () => {
    setErr(null);
    api()
      .invoke("forge:probe", {})
      .then((r) => setRows(r as ForgeCliStatus[]))
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(probe, []);

  return (
    <div className="forge-section" data-testid="forge-section">
      <div className="forge-head">
        <h3>{t("Forge CLIs")}</h3>
        <button
          type="button"
          className="choice forge-refresh"
          onClick={probe}
          disabled={rows === null && err === null}
        >
          {t("Re-check")}
        </button>
      </div>
      {rows === null && err === null && (
        <p className="codex-note" role="status">
          {t("Checking PATH for forge CLIs…")}
        </p>
      )}
      {err !== null && (
        <p className="codex-note forge-error" role="alert">
          {t("Probe failed")}: {err}
        </p>
      )}
      {rows?.map((r) => (
        <div className="forge-row" key={r.id} data-cli={r.id}>
          <span className="forge-name">{r.label}</span>
          <span className="forge-state">
            {r.found
              ? (r.version ?? t("found"))
              : t("not found on PATH")}
          </span>
        </div>
      ))}
      {props.worktreesDir !== "" && (
        <div className="forge-row forge-wt" data-cli="worktrees">
          <span className="forge-name">{t("Worktrees")}</span>
          <span
            className="forge-state forge-wt-dir"
            title={props.worktreesDir}
          >
            {props.worktreesDir}
          </span>
          <button
            type="button"
            className="choice forge-wt-reveal"
            onClick={() => void api().invoke("worktrees:reveal", {})}
          >
            {t("Reveal")}
          </button>
        </div>
      )}
      <p className="codex-note">
        {t(
          "Pull requests open with the GitHub CLI (gh), GitLab CLI (glab), Cursor Origin CLI (origin) or Gitea CLI (tea) from your PATH.",
        )}
      </p>
      <p className="codex-note">
        {t(
          "Merge/PR handoffs need the matching CLI on PATH. Sign-in is never probed — Tivano does not touch forge credentials, and browser sign-in needs a real authorization server this build does not have.",
        )}
      </p>
    </div>
  );
}
