// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 downloads popover — bounded port of frozen RecentDownloads: the
// 15 newest files in the OS downloads directory (hidden skipped,
// directories excluded, newest mtime first), plus the two frozen ways
// out — reveal the folder and the ordinary file dialog.
//
// Path discipline mirrors every other attach surface: the renderer sees
// opaque ids and names only; attach resolves the id back to a real path
// main-side, so no filesystem path crosses the bridge.

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface DownloadItem {
  id: string;
  name: string;
  size: number;
  isImage: boolean;
  /** Epoch ms — the renderer shows the list newest-first already; this
   *  field exists for ordering evidence, not display. */
  mtime: number;
}

const LIMIT = 15;
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "heic", "heif", "gif", "tiff", "tif", "bmp", "webp",
]);

export class DownloadsService {
  /** id → absolute path for the most recent listing. Stale listings are
   *  replaced whole, so a late attach can never bind an old id to a
   *  different file than the row showed. */
  private lastListing = new Map<string, string>();
  /** Every listing mints a new generation — an id from an older list
   *  can never resolve against the new one. */
  private generation = 0;

  constructor(private readonly directory: string | null) {}

  dir(): string | null {
    return this.directory;
  }

  async list(): Promise<DownloadItem[]> {
    this.lastListing.clear();
    const dir = this.directory;
    if (!dir) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return []; // unreadable/absent folder → honest empty popover
    }
    const found: { path: string; mtime: number; size: number }[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue; // skipsHiddenFiles
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        found.push({ path, mtime: st.mtimeMs, size: st.size });
      } catch {
        // Vanishing/unreadable files are skipped like the frozen compactMap.
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const gen = ++this.generation;
    const items = found.slice(0, LIMIT).map((f, i) => {
      const id = `${gen}:${i}:${f.mtime.toString(36)}`;
      this.lastListing.set(id, f.path);
      const ext = f.path.slice(f.path.lastIndexOf(".") + 1).toLowerCase();
      return {
        id,
        name: basename(f.path),
        size: f.size,
        isImage: IMAGE_EXTS.has(ext),
        mtime: Math.floor(f.mtime),
      };
    });
    return items;
  }

  /** The real path behind a listed id — null for anything the last
   *  listing did not hand out (an id is never trusted as a path). */
  resolve(id: string): string | null {
    return this.lastListing.get(id) ?? null;
  }
}
