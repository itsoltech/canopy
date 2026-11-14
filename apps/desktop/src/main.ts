import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";

// Separate bundles keep app services and vault initialization out of the viewer process.
const entry = process.argv.includes("--canopy-agent-html-viewer") ? "html-viewer-process" : "desktop-main";
const load = createRequire(join(app.getAppPath(), "dist/main.cjs"));

load(`./${entry}.cjs`);
