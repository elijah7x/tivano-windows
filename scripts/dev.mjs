// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Launch the isolated dev instance: Electron on the built bundle with its own
// data root (<project>/.devdata by default, overridable via TIVANO_DATA_ROOT
// or --data-root). Never touches Mac Tivano / Tivano Dev / production data.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "package.json"));
const electronBin = require("electron");

// ELECTRON_RUN_AS_NODE would degrade the binary to plain Node; never
// propagate it (or debugger leftovers) into the dev instance.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [root, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
