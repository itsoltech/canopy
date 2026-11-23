import { app } from "electron";
import { join } from "node:path";
import { desktopIdentity } from "./identity.ts";

export function desktopResourcePaths() {
  if (app.isPackaged)
    return { runtime: join(process.resourcesPath, "runtime"), iconPath: join(process.resourcesPath, "icon.png") };

  const desktop = app.getAppPath();

  return {
    runtime: join(desktop, "build/runtime"),
    iconPath: join(desktop, "../web/static", desktopIdentity().assets, "icon-512.png"),
  };
}
