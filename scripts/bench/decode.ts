import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema, ui } from "@canopy/contracts";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { decodeSnapshotRows } from "../../apps/gateway/src/store/snapshot-decode.ts";

const { values } = parseArgs({ options: { run: { type: "boolean" } } });

if (!values.run) throw new Error("Opt in with --run; synthetic in-memory rows only");

const rows: JsonValue[] = Array.from({ length: 32768 }, (_, n) => ({
  itemId: `item-${n}`,
  status: "ITEM_STATUS_COMPLETED",
  agentMessage: { text: "synthetic output ".repeat(256) },
}));

const decode = (row: JsonValue) =>
  create(ui.TimelineItemSchema, { item: fromJson(ItemSchema, row), firstSeq: 1n, lastSeq: 2n });

const results: object[] = [];

const modes: { cooperative: boolean; times: number[]; gaps: number[]; rounds: number[] }[] = [false, true].map(
  (cooperative) => ({ cooperative, times: [], gaps: [], rounds: [] }),
);

for (let round = 0; round < 3; round++) {
  for (const mode of round % 2 ? modes.toReversed() : modes) {
    const { cooperative, times, gaps } = mode;
    const current: number[] = [];
    let last = performance.now();

    const timer = globalThis.setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 1);

    try {
      for (let iteration = 0; iteration < 22; iteration++) {
        await setTimeout(2);
        const start = performance.now();
        const output = cooperative ? await decodeSnapshotRows(rows, decode) : rows.map(decode);
        const elapsed = performance.now() - start;

        if (output.length !== rows.length || output.at(-1)?.item?.itemId !== `item-${rows.length - 1}`)
          throw new Error("Decode omitted or reordered rows");

        if (iteration >= 2) current.push(elapsed);
      }

      await setTimeout(2);
    } finally {
      globalThis.clearInterval(timer);
    }

    times.push(...current);
    mode.rounds.push(current.toSorted((a, b) => a - b)[18]!);
  }
}

for (const { cooperative, times, gaps, rounds } of modes) {
  const percentile = (samples: number[], p: number) =>
    samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * p) - 1];

  results.push({
    cooperative,
    rows: rows.length,
    queries: 0,
    p95Ms: percentile(times, 0.95),
    roundP95Ms: rounds,
    timerGapP95Ms: percentile(gaps, 0.95),
    timerGapMaxMs: Math.max(...gaps),
  });
}

console.log(
  JSON.stringify(
    {
      iterations: 20,
      rounds: 3,
      warmups: 2,
      results,
      method:
        "Same 32768 protobuf item rows; 3 rounds, alternating mode order,2 warmups per mode each round;1 ms timer gaps include scheduling and GC. Decode only, without SQL JSON parsing or transport serialization; no latency trace overhead.",
    },
    null,
    2,
  ),
);
