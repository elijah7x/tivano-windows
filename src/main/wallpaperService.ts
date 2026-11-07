// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 bounded slice: frozen WallpaperStore — one picked picture kept in
// the library, handed out by basename. The chooser path is injected so
// tests never touch the OS dialog; the renderer can install either a
// dialog-picked path or dropped BYTES — it can never name a filesystem
// path. A pick that is not a picture or cannot be used reports the
// frozen sentence and leaves the current wallpaper alone.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  WALLPAPER_ACCEPTED,
  WALLPAPER_DIR,
  WALLPAPER_FILE_RE,
  WALLPAPER_MAX_BYTES,
  isWallpaperName,
} from "../shared/wallpaper";

export type WallpaperInstall =
  | { status: "installed"; file: string }
  | { status: "cancelled" }
  | { status: "notImage" }
  | { status: "tooLarge" }
  | { status: "error"; reason: string };

export class WallpaperService {
  private readonly dir: string;
  constructor(
    root: string,
    private readonly pick: () => Promise<string | null>,
  ) {
    this.dir = join(root, WALLPAPER_DIR);
  }

  /** Copy an accepted source file into the library; `previous` (the
   *  currently-installed basename) is deleted only AFTER the new file
   *  lands — a failed pick never takes the wallpaper down with it. */
  install(sourcePath: string, previous?: string): WallpaperInstall {
    if (!isWallpaperName(sourcePath)) return { status: "notImage" };
    try {
      if (statSync(sourcePath).size > WALLPAPER_MAX_BYTES)
        return { status: "tooLarge" };
    } catch {
      return { status: "error", reason: "Could not use that picture." };
    }
    const ext = sourcePath.slice(sourcePath.lastIndexOf(".") + 1).toLowerCase();
    const file = `wallpaper-${randomUUID()}.${ext}`;
    try {
      mkdirSync(this.dir, { recursive: true });
      copyFileSync(sourcePath, join(this.dir, file));
    } catch {
      return { status: "error", reason: "Could not use that picture." };
    }
    this.discard(previous, file);
    return { status: "installed", file };
  }

  /** Drop path: bytes + the drop's original name for the extension. */
  installBytes(name: string, data: Uint8Array, previous?: string): WallpaperInstall {
    if (!isWallpaperName(name)) return { status: "notImage" };
    if (data.byteLength > WALLPAPER_MAX_BYTES) return { status: "tooLarge" };
    if (data.byteLength === 0) return { status: "error", reason: "Could not use that picture." };
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const file = `wallpaper-${randomUUID()}.${ext}`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, file), data);
    } catch {
      return { status: "error", reason: "Could not use that picture." };
    }
    this.discard(previous, file);
    return { status: "installed", file };
  }

  /** Show the chooser, then install what was picked. */
  async chooseAndInstall(previous?: string): Promise<WallpaperInstall> {
    const picked = await this.pick();
    if (picked === null) return { status: "cancelled" };
    return this.install(picked, previous);
  }

  /** Drop the wallpaper: the file goes; absent file is a quiet no-op. */
  remove(file?: string): void {
    this.discard(file, null);
  }

  /** Read an installed file for the data channel. The basename pattern
   *  is the traversal guard — `file` never escapes the wallpaper dir. */
  read(file: string): Uint8Array | null {
    if (!WALLPAPER_FILE_RE.test(file)) return null;
    const path = join(this.dir, file);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }

  exists(file: string): boolean {
    return WALLPAPER_FILE_RE.test(file) && existsSync(join(this.dir, file));
  }

  private discard(file: string | null | undefined, keep: string | null): void {
    if (file && file !== keep && WALLPAPER_FILE_RE.test(file)) {
      try {
        unlinkSync(join(this.dir, file));
      } catch {
        /* already gone or locked — the registry moves on regardless */
      }
    }
    // Orphan sweep: installs leave no older wallpaper-* files behind.
    try {
      for (const f of readdirSync(this.dir)) {
        if (f !== keep && WALLPAPER_FILE_RE.test(f)) unlinkSync(join(this.dir, f));
      }
    } catch {
      /* nothing to sweep */
    }
  }
}
