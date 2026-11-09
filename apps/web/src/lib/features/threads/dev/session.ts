import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { tick } from "svelte";
import { longThreadSnapshot, streamingTurn } from "./fixture.ts";
import { measureScroll, toEnd } from "./bench.ts";

interface Hooks {
  reset(snapshot: ui.ThreadSnapshot): void;
  apply(update: ui.ThreadUpdate): void;
  scroller(): HTMLElement;
}

interface Sample {
  elapsedMs: number;
  heapBytes: number | undefined;
  nodes: number;
}

interface SessionResult {
  durationMs: number;
  cycles: number;
  messages: number;
  handlerP50Ms: number;
  handlerP95Ms: number;
  longTasks: number;
  longTaskMs: number;
  samples: Sample[];
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const percentile = (values: number[], p: number) =>
  values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;

/** Chromium's optional non-standard heap counter; other engines report no heap rather than zero. */
function heap() {
  // SAFETY: memory is Chromium's optional Performance extension; its absence is handled explicitly.
  return (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
}

/** Dev-only repeatable browser workload. Real elapsed time; 25 text messages/s, one thread visit per cycle. */
export function benchmarkSession(hooks: Hooks) {
  let stopped = false;
  let running = false;
  let result: SessionResult | undefined;

  async function run(minutes = 30, turns = 1000) {
    if (running) throw new Error("A benchmark session is already running");

    if (
      !Number.isFinite(minutes) ||
      minutes <= 0 ||
      minutes > 120 ||
      !Number.isInteger(turns) ||
      turns < 1 ||
      turns > 20_000
    )
      throw new Error("Use 0–120 minutes and 1–20000 turns");
    running = true;
    stopped = false;
    const started = performance.now();
    const times: number[] = [];
    result = {
      durationMs: 0,
      cycles: 0,
      messages: 0,
      handlerP50Ms: 0,
      handlerP95Ms: 0,
      longTasks: 0,
      longTaskMs: 0,
      samples: [],
    };
    const measurement = result;

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        measurement.longTasks++;
        measurement.longTaskMs += entry.duration;
      }
    });

    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) observer.observe({ type: "longtask" });

    const sample = () =>
      measurement.samples.push({
        elapsedMs: performance.now() - started,
        heapBytes: heap(),
        nodes: document.querySelectorAll("*").length,
      });

    try {
      sample();

      while (!stopped && performance.now() - started < minutes * 60_000) {
        const snapshot = longThreadSnapshot({ turns: turns - (measurement.cycles % 3) });
        hooks.reset(snapshot);
        await tick();
        await toEnd(hooks.scroller());
        const live = streamingTurn(snapshot, 200);

        for (const update of live.start) hooks.apply(update);
        const frames: JsonValue[] = live.deltas.map((update) => toJson(ui.ThreadUpdateSchema, update));

        for (const value of frames) {
          if (stopped) break;
          const start = performance.now();
          hooks.apply(fromJson(ui.ThreadUpdateSchema, value));
          times.push(performance.now() - start);
          measurement.messages++;
          await sleep(Math.max(0, 40 - (performance.now() - start)));
        }

        for (const update of live.finish) hooks.apply(update);
        await measureScroll(hooks.scroller(), 20);
        await frame();
        measurement.cycles++;
        sample();
      }
    } finally {
      observer.disconnect();
      times.sort((a, b) => a - b);
      measurement.durationMs = performance.now() - started;
      measurement.handlerP50Ms = percentile(times, 0.5);
      measurement.handlerP95Ms = percentile(times, 0.95);
      running = false;
    }

    return measurement;
  }

  return {
    run,
    stop: () => {
      stopped = true;
    },
    status: () => ({ running, result }),
  };
}
