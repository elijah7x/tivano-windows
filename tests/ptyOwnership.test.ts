import { describe, expect, it, vi } from "vitest";
import { PtyOwnership, parseProcessRows } from "../src/main/ptyOwnership";
const row = (pid: number, birth = "Sat Oct 24 20:00:00 2026") => ({ pid, pgid: pid, tty: "ttys099", state: "S", birth });
describe("PTY cleanup identities", () => {
  it("parses process identities without treating command text as ownership", () => {
    expect(parseProcessRows(" 100 100 ttys099 Ss Sat Oct 24 20:00:00 2026\n")).toEqual([{ ...row(100), state: "Ss" }]);
  });
  it("waits for the spawn helper to acquire its PTY", async () => {
    let n = 0;
    const owner = new PtyOwnership(async () => [{ ...row(100), tty: n++ === 0 ? "??" : "ttys099" }], vi.fn());
    await owner.capture(100);
    expect(owner.snapshot().anchor?.tty).toBe("ttys099");
  });
  it("never discovers a new terminal after its original shell exits", async () => {
    let rows = [row(100), row(101)]; const signal = vi.fn();
    const owner = new PtyOwnership(async () => rows, signal);
    await owner.capture(100); rows = [row(900), row(901)];
    expect(await owner.stop()).toBe(true);
    expect(signal).not.toHaveBeenCalled();
  });
  it("does not signal a reused PID with a different birth identity", async () => {
    let rows = [row(100)]; const signal = vi.fn();
    const owner = new PtyOwnership(async () => rows, signal); await owner.capture(100);
    rows = [row(100, "Sat Oct 24 20:01:00 2026")];
    expect(await owner.stop()).toBe(true); expect(signal).not.toHaveBeenCalled();
  });
  it("still recognizes an owned child after its controlling TTY disappears", async () => {
    let rows = [row(100), row(101)]; const killed: number[] = [];
    const owner = new PtyOwnership(async () => rows, pid => { killed.push(pid); rows = rows.filter(r => r.pid !== pid); return true; });
    await owner.capture(100); rows = [{ ...row(101), tty: "??", pgid: 500 }];
    expect(await owner.stop()).toBe(true); expect(killed).toEqual([101]);
  });
  it("keeps permission failures observable", async () => {
    const owner = new PtyOwnership(async () => [row(100)], () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    await owner.capture(100); await expect(owner.stop()).rejects.toThrow("denied");
  });
  it("signals recorded background children before their shell", async () => {
    let rows = [row(100), row(101)]; const killed: number[] = [];
    const owner = new PtyOwnership(async () => rows, pid => { killed.push(pid); rows = rows.filter(r => r.pid !== pid); return true; });
    await owner.capture(100); expect(await owner.stop()).toBe(true); expect(killed).toEqual([101, 100]);
  });
});
