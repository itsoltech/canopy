import { ui } from "@canopy/contracts";
import { copySize } from "@canopy/domain/workspace-copy";
import { requestJson } from "#lib/shared/http.ts";
import type { SelectOption } from "#lib/shared/ui/listbox.ts";
import { decode } from "#lib/shared/wire.ts";

/**
 * Moving a thread with its session and files to another worker of this gateway (docs/thread-transfers.md).
 * The gateway runs the move in the background; the dialog follows it while open.
 */

export const previewTransfer = async (threadId: string, workerId: string) =>
  decode(
    ui.ThreadTransferPreviewSchema,
    await requestJson("PUT", `/api/threads/${encodeURIComponent(threadId)}/transfer`, { workerId }, 60_000),
  );

export const startTransfer = async (
  threadId: string,
  body: {
    workerId: string;
    workspaceId: string;
    localFiles: string[];
    confirmedSecrets: string[];
    expectedHead: string;
  },
) =>
  decode(
    ui.ThreadTransferSchema,
    await requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/transfer`, body, 60_000),
  );

export const getTransfer = async (id: string) =>
  decode(ui.ThreadTransferSchema, await requestJson("GET", `/api/thread-transfers/${encodeURIComponent(id)}`));

export const transferFinished = (transfer: ui.ThreadTransfer) =>
  transfer.state === "done" || transfer.state === "committed" || transfer.state === "aborted";

/** This gateway's other workers, each saying why it can't take the thread now. */
export function transferTargets(workers: readonly ui.Worker[], current: string): SelectOption[] {
  return workers.flatMap((w) =>
    w.nodeId || w.id === current || w.revokedAt
      ? []
      : [
          {
            value: w.id,
            label: w.name,
            icon: "computer-desktop" as const,
            ...(w.online ? { description: "Online" } : { description: "Offline", disabled: true }),
          },
        ],
  );
}

const PHASES = new Map([
  ["freezing", "Pausing the thread…"],
  ["exporting", "Packing the session and changes…"],
  ["copying", "Copying…"],
  ["checking_out", "Creating the worktree…"],
  ["applying", "Restoring the changes…"],
  ["switching", "Switching workers…"],
  ["releasing", "Cleaning up…"],
]);

/** One line for the move's progress or result. */
export function transferStatus(transfer: ui.ThreadTransfer, target: string): string {
  if (transfer.state === "aborted") return transfer.error || "The thread stayed on its worker.";

  if (transfer.state === "committed" || transfer.state === "done") return `Moved to ${target}.`;
  const phase = PHASES.get(transfer.phase) ?? "Moving…";

  return transfer.phase === "copying" && transfer.totalBytes
    ? `${phase} ${copySize(transfer.bytes)} of ${copySize(transfer.totalBytes)}`
    : phase;
}

/** What moves along, in a few short lines. */
export function transferSummary(preview: ui.ThreadTransferPreview): string[] {
  const lines: string[] = [];
  const changes = preview.changedFiles + preview.untrackedFiles;

  lines.push(
    changes
      ? `${changes.toLocaleString()} changed ${changes === 1 ? "file" : "files"} and the conversation`
      : "The conversation; the checkout has no uncommitted changes",
  );

  if (preview.unpushedCommits)
    lines.push(
      `${preview.unpushedCommits.toLocaleString()} ${preview.unpushedCommits === 1 ? "commit" : "commits"} not pushed yet`,
    );

  if (preview.threads > 1) lines.push(`${preview.threads - 1} side ${preview.threads === 2 ? "thread" : "threads"}`);

  if (preview.instanceLabel) lines.push(`Continues with ${preview.instanceLabel}`);

  return lines;
}
