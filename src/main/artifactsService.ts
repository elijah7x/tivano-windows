// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-41 Toolbox outputs: main-owned artifact catalog. Lists only files the
// thread itself named (see shared/threadArtifacts), hands the renderer
// opaque per-thread ids, and resolves an id back to a path solely from the
// latest listing — the renderer never supplies a path to open or reveal.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import {
  collectArtifactCandidates,
  resolveArtifacts,
  type ArtifactSourceMessage,
  type PathApi,
  type ThreadArtifactItem,
} from "../shared/threadArtifacts";

export interface ArtifactSources {
  directory: string | null;
  messages: readonly ArtifactSourceMessage[];
  turns: readonly { turnId: string; touchedPaths: readonly string[] }[];
}

/** Bounded so a long session with many chats cannot grow the id map. */
const MAX_THREADS = 32;

function statRegularFile(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export class ArtifactsService {
  private readonly byThread = new Map<string, Map<string, string>>();

  constructor(
    private readonly opts: {
      pathApi?: PathApi;
      home?: string | null;
      statFile?: (path: string) => number | null;
    } = {},
  ) {}

  list(threadId: string, sources: ArtifactSources): ThreadArtifactItem[] {
    const touchedByTurn = new Map<string, readonly string[]>();
    for (const t of sources.turns) {
      const prev = touchedByTurn.get(t.turnId) ?? [];
      touchedByTurn.set(t.turnId, [...prev, ...t.touchedPaths]);
    }
    const resolved = resolveArtifacts(
      collectArtifactCandidates({ messages: sources.messages, touchedByTurn }),
      {
        pathApi: this.opts.pathApi ?? nodePath,
        workingDirectory: sources.directory,
        home: this.opts.home !== undefined ? this.opts.home : homedir(),
        statFile: this.opts.statFile ?? statRegularFile,
      },
    );
    const ids = new Map<string, string>();
    const items = resolved.map(({ path, ...rest }) => {
      const id = randomUUID();
      ids.set(id, path);
      return { id, ...rest };
    });
    this.byThread.delete(threadId);
    this.byThread.set(threadId, ids);
    while (this.byThread.size > MAX_THREADS)
      this.byThread.delete(this.byThread.keys().next().value!);
    return items;
  }

  /** Path for an id from this thread's latest listing, if it still exists. */
  resolve(threadId: string, id: string): string | null {
    const path = this.byThread.get(threadId)?.get(id);
    if (path === undefined) return null;
    return (this.opts.statFile ?? statRegularFile)(path) === null ? null : path;
  }
}
