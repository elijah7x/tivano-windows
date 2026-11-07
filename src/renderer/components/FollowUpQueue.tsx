// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F08 follow-up queue bar (FollowUpQueueTab parity, bounded): queued
// prompts go out in order once the running turn completes; a stopped
// turn waits for the user. Rows can be reordered, edited, removed,
// bundled (one merged message) or sent now. No drag — explicit buttons.

import { useState } from "react";
import type { ChatThread, FollowUpItem } from "../../shared/types";
import { useT } from "../locale";
import { tryCall } from "../client";

/** Display number for each item: a bundle shares its first member's. */
function rowNumbers(items: FollowUpItem[]): (number | null)[] {
  let n = 0;
  let lastBundle: string | undefined;
  return items.map((i) => {
    if (i.bundleId && i.bundleId === lastBundle) return null;
    if (!i.bundleId || i.bundleId !== lastBundle) n += 1;
    lastBundle = i.bundleId;
    return n;
  });
}

export function FollowUpQueue(props: {
  thread: ChatThread;
  readOnly?: boolean;
}): React.JSX.Element | null {
  const t = useT();
  const { thread } = props;
  const items = thread.followUps ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (items.length === 0) return null;
  const numbers = rowNumbers(items);
  const disabled = !!props.readOnly;
  const call = (channel: Parameters<typeof tryCall>[0], payload: object) =>
    tryCall(channel, payload);

  return (
    <div className="followup-queue" aria-label={t("Queued follow-ups")}>
      <div className="followup-head">
        {t("%@ queued", `${items.length}`)}
      </div>
      {items.map((item, idx) => {
        const num = numbers[idx]!;
        const prev = idx > 0 ? items[idx - 1]! : null;
        const next = idx + 1 < items.length ? items[idx + 1]! : null;
        const bundled = !!item.bundleId;
        if (editing === item.id) {
          return (
            <div className="followup-row editing" key={item.id}>
              <textarea
                className="followup-edit"
                value={draft}
                rows={2}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    call("followUps:update", { threadId: thread.id, id: item.id, text: draft });
                    setEditing(null);
                  }
                  if (e.key === "Escape") setEditing(null);
                }}
              />
              <button
                className="followup-btn"
                title={t("Save")}
                onClick={() => {
                  call("followUps:update", { threadId: thread.id, id: item.id, text: draft });
                  setEditing(null);
                }}
              >
                ✓
              </button>
              <button
                className="followup-btn"
                title={t("Cancel")}
                onClick={() => setEditing(null)}
              >
                ×
              </button>
            </div>
          );
        }
        return (
          <div className="followup-row" key={item.id} data-bundled={bundled || undefined}>
            <span className="followup-num">{num ?? "·"}</span>
            <span className="followup-text" title={item.text}>
              {item.text}
            </span>
            <button
              className="followup-btn"
              title={t("Move up")}
              disabled={disabled || !prev}
              onClick={() =>
                prev && call("followUps:move", { threadId: thread.id, id: item.id, targetId: prev.id, after: false })
              }
            >
              ↑
            </button>
            <button
              className="followup-btn"
              title={t("Move down")}
              disabled={disabled || !next}
              onClick={() =>
                next && call("followUps:move", { threadId: thread.id, id: item.id, targetId: next.id, after: true })
              }
            >
              ↓
            </button>
            <button
              className="followup-btn"
              title={bundled ? t("Unbundle — send separately") : t("Bundle with the previous item")}
              disabled={disabled || (!bundled && !prev)}
              onClick={() =>
                bundled
                  ? call("followUps:unbundle", { threadId: thread.id, id: item.id })
                  : prev && call("followUps:bundle", { threadId: thread.id, id: item.id, ontoId: prev.id })
              }
            >
              {bundled ? "⛓" : "⛓‍💥"}
            </button>
            <button
              className="followup-btn"
              title={t("Edit")}
              disabled={disabled}
              onClick={() => {
                setDraft(item.text);
                setEditing(item.id);
              }}
            >
              ✎
            </button>
            <button
              className="followup-btn followup-send"
              title={t("Send now — stops the running turn first")}
              disabled={disabled}
              onClick={() => call("followUps:send-now", { threadId: thread.id, id: item.id })}
            >
              ▶
            </button>
            <button
              className="followup-btn"
              title={t("Remove")}
              disabled={disabled}
              onClick={() => call("followUps:remove", { threadId: thread.id, id: item.id })}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
