// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 draft attachments — bounded port of the frozen attach flow.
// The native file dialog and every path live main-side (the IPC guard
// bars path-bearing payloads); accepted files are copied into the
// app-owned library under <dataRoot>/attachments/<id>/ exactly like the
// frozen Storage.attach copies, so a send still resolves when the
// original file moves or is deleted. Images currently ride the same
// file path — no provider in this build consumes image blocks, so the
// frozen image-input split is honestly out of scope.

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface AttachmentDescriptor {
  id: string;
  name: string;
  size: number;
}

export interface AttachPickResult {
  attached: AttachmentDescriptor[];
  dropped: number;
  /** True when the dialog was dismissed without a selection. */
  canceled?: boolean;
}

interface AttachmentDeps {
  /** <dataRoot>/attachments — app-owned library anchor. */
  attachmentsRoot: string;
  /** Native chooser — injected so tests never touch the OS dialog. */
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  /** engine.addAttachments — bounds the pending set (cap 8). */
  add: (
    threadId: string,
    files: { id: string; name: string; size: number; path: string }[],
  ) => { attached: AttachmentDescriptor[]; dropped: number };
  /** engine.removeAttachment — returns the copy path to clean up. */
  remove: (threadId: string, id: string) => string | undefined;
  /** engine.attachmentDescriptor — names an attachment the thread owns
   *  (pending draft or a sent message) so a preview read is scoped to
   *  records the caller could already see. */
  resolve: (
    threadId: string,
    id: string,
  ) => { name: string; size: number; path?: string } | undefined;
}

/** A single dialog batch can't pick more than this many files — the
 *  frozen per-message cap is enforced separately downstream. */
const MAX_PICK_BATCH = 32;
/** Refuse pathological copies (frozen Storage bounds the library too). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class AttachmentService {
  constructor(private readonly deps: AttachmentDeps) {}

  /** Basename sanitized for the library copy — keeps the visible name
   *  intact for the prompt while never letting a picked file name a
   *  directory outside <attachmentsRoot>/<id>. */
  private static copyName(raw: string): string {
    const name = basename(raw).replace(/[\\/:*?"<>|\r\n]/g, "_");
    return name === "" || name === "." || name === ".." ? "file" : name;
  }

  async pick(threadId: string): Promise<AttachPickResult> {
    const r = await this.deps.showOpenDialog();
    if (r.canceled || r.filePaths.length === 0) {
      return { attached: [], dropped: 0, canceled: true };
    }
    return this.addPaths(threadId, r.filePaths);
  }

  /** F05 downloads popover / any main-resolved path set: the files are
   *  staged into the library exactly like dialog picks — the caller owns
   *  path resolution, this layer owns the copy and the cap. */
  async addPaths(threadId: string, paths: string[]): Promise<AttachPickResult> {
    const files: { id: string; name: string; size: number; path: string }[] = [];
    for (const src of paths.slice(0, MAX_PICK_BATCH)) {
      try {
        const stat = statSync(src);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const id = randomUUID();
        const name = AttachmentService.copyName(src);
        const dest = join(this.deps.attachmentsRoot, id, name);
        mkdirSync(join(this.deps.attachmentsRoot, id), { recursive: true });
        copyFileSync(src, dest);
        files.push({ id, name: basename(src), size: stat.size, path: dest });
      } catch {
        // Unreadable/vanishing picks are skipped, never fatal.
      }
    }
    return this.commit(threadId, files);
  }

  /** Paste/drop path: the renderer ships the bytes it already holds —
   *  never a path — so this gains no file-read primitive the OS-level
   *  paste didn't already grant. Bytes land in the same library. */
  async addBlobs(
    threadId: string,
    blobs: { name: string; data: Uint8Array }[],
  ): Promise<AttachPickResult> {
    const files: { id: string; name: string; size: number; path: string }[] = [];
    for (const b of blobs.slice(0, MAX_PICK_BATCH)) {
      try {
        const id = randomUUID();
        const dest = join(this.deps.attachmentsRoot, id, AttachmentService.copyName(b.name));
        mkdirSync(join(this.deps.attachmentsRoot, id), { recursive: true });
        writeFileSync(dest, b.data);
        files.push({ id, name: basename(b.name) || "file", size: b.data.byteLength, path: dest });
      } catch {
        // Write failures are skipped, never fatal.
      }
    }
    return this.commit(threadId, files);
  }

  /** Hand the staged copies to the engine (cap applies) and remove
   *  every copy it did not keep — the library never grows orphans. */
  private commit(
    threadId: string,
    files: { id: string; name: string; size: number; path: string }[],
  ): AttachPickResult {
    const { attached, dropped } = this.deps.add(threadId, files);
    const kept = new Set(attached.map((a) => a.id));
    for (const f of files) {
      if (!kept.has(f.id)) {
        try {
          rmSync(join(this.deps.attachmentsRoot, f.id), { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    return { attached, dropped };
  }

  remove(threadId: string, id: string): void {
    const path = this.deps.remove(threadId, id);
    if (!path) return;
    try {
      rmSync(join(this.deps.attachmentsRoot, id), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  /** A80 attachment preview — bounded AttachmentPreviewPanel port. The
   *  record must belong to the thread (pending draft or a sent
   *  message); images come back as display bytes, everything else as a
   *  descriptor only. Sent records carry no path — the library copy
   *  still sits at <root>/<id>/<copyName>. */
  read(
    threadId: string,
    id: string,
  ): { kind: "image"; dataUrl: string; name: string; size: number } | { kind: "file"; name: string; size: number } | undefined {
    const rec = this.deps.resolve(threadId, id);
    if (!rec) return undefined;
    const path = rec.path ?? join(this.deps.attachmentsRoot, id, AttachmentService.copyName(rec.name));
    const ext = extname(rec.name).slice(1).toLowerCase();
    if (PREVIEW_EXTS.has(ext) && rec.size <= MAX_PREVIEW_BYTES) {
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size <= MAX_PREVIEW_BYTES) {
          const bytes = readFileSync(path);
          return {
            kind: "image",
            dataUrl: `data:${PREVIEW_MIME[ext] ?? `image/${ext}`};base64,${bytes.toString("base64")}`,
            name: rec.name,
            size: rec.size,
          };
        }
      } catch {
        /* vanished copy — falls through to the descriptor */
      }
    }
    return { kind: "file", name: rec.name, size: rec.size };
  }
}

/** Extensions this build decodes into a thumbnail/preview (bounded
 *  subset of the frozen imageExtensions — Chromium raster formats
 *  only; heic/tiff render as the plain file chip). */
const PREVIEW_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "avif"]);
const PREVIEW_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  avif: "image/avif",
};
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
