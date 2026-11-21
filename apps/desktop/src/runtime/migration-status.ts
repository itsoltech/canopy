import type { DesktopMigrationStatus } from "@canopy/ui/desktop";
import type { MigrationJournal } from "./migration-state.ts";

export function migrationStatus(operation: MigrationJournal | undefined, error: string | undefined) {
  const phase = operation?.phase ?? "idle";
  const preparation = operation?.preparation;
  const canAbort = !!operation && !["committed", "reviewing", "switching", "completed"].includes(phase);

  const awaitingReview =
    operation?.kind === "join" && ["fenced", "reviewing"].includes(phase) && !!operation.archiveSha256;

  const status: DesktopMigrationStatus = {
    phase:
      error && operation && !awaitingReview
        ? "error"
        : phase === "committed"
          ? "activating"
          : phase === "reviewing"
            ? "fenced"
            : phase,
    canAbort,
    canRecover:
      phase === "reviewing" ||
      (awaitingReview ? !!preparation?.review?.blockers.length : !["idle", "prepared", "completed"].includes(phase)),
    ...(operation && { kind: operation.kind, target: operation.target }),
    ...(preparation && {
      preparation: {
        durationMs: preparation.durationMs,
        ...(preparation.databaseBytes !== undefined && { databaseBytes: preparation.databaseBytes }),
        ...(preparation.timings && { timings: preparation.timings }),
        ...(preparation.peers && { peers: preparation.peers }),
        ...(preparation.selectedPeerIds && { selectedPeerIds: preparation.selectedPeerIds }),
        ...(preparation.review && { review: preparation.review }),
        ...(preparation.routes && { routes: [...preparation.routes] }),
      },
    }),
    ...(error && { error: error }),
  };

  return {
    migration: status,
    migrationRunId: operation?.runId,
    ...(operation?.phase === "switching" &&
      operation.profile &&
      operation.routes &&
      operation.device && {
        migrationDestination: { routes: operation.routes, profile: operation.profile, deviceId: operation.device.id },
      }),
  };
}
