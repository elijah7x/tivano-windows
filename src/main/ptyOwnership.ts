// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface PtyIdentity { pid: number; pgid: number; tty: string; birth: string; }
interface Row extends PtyIdentity { state: string; }
export function parseProcessRows(text: string): Row[] {
  return text.trim().split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), pgid: Number(m[2]), tty: m[3]!, state: m[4]!, birth: m[5]!.trim() }] : [];
  });
}
export const sameProcess = (a: PtyIdentity, b: PtyIdentity): boolean =>
  a.pid === b.pid && a.birth === b.birth;
async function rows(): Promise<Row[]> {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,pgid=,tty=,stat=,lstart="],
    { encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  return parseProcessRows(stdout);
}
const alive = (r: Row): boolean => !r.state.startsWith("Z");
export class PtyOwnership {
  private members = new Map<number, PtyIdentity>();
  private anchor: PtyIdentity | null = null;
  private discoveryEnded = false;
  constructor(private read = rows, private signal = (pid: number, sig: NodeJS.Signals) => process.kill(pid, sig)) {}
  async capture(pid: number): Promise<void> {
    const deadline = Date.now() + 1000;
    do {
      const all = await this.read();
      const root = all.find(r => r.pid === pid && alive(r));
      if (root && /^tty/.test(root.tty)) { this.anchor = root; this.collect(all); return; }
      // node-pty returns the spawn-helper PID before setsid/TTY attachment
      // finishes. Observe it becoming the shell; never guess a group id.
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error(`PTY process identity unavailable for pid ${pid}`);
  }

  private collect(all: Row[]): void {
    if (!this.anchor || this.discoveryEnded) return;
    const root = all.find(r => sameProcess(r, this.anchor!) && alive(r));
    if (!root || root.tty !== this.anchor.tty) { this.discoveryEnded = true; return; }
    // Only enumerate a TTY while its original shell still owns it.
    // Once that anchor exits, never discover processes using the reused name.
    for (const r of all) if (r.tty === root.tty && alive(r)) this.members.set(r.pid, r);
  }
  async refresh(): Promise<void> { this.collect(await this.read()); }
  snapshot(): { anchor: PtyIdentity | null; members: PtyIdentity[] } {
    return { anchor: this.anchor, members: [...this.members.values()] };
  }
  restore(snapshot: { anchor: PtyIdentity | null; members: PtyIdentity[] }): void {
    this.anchor = snapshot.anchor;
    this.members = new Map(snapshot.members.map(m => [m.pid, m]));
    // The original live shell can still anchor discovery after host death.
    // If it has exited, collect() permanently disables TTY enumeration.
    this.discoveryEnded = false;
  }
  async stop(): Promise<boolean> {
    if (!this.anchor) return false;
    const budget = Date.now() + 4500;
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      const all = await this.read();
      this.collect(all);
      const members = [...this.members.values()].sort((a, b) => Number(a.pid === this.anchor!.pid) - Number(b.pid === this.anchor!.pid));
      for (const identity of members) {
        if (Date.now() >= budget) return false;
        // Every delayed signal revalidates the recorded process identity.
        // A missing/reused PID is not a target. Query/permission errors fail.
        const current = (await this.read()).find(r => sameProcess(r, identity) && alive(r));
        if (!current) continue;
        try { this.signal(current.pid, sig); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      }
      const deadline = Date.now() + (sig === "SIGTERM" ? 1200 : 1000);
      do {
        const current = await this.read();
        if (![...this.members.values()].some(m => current.some(r => sameProcess(r, m) && alive(r)))) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
    }
    return false;
  }
}
