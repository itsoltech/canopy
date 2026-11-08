import type { Item, Notice, Usage } from "@canopy/contracts";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

export interface TimelineEntry {
  readonly id: string;
  readonly item: Item;
  readonly turnId: string;
  readonly firstSeq: bigint;
  /** From the history a fork inherited (its seq counts in the source thread). */
  readonly inherited: boolean;
  /** Inherited: the thread it belongs to (along a chain of forks, not always the direct source). */
  readonly fromThreadId: string;
  /** Live item times; snapshots bring only a completed agent message's end. */
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
}

/** A notice event (rate limit, retry, provider error, restart); the snapshot brings the latest ones. */
export interface TimelineNotice {
  readonly seq: bigint;
  readonly turnId: string;
  readonly notice: Notice;
  readonly at: Timestamp | undefined;
}

/** Live turn_finished details until the projected turn update arrives. */
export interface TurnResult {
  readonly usage: Usage | undefined;
  readonly reason: string;
}
