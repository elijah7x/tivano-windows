// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Type declarations for harness-control.mjs (platform-agnostic control
// layer of the Windows helper harness).

import type { ChildProcess } from "node:child_process";

export const sleep: (ms: number) => Promise<void>;

export type QueryResult =
  | { status: "alive"; ticks: string }
  | { status: "not-found" }
  | { status: "unknown"; why?: string };
export type QueryImpl = (pid: number) => Promise<QueryResult>;

export type IdentVerdict = {
  verdict: "all-dead" | "living" | "unknown";
  living: number[];
  unknown: number;
};

export class IdentityTracker {
  constructor(queryImpl: QueryImpl);
  track(childProcess: ChildProcess): Promise<void>;
  state(pid: number): Promise<"alive" | "dead" | "unknown">;
  checkIdents(
    idents: { pid: number; ticks?: string | null }[],
  ): Promise<IdentVerdict>;
  teardown(killWaitMs?: number): Promise<{ killed: number[]; unknown: string[] }>;
}

export type CaseEvidence =
  | {
      dir: string;
      persisted: true;
      files: { stdout: string; stderr: string; outcome: string };
    }
  | { dir: string; persisted: false; error: string };

export function runCaseIsolated(opts: {
  nodeExe: string;
  harnessPath: string;
  name: string;
  dir: string;
  timeoutMs: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  cleanupWaitMs?: number;
}): Promise<{
  pass: boolean;
  detail?: string;
  timedOut?: boolean;
  cleanup?: "clean" | "unknown";
  ms?: number;
  evidence?: CaseEvidence;
}>;

export function parseProcessQuery(text: string): QueryResult;
export function queryWindowsProcess(pid: number): Promise<QueryResult>;

export function selectCases(
  caseList: [string, number][],
  raw: string | null | undefined,
): [string, number][];
