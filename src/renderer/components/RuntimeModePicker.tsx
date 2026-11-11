// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F06 runtime-mode picker — the four frozen modes (Provider.swift @
// d31e093b). Persisted per thread; applies to the NEXT turn, never
// retargets a running one. Providers without a policy mapping ignore
// the value — it is an honest preference, not a promise of enforcement
// by a synthetic provider.

import type { ChatThread, RuntimeMode } from "../../shared/types";
import { useT } from "../locale";
import { tryCall } from "../client";

export const RUNTIME_MODES: readonly RuntimeMode[] = [
  "supervised",
  "autoAcceptEdits",
  "auto",
  "fullAccess",
];

export const RUNTIME_MODE_TITLE: Record<RuntimeMode, string> = {
  supervised: "Supervised",
  autoAcceptEdits: "Auto-accept edits",
  auto: "Auto",
  fullAccess: "Full access",
};
export const RUNTIME_MODE_SUMMARY: Record<RuntimeMode, string> = {
  supervised: "Asks before commands and file changes",
  autoAcceptEdits: "Edits files freely, asks before other actions",
  auto: "The provider's reviewer approves routine actions",
  fullAccess: "Runs commands and edits without asking",
};

export function RuntimeModePicker(props: {
  thread: ChatThread;
  readOnly: boolean;
}): React.JSX.Element {
  const t = useT();
  const mode = props.thread.runtimeMode ?? "supervised";
  return (
    <span className="runtime-mode-wrap">
      {mode === "fullAccess" && (
        // P1-30: full access shows a checked shield (Mac checkmark.shield).
        <span className="runtime-mode-glyph" title={t("Full access")}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1.7 13.4 3.6v3.6c0 3.4-2.4 5.9-5.4 7.2-3-1.3-5.4-3.8-5.4-7.2V3.6Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="m5.6 7.6 1.7 1.7 3.1-3.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      <select
        className="runtime-mode"
        aria-label={t("Runtime mode")}
        title={`${t("Runtime mode")} — ${t(RUNTIME_MODE_SUMMARY[mode])}`}
        value={mode}
        disabled={props.readOnly}
        onChange={(e) =>
          tryCall("threads:set-runtime-mode", {
            threadId: props.thread.id,
            mode: e.target.value as RuntimeMode,
          })
        }
      >
        {RUNTIME_MODES.map((m) => (
          <option key={m} value={m}>
            {t(RUNTIME_MODE_TITLE[m])}
          </option>
        ))}
      </select>
    </span>
  );
}
