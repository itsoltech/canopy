import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { setBffStorage } from "@canopy/domain/bff-storage";
import { desktopStorageOptions } from "@canopy/logs/desktop-storage";
import { StorageSampler } from "@canopy/logs/storage";
import type { RuntimePaths } from "./config.ts";

/** The BFF shares its controller's sampler; sidecars receive only fixed local roots. */
export function desktopStorage(
  directory: string,
  paths: RuntimePaths,
  env: NodeJS.ProcessEnv,
  worker?: () => string | undefined,
) {
  const sampler = new StorageSampler(desktopStorageOptions(directory, paths.application, paths.updateCache));
  setBffStorage(() => {
    const snapshot = sampler.snapshot();

    return create(ui.DiagnosticsStorageSchema, {
      ...snapshot,
      component: "desktop",
      sampledAtMs: BigInt(snapshot.sampledAtMs),
      sampleAgeMs: snapshot.sampledAtMs ? Math.max(0, Date.now() - snapshot.sampledAtMs) : 0,
      categories: [...snapshot.categories],
    });
  }, worker);
  env["CANOPY_DESKTOP_DATA_DIR"] = directory;

  if (paths.application) env["CANOPY_DESKTOP_APP_PATH"] = paths.application;

  if (paths.updateCache) env["CANOPY_DESKTOP_UPDATE_CACHE"] = paths.updateCache;

  return sampler;
}
