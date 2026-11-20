import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { eventItemId } from "@canopy/domain";
import { AsyncChannel } from "@canopy/transport";
import { threadRequestSnapshot } from "../store/thread-request-snapshot.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

/** Publish replacements so answers, expirations and reconnects drop obsolete cards. */
export async function* watchThreadRequests(core: GatewayCore, thread: string, signal: AbortSignal) {
  if (signal.aborted) return;
  const { runtime, userId, watchProbeMs } = core[coreState].options;
  const changes = new AsyncChannel<void>();

  const wake = () => {
    if (!changes.queuedItems) changes.push(undefined);
  };

  let related: Set<string> | undefined;
  let revision: string | undefined;

  const unsubscribe = core.hub.observeThread(thread, ({ change }) => {
    if (change.case === "interaction" || (change.case === "thread" && change.value.deletedAt)) wake();

    if (change.case === "event" && change.value.event) {
      const id = eventItemId(change.value.event.body);

      if (id && (!related || related.has(id))) wake();
    }
  });

  const timer = setInterval(wake, watchProbeMs ?? 5000);
  const close = () => changes.close();
  signal.addEventListener("abort", close, { once: true });
  wake();

  try {
    const pulses = changes[Symbol.asyncIterator]();

    while (!signal.aborted && !(await pulses.next()).done) {
      const next = await runtime.runPromise(threadRequestSnapshot(userId, thread, revision), { signal });

      if (!next || signal.aborted) continue;
      related = next.related;
      revision = next.revision;
      yield create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: next.snapshot } });
    }
  } finally {
    clearInterval(timer);
    unsubscribe();
    signal.removeEventListener("abort", close);
    close();
  }
}
