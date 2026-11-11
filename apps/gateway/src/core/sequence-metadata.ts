import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";

// Fan-out shares immutable envelopes; charge their size once without retaining bytes or keys.
const metadataSizes = new WeakMap<ui.ThreadUpdate, number>();

/** Permission-bearing controls stay at the home and outside the replication journal. */
export async function sequenceControls(core: GatewayCore, threadId: string) {
  const schedules = await core.listSchedules(create(ui.ListSchedulesRequestSchema, { threadId }));
  const secrets = await coreRun(core, (store) => store.threadSecrets(core[coreState].options.userId, threadId));

  return create(ui.ThreadUpdateSchema, { change: { case: "controls", value: { schedules, secrets } } });
}

export function sequenceMetadata(core: GatewayCore, thread: string) {
  const pending = new Map<string, { update: ui.ThreadUpdate; bytes: number }>();
  let pendingBytes = 0;
  let version = 0;
  let closed = false;
  const wake = new Set<() => void>();

  const unsubscribe = core.hub.observeThread(thread, (update) => {
    if (closed) return;
    version++;

    for (const notify of wake) notify();
    const change = update.change;

    const key =
      change.case === "secret"
        ? `secret:${change.value.requestId}`
        : change.case === "schedule"
          ? `schedule:${change.value.id}`
          : change.case === "event" && change.value.event?.body.case === "usageUpdated"
            ? "usage"
            : undefined;

    if (!key) return;
    let bytes = metadataSizes.get(update);

    if (bytes === undefined) {
      bytes = toBinary(ui.ThreadUpdateSchema, update).length;
      metadataSizes.set(update, bytes);
    }

    pendingBytes += bytes - (pending.get(key)?.bytes ?? 0);
    pending.set(key, { update, bytes });

    // A periodic authoritative control refresh repairs overflow; never retain an unbounded fan-out queue.
    if (pending.size > 128 || pendingBytes > 64 * 1024) {
      pending.clear();
      pendingBytes = 0;
    }
  });

  return {
    get version() {
      return version;
    },
    wait(previous: number, signal: AbortSignal, milliseconds: number) {
      if (previous !== version || signal.aborted) return Promise.resolve();

      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wake.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };

        const timer = setTimeout(done, milliseconds);
        wake.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    },
    drain() {
      const updates = [...pending.values()].map((entry) => entry.update);
      pending.clear();
      pendingBytes = 0;

      return updates;
    },
    close() {
      closed = true;
      unsubscribe();
      pending.clear();
      pendingBytes = 0;

      for (const notify of wake) notify();
    },
  };
}
