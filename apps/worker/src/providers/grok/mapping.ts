import { clone, create } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemSchema, ItemStatus, type Item } from "@canopy/contracts";
import type { SessionUpdate, ToolCall } from "@canopy/grok-acp";
import type { ThreadEventInit } from "../../journal/index.ts";

const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** ACP tool updates are patches, not replacement items. Preserve inputs, diffs and output across updates. */
export class GrokEventMapper {
  readonly #items = new Map<string, Item>();
  readonly #tools = new Map<string, ToolCall>();
  #message: Item | undefined;
  #sequence = 0;
  constructor(readonly turnId: string, readonly cwd: string) {}

  update(update: SessionUpdate): ThreadEventInit[] {
    const out: ThreadEventInit[] = [];
    const rawJson = JSON.stringify(update);
    const event = (body: NonNullable<ThreadEventInit["body"]>): ThreadEventInit => ({ turnId: this.turnId, rawJson, body });
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type !== "text") return [];
      const reasoning = update.sessionUpdate === "agent_thought_chunk";
      const kind = reasoning ? "reasoning" : "agentMessage";
      if (this.#message?.content.case !== kind) {
        out.push(...this.#flush());
        this.#message = create(ItemSchema, { itemId: `${this.turnId}:grok:${++this.#sequence}`, status: ItemStatus.IN_PROGRESS,
          content: reasoning ? { case: "reasoning", value: { text: "" } } : { case: "agentMessage", value: { text: "" } } });
        this.#items.set(this.#message.itemId, this.#message);
        out.push(event({ case: "itemStarted", value: { item: clone(ItemSchema, this.#message) } }));
      }
      const item = this.#message!;
      if (item.content.case === "agentMessage" || item.content.case === "reasoning") item.content.value.text += update.content.text;
      out.push(event({ case: "itemDelta", value: { itemId: item.itemId, field: ItemDeltaField.TEXT, chunk: update.content.text } }));
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      out.push(...this.#flush());
      const previous = this.#tools.get(update.toolCallId);
      const tool = { ...previous, ...update };
      this.#tools.set(tool.toolCallId, tool);
      // The gateway owns canonical agentBusCall items; keep use_tool wrappers only in the raw transcript.
      if (tool.title === "use_tool" && text(object(tool.rawInput)["tool_name"]).startsWith("openagents__")) return [{ turnId: this.turnId, rawJson }];
      const itemId = `${this.turnId}:${tool.toolCallId}`;
      const item = toolItem(itemId, tool, this.cwd);
      this.#items.set(itemId, item);
      out.push(event({ case: item.status === ItemStatus.IN_PROGRESS ? "itemStarted" : "itemCompleted", value: { item } }));
    } else if (update.sessionUpdate === "usage_update") {
      out.push(event({ case: "usageUpdated", value: { usage: { contextWindowTokens: BigInt(Math.max(0, Math.trunc(update.size))),
        ...(update.cost?.currency === "USD" && { costUsd: update.cost.amount }) } } }));
    } else if (update.sessionUpdate === "plan") {
      const item = create(ItemSchema, { itemId: `${this.turnId}:plan`, status: ItemStatus.COMPLETED,
        content: { case: "plan", value: { steps: update.entries.map((e) => ({ text: e.content, status: e.status })) } } });
      out.push(event({ case: "itemCompleted", value: { item } }));
    }
    // All known and unknown updates remain available in the durable raw transcript.
    if (out.length === 0) out.push({ turnId: this.turnId, rawJson });
    return out;
  }
  finish(status = ItemStatus.COMPLETED): ThreadEventInit[] {
    const result = this.#flush();
    for (const item of this.#items.values()) if (item.status === ItemStatus.IN_PROGRESS) {
      item.status = status;
      result.push({ turnId: this.turnId, body: { case: "itemCompleted", value: { item } } });
    }
    return result;
  }
  #flush(): ThreadEventInit[] {
    if (!this.#message) return [];
    const item = this.#message; this.#message = undefined;
    item.status = ItemStatus.COMPLETED;
    return [{ turnId: this.turnId, body: { case: "itemCompleted", value: { item } } }];
  }
}

function toolItem(itemId: string, tool: ToolCall, cwd: string): Item {
  const input = object(tool.rawInput);
  const name = tool.title ?? "tool";
  const output = tool.content?.flatMap((c) => c.type === "content" && c.content.type === "text" ? [c.content.text] : []).join("\n") || text(tool.rawOutput);
  const status = tool.status === "completed" ? ItemStatus.COMPLETED : tool.status === "failed" ? ItemStatus.FAILED : ItemStatus.IN_PROGRESS;
  const base = { itemId, status };
  if (tool.kind === "execute" || /^(run_terminal_command|bash|shell|execute_command)$/i.test(name)) {
    const raw = object(tool.rawOutput);
    return create(ItemSchema, { ...base, content: { case: "commandExecution", value: {
      command: text(input["command"] ?? input["cmd"] ?? name), cwd: text(input["cwd"]) || cwd, output,
      ...(typeof raw["exit_code"] === "number" && { exitCode: raw["exit_code"] }),
    } } });
  }
  const diffs = tool.content?.filter((c) => c.type === "diff") ?? [];
  if (diffs.length) return create(ItemSchema, { ...base, content: { case: "fileChange", value: { changes: diffs.map((d) => ({ path: d.path, kind: d.oldText == null ? "add" : "update", diff: `--- ${d.path}\n+++ ${d.path}\n${(d.oldText ?? "").split("\n").map((l) => `-${l}`).join("\n")}\n${d.newText.split("\n").map((l) => `+${l}`).join("\n")}` })) } } });
  return create(ItemSchema, { ...base, content: { case: "toolCall", value: { name, inputJson: JSON.stringify(tool.rawInput ?? {}), output, isError: status === ItemStatus.FAILED } } });
}
