import { describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ItemDeltaField,
  ItemStatus,
  ThreadEventSchema,
  type Item,
  type ThreadEvent,
} from "@canopy/contracts";
import { eventItemId, eventKind, itemStatus, itemType, reduceItem } from "./items.ts";

type Body = NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>;
const event = (body: Body): ThreadEvent => create(ThreadEventSchema, { threadId: "t", eventId: "e", body });

/** Folds events into the item map, like the gateway projection does. */
function project(bodies: Body[]): Map<string, Item> {
  const items = new Map<string, Item>();
  for (const body of bodies) {
    const e = event(body);
    const id = eventItemId(e.body);
    if (!id) continue;
    const next = reduceItem(items.get(id), e.body);
    if (next) items.set(id, next);
  }
  return items;
}

const commandStarted: Body = {
  case: "itemStarted",
  value: { item: { itemId: "c1", status: ItemStatus.IN_PROGRESS, content: { case: "commandExecution", value: { command: "bun test" } } } },
};
const outputDelta = (chunk: string): Body => ({
  case: "itemDelta",
  value: { itemId: "c1", field: ItemDeltaField.OUTPUT, chunk },
});

describe("reduceItem", () => {
  test("started -> output deltas -> completed with final exit code", () => {
    const items = project([
      commandStarted,
      outputDelta("1 pass\n"),
      outputDelta("0 fail\n"),
      {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "c1",
            status: ItemStatus.COMPLETED,
            content: { case: "commandExecution", value: { command: "bun test", exitCode: 0, output: "1 pass\n0 fail\n" } },
          },
        },
      },
    ]);
    const item = items.get("c1")!;
    expect(itemType(item)).toBe("command_execution");
    expect(itemStatus(item)).toBe("completed");
    expect(item.content.case === "commandExecution" && item.content.value).toMatchObject({
      output: "1 pass\n0 fail\n",
      exitCode: 0,
    });
  });

  test("completed without output keeps what deltas already showed", () => {
    const items = project([
      commandStarted,
      outputDelta("streamed output"),
      {
        case: "itemCompleted",
        value: { item: { itemId: "c1", status: ItemStatus.FAILED, content: { case: "commandExecution", value: { exitCode: 1 } } } },
      },
    ]);
    const item = items.get("c1")!;
    expect(item.status).toBe(ItemStatus.FAILED);
    expect(item.content.case === "commandExecution" && item.content.value.output).toBe("streamed output");
  });

  test("late deltas and a late started do not change a finished item", () => {
    const completed: Body = {
      case: "itemCompleted",
      value: { item: { itemId: "c1", status: ItemStatus.COMPLETED, content: { case: "commandExecution", value: { output: "final" } } } },
    };
    const items = project([completed, outputDelta("late"), commandStarted]);
    const item = items.get("c1")!;
    expect(item.status).toBe(ItemStatus.COMPLETED);
    expect(item.content.case === "commandExecution" && item.content.value.output).toBe("final");
  });

  test("text and summary deltas go to the matching fields only", () => {
    const items = project([
      { case: "itemStarted", value: { item: { itemId: "r1", status: ItemStatus.IN_PROGRESS, content: { case: "reasoning", value: {} } } } },
      { case: "itemDelta", value: { itemId: "r1", field: ItemDeltaField.TEXT, chunk: "think " } },
      { case: "itemDelta", value: { itemId: "r1", field: ItemDeltaField.SUMMARY, chunk: "sum" } },
      // OUTPUT does not apply to reasoning and is ignored by the projection (still kept in thread_events).
      { case: "itemDelta", value: { itemId: "r1", field: ItemDeltaField.OUTPUT, chunk: "x" } },
      { case: "itemDelta", value: { itemId: "r1", field: ItemDeltaField.TEXT, chunk: "more" } },
    ]);
    const item = items.get("r1")!;
    expect(item.content.case === "reasoning" && item.content.value).toMatchObject({ text: "think more", summary: "sum" });
  });

  test("subagent items keep their parent; unknown provider items are kept whole", () => {
    const items = project([
      { case: "itemStarted", value: { item: { itemId: "task", status: ItemStatus.IN_PROGRESS, content: { case: "subagent", value: { agentType: "explore" } } } } },
      {
        case: "itemCompleted",
        value: { item: { itemId: "read-1", parentItemId: "task", status: ItemStatus.COMPLETED, content: { case: "toolCall", value: { name: "Read" } } } },
      },
      {
        case: "itemCompleted",
        value: { item: { itemId: "x", status: ItemStatus.COMPLETED, content: { case: "providerItem", value: { type: "sleep", json: '{"ms":10}' } } } },
      },
    ]);
    expect(items.get("read-1")?.parentItemId).toBe("task");
    expect(itemType(items.get("x")!)).toBe("provider_item");
    expect(items.get("x")?.content.case === "providerItem" && items.get("x")?.content.value).toMatchObject({ type: "sleep" });
  });

  test("event kinds for thread_events.kind", () => {
    expect(eventKind(event({ case: "itemDelta", value: {} }))).toBe("item_delta");
    expect(eventKind(event({ case: "turnFinished", value: {} }))).toBe("turn_finished");
    expect(eventKind(event({ case: undefined }))).toBe("provider_raw");
  });
});
