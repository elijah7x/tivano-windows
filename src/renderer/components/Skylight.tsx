// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// A84 F26 — the sidebar's skylight hero (frozen SidebarHero +
// HeroWeatherCard): every visible thread folds into one weather and the
// card creates a new thread on activation. The frozen build draws a
// teru-teru-bōzu scene in CoreAnimation; this port keeps the weather
// fold, the tag and the affordance, and renders a simplified SVG scene —
// honest simplification, noted in the ledger.

import type React from "react";
import { useMemo } from "react";
import type { ChatThread } from "../../shared/types";
import {
  heroWeatherTag,
  resolveHeroWeather,
  threadActivityStatus,
} from "../../shared/skylight";
import { useT } from "../locale";

/** The doll and its weather — one small SVG, variant strokes per state. */
function SkyScene({ kind }: { kind: string }): React.JSX.Element {
  return (
    <svg className="sky-art" viewBox="0 0 72 60" aria-hidden="true" focusable="false">
      {/* hanging thread */}
      <line className="sky-thread" x1="24" y1="0" x2="24" y2="12" />
      {/* teru-teru-bōzu doll */}
      <g className={`sky-doll${kind === "running" ? " sway" : ""}`}>
        <circle className="sky-doll-head" cx="24" cy="20" r="8" />
        <path className="sky-doll-body" d="M16 26 Q24 28 32 26 L34 44 Q24 48 14 44 Z" />
      </g>
      {/* weather marks */}
      {kind === "awaiting" && (
        <g className="sky-w awaiting">
          <ellipse className="sky-cloud" cx="50" cy="16" rx="13" ry="6" />
          <ellipse className="sky-cloud" cx="44" cy="12" rx="8" ry="5" />
        </g>
      )}
      {kind === "failed" && (
        <g className="sky-w failed">
          <ellipse className="sky-cloud" cx="50" cy="14" rx="13" ry="6" />
          <ellipse className="sky-cloud" cx="44" cy="10" rx="8" ry="5" />
          <line className="sky-rain" x1="44" y1="24" x2="42" y2="32" />
          <line className="sky-rain" x1="52" y1="24" x2="50" y2="32" />
          <line className="sky-rain" x1="60" y1="24" x2="58" y2="32" />
        </g>
      )}
      {kind === "running" && (
        <g className="sky-w running">
          <path className="sky-wind" d="M44 26 q8 -4 14 0 q6 4 12 0" />
          <path className="sky-wind" d="M48 36 q7 -3 12 0 q5 3 10 0" />
        </g>
      )}
      {kind === "done" && (
        <g className="sky-w done">
          <circle className="sky-sun" cx="52" cy="16" r="7" />
          <g className="sky-rays">
            <line x1="52" y1="4" x2="52" y2="7" />
            <line x1="52" y1="25" x2="52" y2="28" />
            <line x1="40" y1="16" x2="43" y2="16" />
            <line x1="61" y1="16" x2="64" y2="16" />
            <line x1="44" y1="8" x2="46" y2="10" />
            <line x1="58" y1="22" x2="60" y2="24" />
            <line x1="60" y1="8" x2="58" y2="10" />
            <line x1="46" y1="22" x2="44" y2="24" />
          </g>
        </g>
      )}
      {kind === "idle" && (
        <g className="sky-w idle">
          <circle className="sky-dot" cx="52" cy="18" r="2" />
          <circle className="sky-dot" cx="60" cy="26" r="1.6" />
          <circle className="sky-dot" cx="46" cy="28" r="1.4" />
        </g>
      )}
    </svg>
  );
}

export function Skylight(props: {
  threads: ChatThread[];
  onNewThread: () => void;
}): React.JSX.Element {
  const t = useT();
  const weather = useMemo(() => {
    // Frozen SidebarHero.weather: helpers running under a parent count the
    // parent as working (workingParents); heads never enter the fold.
    const working = new Set<string>();
    for (const th of props.threads) {
      if (
        th.parentThreadId &&
        (th.turn?.status === "running" || th.turn?.status === "waiting-approval")
      )
        working.add(th.parentThreadId);
    }
    return resolveHeroWeather(
      props.threads
        .filter((th) => !th.isArchived && !th.hydraHead)
        .map((th) =>
          working.has(th.id) && th.turn?.status !== "running"
            ? "running"
            : threadActivityStatus(th),
        ),
    );
  }, [props.threads]);
  const tag = heroWeatherTag(weather);
  return (
    <button
      type="button"
      className={`skylight w-${weather.kind}`}
      title={t("Skylight — start a new thread")}
      aria-label={t("Skylight — start a new thread")}
      onClick={props.onNewThread}
    >
      <SkyScene kind={weather.kind} />
      {tag !== null && <span className="sky-tag">{tag}</span>}
    </button>
  );
}
