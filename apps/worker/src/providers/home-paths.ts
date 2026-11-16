import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve existing ancestors too, so aliases remain comparable before a home exists. */
function canonicalHome(path: string): string {
  const absolute = resolve(path);

  try {
    return realpathSync(absolute);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(absolute);

    if (parent === absolute) throw error;

    return join(canonicalHome(parent), basename(absolute));
  }
}

export function providerHomeProblem(
  path: string,
  loginSource: string,
  protectedDeviceHome = loginSource,
): string | undefined {
  try {
    const target = canonicalHome(path);

    if (target === canonicalHome(loginSource) || target === canonicalHome(protectedDeviceHome))
      return "The shadow home is also the device CLI home. Choose a separate shadow home to keep the device login unchanged.";
  } catch {
    return "Cannot inspect the provider home. Check its path and directory permissions.";
  }

  return undefined;
}
