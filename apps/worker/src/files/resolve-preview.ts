import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FileContentSchema, FileRequestSchema, FileResolution, type FileRequest } from "@canopy/contracts";
import { isWithin } from "../git/worktrees.ts";
import { CommandError } from "../runtime/host-types.ts";
import { exactFileMatches } from "./search.ts";
import { expandFileHome, resolveReadableFile, resolveThreadFile } from "./thread-files.ts";

type Resolution = MessageInitShape<typeof FileContentSchema>;

type Access = "workspace" | "readable";

function checkedPath(root: string, path: string, workspace = root, access: Access = "workspace"): string {
  if (!path || path.length > 4096 || path.includes("\0") || path.split(/[\\/]/).includes(".."))
    throw new CommandError("FILE_PATH_INVALID", "This file path is invalid. Check the path, then reload.", true);

  path = expandFileHome(path);

  const absolute =
    isAbsolute(path) && isWithin(workspace, path) ? resolve(root, relative(workspace, path)) : resolve(root, path);

  if (access === "workspace" && !isWithin(root, absolute))
    throw new CommandError("FILE_OUTSIDE_ROOTS", "This file is outside this workspace. Choose a file inside it.", true);

  return absolute;
}

/** Reads only existing files, keeping permission, symlink and I/O failures distinct from a missing path. */
function existing(
  request: FileRequest,
  path: string,
  extraRoots: readonly string[],
  access: Access,
): string | undefined {
  try {
    return access === "readable"
      ? resolveReadableFile(path)
      : resolveThreadFile(create(FileRequestSchema, { ...request, path }), extraRoots);
  } catch (cause) {
    if (cause instanceof CommandError && cause.code === "FILE_NOT_FOUND") return undefined;
    throw cause;
  }
}

/** Resolve on the thread's worker, with exact same-turn hints before root and gitignore-aware name lookup. */
export async function resolvePreview(
  request: FileRequest,
  extraRoots: readonly string[],
  access: Access = "workspace",
): Promise<Resolution> {
  const root = realpathSync(request.workspace);
  const raw = request.path.trim();
  const absolute = checkedPath(root, raw, request.workspace, access);
  const displayPath = (path: string) => (isWithin(root, path) ? relative(root, path) : path);
  const searchedPaths = [displayPath(absolute) || "."];
  const bare = !isAbsolute(raw) && !/[\\/]/.test(raw.replace(/^\.[\\/]/, ""));

  const found = (path: string): Resolution => ({
    path,
    // External previews never enter workspace watches or authorize mutations in any client.
    relativePath: isWithin(root, path) ? relative(root, path) : "",
    ...(!isWithin(root, path) && { readOnly: true, sha256: "" }),
    resolution: FileResolution.FOUND,
    searchedPaths,
  });

  if (bare) {
    const preferred = new Set<string>();

    for (const hint of request.preferredPaths.slice(0, 32)) {
      if (basename(hint) !== basename(raw)) continue;
      let candidate: string;

      try {
        candidate = checkedPath(root, hint, request.workspace, access);
      } catch {
        continue; // Invalid hints never change the access policy for this command.
      }

      searchedPaths.push(displayPath(candidate));
      const path = existing(request, candidate, extraRoots, access);

      if (path) preferred.add(path);
    }

    if (preferred.size === 1) return found([...preferred][0]!);

    if (preferred.size > 1)
      return {
        resolution: FileResolution.AMBIGUOUS,
        matches: [...preferred].map(displayPath),
        searchedPaths,
      };
  }

  const direct = existing(request, absolute, extraRoots, access);

  if (direct) return found(direct);

  if (request.expectedSha256)
    return {
      resolution: FileResolution.DELETED,
      relativePath: isWithin(root, absolute) ? relative(root, absolute) : "",
      searchedPaths,
    };

  if (!bare) return { resolution: FileResolution.NOT_FOUND, searchedPaths };
  const listing = await exactFileMatches(root, basename(raw));
  searchedPaths.push("**/" + basename(raw));
  const matches: string[] = [];

  for (const path of listing.matches) {
    const actual = existing(request, checkedPath(root, path), extraRoots, access);

    if (actual) matches.push(actual);
  }

  if (matches.length === 1 && !listing.incomplete) return found(matches[0]!);

  return {
    resolution: matches.length ? FileResolution.AMBIGUOUS : FileResolution.NOT_FOUND,
    matches: matches.map(displayPath),
    searchedPaths,
    searchIncomplete: listing.incomplete,
  };
}
