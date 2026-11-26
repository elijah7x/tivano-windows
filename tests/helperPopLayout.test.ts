// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import { describe, expect, it } from "vitest";
import {
  HELPER_PANEL_INSET,
  HELPER_POP_TITLE_STEP,
  helperPopLayout,
  type HelperPopPlacement,
} from "../src/shared/helperPopLayout";

const CHROME_TOP = 48;
const COMPOSER_BOTTOM = 124;

const layout = (paneWidth: number, paneHeight: number, runningHeads: number) =>
  helperPopLayout({
    paneWidth,
    paneHeight,
    chromeTop: CHROME_TOP,
    composerBottom: COMPOSER_BOTTOM,
    runningHeads,
  });

const overlaps = (a: HelperPopPlacement, b: HelperPopPlacement): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const expectInsideSafeArea = (
  p: HelperPopPlacement,
  paneWidth: number,
  paneHeight: number,
) => {
  expect(p.x).toBeGreaterThanOrEqual(HELPER_PANEL_INSET);
  expect(p.y).toBeGreaterThanOrEqual(CHROME_TOP + HELPER_PANEL_INSET);
  expect(p.x + p.width).toBeLessThanOrEqual(paneWidth - HELPER_PANEL_INSET);
  expect(p.y + p.height).toBeLessThanOrEqual(
    paneHeight - COMPOSER_BOTTOM - HELPER_PANEL_INSET,
  );
};

describe("helperPopLayout automatic independent panels", () => {
  it("pops nothing until a second running head exists", () => {
    expect(layout(1100, 720, 0).placements).toHaveLength(0);
    expect(layout(1100, 720, 1).placements).toHaveLength(0);
  });

  for (const runningHeads of [2, 3, 4, 5]) {
    it(`keeps ${runningHeads - 1} pop(s) inside a wide pane without overlaps`, () => {
      const paneWidth = 1100;
      const paneHeight = 720;
      const out = layout(paneWidth, paneHeight, runningHeads);
      expect(out.mode).toBe("wide");
      expect(out.placements).toHaveLength(runningHeads - 1);
      for (const p of out.placements) expectInsideSafeArea(p, paneWidth, paneHeight);
      for (const [i, a] of out.placements.entries()) {
        for (const b of out.placements.slice(i + 1)) {
          expect(overlaps(a, b)).toBe(false);
        }
      }
    });

    it(`gives ${runningHeads - 1} narrow-pane pop(s) distinct reachable positions`, () => {
      const paneWidth = 700;
      const paneHeight = 720;
      const out = layout(paneWidth, paneHeight, runningHeads);
      expect(out.mode).toBe("narrow");
      expect(out.placements).toHaveLength(runningHeads - 1);
      for (const p of out.placements) expectInsideSafeArea(p, paneWidth, paneHeight);
      expect(new Set(out.placements.map((p) => `${p.x}:${p.y}`)).size).toBe(
        out.placements.length,
      );
      for (let i = 1; i < out.placements.length; i += 1) {
        expect(out.placements[i]!.y - out.placements[i - 1]!.y).toBeGreaterThanOrEqual(
          HELPER_POP_TITLE_STEP,
        );
      }
    });
  }

  it("uses the frozen corner order in a wide pane", () => {
    const out = layout(1100, 720, 5);
    expect(out.placements.map((p) => p.corner)).toEqual(["tr", "tl", "br", "bl"]);
  });
});
