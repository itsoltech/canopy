import { expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Schema } from "effect";
import { decodeInfo, syncProcess } from "./support/sync-process.ts";

const Memory = Schema.Struct({
  heap: Schema.Number,
  rss: Schema.Number,
  external: Schema.Number,
  windows: Schema.Number,
  waiting: Schema.Number,
});

const decodeMemory = Schema.decodeSync(Schema.fromJsonString(Memory));

type Memory = typeof Memory.Type;

type Sample = readonly [Memory, Memory];

const MiB = 1024 * 1024;

function record(threads: number, phase: string, cycle: number, sample: Sample) {
  console.info("sync-memory", JSON.stringify({ threads, phase, cycle, home: sample[0], viewer: sample[1] }));

  return sample;
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)]!;
}

function assertPlateau(samples: readonly Sample[], baseline: Sample) {
  expect(samples).toHaveLength(20);

  for (const side of [0, 1] as const) {
    const values = samples.map((sample) => sample[side].heap);
    // Fixed before execution: <=4 MiB above warm-up, <=1 MiB late-cycle drift.
    expect(Math.max(...values) - baseline[side].heap).toBeLessThanOrEqual(4 * MiB);
    expect(median(values.slice(-5)) - median(values.slice(0, 5))).toBeLessThanOrEqual(MiB);

    for (const sample of samples) {
      expect(sample[side].windows).toBe(0);
      expect(sample[side].waiting).toBeLessThanOrEqual(1);
    }
  }
}

/** Opt-in retention correctness check, with separate home/viewer GC heaps. No timing thresholds. */
test.skipIf(!dockerAvailable || process.env["CANOPY_SYNC_MEMORY"] !== "1")(
  "thread sync releases payloads across thread sizes, reconnects and real decode failures",
  async () => {
    const home = syncProcess("home", true);
    const viewer = syncProcess("viewer", true);
    const plateaus: Sample[] = [];

    const sample = async (): Promise<Sample> => [
      decodeMemory(await home.run("memory-gc")),
      decodeMemory(await viewer.run("memory-gc")),
    ];

    try {
      const local = decodeInfo(await viewer.run("info"));
      await home.run("pair", { url: local.address, code: await viewer.run("invitation") });

      for (const count of [1, 10, 50]) {
        await home.run("memory-seed", { count });
        const source = decodeInfo(await home.run("info"));
        const fields = { node: source.node, threads: source.threads };
        await viewer.run("memory-caught", fields);

        const reconnect = async (cycle: number) => {
          await viewer.run("memory-release");
          await viewer.run("memory-reconnect", fields);
          const code = `Reconnect ${count}:${cycle}`;
          await home.run("memory-title", { code });
          await viewer.run("memory-caught", { ...fields, code });
          await viewer.run("memory-watch", fields);
          await viewer.run("memory-release");
        };

        const fail = async (cycle: number) => {
          await viewer.run("memory-watch", fields);
          await home.run("memory-corrupt");
          await viewer.run("memory-failed", fields);
          await viewer.run("memory-release");
          const failed = await sample();
          // The same invalid record must remain suppressed across a subscription restart.
          await viewer.run("memory-reconnect", fields);
          await home.run("memory-suppressed");
          const code = `Repaired ${count}:${cycle}`;
          await home.run("memory-repair", { code });
          await viewer.run("memory-caught", { ...fields, code });

          return failed;
        };

        for (let warm = 0; warm < 5; warm++) {
          await reconnect(warm);
          await fail(warm);
        }

        // Hold different windows concurrently to exercise process-wide LRU eviction.
        await viewer.run("memory-watch", { ...fields, count });
        await viewer.run("memory-release");
        const baseline = record(count, "baseline", 0, await sample());
        const reconnects: Sample[] = [];
        const failures: Sample[] = [];
        const recovered: Sample[] = [];

        for (let cycle = 0; cycle < 20; cycle++) {
          await reconnect(cycle + 5);
          reconnects.push(record(count, "reconnect", cycle + 1, await sample()));
        }

        for (let cycle = 0; cycle < 20; cycle++) {
          failures.push(record(count, "failure", cycle + 1, await fail(cycle + 5)));
          recovered.push(record(count, "recovered", cycle + 1, await sample()));
        }

        assertPlateau(reconnects, baseline);
        assertPlateau(failures, baseline);
        assertPlateau(recovered, baseline);
        plateaus.push(await sample());

        // Quadruple the largest source history; retained heap must depend on the window.
        await home.run("memory-grow");
        await home.run("memory-title", { code: `Grown ${count}` });
        await viewer.run("memory-caught", { ...fields, code: `Grown ${count}` });
        await viewer.run("memory-watch", fields);
        await viewer.run("memory-release");
        const grown = record(count, "larger-history", 0, await sample());

        for (const side of [0, 1] as const) expect(grown[side].heap - baseline[side].heap).toBeLessThanOrEqual(4 * MiB);
      }

      for (const side of [0, 1] as const) {
        const heaps = plateaus.map((entry) => entry[side].heap);
        expect(Math.max(...heaps) - Math.min(...heaps)).toBeLessThanOrEqual(4 * MiB);
      }
    } finally {
      await viewer.close();
      await home.close();
    }
  },
  600_000,
);
