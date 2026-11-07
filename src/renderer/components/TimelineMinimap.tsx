// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F03 conversation outline (frozen TimelineMinimap port): one tick per
// message the USER sent — prompts, follow-ups, attachments. Replies,
// tool runs and notices never get ticks. The rail floats over the
// timeline's leading gutter (it takes no layout space), shows only when
// at least two user messages exist, previews title+snippet on hover,
// and jumps the timeline to the message on tap or drag-scrub. The lit
// tick follows the reader's scroll position like the frozen tracking
// does. Pointer input is confined to the tick cluster, mirroring the
// frozen hitRect — the column above and below stays clear.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../../shared/types";
import { useT } from "../locale";

export interface MinimapEntry {
  id: string;
  title: string;
  snippet: string;
  /** 0.15…1 — drives tick width (frozen: len/420 clamped). */
  weight: number;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif|svg)$/i;

// Frozen MinimapRailMetrics geometry.
const TICK_BAR = 2; // painted bar height
const TICK_PAD = 8; // vertical hit padding around the bar (4+4)
const TICK_OUTER = TICK_BAR + TICK_PAD; // 10
const GAP_ROOMY = 8;
const GAP_TIGHT = 2;
const CLUSTER_PAD_V = 6; // reaches ~half a pitch past the first/last tick

function firstWords(text: string, limit: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const head = words.slice(0, limit).join(" ");
  return words.length > limit ? `${head}…` : head;
}

function preview(text: string, limit = 160): string {
  const flat = text.split(/\s+/).join(" ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Frozen `TimelineMinimap.entries(for:)` — user messages only. */
export function minimapEntries(
  messages: Message[],
  label: { oneImage: string; images: (n: number) => string; fallback: string },
): MinimapEntry[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const images = (m.attachments ?? []).filter((a) => IMAGE_RE.test(a.name)).length;
      const title =
        firstWords(m.content, 8) ||
        (images === 1
          ? label.oneImage
          : images > 1
            ? label.images(images)
            : (m.attachments?.[0]?.name ?? label.fallback));
      const snippet = preview(m.content);
      return {
        id: m.id,
        title,
        snippet: snippet === title ? "" : snippet,
        weight: Math.min(1, Math.max(0.15, m.content.length / 420)),
      };
    });
}

/** Frozen estimatedCardHeight — clamp the card without a measure loop. */
function estCardHalf(e: MinimapEntry, cardWidth: number): number {
  const title = 17;
  const pad = 20;
  if (!e.snippet) return (title + pad) / 2;
  const glyphsPerLine = Math.max(1, Math.floor((cardWidth - 24) / 7));
  const lines = Math.min(3, Math.max(1, Math.ceil(e.snippet.length / glyphsPerLine)));
  return (title + 3 + lines * 15 + pad) / 2;
}

const CARD_WIDTH = 240;

export function TimelineMinimap(props: {
  messages: Message[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element | null {
  const t = useT();
  const railRef = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pressing, setPressing] = useState(false);
  const [cardTop, setCardTop] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [railH, setRailH] = useState(0);

  const entries = useMemo(
    () =>
      minimapEntries(props.messages, {
        oneImage: t("1 image"),
        images: (n) => t("%d images").replace("%d", String(n)),
        fallback: t("Message"),
      }),
    [props.messages, t],
  );

  // Frozen parity: the rail exists only when the outline has ≥2 ticks.
  const shown = entries.length > 1;
  const expanded = hoveredId != null || pressing;

  // Measure the rail once and on resize — drives the frozen gap-fitting
  // (roomy spacing shrinks toward tightest when the cluster overflows)
  // and the preview card's clamp. One ResizeObserver, no timers.
  useEffect(() => {
    const rail = railRef.current;
    if (!shown || !rail) return;
    const sync = () => setRailH(rail.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(rail);
    return () => ro.disconnect();
  }, [shown]);

  // The lit tick follows the reader: last user message whose top passed
  // the upper third of the viewport; the last entry while at the bottom.
  useEffect(() => {
    const el = props.scrollRef.current;
    if (!shown || !el) return;
    const onScroll = () => {
      const line = el.scrollTop + el.clientHeight * 0.35;
      let current: string | null = null;
      for (const e of entries) {
        const art = el.querySelector<HTMLElement>(`[data-mid="${e.id}"]`);
        if (!art) continue;
        if (art.offsetTop <= line) current = e.id;
        else break;
      }
      setActiveId(current ?? entries[entries.length - 1]!.id);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [entries, shown, props.scrollRef]);

  if (!shown) return null;

  const count = entries.length;
  // Largest gap in [tightest, roomy] whose centred strip still fits the rail.
  const gap =
    railH > 0 && count > 1
      ? Math.max(
          GAP_TIGHT,
          Math.min(GAP_ROOMY, (railH - count * TICK_OUTER) / (count - 1)),
        )
      : GAP_ROOMY;
  const pitch = TICK_OUTER + gap;

  /** Frozen entryID(at:) — nearest tick by pitch, never nil over the cluster. */
  const entryAt = (clientY: number): { entry: MinimapEntry; index: number } | null => {
    const box = clusterRef.current?.getBoundingClientRect();
    if (!box || !count) return null;
    const raw = (clientY - box.top - CLUSTER_PAD_V - TICK_OUTER / 2 + pitch / 2) / pitch;
    const index = Math.min(count - 1, Math.max(0, Math.floor(raw)));
    return { entry: entries[index]!, index };
  };

  const tickCenterY = (index: number): number => {
    const box = clusterRef.current?.getBoundingClientRect();
    const rail = railRef.current?.getBoundingClientRect();
    if (!box || !rail) return 0;
    return box.top - rail.top + CLUSTER_PAD_V + index * pitch + TICK_OUTER / 2;
  };

  // Frozen jump: position.scrollTo(id:, anchor: .top) — the message lands
  // at the top of the scrollport, always above the tracking line, so the
  // tapped tick is the one that lights up (clamp at the bottom lands the
  // last entry, which is also correct).
  const jump = (id: string) => {
    props.scrollRef.current
      ?.querySelector(`[data-mid="${id}"]`)
      ?.scrollIntoView({ block: "start" });
  };

  const previewAt = (clientY: number) => {
    const hit = entryAt(clientY);
    if (!hit) return;
    setHoveredId(hit.entry.id);
    const half = estCardHalf(hit.entry, CARD_WIDTH);
    const top = half + 2;
    const bottom = Math.max(top, railH - half - 2);
    setCardTop(Math.min(Math.max(tickCenterY(hit.index), top), bottom));
  };

  const hovered = entries.find((e) => e.id === hoveredId);

  return (
    <div className="minimap-rail" ref={railRef} aria-label={t("Conversation outline")}>
      <div
        className="minimap-ticks"
        ref={clusterRef}
        style={{ gap, paddingTop: CLUSTER_PAD_V, paddingBottom: CLUSTER_PAD_V }}
        onPointerMove={(ev) => {
          if (pressing) {
            // Live scrub: the timeline tracks 1:1 while the pointer moves.
            const hit = entryAt(ev.clientY);
            if (hit && hit.entry.id !== hoveredId) {
              setHoveredId(hit.entry.id);
              jump(hit.entry.id);
            }
          } else {
            previewAt(ev.clientY);
          }
        }}
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          ev.currentTarget.setPointerCapture(ev.pointerId);
          setPressing(true);
          const hit = entryAt(ev.clientY);
          if (hit) {
            setHoveredId(hit.entry.id);
            jump(hit.entry.id);
          }
        }}
        onPointerUp={(ev) => {
          setPressing(false);
          const hit = entryAt(ev.clientY);
          if (hit) jump(hit.entry.id);
          ev.currentTarget.releasePointerCapture(ev.pointerId);
          const box = clusterRef.current?.getBoundingClientRect();
          if (box && (ev.clientY < box.top || ev.clientY > box.bottom)) {
            setHoveredId(null);
          }
        }}
        onPointerCancel={() => setPressing(false)}
        onPointerLeave={() => {
          if (!pressing) setHoveredId(null);
        }}
      >
        {entries.map((e) => {
          const lit = e.id === activeId;
          const hot = e.id === hoveredId;
          const base = 10 + e.weight * 12;
          const width = hot || lit ? 26 : expanded ? Math.min(26, base + 2) : base;
          return (
            <button
              key={e.id}
              type="button"
              className={`minimap-tick${lit ? " lit" : ""}`}
              style={{ width }}
              aria-label={e.title}
              onClick={() => jump(e.id)}
            />
          );
        })}
      </div>
      {hovered && (
        <div className="minimap-card" style={{ top: cardTop }}>
          <div className="minimap-card-title">{hovered.title}</div>
          {hovered.snippet && <div className="minimap-card-body">{hovered.snippet}</div>}
        </div>
      )}
    </div>
  );
}
