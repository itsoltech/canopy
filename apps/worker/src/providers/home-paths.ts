import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { instructionDirectory } from "../agent-environment/files.ts";

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

    if (!relative(target, canonicalHome(loginSource)) || !relative(target, canonicalHome(protectedDeviceHome)))
      return "The shadow home is also the device CLI home. Choose a separate shadow home to keep the device login unchanged.";
  } catch {
    return "Cannot inspect the provider home. Check its path and directory permissions.";
  }

  return undefined;
}

/** Check overlap even when a protected path is configured for a different, unavailable instance. */
function homeOverlapProblem(privateHome: string, protectedHomes: readonly string[], label: string): string | undefined {
  try {
    const target = canonicalHome(privateHome);
    const nested = (path: string) => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);

    for (const source of new Set(protectedHomes)) {
      const root = canonicalHome(source);

      if (nested(relative(target, root)) || nested(relative(root, target)))
        return `Choose separate ${label} CLI and private home directories outside each other.`;
    }
  } catch {
    return "Cannot inspect the provider home. Check its path and directory permissions.";
  }

  return undefined;
}

export const codexHomeOverlapProblem = (privateHome: string, protectedHomes: readonly string[]) =>
  homeOverlapProblem(privateHome, protectedHomes, "Codex");

export function antigravityHomeProblem(privateHome: string, deviceCliHome: string): string | undefined {
  const overlap = homeOverlapProblem(privateHome, [deviceCliHome], "Antigravity");

  if (overlap) return overlap;

  try {
    // Use the same check as managed skill writes. Existing aliases in any component must be rejected at validation too.
    instructionDirectory(join(privateHome, "skills"), false);
  } catch {
    return "Choose an absolute Antigravity private home with readable directories and no symlinks.";
  }

  return undefined;
}

/** Both the native CLI and the worker manage files below their respective roots. */
export function codexCliHomeProblem(privateHome: string, cliHome: string, deviceHome: string): string | undefined {
  const problem = codexHomeOverlapProblem(privateHome, [cliHome, deviceHome]);

  if (problem) return problem;

  try {
    const source = statSync(cliHome, { throwIfNoEntry: false });

    if (source && !source.isDirectory()) return "The Codex CLI home must be a directory.";
  } catch {
    return "Cannot inspect the provider home. Check its path and directory permissions.";
  }

  return undefined;
}
