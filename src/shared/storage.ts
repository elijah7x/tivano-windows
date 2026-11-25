// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-54: Shared storage measurement, cleanup breakdown, and worktree
// review prompt contracts.

import type { ChatThread, Project } from "./types";

export interface StorageWorktreeUsage {
  /** App-owned relative id under <dataRoot>/worktrees (never an arbitrary path). */
  id: string;
  /** Display folder name. */
  name: string;
  sizeBytes: number;
  buildFilesSizeBytes: number;
  buildFolderCount: number;
  isRegistered: boolean;
  changedFiles: number | null;
  branch: string | null;
  lastCommitAt: number | null;
  isIdle: boolean;
  canRemove: boolean;
  removeReason:
    | "active-or-archived-chat"
    | "uncommitted-changes"
    | "project-in-use"
    | null;
  usedByThreadTitle: string | null;
  usedByArchived: boolean;
}

export interface RuntimeStorageUsage {
  totalBytes: number;
  cleanableBytes: number;
  supported: boolean;
}

export interface StorageUsageReport {
  chatsBytes: number;
  attachmentsBytes: number;
  patchesBytes: number;
  diagnostics: RuntimeStorageUsage;
  updates: RuntimeStorageUsage;
  worktrees: StorageWorktreeUsage[];
  worktreesDir: string;
}

export interface StorageCleanOptions {
  idleWorktrees: boolean;
  activeWorktrees: boolean;
  diagnostics: boolean;
  updates: boolean;
}

export interface StorageCleanResult {
  usage: StorageUsageReport;
  error?: string | null;
}

export interface StorageBreakdownPart {
  id:
    | "chats"
    | "worktrees"
    | "cleanable"
    | "patches"
    | "diagnostics"
    | "updates";
  title: string;
  bytes: number;
  tone: "blue" | "green" | "accent" | "gray";
}

export interface StorageMetrics {
  idleWorktreeCount: number;
  idleBuildBytes: number;
  activeBuildBytes: number;
  uncommittedCount: number;
  cleanableDiagnosticsBytes: number;
  cleanableUpdatesBytes: number;
  defaultCleanableBytes: number;
  parts: StorageBreakdownPart[];
  totalBytes: number;
}

/** Frozen Storage.buildFolderNames: only these ignored folder names are ever cleaned. */
export const BUILD_FOLDER_NAMES = new Set<string>([
  "node_modules",
  "build",
  "build.noindex",
  ".build",
  "DerivedData",
  "dist",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  "Pods",
  ".dart_tool",
]);

/** Decimal file-size formatter matching ByteCountFormatter(.file). */
export function formatStorageBytes(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1000;
  let idx = 0;
  while (value >= 1000 && idx < units.length - 1) {
    value /= 1000;
    idx++;
  }
  if (value >= 100) return `${Math.round(value)} ${units[idx]}`;
  if (value >= 10) return `${value.toFixed(1).replace(/\.0$/, "")} ${units[idx]}`;
  return `${value.toFixed(2).replace(/\.?0+$/, "")} ${units[idx]}`;
}

/** Compute StorageOverviewSection metrics matching v3.0.0 makeMetrics(). */
export function computeStorageMetrics(usage: StorageUsageReport): StorageMetrics {
  let idleWorktreeCount = 0;
  let idleBuildBytes = 0;
  let activeBuildBytes = 0;
  let uncommittedCount = 0;
  let worktreesTotal = 0;

  for (const wt of usage.worktrees) {
    worktreesTotal += wt.sizeBytes;
    if ((wt.changedFiles ?? 0) > 0) uncommittedCount++;
    if (wt.isIdle) {
      idleBuildBytes += wt.buildFilesSizeBytes;
      if (wt.buildFilesSizeBytes > 0) idleWorktreeCount++;
    } else if (wt.buildFilesSizeBytes > 0) {
      activeBuildBytes += wt.buildFilesSizeBytes;
    }
  }

  const cleanableDiagnosticsBytes = usage.diagnostics.cleanableBytes;
  const cleanableUpdatesBytes = usage.updates.cleanableBytes;
  const defaultCleanableBytes =
    idleBuildBytes + cleanableDiagnosticsBytes + cleanableUpdatesBytes;

  const parts: StorageBreakdownPart[] = [
    {
      id: "chats",
      title: "Chats and attachments",
      bytes: usage.chatsBytes + usage.attachmentsBytes,
      tone: "blue",
    },
    {
      id: "worktrees",
      title: "Worktrees",
      bytes: Math.max(0, worktreesTotal - idleBuildBytes),
      tone: "green",
    },
    {
      id: "cleanable",
      title: "Safe to clean up",
      bytes: defaultCleanableBytes,
      tone: "accent",
    },
  ];

  if (usage.patchesBytes > 0) {
    parts.push({
      id: "patches",
      title: "Worktree recovery patches",
      bytes: usage.patchesBytes,
      tone: "gray",
    });
  }
  const keptDiagnostics = Math.max(
    0,
    usage.diagnostics.totalBytes - cleanableDiagnosticsBytes,
  );
  if (keptDiagnostics > 0) {
    parts.push({
      id: "diagnostics",
      title: "Diagnostic files",
      bytes: keptDiagnostics,
      tone: "gray",
    });
  }
  const keptUpdates = Math.max(
    0,
    usage.updates.totalBytes - cleanableUpdatesBytes,
  );
  if (keptUpdates > 0) {
    parts.push({
      id: "updates",
      title: "Update files",
      bytes: keptUpdates,
      tone: "gray",
    });
  }

  const totalBytes = parts.reduce((sum, part) => sum + part.bytes, 0);

  return {
    idleWorktreeCount,
    idleBuildBytes,
    activeBuildBytes,
    uncommittedCount,
    cleanableDiagnosticsBytes,
    cleanableUpdatesBytes,
    defaultCleanableBytes,
    parts,
    totalBytes,
  };
}

function sanitizeTableCell(value: string): string {
  return value
    .replace(/\|/g, "/")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\r/g, " ");
}

function formatRelativeTime(tsMs: number, nowMs: number): string {
  const diffSec = Math.round((tsMs - nowMs) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return diffSec >= 0 ? "just now" : `${abs} seconds ago`;
  const min = Math.round(abs / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const days = Math.round(hr / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Builds the read-only worktree tidy-up prompt that Settings > Storage
 * prefills into a new standalone chat (frozen WorktreeReviewPrompt.swift).
 */
export function buildWorktreeReviewPromptText(
  usage: StorageUsageReport,
  threads: readonly ChatThread[],
  projects: readonly Project[],
  nowMs = Date.now(),
): string {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const sorted = [...usage.worktrees].sort((a, b) => {
    if (a.isIdle !== b.isIdle) return a.isIdle ? -1 : 1;
    return b.sizeBytes - a.sizeBytes;
  });

  const entries = sorted.map((wt) => {
    const matched = threads.filter((t) => {
      const candidates = [t.worktreeDir, t.hydraHead?.targetCheckout].filter(
        (c): c is string => typeof c === "string" && c.length > 0,
      );
      return candidates.some((c) => {
        const suffix = wt.id.replace(/\//g, "\\");
        return c.endsWith("/" + wt.id) || c.endsWith("\\" + suffix);
      });
    });
    const preferred = [...matched].sort((a, b) => {
      if (!!a.isArchived !== !!b.isArchived) return a.isArchived ? 1 : -1;
      return a.updatedAt - b.updatedAt;
    })[matched.length - 1];

    const projectName =
      (preferred?.projectId ? projectById.get(preferred.projectId)?.name : undefined) ??
      matched
        .map((m) => (m.projectId ? projectById.get(m.projectId)?.name : undefined))
        .find((n): n is string => Boolean(n)) ??
      "-";

    let chatState: string;
    let isActive = false;
    if (!wt.isRegistered) {
      chatState = "Not a worktree";
    } else if (matched.some((t) => !t.isArchived)) {
      chatState = "Active";
      isActive = true;
    } else if (matched.length > 0) {
      chatState = "Archived";
    } else {
      chatState = "None";
    }

    const lastActivityTs = Math.max(
      preferred?.updatedAt ?? 0,
      wt.lastCommitAt ?? 0,
    );
    const lastActivity =
      lastActivityTs > 0 ? formatRelativeTime(lastActivityTs, nowMs) : "-";
    const sizeText = `${formatStorageBytes(wt.sizeBytes)} (${formatStorageBytes(wt.buildFilesSizeBytes)})`;

    const cells = [
      wt.name,
      projectName,
      wt.branch ?? "-",
      preferred?.title ?? wt.usedByThreadTitle ?? "-",
      chatState,
      lastActivity,
      wt.changedFiles === null ? "?" : String(wt.changedFiles),
      sizeText,
    ].map(sanitizeTableCell);

    return { line: `| ${cells.join(" | ")} |`, isActive };
  });

  let rows: string[];
  let omittedCount = 0;
  if (entries.length > 60) {
    const kept = entries.filter((e) => !e.isActive);
    omittedCount = entries.length - kept.length;
    rows = kept.map((e) => e.line);
  } else {
    rows = entries.map((e) => e.line);
  }

  const tableLines = [
    "| Worktree | Project | Branch | Chat | Chat state | Last activity | Uncommitted | Size (build output) |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ];
  let inventory = tableLines.join("\n");
  if (omittedCount > 0) {
    inventory += `\n\n${omittedCount} worktrees used by active chats are left out.`;
  }

  const timestamp = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return [
    "## Goal",
    "Help me tidy up Tivano's Git worktrees: tell me which ones are safe to delete, which ones to keep, and which ones need my attention first. Inspect only. Do not delete or change anything.",
    "",
    "## Background",
    "Each worktree is a separate copy of a project that a Tivano chat works in. Deleting a worktree folder keeps its branch and commits in the repository.",
    `Worktrees folder: ${usage.worktreesDir}`,
    "",
    `## Inventory from Tivano (${timestamp})`,
    inventory,
    "",
    "## Check each worktree (read-only Git commands are fine)",
    "1. Is its branch already merged into the project's default branch or dev? (git merge-base --is-ancestor)",
    "2. Does it have commits that are neither pushed nor merged? (git log <default>..<branch>)",
    "3. What are its uncommitted changes and untracked files? (git status --short)",
    "4. Does it hold ignored files that are not build output, such as .env or a local database?",
    "",
    "## Output",
    "Three groups, each a table with Worktree, Reason and Evidence (a short summary of the command output):",
    "- Safe to delete: no active chat uses it, no uncommitted changes, and its commits are merged or it has none of its own.",
    "- Handle first: unmerged commits or uncommitted changes. Say what to do first.",
    "- Keep: an active chat uses it, or it changed in the last 7 days.",
    "End with how much space the safe group frees. I will delete those myself in Settings › Storage; you may list the matching commands for me to review.",
    "",
    "## Do not",
    "Do not run git worktree remove, rm, git reset, git clean, git checkout or git push, and do not modify any file. When unsure, put it under Handle first and say why.",
  ].join("\n");
}
