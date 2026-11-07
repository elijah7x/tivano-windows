// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F21/F22: the Hydra mark in the chat header — frozen HydraButton
// parity, bounded. Click: the read-once intro first (until it has been
// seen), then — no heads — an explainer note, otherwise the heads panel
// toggle. Right-click (or control-click) opens the per-chat switch. The
// mark itself dims while Hydra is off for the app or this chat.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { personaAt } from "../../shared/hydraDelegation";
import type { ChatThread } from "../../shared/types";
import { callApi, clientStore } from "../client";
import { useT } from "../locale";

type Pop = "intro" | "idle" | "switch";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

export function HydraMark(props: {
  thread: ChatThread;
  /** The lead's resolved heads (empty for head threads and quiet leads). */
  heads: ChatThread[];
  readOnly?: boolean;
  /** Frozen runtime.isHydraPanelHidden — the mark's click toggles it. */
  panelHidden: boolean;
  onTogglePanel: () => void;
  onOpenSettings?: () => void;
}): React.JSX.Element {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const settings = clientStore.snapshot?.settings;
  const seenIntro = settings?.hasSeenHydraIntro === true;
  const globalOn = settings?.hydraEnabled !== false;
  const isOn = globalOn && props.thread.hydraEnabled !== false;
  const running = props.heads.filter((h) => h.hydraHead?.status === "running").length;

  // Frozen: the first chat's Hydra intro opens by itself until read.
  const introArmed = useRef(false);
  useEffect(() => {
    if (introArmed.current) return;
    if (!seenIntro && isOn && !props.readOnly) {
      introArmed.current = true;
      requestAnimationFrame(() => openPop("intro"));
    }
  }, [seenIntro, isOn, props.readOnly]);

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
    if (props.readOnly) return;
    if (!seenIntro) return openPop("intro");
    if (props.heads.length === 0) return openPop("idle");
    props.onTogglePanel();
  };

  const markTitle = (): string => {
    if (!isOn) return t("Hydra is on in Settings");
    const parts = [t("Hydra is on")];
    parts.push(t("Heads run on this chat's model"));
    if (running > 0)
      parts.push(running === 1 ? t("1 head working") : t("%d heads working", String(running)));
    if (props.heads.length === 0) parts.push(t("No heads out yet"));
    else parts.push(props.panelHidden ? t("Show the panel") : t("Hide the panel"));
    return parts.join(" · ");
  };

  return (
    <span className="hydra-mark-root" ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className={`hydra-mark${isOn ? "" : " off"}`}
        title={markTitle()}
        aria-label={t("Hydra")}
        aria-pressed={isOn}
        disabled={props.readOnly === true}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!props.readOnly) openPop("switch");
        }}
      >
        <span className="hydra-mark-dots" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="hydra-dot"
              style={{ background: hex(personaAt(i).hex) }}
            />
          ))}
        </span>
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
                props.onOpenSettings?.();
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
        <div className="hydra-mark-pop hydra-idle-pop" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label={t("Hydra")}>
          <div className="hmi-title">{t("Hydra is on")}</div>
          <div className="hmi-note">{t("Heads run on this chat's model and effort.")}</div>
          <div className="hmi-sep" />
          <div className="hmi-note">
            {t("No heads are out yet. Ask for something big enough to split up and this chat sends them out, each with a panel of its own.")}
          </div>
          <div className="hmi-sep" />
          <div className="hmi-note dim">{t("Right-click the mark to switch Hydra off for this chat.")}</div>
        </div>
      )}
      {pop === "switch" && pos && (
        <div className="hydra-mark-pop hydra-switch-pop" style={{ top: pos.top, left: pos.left }} role="menu">
          {!globalOn ? (
            <>
              <div className="hmi-title">{t("Hydra is off in Settings")}</div>
              <button type="button" className="hmi-item" onClick={() => flip(true)}>
                {t("Turn Hydra on")}
              </button>
            </>
          ) : (
            <>
              <div className="hmi-title">
                {isOn ? t("Hydra is on for this chat") : t("Hydra is off for this chat")}
              </div>
              <button type="button" className="hmi-item" onClick={() => flip(true)}>
                <span className="hmi-check" aria-hidden="true">{isOn ? "✓" : ""}</span>
                {t("Turn Hydra on for this chat")}
              </button>
              <button type="button" className="hmi-item" onClick={() => flip(false)}>
                <span className="hmi-check" aria-hidden="true">{!isOn ? "✓" : ""}</span>
                {t("Turn Hydra off for this chat")}
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
