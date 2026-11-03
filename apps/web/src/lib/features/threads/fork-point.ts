import type { ui } from "@canopy/contracts";

/**
 * Where a fork can start (docs/threads.md, "Fork od tury"): after an ended turn (completed, failed, interrupted).
 * A turn the provider never started (no time it started) has no point to fork at, and a running one none yet.
 */
export const forkable = (turn: ui.Turn): boolean => (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") && Boolean(turn.startedAt);

/** "Fork thread": the latest turn a fork can start after (own turns first, then the inherited history). */
export const lastForkPoint = (own: readonly ui.Turn[], inherited: readonly ui.Turn[]): ui.Turn | undefined => own.findLast(forkable) ?? inherited.findLast(forkable);
