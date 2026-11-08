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
      const refreshed = completed();
      const cached = reads.read("peer", method, request, () => next.promise);
      expect(cached).toEqual(snapshot);
      expect(state()).toBe("fresh");
      next.resolve(snapshot);
      await refreshed;
      expect(state()).toBe("fresh");
    }

    reads.connected("peer");
    const failed = completed();
    expect(
      reads.read<ui.UpdatesSnapshot>("peer", method, request, async () => {
        throw new Error("Peer read failed");
      }),
    ).toEqual(snapshot);
    await failed;
    expect(state()).toBe("stale");
    expect(reads.read("peer", method, request, async () => snapshot)).toEqual(snapshot);
    reads.disconnected("peer");
    expect(state()).toBe("unavailable");
    reads.forget("peer");
    expect(reads.read("peer", method, request, async () => snapshot, undefined, false)).toBeUndefined();
  } finally {
    await reads.close();
  }
});
