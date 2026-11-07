// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { spawn as ptySpawn, type IPty } from "node-pty";
import { PtyOwnership } from "./ptyOwnership";
const port = (process as unknown as { parentPort?: { postMessage(m: unknown): void; on(e: string, cb: (m: { data: unknown }) => void): void } }).parentPort;
const send = (m: unknown): void => { if (port) port.postMessage(m); else process.send?.(m); };
let term: IPty | null = null;
let ownership = new PtyOwnership();
let stopping: Promise<void> | null = null;
let exited = false;
let started = false;
let closingRequested = false;
let seq = 0;
let acked = 0;
let paused = false;
let flowPaused = false;
let pendingBytes = 0;
const pending = new Map<number, number>();
let poll: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

function pauseState(): void {
  if (!term || exited) return;
  if (paused || flowPaused) term.pause(); else term.resume();
}
function publishOwnership(): void { send({ type: "ownership", ...ownership.snapshot() }); }
async function shutdown(): Promise<void> {
  closingRequested = true;
  if (stopping) return stopping;
  stopping = (async () => {
    if (poll) clearInterval(poll);
    poll = null;
    // No spawn was ever requested: host exit alone suffices for this case.
    let confirmed = !started;
    try {
      if (started && term && !exited && !ownership.snapshot().anchor) await ownership.capture(term.pid);
      if (started) confirmed = await ownership.stop();
    }
    catch (e) { send({ type: "host-error", message: String(e) }); }
    send({ type: "cleanup", confirmed });
    if (confirmed) {
      // Flush queued parent-port messages before exiting the utility process.
      setTimeout(() => process.exit(0), 25);
    } else { stopping = null; }
  })();
  return stopping;
}
async function spawn(raw: Record<string, unknown>): Promise<void> {
  if (started || stopping || closingRequested) return;
  if (raw.shell !== "/bin/zsh" || !Array.isArray(raw.args) || raw.args.length !== 1 || raw.args[0] !== "-f" ||
      typeof raw.cwd !== "string" || !raw.cwd.startsWith("/") || !raw.env || typeof raw.env !== "object" ||
      !Number.isInteger(raw.cols) || !Number.isInteger(raw.rows)) throw new Error("invalid spawn specification");
  started = true;
  try {
    term = ptySpawn("/bin/zsh", ["-f"], { name: "xterm-256color", cols: raw.cols as number, rows: raw.rows as number,
      cwd: raw.cwd, env: raw.env as Record<string, string>, encoding: "utf8" });
  } catch (e) {
    started = false;
    send({ type: "spawn-failed", message: String(e) });
    await shutdown(); return;
  }
  term.onData(data => {
    // Bound both individual frames and the host's unacknowledged byte queue.
    for (let i = 0; i < data.length;) {
      let end = Math.min(i + 4096, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
      const chunk = data.slice(i, end); i = end;
      const bytes = Buffer.byteLength(chunk);
      if (pendingBytes + bytes > 512 * 1024) {
        send({ type: "host-error", message: "output backlog exceeded" }); void shutdown(); return;
      }
      pendingBytes += bytes; pending.set(++seq, bytes);
      send({ type: "data", seq, data: chunk });
    }
    if (pendingBytes >= 128 * 1024) { flowPaused = true; pauseState(); }
  });
  term.onExit(e => {
    exited = true;
    send({ type: "exit", ...e });
    // Shell exit is distinct from observed descendant cleanup.
    void shutdown();
  });
  try {
    await ownership.capture(term.pid);
    publishOwnership();
    send({ type: "spawned", pid: term.pid });
    if (closingRequested) { await shutdown(); return; }
    poll = setInterval(() => {
      if (refreshing || stopping || exited) return;
      refreshing = true;
      void ownership.refresh().then(publishOwnership).catch(e => {
        send({ type: "host-error", message: String(e) }); void shutdown();
      }).finally(() => { refreshing = false; });
    }, 500);
  } catch (e) { send({ type: "host-error", message: String(e) }); await shutdown(); }
}
function message(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const m = raw as Record<string, unknown>;
  try {
    switch (m.type) {
      case "spawn": void spawn(m).catch(e => { send({ type: "spawn-failed", message: String(e) }); void shutdown(); }); break;
      case "input": if (term && !exited && !stopping && typeof m.data === "string" && m.data.length <= 65536) term.write(m.data); break;
      case "resize": if (term && !exited && Number.isInteger(m.cols) && Number.isInteger(m.rows) && (m.cols as number) >= 2 && (m.cols as number) <= 500 && (m.rows as number) >= 2 && (m.rows as number) <= 200) term.resize(m.cols as number, m.rows as number); break;
      case "pause": paused = true; pauseState(); break;
      case "resume": paused = false; pauseState(); break;
      case "ack": {
        if (!Number.isSafeInteger(m.seq) || (m.seq as number) > seq || (m.seq as number) <= acked) break;
        acked = m.seq as number;
        for (const [n, bytes] of pending) if (n <= acked) { pendingBytes -= bytes; pending.delete(n); }
        if (pendingBytes < 32 * 1024) { flowPaused = false; pauseState(); }
        break;
      }
      case "kill": case "shutdown": void shutdown(); break;
    }
  } catch (e) { send({ type: "host-error", message: String(e) }); void shutdown(); }
}
if (port) port.on("message", e => message(e.data)); else process.on("message", message);
process.on("disconnect", () => { void shutdown(); });
process.on("uncaughtException", e => { send({ type: "host-error", message: e.message }); void shutdown(); });
send({ type: "ready" });
