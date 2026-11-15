import { app } from "electron";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { Schema } from "effect";
import { getAppCacheDir } from "electron-updater/out/AppAdapter.js";

/** Only main supplies installation roots; browser requests cannot select directories. */
export function desktopStoragePaths() {
  if (!app.isPackaged) return {};

  const application =
    process.platform === "darwin"
      ? resolve(process.resourcesPath, "../..")
      : process.env["APPIMAGE"] || dirname(process.execPath);

  let cacheName = app.getName();

  try {
    const configuration = Schema.decodeUnknownSync(
      Schema.Struct({ updaterCacheDirName: Schema.optionalKey(Schema.String) }),
    )(load(readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8")));

    if (configuration.updaterCacheDirName) cacheName = configuration.updaterCacheDirName;
  } catch {
    // The updater uses the app name when packaged metadata has no cache name.
  }

  return { application, updateCache: join(getAppCacheDir(), cacheName) };
}
