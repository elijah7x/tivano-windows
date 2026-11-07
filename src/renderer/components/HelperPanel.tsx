// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F25 helper panel — frozen SubagentPanel/PlacedPanel bounded port: a
// small floating panel over the chat pane with the helper's own
// timeline + composer. The head strip is the drag handle: drag
// anywhere in the pane (clamped inside), release snaps to the nearest
// dock corner with the frozen 56px slack; a corner on a side reserves
// that width from the chat column only while the pane is wide enough
// to type in (frozen sitsBesideComposer), otherwise the panel just
// overlays a top corner. The bottom-right grip resizes it; the fitted
// size persists in settings (frozen AppSettings.panelSize). One panel
// at a time — helpers are per-parent and only the selected parent's
// shows, so the frozen stack depth is honestly 1.

import { useEffect, useRef, useState } from "react";
import type { ChatThread, Message, Settings } from "../../shared/types";
import { useT } from "../locale";
import { renderMarkdown } from "../markdown";
import { tryCall } from "../client";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ToolMsgRow, WorkingIndicator } from "./WorkingIndicator";

// Frozen SubagentPanelLayout constants.
const WIDTH = 400;
const MIN_W = 300;
const MIN_H = 220;
const GAP = 12;
const SIDE_MARGIN = 20;
const SLACK = 56;
const MIN_COMPOSER_W = 360;
const INSET = 8;

type Corner = "tl" | "tr" | "bl" | "br";
const sideOf = (c: Corner): "left" | "right" => (c === "tl" || c === "bl" ? "left" : "right");
const isTop = (c: Corner): boolean => c === "tl" || c === "tr";

export function HelperPanel(props: {
  thread: ChatThread;
  parentTitle: string;
  readOnly: boolean;
  /** Snapshot settings — showReasoning/showsWorkingCard reach the
   *  shared WorkingIndicator (frozen ThreadTimeline parity). */
  settings?: Settings;
  /** settings.helperPanelSize — the user's dragged size, if any. */
  size?: { width: number; height: number } | undefined;
  /** Docked placement while the chat column must keep clear of it:
   *  the panel's side and the width it needs (panel + frozen gap);
   *  null = the panel merely overlays a corner. */
  onDock: (dock: { side: "left" | "right"; px: number } | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const { thread, parentTitle, readOnly, onClose } = props;
  const [draft, setDraft] = useState("");
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  const [corner, setCorner] = useState<Corner>("tr");
  const [held, setHeld] = useState<{ x: number; y: number } | null>(null);
  const [sizeDrag, setSizeDrag] = useState<{ w: number; h: number } | null>(null);

  const busy =
    thread.turn?.status === "running" ||
    thread.turn?.status === "waiting-approval";

  // Measure the pane the panel floats inside (its offsetParent).
  useEffect(() => {
    const paneEl = rootRef.current?.offsetParent as HTMLElement | null;
    if (!paneEl) return;
    const read = () => setPane({ w: paneEl.clientWidth, h: paneEl.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length, thread.turn?.seq]);

  const w = Math.min(
    Math.max(sizeDrag?.w ?? props.size?.width ?? WIDTH, MIN_W),
    Math.max(MIN_W, pane.w - 2 * SIDE_MARGIN),
  );
  const idealH = props.size?.height ?? Math.min(520, Math.max(300, pane.h * 0.5));
  const h = Math.min(Math.max(sizeDrag?.h ?? idealH, MIN_H), Math.max(MIN_H, pane.h - 2 * INSET));
  const beside = pane.w - 2 * SIDE_MARGIN - w - GAP >= MIN_COMPOSER_W;

  // Docked origins: beside the chat column at pane corners when wide;
  // too narrow → the frozen "corner above the box" (top of its side).
  const docked = (c: Corner): { x: number; y: number } => ({
    x: sideOf(c) === "left" ? SIDE_MARGIN : pane.w - SIDE_MARGIN - w,
    y: !beside || isTop(c) ? INSET : pane.h - INSET - h,
  });
  const clamped = (o: { x: number; y: number }) => ({
    x: Math.min(Math.max(o.x, INSET), Math.max(INSET, pane.w - w - INSET)),
    y: Math.min(Math.max(o.y, INSET), Math.max(INSET, pane.h - h - INSET)),
  });
  /** Nearest dock corner with the frozen slack hysteresis. */
  const dockCorner = (origin: { x: number; y: number }): Corner => {
    const cx = origin.x + w / 2;
    const cy = origin.y + h / 2;
    const mx = pane.w / 2;
    const tops = docked("tl").y;
    const bots = docked("bl").y;
    const my = (tops + bots + h) / 2;
    const side =
      cx - mx < -SLACK ? "left" : cx - mx >= SLACK ? "right" : sideOf(corner);
    const top =
      cy - my < -SLACK ? true : cy - my >= SLACK ? false : isTop(corner);
    return ((top ? "t" : "b") + (side === "left" ? "l" : "r")) as Corner;
  };

  // The chat column reserves the panel's room on its docked side —
  // only while docked (not held) and the pane leaves a box worth
  // typing in (frozen sitsBesideComposer).
  const dock: { side: "left" | "right"; px: number } | null =
    !held && beside ? { side: sideOf(corner), px: w + GAP } : null;
  useEffect(() => {
    props.onDock(dock);
    return () => props.onDock(null);
  }, [dock === null ? null : `${dock.side}:${dock.px}`]);

  const pos = held ? clamped(held) : docked(corner);

  const dragStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const paneEl = rootRef.current?.offsetParent as HTMLElement | null;
    if (!paneEl) return;
    const rect = paneEl.getBoundingClientRect();
    const dx = e.clientX - rect.left - pos.x;
    const dy = e.clientY - rect.top - pos.y;
    const move = (ev: PointerEvent) => {
      setHeld({ x: ev.clientX - rect.left - dx, y: ev.clientY - rect.top - dy });
    };
    const up = (ev: PointerEvent) => {
      const o = { x: ev.clientX - rect.left - dx, y: ev.clientY - rect.top - dy };
      setHeld(null);
      setCorner(dockCorner(clamped(o)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const gripStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sw = w;
    const sh = h;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) =>
      setSizeDrag({ w: sw + ev.clientX - sx, h: sh + ev.clientY - sy });
    const up = (ev: PointerEvent) => {
      const fitted = {
        width: Math.round(Math.min(Math.max(sw + ev.clientX - sx, MIN_W), Math.max(MIN_W, pane.w - 2 * SIDE_MARGIN))),
        height: Math.round(Math.min(Math.max(sh + ev.clientY - sy, MIN_H), Math.max(MIN_H, pane.h - 2 * INSET))),
      };
      setSizeDrag(null);
      tryCall("settings:set", { helperPanelSize: fitted });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const send = () => {
    const text = draft.trim();
    if (!text || readOnly) return;
    setDraft("");
    // Frozen parity: a prompt into a busy helper queues behind its turn.
    tryCall(busy ? "followUps:enqueue" : "turns:send", {
      threadId: thread.id,
      text,
    });
  };

  const renderMessage = (m: Message): React.JSX.Element | null => {
    if (m.role === "system")
      return (
        <div key={m.id} className="msg system">
          {m.content}
        </div>
      );
    // Frozen TimelineGroup.build: thinking never renders as a row — it
    // only lives behind the running indicator's chevron below.
    if (m.kind === "reasoning") return null;
    if (m.kind === "tool" && m.tool) {
      // Frozen: running tools fold into the indicator's chevron.
      if (thread.turn?.status === "running" && m.turnId === thread.turn.id)
        return null;
      return <ToolMsgRow key={m.id} m={m} />;
    }
    if (m.kind === "notice") {
      const lv = m.noticeLevel ?? "info";
      return (
        <div key={m.id} className={`msg notice-row lv-${lv}`}>
          <span className="notice-glyph" aria-hidden="true">
            {lv === "error" ? "⛔" : lv === "warning" ? "⚠" : "ⓘ"}
          </span>
          <span className="notice-text">{m.content}</span>
        </div>
      );
    }
    return (
      <div key={m.id} className={`msg ${m.role} ${m.status}`}>
        {m.role === "assistant" ? (
          <div className="md">
            {renderMarkdown(m.content, { copy: t("Copy"), copied: t("Copied") }, m.status === "streaming")}
          </div>
        ) : (
          m.content
        )}
        {m.status === "streaming" && <span className="dots" aria-hidden="true" />}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={`helper-panel float${held ? " held" : ""}`}
      role="complementary"
      aria-label={t("Helper")}
      style={{ left: pos.x, top: pos.y, width: w, height: h }}
      data-corner={corner}
      data-dock-side={dock?.side ?? ""}
    >
      <div
        className="helper-head"
        onPointerDown={dragStart}
        title={t("Drag to move")}
      >
        <div className="helper-head-text">
          <span className="helper-title">{thread.title}</span>
          <span className="helper-sub">
            {t("Helper for")} {parentTitle}
          </span>
        </div>
        {busy && (
          <button
            type="button"
            className="helper-stop"
            title={t("Stop turn")}
            onClick={() => tryCall("turns:cancel", { threadId: thread.id })}
          >
            ■
          </button>
        )}
        <button
          type="button"
          className="helper-close"
          title={t("Move to sidebar")}
          aria-label={t("Move to sidebar")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="helper-timeline" ref={timelineRef} role="log" aria-live="polite" data-chat-id={thread.id}>
        {thread.messages.map(renderMessage)}
        {thread.turn?.status === "running" && (
          <WorkingIndicator
            thread={thread}
            turn={thread.turn}
            showsCard={props.settings?.showsWorkingCard !== false}
            showReasoning={props.settings?.showReasoning === true}
          />
        )}
        {thread.turn?.approval && (
          <ApprovalCard threadId={thread.id} approval={thread.turn.approval} />
        )}
        {thread.turn?.question && (
          <QuestionCard threadId={thread.id} question={thread.turn.question} />
        )}
      </div>
      {(thread.followUps?.length ?? 0) > 0 && (
        <div className="helper-queue">
          {t("Queued")} ({thread.followUps!.length}): {thread.followUps![0]!.text}
        </div>
      )}
      <div className="helper-composer">
        <textarea
          value={draft}
          rows={2}
          disabled={readOnly}
          placeholder={busy ? t("Queue a message…") : t("Message the helper…")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" disabled={readOnly || !draft.trim()} onClick={send}>
          {busy ? t("Queue") : t("Send")}
        </button>
      </div>
      <div
        className="helper-grip"
        role="separator"
        aria-label={t("Resize panel")}
        title={t("Resize panel")}
        onPointerDown={gripStart}
      />
    </div>
  );
}
