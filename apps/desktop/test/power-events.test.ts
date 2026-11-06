import { expect, test } from "bun:test";
import { monitorPower, type PowerEvents } from "../src/power-events.ts";

test("suspend announces immediately; resume resets supervision before a stable wake is announced", () => {
  const listeners = new Map<string, () => void>();

  const events: PowerEvents = {
    on: (event, listener) => {
      listeners.set(event, listener);
    },
  };

  const sent: string[] = [];
  let wake: (() => void) | undefined;

  const stop = monitorPower(
    events,
    async (state) => {
      sent.push(state);
    },
    (run, ms) => {
      expect(ms).toBe(5000);
      wake = run;

      return () => {
        wake = undefined;
      };
    },
  );

  const emit = (event: string) => listeners.get(event)!();

  emit("suspend");
  expect(sent).toEqual(["sleeping"]);
  emit("resume");
  expect(sent.at(-1)).toBe("waking");
  // A short dark wake goes back to sleep without advertising online.
  emit("suspend");
  expect(wake).toBeUndefined();
  expect(sent).not.toContain("connected");
  emit("resume");
  wake!();
  expect(sent.at(-1)).toBe("connected");
  emit("resume");
  emit("unlock-screen");
  expect(wake).toBeUndefined();
  expect(sent.at(-1)).toBe("connected");
  emit("resume");
  stop();
  expect(wake).toBeUndefined();
});

test("sleep does not wait for an unavailable gateway", async () => {
  const listeners = new Map<string, () => void>();

  const events: PowerEvents = {
    on: (event, listener) => {
      listeners.set(event, listener);
    },
  };

  monitorPower(events, async () => {
    throw new Error("gateway not responding");
  });
  expect(listeners.get("suspend")!()).toBeUndefined();
  await Promise.resolve();
});
