import { computerLink as link, ui } from "@canopy/contracts";
import { mismatch } from "./mirror.ts";
import { SNAPSHOT_LISTS } from "./mirror-projection.ts";

/** A partial projection never replaces a durable timeline. */
export class MirrorFrames {
  snapshot: ui.ThreadSnapshot | undefined;
  delta: ui.ThreadSnapshotDelta | undefined;

  get pending() {
    return Boolean(this.snapshot || this.delta);
  }

  accept(update: link.MirrorUpdate): link.MirrorUpdate | undefined {
    if (this.pending && (update.reset || update.commit || update.removedThreadId || update.overview)) throw mismatch();
    const starting = update.snapshotStart || update.deltaStart;
    const ending = update.snapshotEnd || update.deltaEnd;

    if (starting) {
      if (
        this.pending ||
        ending ||
        update.commit ||
        update.removedThreadId ||
        update.overview ||
        update.snapshotStart === update.deltaStart ||
        Boolean(update.snapshot) === Boolean(update.delta)
      )
        throw mismatch();

      if (update.snapshotStart && update.snapshot?.thread) this.snapshot = update.snapshot;
      else if (update.deltaStart && update.delta?.snapshot?.thread) this.delta = update.delta;
      else throw mismatch();

      return undefined;
    }

    if (this.snapshot) {
      if (update.delta || update.deltaEnd) throw mismatch();

      if (update.snapshot) this.append(this.snapshot, update.snapshot);

      if (!update.snapshotEnd) return undefined;
      update.snapshot = this.snapshot;
      this.snapshot = undefined;
    } else if (this.delta) {
      if (update.snapshot || update.snapshotEnd) throw mismatch();

      if (
        update.delta &&
        (update.delta.baseCursor ||
          update.delta.removedItemIds.length ||
          update.delta.removedTurnIds.length ||
          update.delta.removedNoticeSeqs.length ||
          update.delta.snapshot?.thread)
      )
        throw mismatch();

      if (update.delta?.snapshot) this.append(this.delta.snapshot!, update.delta.snapshot);

      if (!update.deltaEnd) return undefined;
      update.delta = this.delta;
      this.delta = undefined;
    } else if (ending || update.delta) throw mismatch();

    return update;
  }

  private append(target: ui.ThreadSnapshot, fragment: ui.ThreadSnapshot) {
    for (const field of SNAPSHOT_LISTS) {
      // SAFETY: The key indexes the same protobuf repeated-field type in both messages.
      const values = target[field] as (typeof fragment)[typeof field][number][];
      values.push(...fragment[field]);
    }
  }
}
