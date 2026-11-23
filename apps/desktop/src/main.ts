import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";
import { desktopResourcePaths } from "./desktop-resources.ts";
import { desktopIdentity } from "./identity.ts";

// The packaged release channels let macOS render the Icon Composer catalog in the Dock.
if (process.platform === "darwin" && (!app.isPackaged || desktopIdentity().channel === "development"))
  void app.whenReady().then(() => app.dock?.setIcon(desktopResourcePaths().iconPath));

// Separate bundles keep app services and vault initialization out of the viewer process.
const entry = process.argv.includes("--canopy-agent-html-viewer") ? "html-viewer-process" : "desktop-main";
const load = createRequire(join(app.getAppPath(), "dist/main.cjs"));

load(`./${entry}.cjs`);
