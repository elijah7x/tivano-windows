// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// F03 — port of frozen WorkingSpinner / MiniSpinner (WorkingIndicators.swift):
// a cell grid whose cells pulse once per 750ms, phase-offset so the bright
// edge travels as a wave. WorkingSpinner is 3×3 with lag = distance from
// bottom-center ÷ 2.5; MiniSpinner is 2×3, cells snaking the perimeter ring.
// Three row tints — accent light / base / deep. prefers-reduced-motion and
// F26 performanceMode freeze the wave at t=0 instead of animating.

import type { CSSProperties } from "react";

/** Frozen GradientSpin.opacity(phase): full → ease to 0.1 by 45%, hold to
 *  92%, rise to full by 100%. Used for the still frame at t=0. */
function stillOpacity(lag: number): number {
  let p = ((-lag % 1) + 1) % 1;
  const dim = 0.1;
  if (p < 0.45) {
    const t = p / 0.45;
    return 1 - (1 - dim) * (t * t * (3 - 2 * t));
  }
  if (p < 0.92) return dim;
  const t = (p - 0.92) / 0.08;
  return dim + (1 - dim) * t;
}

interface Cell {
  row: number;
  column: number;
  lag: number;
}

/** Mini's perimeter ring, clockwise from top-left (frozen `ring`). */
const MINI_RING: [number, number][] = [
  [0, 0],
  [0, 1],
  [1, 1],
  [2, 1],
  [2, 0],
  [1, 0],
];

function miniCells(): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 2; column++) {
      const index = MINI_RING.findIndex(([r, c]) => r === row && c === column);
      cells.push({ row, column, lag: Math.max(0, index) / MINI_RING.length });
    }
  return cells;
}

function workingCells(): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++) {
      const dx = column - 1; // bottom-center = (row 2, column 1)
      const dy = 2 - row;
      cells.push({ row, column, lag: Math.sqrt(dx * dx + dy * dy) / 2.5 });
    }
  return cells;
}

function prefersStill(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return true;
  return document.documentElement.dataset.performance === "1";
}

function SpinnerGrid({
  cells,
  columns,
  cellSize,
  labelled,
}: {
  cells: Cell[];
  columns: number;
  cellSize: number;
  labelled: boolean;
}): React.JSX.Element {
  const still = prefersStill();
  const gap = cellSize * 0.8;
  const style: CSSProperties = {
    display: "inline-grid",
    gridTemplateColumns: `repeat(${columns}, ${cellSize}px)`,
    gap: `${gap}px`,
    verticalAlign: "middle",
  };
  return (
    <span
      className="spin-grid"
      style={style}
      {...(labelled
        ? { role: "img" as const, "aria-label": "Working" }
        : { "aria-hidden": true as const })}
    >
      {cells.map((c) => (
        <span
          key={`${c.row}-${c.column}`}
          className={`spin-cell spin-row-${c.row}${still ? " still" : ""}`}
          style={
            still
              ? { opacity: stillOpacity(c.lag) }
              : { animationDelay: `${(-c.lag * 0.75).toFixed(3)}s` }
          }
        />
      ))}
    </span>
  );
}

/** Frozen MiniSpinner — 2×3 perimeter snake for working rows in lists. */
export function MiniSpinner({ cellSize = 2.4 }: { cellSize?: number }): React.JSX.Element {
  return <SpinnerGrid cells={miniCells()} columns={2} cellSize={cellSize} labelled />;
}

/** Frozen WorkingSpinner — 3×3 bottom-center wave for inline/busy marks. */
export function WorkingSpinner({ cellSize = 3.5 }: { cellSize?: number }): React.JSX.Element {
  // Frozen: the 3×3 sits beside text that already says "working", so it is
  // accessibility-hidden where the 2×3 list mark carries the label.
  return <SpinnerGrid cells={workingCells()} columns={3} cellSize={cellSize} labelled={false} />;
}
