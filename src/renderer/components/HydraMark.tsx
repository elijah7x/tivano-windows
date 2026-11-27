// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F21/F22/P2-79: the chat-top Hydra / Chimera sub-agent mark — frozen
// HydraButton parity, bounded. In Hydra mode, click opens the read-once
// intro until seen, then the explainer note (no heads) or panel toggle
// (heads out); in adaptive (Chimera) mode, renders the Chimera emblem
// with live working count, suppresses the Hydra intro, and toggles the
// sub-agent panel directly when heads are present. Right-click opens
// the per-chat switch; the mark dims while sub-agents are off.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { personaAt } from "../../shared/hydraDelegation";
import type { ChatThread, Settings } from "../../shared/types";
import { callApi, clientStore } from "../client";
import { useT } from "../locale";
import type { SettingsPageId } from "./SettingsModal";

type Pop = "intro" | "idle" | "switch";

export type HydraMarkClickAction =
  | "none"
  | "toggle-panel"
  | "open-intro"
  | "open-idle"
  | "open-switch"
  | "close-pop";

export function resolveHydraMarkClick(opts: {
  readOnly: boolean;
  hasHeads: boolean;
  isOn: boolean;
  isChimera: boolean;
  seenIntro: boolean;
  pop: Pop | null;
}): HydraMarkClickAction {
  if (opts.readOnly) return "none";
  if (opts.hasHeads) {
    if (opts.isOn && !opts.isChimera && !opts.seenIntro) return "open-intro";
    return "toggle-panel";
  }
  if (!opts.isOn) return opts.pop === "switch" ? "close-pop" : "open-switch";
  if (!opts.isChimera && !opts.seenIntro) return "open-intro";
  return opts.pop === "idle" ? "close-pop" : "open-idle";
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

function ChimeraMarkSvg(): React.JSX.Element {
  return (
    <svg
      className="chimera-mark-icon"
      width="18"
      height="16"
      viewBox="0 0 18 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 1.6L11.7 5.6L9 8.2L6.3 5.6L9 1.6Z" fill="currentColor" />
      <path
        d="M2.2 5.4L6.4 6.6L7.4 10.6L3.4 11.4L2.2 5.4Z"
        fill="currentColor"
        opacity="0.88"
      />
      <path
        d="M15.8 5.4L11.6 6.6L10.6 10.6L14.6 11.4L15.8 5.4Z"
        fill="currentColor"
        opacity="0.88"
      />
      <path
        d="M6.2 12.6H11.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function HydraMark(props: {
  thread: ChatThread;
  /** The lead's resolved heads (empty for head threads and quiet leads). */
  heads: ChatThread[];
  /** Live settings snapshot from ChatView (falls back to clientStore for standalone callers). */
  settings?: Settings | undefined;
  readOnly?: boolean;
  /** Frozen runtime.isHydraPanelHidden — the mark's click toggles it. */
  panelHidden: boolean;
  onTogglePanel: () => void;
  onOpenSettings?: (page?: SettingsPageId) => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const internalBtnRef = useRef<HTMLButtonElement>(null);
  const btnRef = props.buttonRef ?? internalBtnRef;
  const [pop, setPop] = useState<Pop | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const settings = props.settings ?? clientStore.snapshot?.settings;
  const seenIntro = settings?.hasSeenHydraIntro === true;
  const globalOn = settings?.hydraEnabled !== false;
  const isOn =
    globalOn && props.thread.hydraEnabled !== false && !props.thread.hydraHead;
  const subagentMode =
    props.thread.subagentMode ?? (props.thread.hydraPairId ? "preset" : "same");
  const isChimera = isOn && subagentMode === "adaptive";
  const activeHeads = props.heads.filter((h) => !h.isArchived);
  const hasHeads = activeHeads.length > 0;
  const running = activeHeads.filter((h) => h.hydraHead?.status === "running").length;

  useEffect(() => {
    setPop(null);
  }, [props.thread.id]);

  useEffect(() => {
    if (isChimera && pop === "intro") setPop(null);
  }, [isChimera, pop]);

  // Frozen: the first chat's Hydra intro opens by itself until read (Hydra mode only).
  const introArmed = useRef(false);
  useEffect(() => {
    if (introArmed.current) return undefined;
    if (!seenIntro && isOn && !isChimera && !props.readOnly) {
      introArmed.current = true;
      const raf = requestAnimationFrame(() => openPop("intro"));
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [seenIntro, isOn, isChimera, props.readOnly]);

  const openPop = (p: Pop): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const W = p === "intro" ? 420 : 290;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 8));
      const maxTop = window.innerHeight - 320 - 8;
      setPos({ top: Math.min(r.bottom + 8, Math.max(8, maxTop)), left });
    }
    setPop(p);
  };

  const seen = (): void => {
    setPop(null);
    void callApi("settings:set", { hasSeenHydraIntro: true }).catch(() => {});
  };

  // Outside-click dismiss. The frozen intro is interactiveDismissDisabled
  // (button-only); bounded here — any dismiss counts as read so the card
  // can never linger over the timeline and eat covered clicks. The intro
  // still auto-opens once and never again once seen.
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        if (pop === "intro") seen();
        else setPop(null);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (pop === "intro") seen();
        else setPop(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pop]);

  const flip = (enabled: boolean): void => {
    setPop(null);
    const calls: Promise<unknown>[] = [
      callApi("threads:set-hydra", { threadId: props.thread.id, enabled }),
    ];
    // Frozen "Turn Hydra on" (global off) flips Settings and the chat.
    if (enabled && !globalOn)
      calls.unshift(callApi("settings:set", { hydraEnabled: true }));
    for (const c of calls) void c.catch(() => {});
  };

  const onClick = (): void => {
    const action = resolveHydraMarkClick({
      readOnly: props.readOnly === true,
      hasHeads,
      isOn,
      isChimera,
      seenIntro,
      pop,
    });
    if (action === "none") return;
    if (action === "toggle-panel") {
      setPop(null);
      props.onTogglePanel();
    } else if (action === "open-intro") {
      openPop("intro");
    } else if (action === "open-idle") {
      openPop("idle");
    } else if (action === "open-switch") {
      openPop("switch");
    } else {
      setPop(null);
    }
  };

  const markTitle = (): string => {
    if (!isOn) {
      if (subagentMode === "adaptive") {
        return !globalOn
          ? t("Sub-agents are off in Settings")
          : t("Sub-agents are off for this chat");
      }
      return !globalOn
        ? t("Hydra is off in Settings")
        : t("Hydra is off for this chat");
    }
    if (isChimera) {
      const parts = [t("Sub-agents are on"), t("Adaptive sub-agents")];
      if (running > 0)
        parts.push(
          running === 1
            ? t("1 sub-agent working")
            : t("%d sub-agents working", String(running)),
        );
      if (!hasHeads) parts.push(t("No sub-agents out yet"));
      else parts.push(props.panelHidden ? t("Show the panel") : t("Hide the panel"));
      return parts.join(" · ");
    }
    const parts = [t("Hydra is on")];
    parts.push(t("Heads run on this chat's model"));
    if (running > 0)
      parts.push(running === 1 ? t("1 head working") : t("%d heads working", String(running)));
    if (!hasHeads) parts.push(t("No heads out yet"));
    else parts.push(props.panelHidden ? t("Show the panel") : t("Hide the panel"));
    return parts.join(" · ");
  };

  const useSubagentCopy = isChimera || subagentMode === "adaptive";

  const ariaLabel = (): string => {
    if (!isChimera) return useSubagentCopy ? t("Sub-agents") : t("Hydra");
    if (!hasHeads) return t("Sub-agents are on, no sub-agents out yet");
    if (running === 0) return t("Sub-agents are on, show the panel");
    return running === 1
      ? t("Sub-agents are on, 1 sub-agent working, show or hide the panel")
      : t("Sub-agents are on, %d sub-agents working, show or hide the panel", String(running));
  };

  return (
    <span className="hydra-mark-root" ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className={`hydra-mark${isOn ? "" : " off"}${isChimera ? " chimera" : ""}`}
        data-subagent-mode={isOn ? subagentMode : "off"}
        title={markTitle()}
        aria-label={ariaLabel()}
        aria-expanded={hasHeads ? !props.panelHidden : pop !== null}
        disabled={props.readOnly === true}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!props.readOnly) openPop("switch");
        }}
      >
        {isChimera ? (
          <span className="chimera-mark" aria-hidden="true">
            <ChimeraMarkSvg />
          </span>
        ) : (
          <span className="hydra-mark-dots" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="hydra-dot"
                style={{ background: hex(personaAt(i).hex) }}
              />
            ))}
          </span>
        )}
        {running > 0 && <span className="hydra-mark-badge">{running}</span>}
      </button>
      {pop === "intro" && pos && (
        <div className="hydra-mark-pop hydra-intro-pop" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label={t("Meet Hydra")}>
          <div className="hi-head">
            <span className="hi-glyphs" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="hydra-dot" style={{ background: hex(personaAt(i).hex) }} />
              ))}
            </span>
            <div>
              <div className="hi-title">{t("Meet Hydra")}</div>
              <div className="hi-sub">
                {t("Hydra is on. Big jobs go out to a team of heads, so this chat leads instead of doing everything itself.")}
              </div>
            </div>
          </div>
          <div className="hi-step">
            <span className="hi-step-glyph" aria-hidden="true">
              {[0, 1].map((i) => (
                <span key={i} className="hydra-dot" style={{ background: hex(personaAt(i).hex) }} />
              ))}
            </span>
            <div>
              <div className="hi-step-title">{t("You ask, the chat leads")}</div>
              <div className="hi-step-line">{t("Ask as you always do. Small things it does itself; anything bigger it splits into briefs.")}</div>
            </div>
          </div>
          <div className="hi-step">
            <span className="hi-step-glyph" aria-hidden="true">
              {[0, 1].map((i) => (
                <span key={i} className="hydra-dot" style={{ background: hex(personaAt(i).hex) }} />
              ))}
            </span>
            <div>
              <div className="hi-step-title">{t("Heads go out in parallel")}</div>
              <div className="hi-step-line">{t("Each head gets one brief and a panel of its own beside the chat. Hank, Walter, Ada and the rest work at the same time.")}</div>
            </div>
          </div>
          <div className="hi-step">
            <span className="hi-step-glyph ok" aria-hidden="true">✓</span>
            <div>
              <div className="hi-step-title">{t("Reports come back, the lead finishes")}</div>
              <div className="hi-step-line">{t("The lead checks their work, fixes what needs fixing and answers you. Their changes land as one merge.")}</div>
            </div>
          </div>
          <div className="hi-pairs">
            <div className="hi-step-title">{t("Pairs")}</div>
            <div className="hi-pairs-line">
              {t("A pair says which model leads and which model, or which provider, runs the heads. Without one, the heads run on this chat's model at a working effort. Pairs live in the model picker and in Settings › Hydra.")}
            </div>
          </div>
          <div className="hi-hint">{t("Right-click the mark to switch Hydra off or on per chat.")}</div>
          <div className="hi-actions">
            <button
              type="button"
              className="hi-btn"
              onClick={() => {
                seen();
                props.onOpenSettings?.("hydra");
              }}
            >
              {t("Set up in Settings")}
            </button>
            <button type="button" className="hi-btn primary" onClick={seen}>
              {t("Got it")}
            </button>
          </div>
        </div>
      )}
      {pop === "idle" && pos && (
        <div
          className="hydra-mark-pop hydra-idle-pop"
          style={{ top: pos.top, left: pos.left }}
          role="dialog"
          aria-label={isChimera ? t("Sub-agents") : t("Hydra")}
        >
          {isChimera ? (
            <>
              <div className="hmi-title">{t("Sub-agents are on")}</div>
              <div className="hmi-note">{t("Adaptive sub-agents")}</div>
              <div className="hmi-sep" />
              <div className="hmi-note">
                {t("No sub-agents are out yet. Send a request and the lead will decide what to do itself and what to delegate. Each sub-agent gets a panel of its own.")}
              </div>
              <div className="hmi-sep" />
              <div className="hmi-note dim">
                {t("Right-click the sub-agent button to switch sub-agents off for this chat.")}
              </div>
            </>
          ) : (
            <>
              <div className="hmi-title">{t("Hydra is on")}</div>
              <div className="hmi-note">{t("Heads run on this chat's model and effort.")}</div>
              <div className="hmi-sep" />
              <div className="hmi-note">
                {t("No heads are out yet. Ask for something big enough to split up and this chat sends them out, each with a panel of its own.")}
              </div>
              <div className="hmi-sep" />
              <div className="hmi-note dim">{t("Right-click the mark to switch Hydra off for this chat.")}</div>
            </>
          )}
        </div>
      )}
      {pop === "switch" && pos && (
        <div className="hydra-mark-pop hydra-switch-pop" style={{ top: pos.top, left: pos.left }} role="menu">
          {!globalOn ? (
            <>
              <div className="hmi-title">
                {useSubagentCopy ? t("Sub-agents are off in Settings") : t("Hydra is off in Settings")}
              </div>
              <button type="button" className="hmi-item" onClick={() => flip(true)}>
                {useSubagentCopy ? t("Turn sub-agents on") : t("Turn Hydra on")}
              </button>
            </>
          ) : (
            <>
              <div className="hmi-title">
                {useSubagentCopy
                  ? isOn
                    ? t("Sub-agents are on for this chat")
                    : t("Sub-agents are off for this chat")
                  : isOn
                    ? t("Hydra is on for this chat")
                    : t("Hydra is off for this chat")}
              </div>
              <button type="button" className="hmi-item" onClick={() => flip(true)}>
                <span className="hmi-check" aria-hidden="true">{isOn ? "✓" : ""}</span>
                {useSubagentCopy ? t("Turn sub-agents on for this chat") : t("Turn Hydra on for this chat")}
              </button>
              <button type="button" className="hmi-item" onClick={() => flip(false)}>
                <span className="hmi-check" aria-hidden="true">{!isOn ? "✓" : ""}</span>
                {useSubagentCopy ? t("Turn sub-agents off for this chat") : t("Turn Hydra off for this chat")}
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
