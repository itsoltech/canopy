import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FileContentSchema, FileRequestSchema, FileResolution, type FileRequest } from "@canopy/contracts";
import { isWithin } from "../git/worktrees.ts";
import { CommandError } from "../runtime/host-types.ts";
import { exactFileMatches } from "./search.ts";
import { resolveThreadFile } from "./thread-files.ts";

type Resolution = MessageInitShape<typeof FileContentSchema>;

function checkedPath(root: string, path: string): string {
  if (!path || path.length > 4096 || path.includes("\0") || path.split(/[\\/]/).includes(".."))
    throw new CommandError("FILE_PATH_INVALID", "Use a path inside this workspace, then reload.", true);
  const absolute = resolve(root, path);

  if (!isWithin(root, absolute))
    throw new CommandError("FILE_OUTSIDE_ROOTS", "This file is outside this workspace. Choose a file inside it.", true);

  return absolute;
}

/** Reads only existing files, keeping permission, symlink and I/O failures distinct from a missing path. */
function existing(request: FileRequest, path: string, extraRoots: readonly string[]): string | undefined {
  try {
    return resolveThreadFile(create(FileRequestSchema, { ...request, path }), extraRoots);
  } catch (cause) {
    if (cause instanceof CommandError && cause.code === "FILE_NOT_FOUND") return undefined;
    throw cause;
  }
}

/** Resolve on the thread's worker, with exact same-turn hints before root and gitignore-aware name lookup. */
export async function resolvePreview(request: FileRequest, extraRoots: readonly string[]): Promise<Resolution> {
  const root = realpathSync(request.workspace);
  const raw = request.path.trim();
  const absolute = checkedPath(root, raw);
  const searchedPaths = [relative(root, absolute) || "."];
  const bare = !isAbsolute(raw) && !/[\\/]/.test(raw.replace(/^\.[\\/]/, ""));
  const found = (path: string): Resolution => ({
    path,
    relativePath: relative(root, path),
    resolution: FileResolution.FOUND,
    searchedPaths,
  });

  if (bare) {
    const preferred = new Set<string>();

    for (const hint of request.preferredPaths.slice(0, 32)) {
      if (basename(hint) !== basename(raw)) continue;
      let candidate: string;

      try {
        candidate = checkedPath(root, hint);
      } catch {
        continue; // A transcript hint grants no access and never widens the workspace.
      }

      searchedPaths.push(relative(root, candidate));
      const path = existing(request, candidate, extraRoots);

      if (path) preferred.add(path);
    }

    if (preferred.size === 1) return found([...preferred][0]!);

    if (preferred.size > 1)
      return { resolution: FileResolution.AMBIGUOUS, matches: [...preferred].map((p) => relative(root, p)), searchedPaths };
  }

  const direct = existing(request, absolute, extraRoots);

  if (direct) return found(direct);

  if (request.expectedSha256)
    return { resolution: FileResolution.DELETED, relativePath: searchedPaths[0], searchedPaths };

  if (!bare) return { resolution: FileResolution.NOT_FOUND, searchedPaths };
  const listing = await exactFileMatches(root, basename(raw));
  searchedPaths.push("**/" + basename(raw));
  const matches: string[] = [];

  for (const path of listing.matches) {
    const actual = existing(request, checkedPath(root, path), extraRoots);

    if (actual) matches.push(path);
  }

  if (matches.length === 1 && !listing.incomplete) return found(join(root, matches[0]!));

  return {
    resolution: matches.length ? FileResolution.AMBIGUOUS : FileResolution.NOT_FOUND,
    matches,
    searchedPaths,
    searchIncomplete: listing.incomplete,
  };
}
