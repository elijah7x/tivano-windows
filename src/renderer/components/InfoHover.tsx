// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A83: frozen InfoHoverButton — an info mark that opens its explainer on
// hover, keeps it open while the pointer is over the popover, and closes a
// beat after the pointer leaves both. Escape and an outside press close
// too, and the mark stays keyboard-focusable like every chrome button.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../locale";

const CLOSE_DELAY_MS = 240;
const POP_WIDTH = 380;

export function InfoHover(props: {
  /** The mark's tooltip/accessible label (frozen `help`). */
  help: string;
  /** The explainer's accessible name (its topic title). */
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const cancelClose = (): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const open = (): void => {
    cancelClose();
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const left = Math.max(
        8,
        Math.min(r.left + r.width / 2 - 40, window.innerWidth - POP_WIDTH - 8),
      );
      const maxTop = window.innerHeight - 200 - 8;
      setPos({ top: Math.min(r.bottom + 8, Math.max(8, maxTop)), left });
    } else setPos({ top: 0, left: 8 });
  };
  const close = (): void => setPos(null);
  const armClose = (): void => {
    cancelClose();
    closeTimer.current = setTimeout(close, CLOSE_DELAY_MS);
  };

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pos]);

  useEffect(() => () => cancelClose(), []);

  return (
    <span className="info-hover" ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className="info-mark"
        title={t(props.help)}
        aria-label={t(props.help)}
        aria-expanded={pos !== null}
        onMouseEnter={open}
        onFocus={open}
        onMouseLeave={armClose}
        onBlur={armClose}
      />
      {pos && (
        <div
          className="info-pop"
          role="dialog"
          aria-label={t(props.label)}
          style={{ top: pos.top, left: pos.left, width: POP_WIDTH }}
          onMouseEnter={cancelClose}
          onMouseLeave={armClose}
        >
          {props.children}
        </div>
      )}
    </span>
  );
}
