import { create } from "@bufbuild/protobuf";
import { ImportLibraryContentSchema, type ImportLibraryContent, type ReadImportLibraryItem } from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { INSTRUCTION_BYTES, libraryPlace, sha256 } from "./library-scan.ts";
import { readCommand, readSkill } from "./library-skills.ts";
import { ConfinementError, readSourceText } from "./read.ts";
import type { WorkerImport } from "./service.ts";
import { resolveSourceKey, SourceKeyError, sourceKeyPath } from "./source-key.ts";
import { maskText } from "./masking.ts";

/**
 * Content of one library item the owner chose to import (docs/import.md, "Ustawienia i biblioteka"): a key may name
 * only the fixed places of LIBRARY_PLACES, and the file must still be the one the scan saw (its digest). Text leaves
 * the worker masked.
 */
export function readImportLibraryItem(service: WorkerImport, request: ReadImportLibraryItem): ImportLibraryContent {
  const roots = service.libraryRoots();
  const masker = service.masker(service.roots().roots);

  try {
    const rel = sourceKeyPath(request.sourceKey);
    const id = request.sourceKey.split(".")[0];
    const place = libraryPlace(roots.find((r) => r.id === id)?.agentCli ?? "claude", rel);

    if (!place) throw new SourceKeyError("the source is not a library item");

    const { root, path } = resolveSourceKey(
      service.key,
      roots,
      request.sourceKey,
      place === "skill" ? "directory" : "file",
    );

    if (place !== "file") {
      const read = place === "skill" ? readSkill(root, rel, masker) : readCommand(root, rel, masker);

      if (!read.artifact) throw new CommandError("IMPORT_SOURCE", read.problem || "the skill is not valid", false);

      if (request.digest && read.artifact.checksum !== request.digest)
        throw new CommandError("IMPORT_CHANGED", "the skill changed since the scan; scan again", false);

      return create(ImportLibraryContentSchema, { digest: read.artifact.checksum, files: read.files });
    }

    const text = readSourceText({ root: root.path, path }, INSTRUCTION_BYTES * 4);

    if (text === undefined) throw new CommandError("IMPORT_SOURCE", "the file is too large or can't be read", false);
    const digest = sha256(text);

    if (request.digest && digest !== request.digest)
      throw new CommandError("IMPORT_CHANGED", "the file changed since the scan; scan again", false);

    return create(ImportLibraryContentSchema, { text: maskText(text, masker), digest });
  } catch (cause) {
    if (cause instanceof SourceKeyError || cause instanceof ConfinementError)
      throw new CommandError("IMPORT_SOURCE", cause.message, false);
    throw cause;
  }
}
