import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ComputerAway, liveSource, type LiveSourceEnvironment } from "../src/lib/shared/live-source";
import type { RecoverySnapshot } from "@canopy/domain/connection-recovery";

class Source extends EventTarget implements EventSource {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url = "/events";
  readonly withCredentials = false;
  readyState: 0 | 1 | 2 = 1;
  onopen: EventSource["onopen"] = null;
  onmessage: EventSource["onmessage"] = null;
  onerror: EventSource["onerror"] = null;
  close() {
    this.readyState = 2;
  }
  send(event: string) {
    this.dispatchEvent(new Event(event));
  }
}

function harness(onopen: () => Promise<void> = async () => {}) {
  let now = 100_000;
  let hidden = false;
  const timers = new Map<() => void, number>();
  const listeners = new Map<string, () => void>();
  const sources: Source[] = [];
  const starts: number[] = [];
  const states: RecoverySnapshot[] = [];
  setSystemTime(new Date(now));

  const environment: LiveSourceEnvironment = {
    source: () => {
      const source = new Source();
      sources.push(source);
      starts.push(now);

      return source;
    },
    hidden: () => hidden,
    online: () => true,
    random: () => 1,
    schedule: (run, delay) => {
      timers.set(run, now + delay);

      return () => {
        timers.delete(run);
      };
    },
    listen: (event, run) => {
      listeners.set(event, run);

      return () => {
        listeners.delete(event);
      };
    },
  };

  const stop = liveSource("/events", { onopen, onmessage() {}, onstatus: (state) => states.push(state) }, environment);

  return {
    sources,
    starts,
    states,
    stop,
    current: () => sources.at(-1)!,
    event: (event: string) => listeners.get(event)?.(),
    hidden: (value: boolean) => {
      hidden = value;
      listeners.get("visibilitychange")?.();
    },
    async advance(ms: number) {
      const target = now + ms;

      for (;;) {
        const next = [...timers].sort((a, b) => a[1] - b[1])[0];

        if (!next || next[1] > target) break;
        now = next[1];
        setSystemTime(new Date(now));
        timers.delete(next[0]);
        next[0]();
        await Promise.resolve();
      }

      now = target;
      setSystemTime(new Date(now));
      await Promise.resolve();
    },
  };
}

afterEach(() => setSystemTime());

describe("browser transport recovery", () => {
  test("failed opens back off, keep unavailable through retries, and clear it only after resync", async () => {
    const h = harness();

    try {
      for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000]) {
        h.current().send("failure");
        await h.advance(delay);
      }

      expect(h.starts).toEqual([100_000, 101_000, 103_000, 107_000, 115_000, 131_000, 161_000]);
      const unavailable = h.states.findIndex((state) => state.status === "unavailable");
      expect(unavailable).toBeGreaterThan(0);
      expect(h.states.slice(unavailable).every((state) => state.status === "unavailable")).toBe(true);
      h.current().send("ready");
      await h.advance(0);
      expect(h.states.at(-1)?.status).toBe("live");
      h.current().send("failure");
      await h.advance(1000);
      expect(h.starts.at(-1)).toBe(162_000);
    } finally {
      h.stop();
    }
  });

  test("hung opens hit the deadline; foreground/manual retry reset the delay without clearing unavailable", async () => {
    const h = harness();

    try {
      await h.advance(12_000);
      expect(h.states.at(-1)?.status).toBe("unavailable");
      h.hidden(true);
      h.hidden(false);
      expect(h.sources.length).toBe(2);
      h.current().send("failure");
      h.event("canopy:reconnect");
      expect(h.sources.length).toBe(3);
      expect(h.states.at(-1)?.status).toBe("unavailable");
      h.current().send("failure");
      await h.advance(1000);
      expect(h.sources.length).toBe(4);
    } finally {
      h.stop();
    }
  });

  test("a late resync from a canceled attempt cannot clear the unavailable decision", async () => {
    let resolve: (() => void) | undefined;

    const h = harness(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );

    try {
      await h.advance(12_000);
      h.current().send("ready");
      h.event("canopy:reconnect");
      resolve?.();
      await h.advance(0);
      expect(h.states.at(-1)?.status).toBe("unavailable");
      h.current().send("ready");
      resolve?.();
      await h.advance(0);
      expect(h.states.at(-1)?.status).toBe("live");
    } finally {
      h.stop();
    }
  });

  test("a linked computer being away never becomes a local gateway outage", async () => {
    const h = harness(async () => {
      throw new ComputerAway();
    });

    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        h.current().send("ready");
        await h.advance(1000);
      }

      expect(h.states.some((state) => state.status === "unavailable")).toBe(false);
    } finally {
      h.stop();
    }
  });
});
