// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F28 finish signals (frozen turnFinished): the chime fires on a real
// result with nothing still working — never on user stops, interruptions
// or queued successors; the notification descriptor rides the same event
// and goes silent when the chime already sounded. Plus the frozen
// ToneSynth WAV shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import { finishChimeWav, toneWave } from "../src/shared/toneSynth";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-signal-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface FinishSignal {
  type: "finish-signal";
  threadId: string;
  status: string;
  chime: boolean;
  notify: "done" | "stopped" | "failed" | null;
  silent: boolean;
}

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  const signals: FinishSignal[] = [];
  engine.onEvent((e) => {
    if (e.type === "finish-signal") signals.push(e as FinishSignal);
  });
  return { store, engine, signals };
}

const thread = (engine: Engine, id: string) =>
  engine.snapshot().threads.find((t) => t.id === id)!;

describe("F28 finish-signal (frozen turnFinished)", () => {
  it("a done turn chimes by default and stays silent about notifying", async () => {
    const { engine, store, signals } = make();
    const th = engine.createThread(null, "chat");
    engine.selectThread(th.id);
    engine.sendTurn(th.id, "work");
    await waitFor(() => thread(engine, th.id).turn?.status === "done");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      threadId: th.id,
      status: "done",
      chime: true,
      notify: null, // notifyOnDone defaults off
    });
    store.close();
  });

  it("notifyOnDone wants a notification, silent because the chime sounded", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "work");
    await waitFor(() => thread(engine, th.id).turn?.status === "done");
    expect(signals.at(-1)).toMatchObject({
      chime: true,
      notify: "done",
      silent: true,
    });
    store.close();
  });

  it("chime off → no chime and the notification keeps its own sound", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true, chimeWhenFinished: false });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "work");
    await waitFor(() => thread(engine, th.id).turn?.status === "done");
    expect(signals.at(-1)).toMatchObject({
      chime: false,
      notify: "done",
      silent: false,
    });
    store.close();
  });

  it("a user-stopped turn claims neither — the stop was witnessed", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] work");
    await waitFor(() => thread(engine, th.id).turn?.status === "waiting-approval");
    engine.cancelTurn(th.id);
    await waitFor(() => thread(engine, th.id).turn?.status === "cancelled");
    expect(signals.at(-1)).toMatchObject({
      status: "cancelled",
      chime: false,
      notify: null,
    });
    store.close();
  });

  it("a queued send-now suppresses both — the thread is still working", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] first");
    await waitFor(() => thread(engine, th.id).turn?.status === "waiting-approval");
    engine.interruptAndSend(th.id, "second");
    // First turn: cancelled BUT a successor fired — still working.
    await waitFor(() => signals.length >= 1);
    expect(signals[0]).toMatchObject({ chime: false, notify: null });
    // Second turn completes and signals honestly.
    await waitFor(() => signals.length >= 2);
    expect(signals[1]).toMatchObject({
      status: "done",
      chime: true,
      notify: "done",
    });
    store.close();
  });

  it("a queued follow-up suppresses both — the turn continues", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "first");
    engine.enqueueFollowUp(th.id, "queued");
    await waitFor(() => signals.length >= 1);
    expect(signals[0]).toMatchObject({ status: "done", chime: false, notify: null });
    await waitFor(() => signals.length >= 2);
    expect(signals[1]).toMatchObject({ status: "done", chime: true });
    store.close();
  });

  it("a failed turn still chimes and notifies as 'failed'", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:fail] work");
    await waitFor(() => thread(engine, th.id).turn?.status === "error");
    expect(signals.at(-1)).toMatchObject({
      status: "error",
      chime: true, // frozen: .failed is a real result — it chimes
      notify: "failed",
      silent: true,
    });
    store.close();
  });

  it("a denied approval counts as user-stopped — no chime, no notify", async () => {
    const { engine, store, signals } = make();
    engine.setSettings({ notifyOnDone: true });
    const th = engine.createThread(null, "chat");
    engine.sendTurn(th.id, "[mock:approval] work");
    await waitFor(() => thread(engine, th.id).turn?.status === "waiting-approval");
    const approvalId = thread(engine, th.id).turn!.approval!.id;
    engine.resolveApproval(th.id, approvalId, "deny");
    await waitFor(() => thread(engine, th.id).turn?.status === "denied");
    expect(signals.at(-1)).toMatchObject({
      status: "denied",
      chime: false,
      notify: null,
    });
    store.close();
  });

  it("chimeWhenFinished persists through setSettings → store → reopen", () => {
    const root = tmp();
    const { engine, store } = make(root);
    engine.setSettings({ chimeWhenFinished: false });
    expect(engine.snapshot().settings.chimeWhenFinished).toBe(false);
    store.close();
    const store2 = new Store(root);
    store2.open();
    expect(store2.state.settings.chimeWhenFinished).toBe(false);
    store2.close();
  });
});

describe("frozen ToneSynth WAV", () => {
  const ascii = (b: Uint8Array, off: number, len: number) =>
    String.fromCharCode(...b.slice(off, off + len));

  it("renders a RIFF/WAVE 16-bit mono PCM at 44.1kHz", () => {
    const wav = finishChimeWav();
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(40, true)).toBe(wav.length - 44);
    // 0.7s at 44.1kHz → floor(44100·0.7) samples of 2 bytes each.
    expect(wav.length).toBe(44 + Math.floor(44100 * 0.7) * 2);
  });

  it("normalizes the peak to 0.9 full-scale and tails off to silence", () => {
    const wav = finishChimeWav();
    const view = new DataView(wav.buffer);
    const count = (wav.length - 44) / 2;
    let peak = 0;
    for (let i = 0; i < count; i++) {
      peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
    }
    expect(peak).toBeGreaterThan(29000); // ≈0.9·32767
    expect(peak).toBeLessThanOrEqual(32767);
    // The release tail ends inaudibly.
    expect(Math.abs(view.getInt16(44 + (count - 1) * 2, true))).toBe(0);
  });

  it("the second note is silent before its 0.14s onset", () => {
    // One A5-only wave: the first 0.14s must hold nothing but zeros.
    const wav = toneWave(
      [{ frequency: 880, onset: 0.14, level: 1 }],
      [{ multiple: 1, level: 1, decay: 0.14 }],
      0.7,
    );
    const view = new DataView(wav.buffer);
    const preOnset = Math.floor(0.14 * 44100);
    for (let i = 0; i < preOnset; i++) {
      expect(view.getInt16(44 + i * 2, true)).toBe(0);
    }
    // And the note actually sounds after the onset.
    let peak = 0;
    for (let i = preOnset; i < preOnset + 4410; i++) {
      peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
    }
    expect(peak).toBeGreaterThan(10000);
  });
});
