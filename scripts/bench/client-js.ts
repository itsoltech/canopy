import { fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { lexMarkdown } from "@canopy/domain/markdown";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { FeedBuilder, type FeedInput } from "../../apps/web/src/lib/features/threads/feed.ts";
import { longThreadSnapshot, streamingTurn } from "../../apps/web/src/lib/features/threads/dev/fixture.ts";
import { turnBody } from "../../apps/mobile/src/features/timeline/turn-plan.ts";
import { visibleTurns } from "../../apps/mobile/src/features/threads/thread-turns.ts";
import { PersistentThreadCache, type ThreadCacheStorage } from "../../apps/mobile/src/storage/thread-cache.ts";

/** CPU measurements, not a test suite. Deterministic data; no application, native modules or user files. */
const turns = Number(process.env["CANOPY_BENCH_TURNS"] ?? 1000);

if (!Number.isInteger(turns) || turns < 1 || turns > 20_000) throw new Error("CANOPY_BENCH_TURNS must be 1–20000");

const snapshot = longThreadSnapshot({ turns });
const live = streamingTurn(snapshot, 200);
let current = snapshot;

for (const update of live.start) current = applyThreadUpdate(current, update);

async function measure(name: string, run: () => void | Promise<void>, repeats = 30) {
  for (let i = 0; i < 5; i++) await run();
  const times: number[] = [];

  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  console.info(
    JSON.stringify({
      metric: name,
      medianMs: times[Math.floor(times.length / 2)],
      p95Ms: times[Math.floor(times.length * 0.95)],
      repeats,
    }),
  );
}

console.info(
  JSON.stringify({
    runtime: Bun.version,
    turns,
    items: snapshot.items.length,
    encodedBytes: toBinary(ui.ThreadSnapshotSchema, snapshot).byteLength,
  }),
);

const frames = live.deltas.map((update) => toJson(ui.ThreadUpdateSchema, update));

await measure("protobuf JSON decode + reducer / 200 deltas", () => {
  let state = current;

  for (const frame of frames) state = applyThreadUpdate(state, fromJson(ui.ThreadUpdateSchema, frame));
});

const builder = new FeedBuilder();

const input: FeedInput = {
  entries: snapshot.items.flatMap((entry) =>
    entry.item
      ? [
          {
            id: entry.item.itemId,
            item: entry.item,
            turnId: entry.turnId,
            firstSeq: entry.firstSeq,
            inherited: entry.inherited,
            fromThreadId: entry.fromThreadId,
          },
        ]
      : [],
  ),
  turns: snapshot.turns,
  notices: [],
  results: new Map(),
  steering: [],
  working: false,
  inheritedEntries: [],
  inheritedTurns: [],
  historyOpen: false,
  openWork: new Set(),
};

await measure("web feed / unchanged history", () => {
  builder.build(input);
});

await measure("mobile visible turns", () => {
  visibleTurns(snapshot);
});

const entries = snapshot.items.filter((entry) => entry.turnId === snapshot.turns[0]?.id);

await measure("mobile turn body / typical turn", () => {
  turnBody(snapshot.turns[0]!, entries, []);
});

const nested = Array.from({ length: 5000 }, (_, i) =>
  create(ui.TimelineItemSchema, {
    turnId: "nested",
    firstSeq: BigInt(i),
    item: create(ItemSchema, {
      itemId: `nested-${i}`,
      parentItemId: i ? "nested-0" : "",
      status: ItemStatus.COMPLETED,
      content: { case: "agentMessage", value: { text: "Nested work" } },
    }),
  }),
);

await measure(
  "mobile turn body / 5000 sibling items",
  () => {
    turnBody(create(ui.TurnSchema, { id: "nested" }), nested, []);
  },
  10,
);

const markdown = snapshot.items
  .flatMap((entry) => (entry.item?.content.case === "agentMessage" ? [entry.item.content.value.text] : []))
  .slice(0, 100)
  .join("\n\n");

await measure("markdown lex / long answer", () => {
  lexMarkdown(markdown);
});

const storage: ThreadCacheStorage = {
  list: async () => [],
  read: async () => new Uint8Array(),
  write: async () => {},
  touch: async () => {},
  remove: async () => {},
  clear: async () => {},
};

const cache = new PersistentThreadCache(storage);

await measure("mobile cache save / serialization + queue, no disk", () => cache.save(snapshot), 10);

await cache.close();
