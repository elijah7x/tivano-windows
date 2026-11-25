// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// P2-47 — v3.0.0 Weather window (PortholeWeatherView.swift, SidebarPorthole.swift,
// GlobalWeatherLayer.swift, WeatherCanvas.swift, WeatherWindowThumbnail.swift):
//   - Skylight (Porthole): non-interactive 64px ink scene above the thread list.
//     Sky follows time of day (dawn/day/dusk/night); wind blows when a chat or
//     sub-agent waits on you, sunlight/full moon shines on finish, rain falls on
//     failure; pauses when out of view, app inactive/covered or reduced motion.
//   - WeatherWindowLayer (Full window): subtle window-wide wind/sun/rain pulse.
//   - WeatherWindowThumbnail: miniature window preview for Settings > Appearance.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { ChatThread, Project, WeatherWindowMode } from "../../shared/types";
import {
  FULL_WINDOW_PULSE_MS,
  FULL_WINDOW_RELEASE_MS,
  PORTHOLE_HOLD_MS,
  comparePortholeStrength,
  portholeWeatherFromSnapshot,
  resolveGlobalWeatherSnapshot,
  resolveSkyPeriod,
  shouldStartPortholeHold,
  type HeroWeather,
  type SkyPeriod,
  type WeatherKind,
} from "../../shared/skylight";
import { useAppPaused, useInView } from "../appActivity";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    if (typeof mq.addEventListener !== "function") return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function PortholeScene(props: {
  kind: WeatherKind;
  sky: SkyPeriod;
  paused: boolean;
  count: number;
}): React.JSX.Element {
  const { kind, sky, paused } = props;
  const isNight = sky === "night";
  const isWind = kind === "awaiting";
  const isDone = kind === "done";
  const isFailed = kind === "failed";
  const sway = isWind && !paused;
  const rainPlanes = isFailed ? Math.min(4, 2 + Math.max(0, props.count - 1)) : 0;

  return (
    <svg
      className="porthole-art"
      viewBox="0 0 260 64"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {/* Distant hills hairline ridge */}
      <path
        className="ph-hills"
        d="M0 49 Q34 42 68 46 T140 44 Q188 41 260 48"
      />

      {/* Horizon ruler + edge ticks */}
      <line className="ph-horizon" x1="8" y1="53" x2="252" y2="53" />
      <g className="ph-ticks">
        <line x1="28" y1="53" x2="28" y2="55" />
        <line x1="64" y1="53" x2="64" y2="55" />
        <line x1="100" y1="53" x2="100" y2="55" />
        <line x1="148" y1="53" x2="148" y2="55" />
        <line x1="224" y1="53" x2="224" y2="55" />
      </g>

      {/* Night sky: stars, crescent/full moon & warm lit cottage window */}
      {isNight && (
        <g className="ph-night">
          <g className={`ph-stars${isDone ? " boost" : ""}`}>
            <path d="M44 13 v3 M42.5 14.5 h3" />
            <path d="M74 22 v2.5 M72.75 23.25 h2.5" />
            <path d="M114 11.5 v3.5 M112.25 13.25 h3.5" />
            <path d="M135 21 v2.5 M133.75 22.25 h2.5" />
            <path d="M154 13 v3.5 M152.25 14.75 h3.5" />
            <path d="M208 14 v3 M206.5 15.5 h3" />
          </g>
          {isDone ? (
            <circle className="ph-full-moon" cx="220" cy="17" r="6.2" />
          ) : (
            <path
              className="ph-moon"
              d="M222 11.5 a6 6 0 1 0 4.5 9.8 a4.8 4.8 0 1 1 -4.5 -9.8 Z"
            />
          )}
        </g>
      )}

      {/* Daylight/twilight sun on finish */}
      {!isNight && isDone && (
        <g className="ph-sun">
          <circle className="ph-sun-disc" cx="222" cy="16" r="5.5" />
          <g className="ph-sun-rays">
            <line x1="222" y1="6.5" x2="222" y2="8.8" />
            <line x1="222" y1="23.2" x2="222" y2="25.5" />
            <line x1="212.5" y1="16" x2="214.8" y2="16" />
            <line x1="229.2" y1="16" x2="231.5" y2="16" />
            <line x1="215.2" y1="9.2" x2="216.9" y2="10.9" />
            <line x1="227.1" y1="21.1" x2="228.8" y2="22.8" />
            <line x1="228.8" y1="9.2" x2="227.1" y2="10.9" />
            <line x1="216.9" y1="21.1" x2="215.2" y2="22.8" />
          </g>
        </g>
      )}

      {/* Drifting line-art clouds */}
      <g className={`ph-clouds${isWind ? " brisk" : ""}`}>
        <path
          className="ph-cloud-far"
          d="M36 22 q4 -5 9 -3 q5 -4 10 0 q4 0 5 3 Z"
        />
        <path
          className="ph-cloud-near"
          d="M104 28 q5 -6 11 -3 q6 -5 13 0 q5 0 6 3 Z"
        />
      </g>

      {/* Cottage rooftop + chimney smoke + night window pinpoint */}
      <g className="ph-cottage">
        <path
          className="ph-rooftop"
          d="M22 53 L38 43 L56 53 M47 47 V41 H51 V49.5"
        />
        {isNight && (
          <rect
            className="ph-lit-window"
            x="36.5"
            y="48.5"
            width="3"
            height="2.6"
            rx="0.5"
          />
        )}
        <g className={`ph-smoke${isWind ? " wind" : ""}`}>
          <path d="M49 39.5 q2 -3 0.5 -5.5 q-1.5 -2.5 1.5 -5" />
          <path d="M51 39.5 q3 -2.5 2 -5" />
        </g>
      </g>

      {/* Telegraph poles, wire & perched birds */}
      <path
        className="ph-poles"
        d="M84 53 V33 M81 36 H87 M148 53 V36 M145.5 38.5 H150.5"
      />
      <path
        className="ph-wire"
        d={
          isWind
            ? "M84 35 Q116 40 148 37.5"
            : "M84 35 Q116 43 148 37.5"
        }
      />
      <g className="ph-birds">
        <path d="M107 39.2 q1.5 -1.8 3 0" />
        <path d="M114 39.8 q1.3 -1.6 2.6 0" />
      </g>

      {/* Breeze wind streaks & botanical leaf (.awaiting) */}
      {isWind && (
        <g className="ph-breeze">
          <path className="ph-wind-1" d="M14 16 C36 13 62 19 88 15 M94 15 H108" />
          <path className="ph-wind-2" d="M26 26 C52 29 82 22 114 26" />
          <path className="ph-wind-3" d="M54 35 C80 32 108 38 136 34" />
          <path
            className="ph-leaf"
            d="M128 21 q5 -3 8 0 q-3 4 -8 0 Z"
          />
        </g>
      )}

      {/* Rain planes & sill ripples (.failed) */}
      {isFailed && (
        <g className="ph-rain">
          <g className="ph-rain-far">
            <line x1="34" y1="10" x2="29" y2="24" />
            <line x1="78" y1="14" x2="73" y2="28" />
            <line x1="126" y1="8" x2="121" y2="22" />
            <line x1="168" y1="12" x2="163" y2="26" />
            {rainPlanes >= 3 && <line x1="214" y1="10" x2="209" y2="24" />}
          </g>
          <g className="ph-rain-near">
            <line x1="56" y1="18" x2="50" y2="36" />
            <line x1="102" y1="22" x2="96" y2="40" />
            <line x1="150" y1="16" x2="144" y2="34" />
            {rainPlanes >= 4 && <line x1="234" y1="20" x2="228" y2="38" />}
          </g>
          <g className="ph-ripples">
            <ellipse cx="64" cy="54" rx="4.5" ry="0.9" />
            <ellipse cx="132" cy="54.2" rx="5.5" ry="1.0" />
            <ellipse cx="206" cy="53.8" rx="4.2" ry="0.85" />
          </g>
        </g>
      )}

      {/* Hanging teru-teru-bōzu doll on the right */}
      <g className={`ph-doll${sway ? " sway" : ""}${isFailed ? " dim" : ""}`}>
        <line
          className="ph-doll-string"
          x1="182"
          y1="0"
          x2={isWind ? "185" : "182"}
          y2="13"
        />
        <circle
          className="ph-doll-head"
          cx={isWind ? "185" : "182"}
          cy="19"
          r="6.2"
        />
        <line
          className="ph-doll-tie"
          x1={isWind ? "181" : "178"}
          y1="24.5"
          x2={isWind ? "189" : "186"}
          y2="24.5"
        />
        <path
          className="ph-doll-cloth"
          d={
            isWind
              ? "M181 25 Q185 26 189 25 L196 41 Q188 44 179 40 Z"
              : isDone
                ? "M178 25 Q182 26 186 25 L190 42 Q182 45 174 42 Z"
                : "M178 25 Q182 26 186 25 L188 42 Q182 44.5 176 42 Z"
          }
        />
      </g>
    </svg>
  );
}

/**
 * P2-47 Porthole (replaces interactive v2 Skylight card): non-interactive ink
 * scene above the thread list whose sky follows the time of day, brings wind
 * while a chat or sub-agent waits on you, sunlight on finish, rain on failure,
 * and pauses when out of view or inactive.
 */
export function Skylight(props: {
  threads: ChatThread[];
  projects?: Project[] | undefined;
  clockOverride?: Date | undefined;
  /** Retained optional so legacy test callers compile; porthole is non-interactive. */
  onNewThread?: (() => void) | undefined;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const appPaused = useAppPaused();
  const inView = useInView(rootRef);
  const reduceMotion = usePrefersReducedMotion();
  const paused = appPaused || !inView || reduceMotion;

  const [sky, setSky] = useState<SkyPeriod>(() =>
    resolveSkyPeriod(props.clockOverride ?? new Date()),
  );

  useEffect(() => {
    if (props.clockOverride) {
      setSky(resolveSkyPeriod(props.clockOverride));
      return;
    }
    setSky(resolveSkyPeriod(new Date()));
    if (paused) return;
    const id = window.setInterval(() => {
      setSky(resolveSkyPeriod(new Date()));
    }, 60_000);
    return () => window.clearInterval(id);
  }, [props.clockOverride, paused]);

  const snapshot = resolveGlobalWeatherSnapshot(props.threads, props.projects);
  const live = portholeWeatherFromSnapshot(snapshot);

  const [held, setHeld] = useState<{ weather: HeroWeather; deadline: number } | null>(null);
  const lastLiveRef = useRef<HeroWeather>(live);
  const holdTimerRef = useRef<number | null>(null);
  const seededRef = useRef(false);

  const clearHold = () => {
    if (holdTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(holdTimerRef.current);
    }
    holdTimerRef.current = null;
    setHeld(null);
  };

  useEffect(() => () => clearHold(), []);

  useEffect(() => {
    const currentLive: HeroWeather = { kind: live.kind, count: live.count };
    if (!seededRef.current) {
      seededRef.current = true;
      lastLiveRef.current = currentLive;
      return;
    }

    const previous = lastLiveRef.current;
    lastLiveRef.current = currentLive;

    if (currentLive.kind === "awaiting") {
      clearHold();
      return;
    }

    const now = Date.now();
    const isHolding = held !== null && now < held.deadline;

    if (shouldStartPortholeHold(previous, currentLive)) {
      if (!isHolding || comparePortholeStrength(currentLive, held.weather) >= 0) {
        if (holdTimerRef.current !== null && typeof window !== "undefined") {
          window.clearTimeout(holdTimerRef.current);
        }
        const deadline = now + PORTHOLE_HOLD_MS;
        setHeld({ weather: currentLive, deadline });
        if (typeof window !== "undefined") {
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            setHeld((cur) => (cur?.deadline === deadline ? null : cur));
          }, PORTHOLE_HOLD_MS);
        }
      }
    } else if (!isHolding && held !== null) {
      clearHold();
    }
  }, [live.kind, live.count]);

  const shown: HeroWeather =
    live.kind === "awaiting"
      ? live
      : held !== null &&
          Date.now() < held.deadline &&
          comparePortholeStrength(live, held.weather) < 0
        ? held.weather
        : live;

  return (
    <div
      ref={rootRef}
      className={`skylight w-${shown.kind} sky-${sky}${paused ? " paused" : ""}`}
      aria-hidden="true"
      data-weather={shown.kind}
      data-sky={sky}
      data-paused={paused ? "true" : "false"}
      data-count={shown.count}
    >
      <PortholeScene
        kind={shown.kind}
        sky={sky}
        paused={paused}
        count={shown.count}
      />
    </div>
  );
}

/**
 * P2-47 Full window weather overlay (frozen GlobalWeatherLayer + WeatherCanvas):
 * non-interactive window-wide subtle wind/sun/rain pulse when mode === "full".
 */
export function WeatherWindowLayer(props: {
  threads: ChatThread[];
  projects?: Project[] | undefined;
  backdropOpacity?: number | undefined;
  holdsSteady?: boolean | undefined;
}): React.JSX.Element | null {
  const appPaused = useAppPaused();
  const reduceMotion = usePrefersReducedMotion();
  const paused = appPaused || reduceMotion;

  const snapshot = resolveGlobalWeatherSnapshot(props.threads, props.projects);
  const live: HeroWeather = { kind: snapshot.kind, count: snapshot.count };

  const liveKey = live.kind === "idle" ? "idle" : `${live.kind}:${live.count}`;
  const [pulseState, setPulseState] = useState<{
    key: string;
    kind: WeatherKind;
    count: number;
    releasing: boolean;
    expired: boolean;
  } | null>(null);

  const prevLiveRef = useRef<HeroWeather>(live);
  const timerRef = useRef<number | null>(null);
  const pulseTokenRef = useRef(0);

  const clearTimer = () => {
    pulseTokenRef.current++;
    if (timerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = null;
  };

  useEffect(() => () => clearTimer(), []);

  useEffect(() => {
    if (paused) {
      clearTimer();
      setPulseState(null);
      prevLiveRef.current = live;
      return;
    }

    if (props.holdsSteady) {
      clearTimer();
      setPulseState(
        live.kind === "idle"
          ? null
          : { key: liveKey, kind: live.kind, count: live.count, releasing: false, expired: false },
      );
      prevLiveRef.current = live;
      return;
    }

    const old = prevLiveRef.current;
    prevLiveRef.current = live;

    if (live.kind === "idle") {
      if (snapshot.hasRunningWork) {
        clearTimer();
        setPulseState(null);
      } else if (old.kind === "awaiting" && pulseState && !pulseState.expired) {
        const token = ++pulseTokenRef.current;
        if (timerRef.current !== null && typeof window !== "undefined") {
          window.clearTimeout(timerRef.current);
        }
        setPulseState({ ...pulseState, releasing: true });
        if (typeof window !== "undefined") {
          timerRef.current = window.setTimeout(() => {
            if (pulseTokenRef.current === token) {
              setPulseState(null);
            }
          }, FULL_WINDOW_RELEASE_MS);
        }
      } else {
        clearTimer();
        setPulseState(null);
      }
      return;
    }

    if (pulseState?.key === liveKey) return;

    const token = ++pulseTokenRef.current;
    if (timerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(timerRef.current);
    }
    setPulseState({
      key: liveKey,
      kind: live.kind,
      count: live.count,
      releasing: false,
      expired: false,
    });
    if (typeof window !== "undefined") {
      timerRef.current = window.setTimeout(() => {
        if (pulseTokenRef.current === token) {
          setPulseState((cur) =>
            cur && cur.key === liveKey ? { ...cur, releasing: false, expired: true } : cur,
          );
        }
      }, FULL_WINDOW_PULSE_MS);
    }
  }, [liveKey, live.kind, live.count, snapshot.hasRunningWork, paused, props.holdsSteady]);

  const displayed = (() => {
    if (paused) return null;
    if (props.holdsSteady) {
      return live.kind === "idle"
        ? null
        : { kind: live.kind, count: live.count, releasing: false };
    }
    if (live.kind !== "idle") {
      if (pulseState?.key === liveKey && pulseState.expired) return null;
      return {
        kind: live.kind,
        count: live.count,
        releasing: pulseState?.key === liveKey ? pulseState.releasing : false,
      };
    }
    if (pulseState && pulseState.releasing && !snapshot.hasRunningWork) {
      return { kind: pulseState.kind, count: pulseState.count, releasing: true };
    }
    return null;
  })();

  if (!displayed || displayed.kind === "idle") return null;

  return (
    <div
      className={`weather-window-layer w-${displayed.kind}${displayed.releasing ? " releasing" : ""}`}
      aria-hidden="true"
      data-weather={displayed.kind}
      data-paused={paused ? "true" : "false"}
      data-count={displayed.count}
      style={
        props.backdropOpacity !== undefined
          ? ({ "--ww-boost": String(1 + 0.4 * (1 - Math.min(1, Math.max(0, props.backdropOpacity / 0.55)))) } as React.CSSProperties)
          : undefined
      }
    >
      {displayed.kind === "awaiting" && (
        <svg className="ww-svg" viewBox="0 0 800 500" preserveAspectRatio="none">
          <path className="ww-wind ww-w1" d="M-80 110 C120 90 340 130 880 100" />
          <path className="ww-wind ww-w2" d="M-120 220 C160 245 420 195 880 225" />
          <path className="ww-wind ww-w3" d="M-60 350 C190 330 480 375 880 340" />
        </svg>
      )}
      {displayed.kind === "done" && (
        <svg className="ww-svg" viewBox="0 0 800 500" preserveAspectRatio="xMaxYMin slice">
          <radialGradient id="ww-sun-grad" cx="92%" cy="6%" r="58%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="55%" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
          <rect className="ww-sun-wash" x="0" y="0" width="800" height="500" fill="url(#ww-sun-grad)" />
          <line className="ww-ray" x1="740" y1="20" x2="520" y2="210" />
          <line className="ww-ray" x1="760" y1="40" x2="610" y2="300" />
          <line className="ww-ray" x1="720" y1="15" x2="430" y2="120" />
        </svg>
      )}
      {displayed.kind === "failed" && (
        <svg className="ww-svg" viewBox="0 0 800 500" preserveAspectRatio="none">
          <g className="ww-rain-streaks">
            <line x1="120" y1="40" x2="90" y2="120" />
            <line x1="270" y1="90" x2="240" y2="170" />
            <line x1="430" y1="30" x2="400" y2="110" />
            <line x1="590" y1="110" x2="560" y2="190" />
            <line x1="710" y1="60" x2="680" y2="140" />
            <line x1="200" y1="240" x2="170" y2="320" />
            <line x1="510" y1="270" x2="480" y2="350" />
          </g>
        </svg>
      )}
    </div>
  );
}

/**
 * Miniature window preview inside Settings > Appearance > Weather window
 * (frozen WeatherWindowThumbnail.swift).
 */
export function WeatherWindowThumbnail(props: {
  mode: WeatherWindowMode;
}): React.JSX.Element {
  return (
    <svg
      className="weather-thumb"
      width="60"
      height="38"
      viewBox="0 0 60 38"
      aria-hidden="true"
      focusable="false"
    >
      {props.mode === "full" && (
        <g className="wt-full">
          <path d="M55.9 6.9 a2.5 2.5 0 1 1 -4.0 -2.4" />
          <line x1="49.5" y1="6.5" x2="47.8" y2="6.5" />
          <line x1="50.7" y1="9.3" x2="49.5" y2="10.5" />
          <line x1="53.5" y1="10.5" x2="53.5" y2="12.2" />
          <line x1="8.0" y1="7.5" x2="6.2" y2="12.3" />
          <line x1="17.5" y1="11.5" x2="15.7" y2="16.3" />
          <line x1="11.5" y1="22.0" x2="9.7" y2="26.8" />
          <line x1="29.5" y1="6.5" x2="27.7" y2="11.3" />
          <line x1="39.5" y1="10.5" x2="37.7" y2="15.3" />
          <line x1="32.5" y1="25.5" x2="30.7" y2="30.3" />
          <line x1="49.5" y1="21.5" x2="47.7" y2="26.3" />
        </g>
      )}
      <g className="wt-base">
        <rect x="0.5" y="0.5" width="59" height="37" rx="5" />
        <line x1="22.5" y1="1" x2="22.5" y2="37" strokeWidth="0.75" />
        <circle cx="4.5" cy="4.0" r="0.8" />
        <circle cx="7.5" cy="4.0" r="0.8" />
        <circle cx="10.5" cy="4.0" r="0.8" />
        <line x1="3.5" y1="19.5" x2="16.5" y2="19.5" />
        <line x1="3.5" y1="23.5" x2="13.5" y2="23.5" />
        <line x1="3.5" y1="27.5" x2="18.5" y2="27.5" />
        <line x1="3.5" y1="31.5" x2="14.5" y2="31.5" />
        <line x1="27.5" y1="13.5" x2="50.5" y2="13.5" />
        <line x1="27.5" y1="18.5" x2="46.5" y2="18.5" />
        <line x1="27.5" y1="23.5" x2="41.5" y2="23.5" />
      </g>
      {props.mode === "porthole" && (
        <g className="wt-porthole">
          <rect x="2.5" y="6.5" width="18" height="9" rx="2.5" strokeWidth="0.75" />
          <line x1="3.5" y1="13.5" x2="19.5" y2="13.5" strokeWidth="0.75" />
          <path d="M4.8 10.8 Q5.4 8.7 8.0 9.5 Q10.3 8.4 11.2 10.8" strokeWidth="0.75" />
          <circle className="wt-fill" cx="15.8" cy="9.0" r="1.3" />
          <path className="wt-fill" d="M15.8 10.1 L17.5 12.9 L14.1 12.9 Z" />
        </g>
      )}
    </svg>
  );
}
