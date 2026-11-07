import { create, toBinary } from "@bufbuild/protobuf";
import { ImportPageSchema, type ImportPage, type ReadImportPage } from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { indexClaude, MalformedSessionError, type ClaudeIndex } from "./claude-index.ts";
import { readClaudePage, type PageResult } from "./claude-history.ts";
import { ConfinementError, prefixSha, sourceStat, type SourceFile } from "./read.ts";
import type { WorkerImport } from "./service.ts";
import { maskedText, MAX_TURN } from "./turns.ts";
import { resolveSourceKey, SourceKeyError, type ResolvedSource } from "./source-key.ts";

/**
 * ReadImportPage on the worker (docs/import.md, "Strony"): the source key resolves again inside this worker's
 * roots, the file must still start as it did at the scan, and only the scanned prefix is read. The Claude branch
 * index is kept for the source being imported, so the pages of a large session do not re-read the whole file.
 */

const DEFAULT_PAGE = 4 * 1024 ** 2;

/** A page is its budget plus at most one turn (MAX_TURN) and its own fields: far below the link's 32 MiB. */
const PAGE_LIMIT = DEFAULT_PAGE + MAX_TURN + 64 * 1024;

let cached: { key: string; index: ClaudeIndex } | undefined;

export function readImportPage(service: WorkerImport, command: ReadImportPage): ImportPage {
  const cli = service.agentCliOf(command.sourceKey);
  const source = resolve(service, command.sourceKey, cli === "grok" ? "directory" : "file");
  const end = Number(command.snapshot?.size ?? 0n);
  const file: SourceFile = { root: source.root.path, path: source.path };

  try {
    return readPage(service, command, cli, file, end);
  } catch (error) {
    if (error instanceof ConfinementError) throw new CommandError("IMPORT_SOURCE", error.message, false);

    if (error instanceof MalformedSessionError) throw new CommandError("IMPORT_MALFORMED", error.message, false);
    throw error;
  }
}

function readPage(
  service: WorkerImport,
  command: ReadImportPage,
  cli: string,
  file: SourceFile,
  end: number,
): ImportPage {
  checkSnapshot(file, command);
  const cursor = command.cursor ? Number(command.cursor) : 0;

  if (!Number.isInteger(cursor) || cursor < 0 || cursor > end)
    throw new CommandError("IMPORT_CURSOR", "the import position is not valid for this source", false);
  const masker = service.masker(service.roots().roots);
  const maxBytes = Math.min(command.maxBytes || DEFAULT_PAGE, DEFAULT_PAGE);
  const warnings: string[] = [];
  let result: PageResult;
  let title = "";

  if (cli === "claude") {
    const key = `${command.sourceKey}:${end}`;
    const index = cached?.key === key ? cached.index : indexClaude(file, end);
    cached = { key, index };
    title = index.title;
    const sessionId = file.path.slice(file.path.lastIndexOf("/") + 1, -".jsonl".length);
    result = readClaudePage({
      file,
      end,
      cursor,
      threadId: command.threadId,
      sessionId,
      index,
      masker,
      maxBytes,
    });

    if (cursor === 0) {
      if (index.branches > 0)
        warnings.push(`${index.branches} earlier ${index.branches === 1 ? "branch" : "branches"} not imported`);

      if (index.inlineSidechains > 0) warnings.push("Subagent steps in an older format are not imported");
    }
  } else throw new CommandError("IMPORT_UNSUPPORTED", `importing ${cli} threads needs a newer worker`, false);

  if (result.skipped > 0)
    warnings.push(`${result.skipped} ${result.skipped === 1 ? "line" : "lines"} could not be read`);

  const page = create(ImportPageSchema, {
    turns: result.turns,
    nextCursor: String(result.next),
    done: result.done,
    warnings,
    skippedLines: result.skipped,
    bytesRead: BigInt(result.read),
    title: maskedText(title, masker, 4000),
  });

  // The bounds above make this impossible; a page that would not fit the link is never sent.
  if (toBinary(ImportPageSchema, page).length > PAGE_LIMIT)
    throw new CommandError("IMPORT_TOO_LARGE", "an import page grew beyond its bounds", false);

  return page;
}

function resolve(service: WorkerImport, sourceKey: string, kind: "file" | "directory"): ResolvedSource {
  try {
    return resolveSourceKey(service.key, service.roots().roots, sourceKey, kind);
  } catch (error) {
    if (error instanceof SourceKeyError) throw new CommandError("IMPORT_SOURCE", error.message, false);
    throw error;
  }
}

/** The file must still be at least as long and start the same way as at the scan (appending is fine). */
function checkSnapshot(file: SourceFile, command: ReadImportPage): void {
  const snapshot = command.snapshot;

  if (!snapshot) throw new CommandError("IMPORT_SNAPSHOT", "the import has no snapshot of its source", false);
  const size = sourceStat(file).size;

  if (size < snapshot.size || prefixSha(file, Number(snapshot.size)) !== snapshot.prefixSha256)
    throw new CommandError("IMPORT_SOURCE_CHANGED", "the source changed since the scan; scan again", false);
}
