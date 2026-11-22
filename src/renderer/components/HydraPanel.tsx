// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-22.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22: Hydra head strip — frozen HydraPanel parity, bounded. A lead
// thread lists its heads (roster colour, name, task, status); a head
// thread shows a banner with a way back to its lead. Heads never appear
// in the sidebar — this strip is their only surface. "Stop" routes
// through hydra:stop so the report honestly reads "stopped".
// P1-31: the strip's middle room drags it free of its dock (a press that
// never moved 2px stays a click), the head's name opens its chat, and a
// right-click anywhere on the panel opens the frozen panel menu.

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { personaAt } from "../../shared/hydraDelegation";
import type { HydraReview } from "../../shared/hydraReview";
import type { ChatThread } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";
import { HydraStaveBar } from "./HydraStaveBar";
import { MiniSpinner } from "./SpinnerCells";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

// P1-31 pure helpers — the drag slop, the clamp that keeps a floated
// panel grabbable on screen, the Continue gate shared by the row button
// and the context menu, and the frozen menu's row list.

/** Frozen PanelDragHandle slop: a press must travel 2px to be a drag. */
export const HYDRA_PANEL_DRAG_SLOP = 2;

export function hydraPanelDragBegun(dx: number, dy: number): boolean {
  const s = HYDRA_PANEL_DRAG_SLOP;
  return dx * dx + dy * dy >= s * s;
}

/** Keep a floated panel reachable: 80px of it must stay inside the
 *  viewport on each axis. */
export function hydraPanelClamp(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
): { x: number; y: number } {
  const minVis = Math.min(80, w, h);
  return {
    x: Math.min(Math.max(x, minVis - w), Math.max(minVis - w, vw - minVis)),
    y: Math.min(Math.max(y, 0), Math.max(0, vh - minVis)),
  };
}

/** Frozen continueFailedHydraHead gate, bounded: a failed or stopped
 *  head with its own copy continues; a shared-checkout head keeps no
 *  Continue. Upstream also waits out releasing copies and open jobs —
 *  the port tracks neither, so its gate is the visible two. */
export function hydraContinueEligible(
  info: NonNullable<ChatThread["hydraHead"]>,
  head: Pick<ChatThread, "worktreeDir">,
): boolean {
  return (
    (info.status === "stopped" || info.status === "failed") &&
    info.baseTree !== undefined &&
    head.worktreeDir !== undefined
  );
}

export type HydraPanelMenuItem =
  | "open"
  | "continue"
  | "stop"
  | "sep"
  | "dock"
  | "dismiss";

/** Frozen panelMenu order, port-adapted: the head's chat first, then
 *  its Continue/Stop under their gates, a divider only when head rows
 *  precede it, then the panel rows — Dock back when floating, and
 *  Dismiss when the host can hide the panel. Upstream's per-head
 *  pop-out rows have no port window to map to. */
export function hydraPanelMenuItems(opts: {
  hasHead: boolean;
  running: boolean;
  continueOk: boolean;
  floating: boolean;
  readOnly: boolean;
  hasDismiss: boolean;
}): HydraPanelMenuItem[] {
  const rows: HydraPanelMenuItem[] = [];
  if (opts.hasHead) rows.push("open");
  if (!opts.readOnly) {
    if (opts.continueOk) rows.push("continue");
    if (opts.running) rows.push("stop");
  }
  const panelRows: HydraPanelMenuItem[] = [];
  if (opts.floating) panelRows.push("dock");
  if (opts.hasDismiss) panelRows.push("dismiss");
  if (rows.length && panelRows.length) rows.push("sep");
  return [...rows, ...panelRows];
}

function statusLabel(
  status: "running" | "completed" | "stopped" | "failed",
  stopReason: "stalled" | undefined,
  t: (s: string) => string,
): string {
  switch (status) {
    case "running":
      return t("Working");
    case "completed":
      return t("Done");
    case "stopped":
      return stopReason === "stalled" ? t("Stalled") : t("Stopped");
    case "failed":
      return t("Failed");
  }
}

/** Frozen hydraWaitingStatus: a running head parked on the user shows
 *  the pending reason instead of "working" (approval beats question). */
function waitingLabel(
  head: ChatThread,
  t: (s: string) => string,
): string | null {
  if (head.hydraHead?.status !== "running") return null;
  if (head.turn?.approval?.status === "pending") return t("Awaiting approval");
  if (head.turn?.question?.status === "pending") return t("Awaiting your answer");
  return null;
}

/** F22 isolation: where an isolated head's work went — one honest word. */
function landingLabel(
  info: NonNullable<ChatThread["hydraHead"]>,
  t: (s: string) => string,
): string | null {
  if (info.landingPending === true) return t("Landing…");
  const l = info.landing;
  if (l) {
    if (l.files.length === 0 && !l.patchPath && !l.error) return t("changed nothing");
    if (l.patchPath) return t("patch kept");
    if (l.error && !l.files.length) return t("landing failed");
    if (l.conflicts.length) return `${t("landed")} · ${t("conflicts")}: ${l.conflicts.length}`;
    if (l.files.length) return `${t("landed")} ${l.files.length === 1 ? t("1 file") : `${l.files.length} ${t("files")}`}`;
  }
  if (info.copyKept === true) return t("copy kept");
  if (info.baseTree !== undefined && info.status === "running") return t("own copy");
  return null;
}

/** P1-38 frozen folding review card: one row naming the reviewer, the
 *  accepted/rejected counts, diff size and duration; it expands in place
 *  to each finding. */
function HydraReviewCard(props: { review: HydraReview }): React.JSX.Element {
  const t = useT();
  const r = props.review;
  const parts: string[] = [];
  if (r.findingCount === 0) parts.push(t("No findings"));
  else parts.push(r.findingCount === 1 ? t("1 finding") : `${r.findingCount} ${t("findings")}`);
  if (r.accepted !== undefined) parts.push(`${r.accepted} ${t("accepted")}`);
  if (r.rejected !== undefined) parts.push(`${r.rejected} ${t("rejected")}`);
  parts.push(
    r.diffBytes >= 1024 ? `${Math.round(r.diffBytes / 1024)} KB ${t("diff")}` : `${r.diffBytes} B ${t("diff")}`,
  );
  parts.push(`${Math.max(1, Math.round(r.durationMs / 1000))} s`);
  const lines = r.findings
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[\s\-*>#_]*Finding\s*\d/i.test(l));
  return (
    <details className="hydra-review">
      <summary>
        <span className="hydra-review-title">
          {t("Independent review by %@", r.reviewer)}
        </span>
        <span className="hydra-review-meta">{parts.join(" · ")}</span>
      </summary>
      {lines.length ? (
        <ol className="hydra-review-findings">
          {lines.map((l, i) => (
            <li key={i}>{l.replace(/^[\s\-*>#_]*Finding\s*\d+\s*[:：]\s*/i, "")}</li>
          ))}
        </ol>
      ) : (
        <p className="codex-note">{t("The reviewer found no problems in this job's changes.")}</p>
      )}
    </details>
  );
}

export function HydraPanel(props: {
  thread: ChatThread;
  /** Every thread — heads are filtered out of the sidebar but live in
   *  the store; this strip is how they are reached. */
  threads: ChatThread[];
  readOnly?: boolean;
  /** P1-31: the frozen Dismiss menu row — hides the docked panel while
   *  the heads keep working (ChatView owns the flag). */
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const t = useT();
  const { thread } = props;
  // P1-31: null = docked in the chat column; set = floating at a
  // viewport point the drag carried it to (w/h keep its box + dock space).
  const [floatPos, setFloatPos] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; head: ChatThread | null } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    px: number;
    py: number;
    ox: number;
    oy: number;
    w: number;
    moved: boolean;
  } | null>(null);
  const ownHead = thread.hydraHead;
  const heads = useMemo(
    () =>
      props.threads
        .filter((x) => x.hydraHead?.leadId === thread.id)
        .slice()
        .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt),
    [props.threads, thread.id],
  );
  const lead = useMemo(
    () =>
      ownHead
        ? (props.threads.find((x) => x.id === ownHead.leadId) ?? null)
        : null,
    [props.threads, ownHead],
  );

  // Frozen DotFieldSweep: when a head leaves "running", one wave of its
  // persona colour flows through the panel once. The prev-status map
  // keeps a restored panel (heads already done at mount) from firing.
  const prevStatus = useRef(new Map<string, string>());
  const [sweep, setSweep] = useState<{ id: string; tint: string } | null>(null);
  useEffect(() => {
    const prev = prevStatus.current;
    const done = heads.find(
      (h) =>
        prev.get(h.id) === "running" && h.hydraHead!.status !== "running",
    );
    for (const h of heads) prev.set(h.id, h.hydraHead!.status);
    if (!done) return;
    const persona = personaAt(done.hydraHead!.headIndex);
    setSweep({ id: done.id, tint: hex(persona.hex) });
    const timer = setTimeout(() => setSweep(null), 1200);
    return () => clearTimeout(timer);
  }, [heads]);

  // P1-31: the context menu is transient like the frozen popover —
  // Escape, an outside press, or a real scroll gesture closes it.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".hydra-menu")) setMenu(null);
    };
    const onScroll = () => setMenu(null);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("wheel", onScroll, true);
    document.addEventListener("touchmove", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("wheel", onScroll, true);
      document.removeEventListener("touchmove", onScroll, true);
    };
  }, [menu]);

  if (ownHead) {
    const persona = personaAt(ownHead.headIndex);
    const waiting = waitingLabel(thread, t);
    return (
      <div className="hydra-strip" role="note">
        <span className="hydra-dot" style={{ background: hex(persona.hex) }} />
        <span className="hydra-strip-text">
          {t("A Hydra head working for the lead")} — {ownHead.name}
          {waiting && ` · ${waiting}`}
        </span>
        {lead && (
          <button
            className="hydra-back"
            onClick={() =>
              void callApi("threads:select", { id: lead.id }).catch(() => {})
            }
          >
            {t("Back to lead")}
          </button>
        )}
      </div>
    );
  }
  const reviews = thread.hydraReviews ?? [];
  if (!heads.length && !reviews.length) return null;

  const waitingCount = heads.filter((h) => waitingLabel(h, t) !== null).length;

  // P1-31: the drag surfaces — the title capsule and the middle room —
  // share one pointer tracker. A press records the strip's box; past the
  // 2px slop it floats and follows the pointer, clamped to the window.
  const onDragDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      ox: rect.left,
      oy: rect.top,
      w: rect.width,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && !hydraPanelDragBegun(dx, dy)) return;
    d.moved = true;
    const h = panelRef.current?.offsetHeight ?? 40;
    const c = hydraPanelClamp(
      d.ox + dx,
      d.oy + dy,
      d.w,
      h,
      window.innerWidth,
      window.innerHeight,
    );
    setFloatPos({ ...c, w: d.w, h });
  };
  const onDragUp = () => {
    dragRef.current = null;
  };
  const dragProps = {
    onPointerDown: onDragDown,
    onPointerMove: onDragMove,
    onPointerUp: onDragUp,
    onPointerCancel: onDragUp,
    // A double-click on a drag surface docks a floating panel.
    onDoubleClick: () => setFloatPos(null),
    title: t("Drag to move"),
  };

  // The menu's head is re-resolved live: a head that finished between
  // the right-click and the click re-checks its own status instead of
  // firing a stale Stop.
  const menuHead = menu?.head
    ? (props.threads.find((x) => x.id === menu.head!.id) ?? menu.head)
    : null;
  const menuRows = menu
    ? hydraPanelMenuItems({
        hasHead: menuHead !== null,
        running: menuHead?.hydraHead?.status === "running",
        continueOk:
          menuHead !== null &&
          menuHead.hydraHead !== undefined &&
          hydraContinueEligible(menuHead.hydraHead, menuHead),
        floating: floatPos !== null,
        readOnly: props.readOnly === true,
        hasDismiss: props.onDismiss !== undefined,
      })
    : [];
  const menuHeadName = menuHead?.hydraHead?.name ?? t("this sub-agent");
  const runMenu = (item: HydraPanelMenuItem) => {
    const head = menuHead;
    setMenu(null);
    if (item === "open" && head)
      void callApi("threads:select", { id: head.id }).catch(() => {});
    else if (item === "continue" && head)
      void callApi("hydra:continue", { threadId: head.id }).catch(() => {});
    else if (item === "stop" && head)
      void callApi("hydra:stop", { threadId: head.id }).catch(() => {});
    else if (item === "dock") setFloatPos(null);
    else if (item === "dismiss") props.onDismiss?.();
  };
  const menuLabel = (item: HydraPanelMenuItem): string => {
    switch (item) {
      case "open":
        return t("Open %@'s chat", menuHeadName);
      case "continue":
        return t("Continue sub-agent");
      case "stop":
        return t("Stop %@", menuHeadName);
      case "dock":
        return t("Dock the panel");
      case "dismiss":
        return t("Dismiss the panel; sub-agents keep working");
      default:
        return "";
    }
  };
  return (
    <>
      {/* A detached panel leaves its dock's space behind so the chat
          does not jump when it lifts. */}
      {floatPos && <div aria-hidden="true" style={{ height: floatPos.h }} />}
      <div
        ref={panelRef}
        className={`hydra-panel${floatPos ? " floating" : ""}`}
      style={
        floatPos
          ? { position: "fixed", left: floatPos.x, top: floatPos.y, width: floatPos.w, zIndex: 60 }
          : undefined
      }
      aria-label={t("Heads")}
      onContextMenu={(e) => {
        e.preventDefault();
        const li = (e.target as HTMLElement).closest<HTMLElement>(
          "li[data-head]",
        );
        const head = li?.dataset.head
          ? (heads.find((h) => h.id === li.dataset.head) ?? null)
          : (heads[0] ?? null);
        setMenu({ x: e.clientX, y: e.clientY, head });
      }}
    >
      <span className="hydra-title hydra-drag-surface" {...dragProps}>
        {t("Heads")} · {heads.length}
        {waitingCount > 0 && ` · ${waitingCount} ${t("waiting")}`}
      </span>
      <ul>
        {heads.map((h) => {
          const info = h.hydraHead!;
          const persona = personaAt(info.headIndex);
          const land = landingLabel(info, t);
          const waiting = waitingLabel(h, t);
          return (
            <li key={h.id} data-head={h.id} className={`hydra-row ${info.status}`}>
              <button
                className="hydra-open"
                title={info.task}
                onClick={() =>
                  void callApi("threads:select", { id: h.id }).catch(() => {})
                }
              >
                <span
                  className="hydra-dot"
                  style={{ background: hex(persona.hex) }}
                />
                <span className="hydra-name">{info.name}</span>
                <span className="hydra-task">{info.task}</span>
                {land && <span className="hydra-land">{land}</span>}
                <span className={`hydra-status ${info.status}`}>
                  {waiting ?? statusLabel(info.status, info.stopReason, t)}
                  {info.status === "running" && <MiniSpinner />}
                </span>
              </button>
              <HydraStaveBar
                messages={h.messages}
                tint={hex(persona.hex)}
                status={info.status}
                height={14}
              />
              {info.status === "running" && (
                <button
                  className="hydra-stop"
                  title={t("Stop this head")}
                  aria-label={`${t("Stop")} ${info.name}`}
                  disabled={props.readOnly === true}
                  onClick={() =>
                    void callApi("hydra:stop", { threadId: h.id }).catch(() => {})
                  }
                >
                  {t("Stop")}
                </button>
              )}
              {/* P1-35: frozen continueFailedHydraHead — a failed or
                  stopped head with its own copy continues in its own
                  session; a shared-checkout head keeps no Continue. */}
              {hydraContinueEligible(info, h) && (
                  <button
                    className="hydra-continue"
                    title={t("Continue this head in its own session")}
                    aria-label={`${t("Continue")} ${info.name}`}
                    disabled={props.readOnly === true}
                    onClick={() =>
                      void callApi("hydra:continue", { threadId: h.id }).catch(
                        () => {},
                      )
                    }
                  >
                    {t("Continue")}
                  </button>
                )}
            </li>
          );
        })}
      </ul>
      {/* P1-31: the strip's middle room is the drag handle — upstream's
          PanelDragHandle on the empty strip room. */}
      <span className="hydra-drag hydra-drag-surface" {...dragProps} />
      {reviews.slice(-3).map((r) => (
        <HydraReviewCard key={r.id} review={r} />
      ))}
      {sweep && (
        <span
          className="sweep-dots"
          style={{ "--sweep-tint": sweep.tint } as React.CSSProperties}
          aria-hidden="true"
        />
      )}
      {menu && menuRows.length > 0 && (
        <div
          className="link-pop hydra-menu"
          role="menu"
          aria-label={t("Heads")}
          style={{
            left: Math.min(menu.x, Math.max(8, window.innerWidth - 240)),
            top: Math.min(menu.y, Math.max(8, window.innerHeight - 160)),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menuRows.map((item) =>
            item === "sep" ? (
              <div key="sep" className="hydra-menu-sep" role="separator" />
            ) : (
              <button
                key={item}
                role="menuitem"
                className="suggest-row msg-row"
                onClick={() => runMenu(item)}
              >
                <span className="suggest-name">{menuLabel(item)}</span>
              </button>
            ),
          )}
        </div>
      )}
      </div>
    </>
  );
}
