import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import { PeerReads } from "./reads.ts";

test("peer refreshes preserve successful update details until an actual failure", async () => {
  const reads = new PeerReads();
  const method = link.ComputerUpdateService.method.getComputerUpdates;
  const request = create(link.ComputerUpdatesRequestSchema);

  const snapshot = create(ui.UpdatesSnapshotSchema, {
    app: { version: "1.0.0", updaterPhase: "downloaded", updaterVersion: "1.1.0", ready: true },
    departure: { state: "failed", reason: "The previous update failed. Check again to retry." },
  });

  const state = () => reads.state("peer", method, request);

  const completed = () => {
    const { promise, resolve } = Promise.withResolvers<void>();

    const off = reads.subscribe(() => {
      off();
      resolve();
    });

    return promise;
  };

  // Announcements clients hear: only reads that changed what they show, never an unchanged refresh.
  let notices = 0;
  const counting = reads.subscribe(() => notices++);

  try {
    const initial = completed();
    expect(reads.read("peer", method, request, async () => snapshot)).toBeUndefined();
    expect(state()).toBe("loading");
    await initial;
    expect(state()).toBe("fresh");

    for (let cycle = 0; cycle < 3; cycle++) {
      // Reconnect invalidates the refresh deadline without discarding the cached snapshot.
      reads.connected("peer");
      const next = Promise.withResolvers<ui.UpdatesSnapshot>();
      const loaded = Promise.withResolvers<void>();
      const before = notices;

      const cached = reads.read("peer", method, request, () => {
        loaded.resolve();

        return next.promise;
      });

      expect(cached).toEqual(snapshot);
      expect(state()).toBe("fresh");
      // The refresh runs, returns the same snapshot and settles without announcing anything.
      await loaded.promise;
      next.resolve(snapshot);
      await Bun.sleep(0);
      expect(state()).toBe("fresh");
      expect(reads.read("peer", method, request, async () => snapshot)).toEqual(snapshot);
      expect(notices).toBe(before);
    }

    // A refresh with different details is announced and replaces the cached snapshot.
    reads.connected("peer");

    const changed = create(ui.UpdatesSnapshotSchema, {
      app: { version: "1.1.0", updaterPhase: "downloaded", updaterVersion: "1.1.0", ready: true },
      departure: { state: "failed", reason: "The previous update failed. Check again to retry." },
    });

    const announced = completed();
    expect(reads.read("peer", method, request, async () => changed)).toEqual(snapshot);
    await announced;
    expect(state()).toBe("fresh");
    expect(reads.read("peer", method, request, async () => changed)).toEqual(changed);

    reads.connected("peer");
    const failed = completed();
    expect(
      reads.read<ui.UpdatesSnapshot>("peer", method, request, async () => {
        throw new Error("Peer read failed");
      }),
    ).toEqual(changed);
    await failed;
    expect(state()).toBe("stale");
    expect(reads.read("peer", method, request, async () => changed)).toEqual(changed);
    reads.disconnected("peer");
    expect(state()).toBe("unavailable");
    reads.forget("peer");
    expect(reads.read("peer", method, request, async () => snapshot, undefined, false)).toBeUndefined();
  } finally {
    counting();
    await reads.close();
  }
});
