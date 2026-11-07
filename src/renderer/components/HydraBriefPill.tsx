// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22: the lead's brief arriving on a head's thread renders as a pill —
// "Hank's brief", or "Hank is starting to cook…" while the brief's turn
// has produced nothing of its own yet (frozen HydraBriefRow). The pill
// opens the brief's markdown in a popover: glyph header, task caption,
// copy button, scrollable body (frozen HydraBriefPopover).

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { personaAt } from "../../shared/hydraDelegation";
import type { ChatThread } from "../../shared/types";
import { useT } from "../locale";
import { renderMarkdown } from "../markdown";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

export function HydraBriefPill(props: {
  /** The head's thread — supplies the persona, task and cooking state. */
  thread: ChatThread;
  /** The brief message's turn — "cooking" while it has no output. */
  turnId?: string;
  content: string;
}): React.JSX.Element {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  const head = props.thread.hydraHead;
  const persona = personaAt(head?.headIndex ?? 0);
  const turn = props.thread.turn;
  // Frozen: the brief's turn has output once any other entry lands on it.
  const cooking =
    (turn?.status === "running" || turn?.status === "waiting-approval") &&
    turn?.id === props.turnId &&
    !props.thread.messages.some(
      (m) => m.role === "assistant" && m.turnId === props.turnId && m.content !== "",
    );
  const title = cooking
    ? t("%@ is starting to cook…", persona.name)
    : t("%@'s brief", persona.name);

  const toggle = (): void => {
    if (open) return setOpen(false);
    const r = rootRef.current?.querySelector(".hydra-brief-pill")?.getBoundingClientRect();
    if (r) {
      const W = 520;
      const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
      const above = r.top - 8;
      const below = window.innerHeight - r.bottom - 8;
      const maxH = 520;
      if (above >= Math.min(maxH, 200) || above >= below) {
        setPos({ top: Math.max(8, r.top - Math.min(maxH, above - 8)), left, maxH: Math.min(maxH, above - 8) });
      } else {
        setPos({ top: r.bottom + 8, left, maxH: Math.min(maxH, below - 8) });
      }
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <span className="hydra-brief" ref={rootRef}>
      <button
        type="button"
        className={`hydra-brief-pill${cooking ? " cooking" : ""}`}
        aria-expanded={open}
        title={t("Show the brief")}
        onClick={toggle}
      >
        <span className="hydra-dot" style={{ background: hex(persona.hex) }} />
        <span className="hb-title">{title}</span>
        <span className="hb-chev" aria-hidden="true">›</span>
      </button>
      {open && pos && (
        <div
          className="hydra-brief-pop"
          style={{ top: pos.top, left: pos.left, maxHeight: pos.maxH }}
          role="dialog"
          aria-label={t("Brief")}
        >
          <div className="hb-pop-head">
            <span className="hydra-dot" style={{ background: hex(persona.hex) }} />
            <span className="hb-pop-name">{persona.name}</span>
            <span className="hb-pop-cap">{t("Brief")}</span>
            {head?.task && <span className="hb-pop-task">{head.task}</span>}
            <button
              type="button"
              className="md-copy hb-pop-copy"
              data-md-copy="1"
              data-label-copy={t("Copy")}
              data-label-copied={t("Copied")}
              data-copy-text={props.content}
            >
              {t("Copy")}
            </button>
          </div>
          <div className="hb-pop-body">
            {renderMarkdown(props.content, { copy: t("Copy"), copied: t("Copied") })}
          </div>
        </div>
      )}
    </span>
  );
}
