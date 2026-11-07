import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, parse, sep } from "node:path";
import { CommandError } from "./host-types.ts";

/** Resolve each segment using disk spelling. Exact names always win, including on case-sensitive volumes. */
export function resolveDirectoryPath(path: string): string {
  if (!isAbsolute(path)) throw new CommandError("CWD_NOT_ABSOLUTE", `${path} must be an absolute directory path`, true);

  try {
    return resolveSegments(sep === "\\" ? path.replaceAll("/", "\\") : path);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      "DIRECTORY_UNAVAILABLE",
      "Could not open this directory. Check the path and its permissions.",
      true,
    );
  }
}

function resolveSegments(path: string): string {
  const { root } = parse(path);
  let directory = realpathSync(root);

  for (const segment of path.slice(root.length).split(sep)) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      directory = realpathSync(join(directory, segment));
      continue;
    }

    const names = siblingNames(directory, segment);
    let name = names.find((entry) => entry === segment);

    if (!name) {
      const matches = names.filter((entry) => {
        if (entry.toLowerCase() !== segment.toLowerCase()) return false;

        try {
          return statSync(join(directory, entry)).isDirectory();
        } catch {
          return false;
        }
      });

      if (matches.length > 1)
        throw new CommandError(
          "CWD_AMBIGUOUS",
          `Several directories match “${segment}”: ${matches
            .sort()
            .map((entry) => `“${entry}”`)
            .join(", ")}. Type an exact name.`,
          true,
        );
      name = matches[0];
    }

    // Keep native filesystem equivalences (for example Unicode normalization on macOS).
    if (!name && existsSync(join(directory, segment))) name = segment;

    if (!name)
      throw new CommandError("CWD_NOT_FOUND", "No such directory. Check the path or choose a directory.", true);
    directory = realpathSync(join(directory, name));

    if (!statSync(directory).isDirectory())
      throw new CommandError("CWD_NOT_DIRECTORY", "This path is not a directory. Choose a directory.", true);
  }

  return directory;
}

/** An exact native path still works through ancestors that permit traversal but not directory listing. */
function siblingNames(directory: string, segment: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (existsSync(join(directory, segment))) return [segment];
    throw error;
  }
}
