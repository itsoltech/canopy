import { create } from "@bufbuild/protobuf";
import { EnvironmentFileStatusSchema, type EnvironmentResolution } from "@canopy/contracts";
import { environmentBlock, environmentDigest, readEnvironmentBlock } from "@canopy/domain/agent-environment";
import {
  EnvironmentFileError,
  fileChecksum,
  fileProblem,
  instructionOverrideExists,
  readInstructionFile,
  replaceInstructionFile,
  restoreInstructionFile,
} from "./files.ts";
import type { InstructionLedger, ManagedInstruction } from "./ledger.ts";
import type { InstructionTarget } from "./targets.ts";

export function reconcileInstruction(
  target: InstructionTarget,
  ledger: InstructionLedger,
  resolution: EnvironmentResolution | undefined,
) {
  const status = create(EnvironmentFileStatusSchema, {
    targetId: target.targetId,
    harness: target.harness,
    path: target.path,
    scope: target.scope,
    desiredChecksum: environmentDigest(target.content),
    status: "error",
  });

  try {
    if (ledger.problem) throw new EnvironmentFileError(ledger.problem);
    const current = readInstructionFile(target.path);
    status.observedChecksum = current.checksum;
    let block;
    let malformed = "";

    try {
      block = readEnvironmentBlock(current.text ?? "");
    } catch (error) {
      malformed = error instanceof Error ? error.message : "Invalid managed block markers.";
    }

    const previous = ledger.entries.get(target.targetId);

    const entry: ManagedInstruction = {
      targetId: target.targetId,
      harness: target.harness,
      scope: target.scope,
      path: target.path,
      checksum: previous?.checksum ?? "",
    };

    const kept = previous?.keptDesired === status.desiredChecksum && previous.keptObserved === current.checksum;

    const drift = Boolean(
      malformed ||
      (block ? !previous || environmentDigest(block.content) !== previous.checksum : previous && target.content),
    );

    const force =
      resolution?.desiredChecksum === status.desiredChecksum && resolution.observedChecksum === current.checksum;

    if ((kept && !(force && resolution?.action === "overwrite")) || (drift && force && resolution?.action === "keep")) {
      if (!kept)
        ledger.commit(target.targetId, {
          ...entry,
          keptDesired: status.desiredChecksum,
          keptObserved: current.checksum,
        });
      status.status = "kept";
      status.managedContent = block?.content ?? "";
      status.importable = Boolean(block);
      status.detail = "Local instructions are preserved. A new library or file change will ask again.";

      return status;
    }

    if (malformed || (drift && !(force && resolution?.action === "overwrite"))) {
      status.status = "drift";
      status.managedContent = block?.content ?? "";
      status.importable = Boolean(block);
      status.detail =
        malformed ||
        (resolution && !force
          ? "The file or desired instructions changed after the preview. Refresh before resolving."
          : "The managed block changed outside Canopy. Choose which version to keep.");

      return status;
    }

    if (target.harness === "codex" && target.content && instructionOverrideExists(target.path))
      throw new EnvironmentFileError(
        "AGENTS.override.md takes precedence over AGENTS.md. Review or remove that override before syncing.",
      );
    const rendered = target.content ? environmentBlock(target.content) : "";
    const prefix = current.text ?? "";
    const appended = `${prefix}${prefix ? (prefix.endsWith("\n") ? "\n" : "\n\n") : ""}${rendered}\n`;
    const next = block ? `${block.before}${rendered}${block.after}` : target.content ? appended : prefix;
    let written = false;

    try {
      if (next !== prefix) {
        replaceInstructionFile(target.path, current, next);
        written = true;
      }

      ledger.commit(target.targetId, target.content ? { ...entry, checksum: status.desiredChecksum } : undefined);
    } catch (error) {
      if (written) restoreInstructionFile(target.path, current, next);
      throw error;
    }

    status.status = target.content ? "applied" : "removed";
    status.observedChecksum = fileChecksum(current.text === undefined && !written ? undefined : next);
    status.detail = target.content
      ? "Synced. New harness sessions use these instructions."
      : "Canopy's managed block was removed. Local text was preserved.";
  } catch (error) {
    status.detail = fileProblem(error instanceof Error ? error : new Error("Instruction reconciliation failed."));
  }

  return status;
}
