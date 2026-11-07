// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Type surface for terminal-session.mjs — shared stdout ingestion,
// session-ready staging and bounded opt-in diagnostics.

export const DIAG_ENV: string;
export const STDOUT_CAP: number;
export const STDERR_CAP: number;
export const LINE_MAX: number;
export const MAX_MSGS: number;
export const MAX_MALFORMED: number;
export const DATA_CAP: number;
export const TAIL_BYTES: number;
export const MAX_SNAPSHOTS: number;
export const SNAPSHOT_MAX_BYTES: number;
export const MAX_STAGES: number;
export const MAX_DIAG_ERRORS: number;

export interface IngestHooks {
  send: (obj: unknown) => void;
  kill: () => void;
}
export function attachStdoutIngest(cp: any, h: any, hooks: IngestHooks): void;

export interface ReadyWaits {
  waitSpawned: (h: any) => Promise<any>;
  waitPrompt: (h: any) => Promise<any>;
}
export function sessionReady(h: any, waits: ReadyWaits): Promise<boolean>;

export interface DiagClock { mono: () => number; wall: () => string }
export interface DiagIo {
  openSync: (path: string, flags: string, mode?: number) => number;
  writeSync: (fd: number, buf: Buffer, off: number, len: number) => number;
  closeSync: (fd: number) => void;
}
export interface DiagTails { pendingLine: string; output: string }
export interface DiagOptions {
  dir: string; pid: number; seq: number; caseName?: string;
  clock?: DiagClock; io?: DiagIo;
  tailsSource?: () => DiagTails;
}
export interface StreamStat {
  file: string; cap: number; observedBytes: number; retainedBytes: number;
  truncated: boolean; broken: boolean;
}

export class SessionDiagnostics {
  constructor(opts: DiagOptions);
  errors: string[];
  streams: { stdout: StreamStat; stderr: StreamStat };
  counters: { parsed: number; malformed: number; frames: Record<string, number> };
  stages: Array<Record<string, unknown>>;
  snapshotsWritten: number;
  snapshotsDropped: number;
  closed: boolean;
  feedStdout(buf: Buffer | string): void;
  feedStderr(buf: Buffer | string): void;
  noteFrame(type: unknown): void;
  noteParsed(ok: boolean): void;
  stage(name: string, event: string, extra?: Record<string, unknown>): void;
  finalize(): Promise<string[]>;
}

export function applyDiagnosticVerdict(res: any, errors: string[]): any;
