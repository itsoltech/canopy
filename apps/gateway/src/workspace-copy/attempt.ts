import { copySelectable, copyTotals } from "@canopy/domain/workspace-copy";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import { pathHash } from "./source.ts";
import { manifestOf, sourceCall, targetCall, type CopyEnds } from "./routes.ts";
import { totalDigest, transferFiles } from "./transfer.ts";

/**
 * What to copy. A first attempt carries the client's own file list and paths; later attempts (a resume after a
 * restart, a retry) read a fresh list and select the same files by their SHA-256 path hashes.
 */
export interface CopySelection {
  manifestToken?: string;
  ignoredPaths?: readonly string[];
  confirmedSecrets?: readonly string[];
  /** Legacy full selection (CopyWorkspaceRequest.paths). */
  paths?: readonly string[];
  ignoredHashes?: ReadonlySet<string>;
  secretHashes?: ReadonlySet<string>;
}

export interface CopyAttemptInput extends CopyEnds {
  transferKey: string;
  parentPath: string;
  name: string;
  selection: CopySelection;
}

export interface CopyAttemptProgress {
  status: "copying" | "finishing" | "completed";
  bytes: bigint;
  totalBytes: bigint;
  files: number;
  totalFiles: number;
  /** Paths of files that may contain secrets are never shown. */
  currentFile: string;
  workspaceRef: string;
  skipped: number;
}

/**
 * One pass of a copy: authorize the selection at the source, prepare (or resume) the target's staging directory,
 * move the missing files in parallel frames and publish. `keepStaged` leaves an interrupted target for a resume;
 * `beforeWrite` runs before every frame is written (tests stop a copy at an exact frame with it).
 */
export async function copyAttempt(
  core: GatewayCore,
  input: CopyAttemptInput,
  signal: AbortSignal,
  report: (progress: CopyAttemptProgress) => void,
  options: { keepStaged: boolean; beforeWrite?: (chunks: number) => Promise<void> | void },
): Promise<CopyAttemptProgress> {
  const selection = await resolveSelection(core, input, signal);
  const token = selection.manifestToken;
  const source = sourceCall(core, input, token, signal);
  const target = targetCall(core, input, signal);
  let prepared = false;
  let completed = false;

  try {
    signal.throwIfAborted();

    const authorized = await source({
      authorize: true,
      paths: [...(selection.paths ?? [])],
      ...(selection.ignoredPaths && { ignoredSelection: { paths: [...selection.ignoredPaths] } }),
      confirmedSecrets: [...(selection.confirmedSecrets ?? [])],
    });

    const selected = authorized.entries;
    const totals = copyTotals(selected);

    const progress: CopyAttemptProgress = {
      status: "copying",
      bytes: 0n,
      totalBytes: totals.bytes,
      files: 0,
      totalFiles: totals.files,
      currentFile: "",
      workspaceRef: "",
      skipped: authorized.skipped,
    };

    prepared = true;

    const existing = await target({
      action: {
        case: "prepare",
        value: {
          token: input.transferKey,
          parentPath: input.parentPath,
          name: input.name,
          entries: selected,
          bytes: totals.bytes,
          resume: true,
        },
      },
    });

    if (existing.workspaceRef) {
      completed = true;

      return {
        ...progress,
        status: "completed",
        bytes: totals.bytes,
        files: totals.files,
        workspaceRef: existing.workspaceRef,
      };
    }

    report({ ...progress });
    const files = selected.filter((e) => !e.directory);

    const hashes = await transferFiles(
      { source: token, target: input.transferKey },
      files,
      new Map(existing.staged.map((s) => [s.path, s])),
      {
        read: async (reads) => {
          const batch = (await source({ readBatch: { token, reads } })).batch;

          if (!batch) throw new InvalidError("The transfer lost its place. Retry the copy.");

          return batch;
        },
        write: async (chunks) => {
          await options.beforeWrite?.(chunks.length);
          await target({ action: { case: "writeBatch", value: { token: input.transferKey, chunks } } });
        },
      },
      signal,
      (tick) => {
        progress.bytes += BigInt(tick.bytes);
        progress.files += tick.files;
        progress.currentFile = tick.current.secret ? "Local configuration" : tick.current.path;
        report({ ...progress });
      },
    );

    signal.throwIfAborted();
    report({ ...progress, status: "finishing" });

    const result = await target({
      action: { case: "finish", value: { token: input.transferKey, sha256: totalDigest(files, hashes) } },
    });

    completed = true;

    return { ...progress, status: "completed", currentFile: "", workspaceRef: result.workspaceRef };
  } finally {
    const cleanup = AbortSignal.timeout(15_000);

    if (prepared && !completed && !options.keepStaged)
      await target({ action: { case: "cancel", value: input.transferKey } }, cleanup).catch(() => {});
    await source({ release: true }, cleanup).catch(() => {});
  }
}

/** The client's own list on a first attempt; a fresh list matched by path hashes afterwards. */
async function resolveSelection(core: GatewayCore, input: CopyAttemptInput, signal: AbortSignal) {
  const selection = input.selection;

  if (selection.manifestToken) return { ...selection, manifestToken: selection.manifestToken };
  const manifest = await manifestOf(core, input.sourceRef, signal);

  if (!manifest) throw new InvalidError("Could not read the file list. Try again.");
  const ignored = selection.ignoredHashes ?? new Set();
  const secrets = selection.secretHashes ?? new Set();

  return {
    manifestToken: manifest.token,
    ignoredPaths: manifest.entries.filter((e) => copySelectable(e) && ignored.has(pathHash(e.path))).map((e) => e.path),
    confirmedSecrets: manifest.entries.filter((e) => e.secret && secrets.has(pathHash(e.path))).map((e) => e.path),
  };
}
