import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Match, Option, Schema } from "effect";
import { ItemStatus, TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { readJsonl, type HarnessRecord, type TurnEnd } from "../harness-record.ts";
import { GrokEventMapper } from "./mapping.ts";

const Entry = Schema.Struct({
  params: Schema.Struct({
    sessionId: Schema.String,
    update: Schema.Struct({
      sessionUpdate: Schema.String,
      stop_reason: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(Schema.Json),
      toolCallId: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      rawInput: Schema.optionalKey(Schema.Json),
    }),
  }),
});

const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const StopReason = Schema.Literals(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

/** Only protocol codes may leave the worker; a provider string can contain private payloads. */
export function grokStopReason(value: string): string {
  return Option.getOrElse(Schema.decodeUnknownOption(StopReason)(value), () => "unknown");
}

/** Search only this bot's durable CLI sessions, including Grok's long-cwd hashed groups. */
export function grokTranscriptPath(root: string, sessionId: string): string | undefined {
  if (!/^[a-z0-9-]+$/i.test(sessionId) || !existsSync(root)) return undefined;

  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const path = join(root, group.name, sessionId, "updates.jsonl");

    if (existsSync(path)) return path;
  }

  return undefined;
}

/** Rebuild only this turn from the CLI's authoritative ACP log; never execute historical MCP calls. */
export async function readGrokTurn(
  root: string,
  sessionId: string,
  offset: number,
  turnId: string,
): Promise<HarnessRecord | undefined> {
  const path = grokTranscriptPath(root, sessionId);

  if (!path) return undefined;
  const mapper = new GrokEventMapper(turnId, "");
  const items = new Map<string, HarnessRecord["items"][number]>();
  let end: TurnEnd | undefined;

  const remember = (events: ReturnType<GrokEventMapper["update"]>) => {
    for (const event of events) {
      if ((event.body?.case === "itemStarted" || event.body?.case === "itemCompleted") && event.body.value.item)
        items.set(event.body.value.item.itemId ?? "", event.body.value.item);
    }
  };

  for (const value of await readJsonl(path, offset)) {
    const parsed = Schema.decodeUnknownOption(Entry)(value);

    if (Option.isNone(parsed) || parsed.value.params.sessionId !== sessionId) continue;
    const update = parsed.value.params.update;

    if (update.sessionUpdate === "turn_completed") {
      const reason = grokStopReason(update.stop_reason ?? "");
      end = {
        outcome: Match.value(reason).pipe(
          Match.when("end_turn", () => TurnOutcome.COMPLETED),
          Match.when("cancelled", () => TurnOutcome.INTERRUPTED),
          Match.orElse(() => TurnOutcome.FAILED),
        ),
        source: TurnEndSource.HARNESS,
        reason: reason === "end_turn" ? "" : "Grok stopped the turn",
        errorCode: reason === "end_turn" ? "" : reason,
        providerTurnRef: sessionId,
      };
      break;
    }

    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const content = Schema.decodeUnknownOption(TextContent)(update.content);

      if (Option.isSome(content))
        remember(mapper.update({ sessionUpdate: update.sessionUpdate, content: content.value }));
    }

    if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.toolCallId)
      remember(
        mapper.update({
          sessionUpdate: update.sessionUpdate,
          toolCallId: update.toolCallId,
          ...(update.title && { title: update.title }),
          rawInput: update.rawInput,
        }),
      );
  }

  remember(mapper.finish(end?.outcome === TurnOutcome.COMPLETED ? ItemStatus.COMPLETED : ItemStatus.INTERRUPTED));

  return { items: [...items.values()], ...(end && { end }) };
}
