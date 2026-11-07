// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Frozen HydraProgressBar, bounded port: one stave per tool call and per
// reply, in order — a lookup is short and faint (tint@40%, 45% height),
// a command taller (70%, 65%), an edit taller still (tint, 85%) and a
// reply stands full height in the tint. Slots are 3px wide at a 6px
// pitch; past capacity the oldest slide off the left, and unfilled slots
// draw as faint stubs. The last stave of a failed or stopped head wears
// the status colour. Hovering a stave names its step.
// Bounded: our ToolNote carries no `edits` list, so a command that wrote
// files stays a command (frozen re-maps it to edit); the CA-layer sweep
// and per-slot GPU budget are CSS-only or absent — a new stave rises via
// a scaleY transition, no travelling highlight.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, ToolNote } from "../../shared/types";
import { useT } from "../locale";

const PITCH = 6;
const W = 3;
const HEIGHTS = { lookup: 0.45, command: 0.65, edit: 0.85, reply: 1 } as const;
type StaveKind = keyof typeof HEIGHTS;

interface Stave {
  id: string;
  kind: StaveKind;
  step: string;
  ts: number;
}

function toolKind(note: ToolNote): StaveKind {
  if (note.kind === "edit") return "edit";
  if (note.kind === "command") return "command";
  return "lookup";
}

export function stavesOf(messages: Message[], repliedLabel: string): Stave[] {
  const out: Stave[] = [];
  for (const m of messages) {
    if (m.kind === "tool" && m.tool) {
      out.push({
        id: m.id,
        kind: toolKind(m.tool),
        step: m.tool.title ?? m.tool.kind,
        ts: m.ts,
      });
    } else if (m.role === "assistant") {
      const words = m.content.split("\n")[0]!.trim().slice(0, 60);
      out.push({
        id: m.id,
        kind: "reply",
        step: words ? `${repliedLabel}: ${words}` : repliedLabel,
        ts: m.ts,
      });
    }
  }
  return out;
}

export function HydraStaveBar(props: {
  messages: Message[];
  /** Hex tint — persona colour for heads, accent for the lead's own work. */
  tint: string;
  status?: "running" | "completed" | "failed" | "stopped";
  height?: number;
}): React.JSX.Element {
  const t = useT();
  const height = props.height ?? 18;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Stave | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setWidth(es[0]!.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const events = useMemo(
    () => stavesOf(props.messages, t("Replied")),
    [props.messages, t],
  );
  const capacity = Math.max(1, Math.floor(width / PITCH));
  const staves = events.length > capacity ? events.slice(-capacity) : events;
  const counts = useMemo(() => {
    let e = 0, c = 0, r = 0;
    for (const s of events) {
      if (s.kind === "edit") e++;
      else if (s.kind === "command") c++;
      else if (s.kind === "lookup") r++;
    }
    const parts: string[] = [];
    if (e) parts.push(e === 1 ? t("1 edit") : t("%@ edits", String(e)));
    if (c) parts.push(c === 1 ? t("1 command") : t("%@ commands", String(c)));
    if (r) parts.push(r === 1 ? t("1 read") : t("%@ reads", String(r)));
    return parts.length ? parts.join(" · ") : t("Nothing done yet");
  }, [events, t]);

  const lastI = staves.length - 1;
  const fill = (s: Stave, i: number): string => {
    if (i === lastI && props.status === "failed") return "var(--danger)";
    if (i === lastI && props.status === "stopped") return "var(--text-2)";
    return props.tint;
  };
  const op = (s: Stave) =>
    s.kind === "lookup" ? 0.4 : s.kind === "command" ? 0.7 : 1;

  return (
    <div
      ref={wrapRef}
      className="stave-bar"
      style={{ height }}
      role="img"
      aria-label={counts}
      onMouseLeave={() => setHover(null)}
    >
      <svg width="100%" height={height} aria-hidden="true">
        {Array.from({ length: Math.max(0, capacity - staves.length) }).map((_, i) => (
          <rect
            key={`e${i}`}
            x={(staves.length + i) * PITCH}
            y={height - height * 0.45}
            width={W}
            height={height * 0.45}
            rx={W / 2}
            fill={props.tint}
            opacity={0.14}
          />
        ))}
        {staves.map((s, i) => {
          const h = height * HEIGHTS[s.kind];
          return (
            <rect
              key={s.id}
              className="stave"
              x={i * PITCH}
              y={height - h}
              width={W}
              height={h}
              rx={W / 2}
              fill={fill(s, i)}
              opacity={op(s)}
              onMouseEnter={() => setHover(s)}
            >
              <title>{s.step}</title>
            </rect>
          );
        })}
      </svg>
      {hover && (
        <div className="stave-card" role="tooltip">
          {hover.step}
        </div>
      )}
    </div>
  );
}
