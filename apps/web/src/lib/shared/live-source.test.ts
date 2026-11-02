import { expect, test } from "bun:test";
import { liveSource, retryDelay, type LiveSourceEnvironment, type LiveSourceHandlers } from "./live-source.ts";

class Source extends EventTarget {
  closed = false;
  onerror: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  close() { this.closed = true; }
  ready() { this.dispatchEvent(new Event("ready")); }
  fail() { this.dispatchEvent(new Event("failure")); }
}

function setup(handlers: LiveSourceHandlers = { onmessage() {} }) {
  const sources: Source[] = [];
  const timers = new Set<{ run: () => void; delay: number }>();
  const listeners = new Map<string, () => void>();
  let hidden = false;
  let online = true;
  const environment: LiveSourceEnvironment = {
    source: () => {
      const source = new Source();
      sources.push(source);
      return source as unknown as EventSource;
    },
    hidden: () => hidden,
    online: () => online,
    random: () => 1,
    schedule: (run, delay) => {
      const timer = { run, delay };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    listen: (event, run) => {
      listeners.set(event, run);
      return () => { listeners.delete(event); };
    },
  };
  const stop = liveSource("/events", handlers, environment);
  return {
    sources, timers, listeners, stop,
    get current() { return sources.at(-1)!; },
    get delays() { return [...timers].map((timer) => timer.delay); },
    advance() {
      const timer = [...timers].sort((a, b) => a.delay - b.delay)[0]!;
      timers.delete(timer);
      timer.run();
    },
    hide(value: boolean) { hidden = value; listeners.get("visibilitychange")?.(); },
    online(value: boolean) { online = value; listeners.get(value ? "online" : "offline")?.(); },
  };
}

test("HTTP and network errors back off with bounded jitter, then reset after a ready stream", async () => {
  const opened: boolean[] = [];
  let unavailable = 0;
  const live = setup({ onmessage() {}, onopen: (reconnected) => { opened.push(reconnected); }, onfailure: () => unavailable++ });
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    live.current.onerror?.();
    expect(live.current.closed).toBe(true);
    expect(live.delays).toEqual([delay]);
    live.advance();
  }
  expect(unavailable).toBeGreaterThan(0);
  live.current.ready();
  await Promise.resolve();
  live.current.onerror?.();
  expect(live.delays).toEqual([1000]);
  live.advance();
  live.current.ready();
  expect(opened).toEqual([false, true]);
  expect(retryDelay(0, 0)).toBe(750);
  expect(retryDelay(1000, 1)).toBe(15000);
  live.stop();
});

test("hidden tabs cancel retries; focus and online reopen immediately without duplicating healthy streams", () => {
  const live = setup();
  live.current.onerror?.();
  live.hide(true);
  expect(live.timers.size).toBe(0);
  expect(live.sources.length).toBe(1);
  live.hide(false);
  expect(live.sources.length).toBe(2);
  live.current.ready();
  live.hide(true);
  expect(live.current.closed).toBe(false);
  live.hide(false);
  live.listeners.get("focus")?.();
  expect(live.sources.length).toBe(2);
  live.online(false);
  expect(live.current.closed).toBe(true);
  expect(live.timers.size).toBe(0);
  live.online(true);
  expect(live.sources.length).toBe(3);
  live.stop();
  expect(live.timers.size).toBe(0);
  expect(live.listeners.size).toBe(0);
});

test("stale callbacks cannot reconnect or deliver messages after disposal", () => {
  const received: string[] = [];
  const live = setup({ onmessage: (data) => received.push(data) });
  const old = live.current;
  old.fail();
  live.advance();
  old.onmessage?.({ data: "stale" });
  old.ready();
  expect(received).toEqual([]);
  live.stop();
  live.current.onerror?.();
  live.current.ready();
  expect(live.timers.size).toBe(0);
});

test("a failed resync and a silent stream both reopen automatically", async () => {
  let failed = false;
  const live = setup({ onmessage() {}, onopen: async () => { throw new Error("resync unavailable"); }, onfailure: () => { failed = true; } });
  live.current.ready();
  await Promise.resolve();
  await Promise.resolve();
  expect(failed).toBe(true);
  live.advance();
  expect(live.sources.length).toBe(2);
  live.advance(); // No ready/heartbeat for 30 s.
  expect(live.current.closed).toBe(true);
  expect(live.delays).toEqual([2000]);
  live.stop();
});
