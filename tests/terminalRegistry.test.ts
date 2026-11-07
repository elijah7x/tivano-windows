import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ listener: null as null | ((e: any) => void), select: vi.fn(), ack: vi.fn(), terms: [] as any[] }));
vi.mock("../src/renderer/client", () => ({ api: () => ({ onEvent: (cb: any) => { mock.listener = cb; } }),
  callApi: (...args: any[]) => mock.select(...args), tryCall: (...args: any[]) => mock.ack(...args) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  writes: { data: string; done: () => void }[] = [];
  constructor() { mock.terms.push(this); }
  loadAddon() {} open() {} onData() {} onResize() {} reset() {} dispose() {}
  write(data: string, done: () => void) { this.writes.push({ data, done }); }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
const info = (incarnation = 1) => ({ id: "a", threadId: "t", title: "Terminal 1", incarnation, state: "running" as const, cwd: "/tmp" });
const deferred = () => { let resolve!: (v: any) => void; let reject!: (e: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => { vi.resetModules(); mock.select.mockReset(); mock.ack.mockReset(); mock.terms = []; mock.listener = null;
  vi.stubGlobal("document", { createElement: () => ({ className: "", remove() {} }) }); });
describe("terminal rendering order and incarnation", () => {
  it("buffers live output during select and replays the snapshot exactly once", async () => {
    const d = deferred(); mock.select.mockReturnValue(d.promise);
    const r = await import("../src/renderer/terminalRegistry"); r.ensureTerminalBridge(); r.ensureEntry(info());
    mock.listener!({ type: "terminal-data", terminalId: "a", incarnation: 1, seq: 1, data: "ONE" });
    mock.listener!({ type: "terminal-data", terminalId: "a", incarnation: 1, seq: 2, data: "TWO" });
    expect(mock.terms[0].writes).toHaveLength(0);
    d.resolve({ info: info(), tail: "ONE", tailFromSeq: 1, tailEndSeq: 1 }); await flush();
    expect(mock.terms[0].writes.map((x: any) => x.data)).toEqual(["ONE", "TWO"]);
  });
  it("old xterm completion cannot acknowledge a replacement incarnation", async () => {
    mock.select.mockResolvedValue({ info: info(), tail: "old", tailFromSeq: 1, tailEndSeq: 1 });
    const r = await import("../src/renderer/terminalRegistry"); r.ensureEntry(info()); await flush();
    const oldCompletion = mock.terms[0].writes[0].done;
    mock.select.mockReturnValue(new Promise(() => {})); r.ensureEntry(info(2)); oldCompletion();
    expect(mock.ack).not.toHaveBeenCalled();
    expect(mock.terms).toHaveLength(2);
  });
  it("a failed select is retried on the next attach", async () => {
    mock.select.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const r = await import("../src/renderer/terminalRegistry"); r.ensureEntry(info()); await flush();
    mock.select.mockReturnValue(new Promise(() => {})); r.ensureEntry(info());
    expect(mock.select).toHaveBeenCalledTimes(2);
  });
  it("creates a consumer for state events even without a mounted panel", async () => {
    mock.select.mockReturnValue(new Promise(() => {}));
    const r = await import("../src/renderer/terminalRegistry"); r.ensureTerminalBridge();
    mock.listener!({ type: "terminal-state", terminal: info() });
    expect(r.entryOf("a")).toBeDefined();
  });
});
