// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Main-owned directory chooser. The renderer can only ASK for the
// chooser — every path arrives exclusively through the injected
// showOpenDialog implementation (the real Electron dialog in production,
// a scripted resolver in tests). No renderer payload, no environment
// variable, no preload surface can name a directory: authorization is
// created only here, in main, from what the dialog actually returned.

import type { OpenDirectoryResult, Project } from "../shared/types";

export type { OpenDirectoryResult };

export interface OpenDirectoryDeps {
  /** The ONLY directory source — the real `dialog.showOpenDialog` wired
   *  to the current BrowserWindow in index.ts, scripted in tests. */
  showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }>;
  /**
   * "May a project be created right now?" Checked BEFORE the chooser
   * opens and AGAIN after it resolves — a window that was destroyed or
   * an engine that entered closing/read-only while the chooser was up
   * must never materialize a late project.
   */
  usable(): boolean;
  /**
   * Bind one dialog-supplied path: canonicalize, dedupe, durable grant,
   * persisted project (engine.openUserDirectory). Throws on failure.
   */
  attach(rawPath: string): { project: Project; reused: boolean };
}

export class DirectoryOpener {
  private inFlight: Promise<OpenDirectoryResult> | null = null;

  constructor(private readonly deps: OpenDirectoryDeps) {}

  /**
   * Exactly one chooser at a time. A concurrent invocation coalesces
   * onto the pending open rather than stacking a second native dialog
   * or racing project creation.
   */
  open(): Promise<OpenDirectoryResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<OpenDirectoryResult> {
    if (!this.deps.usable()) return { opened: [], cancelled: true };
    const result = await this.deps.showOpenDialog();
    // The world may have moved while the chooser was up — destroyed
    // window, entered closing/read-only — re-check before binding.
    if (!this.deps.usable()) return { opened: [], cancelled: true };
    if (
      result.canceled ||
      !Array.isArray(result.filePaths) ||
      result.filePaths.length === 0
    )
      return { opened: [], cancelled: true };
    const opened: Project[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const raw of result.filePaths) {
      if (typeof raw !== "string" || seen.has(raw)) continue;
      seen.add(raw);
      try {
        const { project, reused } = this.deps.attach(raw);
        if (!reused || !opened.some((p) => p.id === project.id)) opened.push(project);
      } catch (err) {
        errors.push(`${raw}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Total failure is an error; partial success still reports what failed.
    if (opened.length === 0 && errors.length > 0) throw new Error(errors[0]);
    return { opened, cancelled: false, ...(errors.length ? { errors } : {}) };
  }
}
