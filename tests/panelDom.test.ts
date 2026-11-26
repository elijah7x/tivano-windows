// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-40 executing component coverage: the panel layout behaviors are mounted
// in Chromium (through the Electron already used by this repository's e2e)
// and driven through real DOM events rather than asserted as SSR strings.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import type { ConsoleMessage, ElectronApplication, Page } from "playwright-core";
import type { ChatThread, Settings } from "../src/shared/types";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const req = createRequire(import.meta.url);
const electronBin = req("electron") as string;

let page!: Page;
let app!: ElectronApplication;
let scratch = "";
const pageDiagnostics: string[] = [];

interface PanelHarness {
  lead(over?: Partial<ChatThread>): ChatThread;
  head(index: number, status?: "running" | "completed"): ChatThread;
  helper(over?: Partial<ChatThread>): ChatThread;
  mountChat(scene: { settings: Partial<Settings>; threads: ChatThread[] }): Promise<true>;
  updateChat(scene: { settings: Partial<Settings>; threads: ChatThread[] }): Promise<true>;
  mountHelperPanel(thread: ChatThread): Promise<true>;
  invocations(): Array<{ channel: string; payload: { id?: string } }>;
  clearInvocations(): void;
  closeCalls(): number;
}

async function waitCount(selector: string, count: number): Promise<void> {
  try {
    await page.waitForFunction(
      ({ s, c }: { s: string; c: number }) => document.querySelectorAll(s).length === c,
      { s: selector, c: count },
      { timeout: 5000 },
    );
  } catch (e) {
    const html = await page.evaluate(() => document.body.innerHTML.slice(-5000));
    throw new Error(`waiting for ${count} × ${selector}: ${String(e)}\nDIAG: ${pageDiagnostics.join(" | ")}\nDOM: ${html}`);
  }
}

async function invocations(): Promise<Array<{ channel: string; payload: { id?: string } }>> {
  return page.evaluate(() => {
    const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
    return h.invocations();
  });
}

describe("P2-40 executing panel layout behavior", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "tivano-panel-dom-"));
    const bundle = buildSync({
      entryPoints: [join(root, "tests/panelDomHarness.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      write: false,
      logLevel: "silent",
    }).outputFiles[0]!.text;
    writeFileSync(join(scratch, "bundle.js"), bundle);
    writeFileSync(join(scratch, "styles.css"), readFileSync(join(root, "src/renderer/styles.css"), "utf8"));
    const htmlPath = join(scratch, "index.html");
    writeFileSync(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><script>
window.__invocations=[];
window.tivano={
  platform:'win32',
  invoke:(channel,payload)=>{
    window.__invocations.push({channel,payload});
    if(channel==='checkpoints:list'||channel==='downloads:list'||channel==='mention:search') return Promise.resolve([]);
    if(channel==='checkpoints:changes') return Promise.resolve(null);
    return Promise.resolve({editors:[]});
  },
  onEvent:()=>()=>{}
};
window.matchMedia=window.matchMedia||(()=>({matches:false,media:'',addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}));
</script></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`,
    );
    const mainPath = join(scratch, "main.cjs");
    writeFileSync(
      mainPath,
      `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(scratch, "user-data"))});
app.whenReady().then(()=>{
  const win=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{backgroundThrottling:false}});
  win.loadFile(${JSON.stringify(htmlPath)});
});
app.on('window-all-closed',()=>app.quit());
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronBin,
      args: [mainPath],
      env: env as Record<string, string>,
      timeout: 60000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e: Error) => pageDiagnostics.push(`pageerror: ${e.message}`));
    page.on("console", (m: ConsoleMessage) => pageDiagnostics.push(`console-${m.type()}: ${m.text()}`.slice(0, 600)));
    await page.waitForFunction(
      () => Boolean((window as unknown as { __panelHarness?: unknown }).__panelHarness),
      null,
      { timeout: 10000 },
    );
  }, 90000);

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("flipping the layout Off folds the docked team panel into the working pill", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.mountChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.head(1)],
      });
    });
    await waitCount(".hydra-panel", 1);

    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.updateChat({
        settings: { hydraAutoOpensPanels: false, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.head(1)],
      });
    });
    await waitCount(".hydra-panel", 0);
    await waitCount(".hydra-working-pill", 1);
  }, 20000);

  it("a genuinely new head auto-opens the panel while the layout flip alone does not", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.mountChat({
        settings: { hydraAutoOpensPanels: false, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.head(1)],
      });
    });
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.updateChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.head(1)],
      });
    });
    await waitCount(".hydra-panel", 0);

    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.updateChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.head(1), h.head(2)],
      });
    });
    await waitCount(".hydra-panel", 1);
    await waitCount(".hydra-working-pill", 0);
  }, 20000);

  it("dismissing one pop holds it until switching the lead away and back resets the hold", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.mountChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: true },
        threads: [h.lead(), h.head(1), h.head(2)],
      });
    });
    await waitCount(".helper-panel.float", 1);

    await page.locator(".helper-panel.float .helper-close").first().click();
    await waitCount(".helper-panel.float", 0);

    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.updateChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: true },
        threads: [h.lead({ id: "other", title: "Other chat" })],
      });
    });
    await waitCount(".helper-panel.float", 0);

    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.updateChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: true },
        threads: [h.lead(), h.head(1), h.head(2)],
      });
    });
    await waitCount(".hydra-panel", 1);
    await waitCount(".helper-panel.float", 1);
  }, 20000);

  it("dismissing and reopening the team panel resets an automatic-pop hold", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.mountChat({
        settings: { hydraAutoOpensPanels: true, hydraAutoPopsHeads: true },
        threads: [h.lead(), h.head(1), h.head(2)],
      });
    });
    await waitCount(".helper-panel.float", 1);

    await page.locator(".helper-panel.float .helper-close").first().click();
    await waitCount(".helper-panel.float", 0);

    await page.locator(".hydra-panel .hydra-title").click({ button: "right" });
    await page.locator(".hydra-menu .suggest-row", { hasText: "Dismiss the panel" }).click();
    await waitCount(".hydra-panel", 0);
    await waitCount(".hydra-working-pill", 1);

    await page.locator(".hydra-working-pill").click();

    await waitCount(".hydra-panel", 1);
    await waitCount(".helper-panel.float", 1);
  }, 20000);

  it("the working pill for a head re-opens the hidden team panel", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.mountChat({
        settings: { hydraAutoOpensPanels: false, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.head(1)],
      });
    });
    await waitCount(".hydra-panel", 0);
    await waitCount(".hydra-working-pill", 1);

    await page.locator(".hydra-working-pill").click();

    await waitCount(".hydra-panel", 1);
    await waitCount(".hydra-working-pill", 0);
  }, 20000);

  it("the working pill for a plain helper invokes threads:show-helper", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      return h.mountChat({
        settings: { hydraAutoOpensPanels: false, hydraAutoPopsHeads: false },
        threads: [h.lead(), h.helper()],
      });
    });
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      h.clearInvocations();
    });
    await page.locator(".hydra-working-pill").click();
    await page.waitForFunction(
      () => ((window as unknown as { __invocations?: Array<{ channel: string }> }).__invocations ?? []).some((c) => c.channel === "threads:show-helper"),
      null,
      { timeout: 2500 },
    );
    const calls = await invocations();
    expect(
      calls.some((c) => c.channel === "threads:show-helper" && c.payload.id === "helper-1"),
    ).toBe(true);
  }, 20000);

  it("clicking close on a running helper folds it without sending turns:cancel", async () => {
    await page.evaluate(() => {
      const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
      h.clearInvocations();
      return h.mountHelperPanel(h.helper());
    });
    await page.locator('button[aria-label="Move to sidebar"]').click();
    expect(
      await page.evaluate(() => {
        const h = (window as unknown as { __panelHarness: PanelHarness }).__panelHarness;
        return h.closeCalls();
      }),
    ).toBe(1);
    expect((await invocations()).some((c) => c.channel === "turns:cancel")).toBe(false);
  }, 20000);
});
