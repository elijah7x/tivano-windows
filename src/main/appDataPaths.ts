// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Data-root resolution, extracted pure for testing (P2H).
//
// Rules:
//   --data-root=<abs|rel> flag   → wins over everything
//   TIVANO_DATA_ROOT env         → supported test/runtime override
//   packaged build               → <OS appData>/Tivano Windows Dev —
//                                  NEVER inside the install dir or the
//                                  ASAR (app.getAppPath() points there)
//   unbundled development        → <project>/.devdata (unchanged)
//
// Resolution happens before app "ready" and performs no writes. The
// chosen root is always per-edition: this product never reuses the
// Tivano, Tivano Dev or Droppy stores and imports no credentials.

import { isAbsolute, join, resolve } from "node:path";

/** Product-private folder name inside the OS app-data directory. This
 *  string must stay in sync with productName in
 *  config/windows-dev-builder.cjs — deliberately NOT derived from
 *  app.getName() because the dev unbundled name differs. */
export const PACKAGED_DATA_DIR_NAME = "Tivano Windows Dev";

export interface DataRootInputs {
  argv: readonly string[];
  env: { TIVANO_DATA_ROOT?: string | undefined };
  /** app.isPackaged — true inside a built package. */
  packaged: boolean;
  /** app.getAppPath() — the project dir unbundled, the ASAR when packed. */
  appPath: string;
  /** app.getPath("appData") — OS per-user app-data dir. */
  appDataDir: string | (() => string);
}

export interface DataRootDecision {
  root: string;
  source: "flag" | "env" | "dev-default" | "packaged-default";
}

export function resolveDataRoot(i: DataRootInputs): DataRootDecision {
  const flag = i.argv.find((a) => a.startsWith("--data-root="));
  if (flag) {
    const v = flag.slice("--data-root=".length);
    if (v !== "") return { root: resolve(v), source: "flag" };
  }
  if (i.env.TIVANO_DATA_ROOT)
    return { root: resolve(i.env.TIVANO_DATA_ROOT), source: "env" };
  if (i.packaged) {
    const appDataDir = typeof i.appDataDir === "function" ? i.appDataDir() : i.appDataDir;
    if (!isAbsolute(appDataDir) || appDataDir.trim() === "")
      throw new Error("packaged build: OS app-data directory is unavailable");
    return {
      root: join(appDataDir, PACKAGED_DATA_DIR_NAME),
      source: "packaged-default",
    };
  }
  return { root: join(i.appPath, ".devdata"), source: "dev-default" };
}
