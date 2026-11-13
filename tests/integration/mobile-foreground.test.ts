import { expect, test } from "bun:test";
import { whileForeground } from "../../apps/mobile/src/state/foreground-work";
import { QueryCache } from "@canopy/domain/shared-query";

class Activity {
  currentState = "background";
  listeners = new Set<(state: string) => void>();

  addEventListener(_event: "change", listener: (state: string) => void) {
    this.listeners.add(listener);

    return { remove: () => this.listeners.delete(listener) };
  }

  change(state: string) {
    this.currentState = state;

    for (const listener of this.listeners) listener(state);
  }
}

test("mobile polling removes timers on suspension and cannot restart after screen cleanup", async () => {
  const activity = new Activity();
  const queries = new QueryCache({ coalesceMs: 0 });
  let reads = 0;
  let started = 0;
  let ended = 0;
  let nextRead = Promise.withResolvers<void>();

  const unsubscribe = queries.watch(
    "fixture",
    async () => {
      reads++;
      nextRead.resolve();

      return reads;
    },
    () => {},
  );

  const stop = whileForeground(activity, () => {
    started++;
    const timer = setInterval(() => queries.invalidate("fixture"), 5);

    return () => {
      ended++;
      clearInterval(timer);
    };
  });

  try {
    await nextRead.promise;
    expect(started).toBe(0);
    activity.change("active");
    activity.change("active");
    nextRead = Promise.withResolvers<void>();
    await nextRead.promise;
    expect(started).toBe(1);

    // Let the coalesced read settle before counting: an already-started read is not a new poll.
    await Bun.sleep(0);
    activity.change("inactive");
    activity.change("background");
    const paused = reads;
    await Bun.sleep(25);
    expect(reads).toBe(paused);
    expect(ended).toBe(1);

    nextRead = Promise.withResolvers<void>();
    activity.change("active");
    await nextRead.promise;
    expect(reads).toBeGreaterThan(paused);
    expect(started).toBe(2);
    await Bun.sleep(0);
    stop();
    const closed = reads;
    activity.change("background");
    activity.change("active");
    await Bun.sleep(25);
    expect(reads).toBe(closed);
    expect(ended).toBe(2);
    expect(activity.listeners.size).toBe(0);
  } finally {
    stop();
    unsubscribe();
    queries.dispose();
  }
});
