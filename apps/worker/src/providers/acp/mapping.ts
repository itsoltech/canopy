import type { ConsumedUsage } from "../token-usage.ts";
import { clone, create } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemSchema, ItemStatus, type Item } from "@canopy/contracts";
import type { PromptEvent, SessionUpdate, ToolCall } from "@canopy/acp";
import type { ThreadEventInit } from "../../journal/index.ts";
import { Match, Option, Schema } from "effect";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { decodeJson, isString, isNumber } from "../json.ts";
import { inlineImages } from "../../images/previews.ts";

const text = (value: JsonValue | undefined): string =>
  isString(value) ? value : value == null ? "" : JSON.stringify(value);

const decodeObject = Schema.decodeUnknownOption(Schema.JsonObject);

/** ACP tool updates are patches, not replacement items. Preserve inputs, diffs and output across updates. */
export class AcpEventMapper {
  readonly #items = new Map<string, Item>();
  readonly #tools = new Map<string, ToolCall>();
  #message: Item | undefined;
  #sequence = 0;
  usage: ConsumedUsage[] = [];

  constructor(
    readonly turnId: string,
    readonly cwd: string,
    readonly provider: string,
  ) {}

  async complete(event: Extract<PromptEvent, { type: "complete" }>): Promise<ThreadEventInit[]> {
    return [{ turnId: this.turnId, rawJson: JSON.stringify(event) }];
  }

  protected platformTool(_tool: ToolCall): boolean {
    return false;
  }

  protected command(tool: ToolCall): boolean {
    return tool.kind === "execute";
  }

  update(update: SessionUpdate): ThreadEventInit[] {
    const out: ThreadEventInit[] = [];
    const rawJson = JSON.stringify(update);

    const event = (body: NonNullable<ThreadEventInit["body"]>): ThreadEventInit => ({
      turnId: this.turnId,
      rawJson,
      body,
    });

    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type !== "text") return [{ turnId: this.turnId, rawJson }];
      const reasoning = update.sessionUpdate === "agent_thought_chunk";
      const kind = reasoning ? "reasoning" : "agentMessage";

      if (this.#message?.content.case !== kind) {
        out.push(...this.#flush());
        this.#message = create(ItemSchema, {
          itemId: `${this.turnId}:${this.provider}:${++this.#sequence}`,
          status: ItemStatus.IN_PROGRESS,
          content: reasoning
            ? { case: "reasoning", value: { text: "" } }
            : { case: "agentMessage", value: { text: "" } },
        });
        this.#items.set(this.#message.itemId, this.#message);
        out.push(event({ case: "itemStarted", value: { item: clone(ItemSchema, this.#message) } }));
      }

      const item = this.#message!;

      if (item.content.case === "agentMessage" || item.content.case === "reasoning")
        item.content.value.text += update.content.text;
      out.push(
        event({
          case: "itemDelta",
          value: { itemId: item.itemId, field: ItemDeltaField.TEXT, chunk: update.content.text },
        }),
      );
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      out.push(...this.#flush());
      const previous = this.#tools.get(update.toolCallId);
      const tool = { ...previous, ...update };
      this.#tools.set(tool.toolCallId, tool);

      if (this.platformTool(tool)) return [...out, { turnId: this.turnId, rawJson }];
      const itemId = `${this.turnId}:${tool.toolCallId}`;
      const item = toolItem(itemId, tool, this.cwd, this.command(tool));
      this.#items.set(itemId, item);

      const mapped = event({
        case: item.status === ItemStatus.IN_PROGRESS ? "itemStarted" : "itemCompleted",
        value: { item },
      });

      if (item.status !== ItemStatus.IN_PROGRESS && item.content.case === "toolCall") {
        const mergedRaw = JSON.stringify(tool);

        if (mergedRaw !== rawJson && inlineImages(mergedRaw, itemId).length > inlineImages(rawJson, itemId).length) {
          // Retain the exact provider patch before the synthetic completion that carries inherited previews.
          out.push({ turnId: this.turnId, rawJson });
          mapped.rawJson = mergedRaw;
        }
      }

      out.push(mapped);
    } else if (update.sessionUpdate === "usage_update") {
      out.push(
        event({
          case: "usageUpdated",
          value: {
            contextUsage: {
              ...(Number.isSafeInteger(update.used) && update.used >= 0 && { usedTokens: BigInt(update.used) }),
              ...(Number.isSafeInteger(update.size) && update.size > 0 && { limitTokens: BigInt(update.size) }),
            },
            usage: {
              contextWindowTokens: Number.isSafeInteger(update.size) && update.size > 0 ? BigInt(update.size) : 0n,
            },
          },
        }),
      );
    } else if (update.sessionUpdate === "plan") {
      const item = create(ItemSchema, {
        itemId: `${this.turnId}:plan`,
        status: ItemStatus.COMPLETED,
        content: { case: "plan", value: { steps: update.entries.map((e) => ({ text: e.content, status: e.status })) } },
      });

      out.push(event({ case: "itemCompleted", value: { item } }));
    }

    // All known and unknown updates remain available in the durable raw transcript.
    if (out.length === 0) out.push({ turnId: this.turnId, rawJson });

    return out;
  }
  finish(status = ItemStatus.COMPLETED): ThreadEventInit[] {
    const result = this.#flush();

    for (const item of this.#items.values())
      if (item.status === ItemStatus.IN_PROGRESS) {
        item.status = status;
        result.push({ turnId: this.turnId, body: { case: "itemCompleted", value: { item } } });
      }

    return result;
  }
  #flush(): ThreadEventInit[] {
    if (!this.#message) return [];
    const item = this.#message;
    this.#message = undefined;
    item.status = ItemStatus.COMPLETED;

    return [{ turnId: this.turnId, body: { case: "itemCompleted", value: { item } } }];
  }
}

function toolItem(itemId: string, tool: ToolCall, cwd: string, command: boolean): Item {
  const input: JsonObject = Option.getOrElse(decodeObject(tool.rawInput), () => ({}));
  const name = tool.title ?? "tool";

  const output =
    tool.content
      ?.flatMap((c) => (c.type === "content" && c.content.type === "text" ? [c.content.text] : []))
      .join("\n") || text(decodeJson(tool.rawOutput ?? null));

  const status = Match.value(tool.status).pipe(
    Match.when("completed", () => ItemStatus.COMPLETED),
    Match.when("failed", () => ItemStatus.FAILED),
    Match.orElse(() => ItemStatus.IN_PROGRESS),
  );

  const base = { itemId, status };

  if (command) {
    const raw: JsonObject = Option.getOrElse(decodeObject(tool.rawOutput), () => ({}));

    return create(ItemSchema, {
      ...base,
      content: {
        case: "commandExecution",
        value: {
          command: text(input["command"] ?? input["cmd"] ?? input["CommandLine"] ?? name),
          cwd: text(input["cwd"]) || cwd,
          output,
          ...(isNumber(raw["exit_code"]) && { exitCode: raw["exit_code"] }),
        },
      },
    });
  }

  const diffs = tool.content?.filter((c) => c.type === "diff") ?? [];

  if (diffs.length)
    return create(ItemSchema, {
      ...base,
      content: {
        case: "fileChange",
        value: {
          changes: diffs.map((d) => ({
            path: d.path,
            kind: d.oldText == null ? "add" : "update",
            diff: `--- ${d.path}\n+++ ${d.path}\n${(d.oldText ?? "")
              .split("\n")
              .map((l) => `-${l}`)
              .join("\n")}\n${d.newText
              .split("\n")
              .map((l) => `+${l}`)
              .join("\n")}`,
          })),
        },
      },
    });

  return create(ItemSchema, {
    ...base,
    content: {
      case: "toolCall",
      value: { name, inputJson: JSON.stringify(tool.rawInput ?? {}), output, isError: status === ItemStatus.FAILED },
    },
  });
}
