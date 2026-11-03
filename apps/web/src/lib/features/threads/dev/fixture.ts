import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ItemDeltaField, ItemSchema, ItemStatus, Provider, ThreadEventSchema, ui, type Item } from "@canopy/contracts";

type ItemContent = MessageInitShape<typeof ItemSchema>["content"];
type EventBody = MessageInitShape<typeof ThreadEventSchema>["body"];

/**
 * A long synthetic thread for the dev benchmark (`/dev/long-thread`): turns with markdown answers,
 * reasoning, commands with long output, diffs, tool calls and subagents with nested items, optionally
 * forked (inherited history). Deterministic, so runs compare. Never talks to the gateway.
 */
export interface FixtureOptions {
  readonly turns: number;
  /** Inherited turns (a fork's history) before the thread's own turns. */
  readonly inherited?: number;
}

export const FIXTURE_THREAD_ID = "dev-long-thread";
const SOURCE_ID = "dev-long-thread-source";
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

const words = "agent thread worker gateway snapshot reducer timeline render measure scroll anchor stream delta item turn".split(" ");
const sentence = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => words[(seed * 7 + i * 3) % words.length]).join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
const paragraphs = (count: number, seed: number) => Array.from({ length: count }, (_, i) => `${sentence(14 + ((seed + i) % 9), seed + i)} ${sentence(10, seed + i + 1)}`);

function answer(seed: number): string {
  const parts = paragraphs(2 + (seed % 3), seed);
  if (seed % 3 === 0) parts.splice(1, 0, "```ts\n" + Array.from({ length: 6 + (seed % 10) }, (_, i) => `const value${i} = compute(${i}, "${words[i % words.length]}");`).join("\n") + "\n```");
  if (seed % 4 === 1) parts.push(Array.from({ length: 4 }, (_, i) => `- ${sentence(6, seed + i)}`).join("\n"));
  return parts.join("\n\n");
}

const output = (lines: number, seed: number) => Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(4)}  ${sentence(8, seed + i)}`).join("\n");
const diff = (seed: number) =>
  ["@@ -1,6 +1,8 @@", ...Array.from({ length: 24 }, (_, i) => `${i % 5 === 0 ? "+" : i % 7 === 0 ? "-" : " "} line ${i} ${sentence(5, seed + i)}`)].join("\n");

const item = (id: string, content: ItemContent, parentItemId = ""): Item => create(ItemSchema, { itemId: id, parentItemId, status: ItemStatus.COMPLETED, content });

/** Items of one turn (the provider's echo of the input first). */
function turnItems(prefix: string, seed: number, input: string): Item[] {
  const items: Item[] = [
    item(`${prefix}-user`, { case: "userMessage", value: { text: input, attachments: [], authorUserId: "", authorAgentId: "" } }),
    item(`${prefix}-reasoning`, { case: "reasoning", value: { text: paragraphs(1, seed).join(""), summary: sentence(6, seed) } }),
  ];
  const commands = 1 + (seed % 3);
  for (let c = 0; c < commands; c++) {
    items.push(
      item(`${prefix}-cmd${c}`, {
        case: "commandExecution",
        value: {
          command: `bun test --filter ${words[(seed + c) % words.length]}`,
          cwd: "/srv/canopy",
          exitCode: seed % 11 === 0 && c === 0 ? 1 : 0,
          output: output(c === 0 ? 40 + (seed % 5) * 60 : 8, seed + c),
          durationMs: BigInt(1200 + c * 300),
        },
      }),
    );
  }
  if (seed % 2 === 0) {
    items.push(
      item(`${prefix}-edit`, {
        case: "fileChange",
        value: { changes: [{ path: `src/module-${seed}.ts`, kind: "update", diff: diff(seed), movePath: "" }] },
      }),
    );
  }
  items.push(
    item(`${prefix}-tool`, {
      case: "toolCall",
      value: { server: "", name: "Read", inputJson: JSON.stringify({ file_path: `src/file-${seed}.ts` }), output: output(12, seed), isError: false },
    }),
  );
  if (seed % 5 === 2) {
    const parent = `${prefix}-sub`;
    items.push(
      item(parent, {
        case: "subagent",
        value: { agentType: "general-purpose", description: sentence(5, seed), prompt: sentence(12, seed), result: paragraphs(1, seed + 3).join(""), model: "", providerThreadId: "", background: false, taskId: "" },
      }),
      item(`${parent}-a`, { case: "toolCall", value: { server: "", name: "Grep", inputJson: '{"pattern":"anchor"}', output: output(6, seed), isError: false } }, parent),
      item(`${parent}-b`, { case: "agentMessage", value: { text: paragraphs(1, seed + 5).join(""), phase: "" } }, parent),
    );
  }
  items.push(item(`${prefix}-answer`, { case: "agentMessage", value: { text: answer(seed), phase: "final_answer" } }));
  return items;
}

export function longThreadSnapshot({ turns, inherited = 0 }: FixtureOptions): ui.ThreadSnapshot {
  const thread = create(ui.ThreadSchema, {
    id: FIXTURE_THREAD_ID,
    title: `Synthetic thread (${turns} turns)`,
    status: "idle",
    provider: Provider.CODEX,
    ...(inherited > 0 && { forkSourceThreadId: SOURCE_ID }),
  });
  const turnList: ui.Turn[] = [];
  const timeline: ui.TimelineItem[] = [];
  let seq = 1n;
  const total = inherited + turns;
  for (let t = 0; t < total; t++) {
    const own = t >= inherited;
    const id = `${own ? "turn" : "src"}-${t}`;
    const input = `${sentence(10, t)} ${t % 4 === 0 ? sentence(18, t + 2) : ""}`.trim();
    const at = (offset: number) => timestampFromMs(T0 + t * 120_000 + offset);
    turnList.push(
      create(ui.TurnSchema, {
        id,
        ordinal: t + 1,
        status: "completed",
        trigger: "user",
        inputText: input,
        messageText: input,
        queuedAt: at(0),
        startedAt: at(500),
        completedAt: at(90_000),
        usage: { inputTokens: 12_000n + BigInt(t), cachedInputTokens: 8_000n, outputTokens: 900n, costUsd: 0.02 },
        inherited: !own,
        fromThreadId: own ? "" : SOURCE_ID,
      }),
    );
    for (const it of turnItems(id, t, input)) {
      timeline.push(create(ui.TimelineItemSchema, { item: it, turnId: id, firstSeq: seq, lastSeq: seq, inherited: !own, fromThreadId: own ? "" : SOURCE_ID }));
      seq += 1n;
    }
  }
  return create(ui.ThreadSnapshotSchema, { thread, turns: turnList, items: timeline, interactions: [], lastSeq: seq, notices: [], schedules: [] });
}

/** Live updates of a new streaming turn: the turn, its input echo, then an agent message in `chunks` deltas. */
export function streamingTurn(snapshot: ui.ThreadSnapshot, chunks: number): { start: ui.ThreadUpdate[]; deltas: ui.ThreadUpdate[]; finish: ui.ThreadUpdate[] } {
  const ordinal = snapshot.turns.length + 1;
  const turnId = `turn-live-${ordinal}`;
  let seq = snapshot.lastSeq + 1n;
  const event = (body: EventBody): ui.ThreadUpdate =>
    create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: seq++, event: create(ThreadEventSchema, { threadId: FIXTURE_THREAD_ID, turnId, occurredAt: timestampFromMs(Date.now()), body }) } } });
  const input = "Stream a long answer for the benchmark.";
  const turn = create(ui.TurnSchema, { id: turnId, ordinal, status: "running", trigger: "user", inputText: input, messageText: input, startedAt: timestampFromMs(Date.now()) });
  const start = [
    create(ui.ThreadUpdateSchema, { change: { case: "turn", value: turn } }),
    event({ case: "itemStarted", value: { item: create(ItemSchema, { itemId: `${turnId}-user`, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text: input, attachments: [], authorUserId: "", authorAgentId: "" } } }) } }),
    event({ case: "itemStarted", value: { item: create(ItemSchema, { itemId: `${turnId}-answer`, status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: { text: "", phase: "" } } }) } }),
  ];
  const deltas = Array.from({ length: chunks }, (_, i) =>
    event({ case: "itemDelta", value: { itemId: `${turnId}-answer`, field: ItemDeltaField.TEXT, chunk: i % 12 === 11 ? "\n\n" : `${words[i % words.length]} ` } }),
  );
  const finish = [create(ui.ThreadUpdateSchema, { change: { case: "turn", value: { ...turn, status: "completed", completedAt: timestampFromMs(Date.now()) } } })];
  return { start, deltas, finish };
}
