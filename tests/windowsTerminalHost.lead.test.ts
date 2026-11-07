// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { spawnWindowsTerminalHost } from "../src/main/windowsTerminalHost";

class Pipe extends EventEmitter {
  writes: string[] = [];
  writableLength = 0;
  blocked = false;
  writable = true;
  destroyed = false;
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(data);
    if (this.blocked) this.writableLength += Buffer.byteLength(data);
    else callback?.(null);
    return !this.blocked;
  }
  end() { this.writable = false; }
  destroy() { this.destroyed = true; this.writable = false; }
}
class Child extends EventEmitter {
  stdin = new Pipe();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
  frame(message: Record<string, unknown>) {
    this.stdout.emit("data", Buffer.from(JSON.stringify(message) + "\n"));
  }
}
const children: Child[] = [];
afterEach(() => { for (const child of children.splice(0)) child.emit("close", null); });
async function rig(cwd = "C:\\synthetic") {
  const child = new Child(); children.push(child);
  let launches = 0;
  const messages: Record<string, unknown>[] = [];
  const exits: (number | null)[] = [];
  const host = spawnWindowsTerminalHost({
    helperPath: "C:\\package\\job-helper\\tivano-job-helper.exe",
    spawnImpl: () => { launches++; return child as unknown as ChildProcess; },
  });
  host.onMessage(message => messages.push(message as Record<string, unknown>));
  host.onExit(code => exits.push(code));
  await Promise.resolve();
  host.post({ type: "spawn", cols: 80, rows: 25, cwd, env: { SystemRoot: "C:\\Windows" } });
  return { child, host, messages, exits, launches: () => launches };
}
const provedCleanup = (messages: Record<string, unknown>[]) =>
  messages.some(message => message.type === "cleanup" && message.confirmed === true);

describe("lead regressions: Windows terminal ownership and transport", () => {
  it("killed helper without a cleanup proof stays unconfirmed", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.emit("close", null);
    expect(provedCleanup(r.messages)).toBe(false);
  });
  it("unknown helper exit status cannot prove an empty Job", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.emit("close", 17);
    expect(provedCleanup(r.messages)).toBe(false);
  });
  it("runtime child error cannot reclaim a live helper", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.emit("error", new Error("synthetic process-control failure"));
    expect(provedCleanup(r.messages)).toBe(false);
    expect(r.exits).toHaveLength(0);
  });
  it("shutdown while waiting for spawned is delivered or cancels the child", async () => {
    const r = await rig(); r.host.post({ type: "shutdown" });
    const stop = r.child.stdin.writes.some(line => JSON.parse(line).type === "stop");
    expect(stop || r.child.killed).toBe(true);
  });
  it("rejected command-line budget releases the never-created host", async () => {
    const r = await rig("C:\\" + "x".repeat(40000));
    expect(r.launches()).toBe(0);
    expect(r.messages.some(message => message.type === "spawn-failed")).toBe(true);
    expect(provedCleanup(r.messages)).toBe(true);
    expect(r.exits).toHaveLength(1);
  });
  it("stalled stdin cannot accumulate an unbounded writable queue", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.stdin.blocked = true;
    for (let i = 0; i < 20; i++) r.host.post({ type: "input", data: "x".repeat(65536) });
    expect(r.child.stdin.writableLength).toBeLessThanOrEqual(512 * 1024);
  });
  it("invalid base64 is a protocol error, not successful empty output", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.frame({ type: "data", seq: 1, data: "%%%" });
    expect(r.messages.some(message => message.type === "host-error")).toBe(true);
    expect(r.messages.some(message => message.type === "data")).toBe(false);
  });
  it("output before spawned violates the session lifecycle", async () => {
    const r = await rig();
    r.child.frame({ type: "data", seq: 1, data: "eA==" });
    expect(r.messages.some(message => message.type === "host-error")).toBe(true);
    expect(r.messages.some(message => message.type === "data")).toBe(false);
  });
  it("stdin EPIPE is handled without claiming process cleanup", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    expect(() => r.child.stdin.emit("error", new Error("synthetic EPIPE"))).not.toThrow();
    expect(provedCleanup(r.messages)).toBe(false);
  });
  it("cleanup testimony cannot hide a subsequent helper failure", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.frame({ type: "exit", exitCode: 0, forced: false });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    r.child.emit("close", 4);
    expect(provedCleanup(r.messages)).toBe(false);
  });
  it("cleanup before the shell exit is a protocol violation", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    expect(r.messages.some(message => message.type === "host-error")).toBe(true);
    expect(provedCleanup(r.messages)).toBe(false);
  });
  it("control traffic is also bounded when the pipe is stalled", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.stdin.blocked = true;
    for (let i = 0; i < 6000; i++) r.host.post({ type: "resize", cols: 80, rows: 25 });
    expect(r.child.stdin.writableLength).toBeLessThanOrEqual(128 * 1024);
  });
  it("oversize output enters one terminal protocol-failure state", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.stdout.emit("data", Buffer.from("x".repeat(600 * 1024)));
    r.child.stdout.emit("data", Buffer.from("x".repeat(600 * 1024)));
    expect(r.messages.filter(message => message.type === "host-error")).toHaveLength(1);
  });
  it("frames following protocol failure cannot mint cleanup proof", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.stdout.emit("data", Buffer.from("{broken}\n"));
    r.child.frame({ type: "exit", exitCode: 0, forced: false });
    r.child.frame({ type: "cleanup", jobEmpty: true, outputComplete: true });
    r.child.emit("close", 0);
    expect(provedCleanup(r.messages)).toBe(false);
  });
  it("diagnostic capture keeps draining after its byte budget", async () => {
    const r = await rig(); r.child.frame({ type: "spawned", pid: 1234 });
    r.child.stderr.emit("data", Buffer.alloc(70 * 1024));
    expect(r.child.stderr.listenerCount("data")).toBeGreaterThan(0);
  });
});
