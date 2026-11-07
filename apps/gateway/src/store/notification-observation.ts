import type { JsonValue } from "@bufbuild/protobuf";
import { Predicate } from "effect";
import { isJsonArray, isJsonObject } from "../bots/json.ts";

export const finishedTurn = (status: string): boolean =>
  ["completed", "interrupted", "failed", "cancelled"].includes(status);

/** Explicit messages returned alongside a wait, summary or transcript page. */
export function observedMessageCalls(result: JsonValue | undefined): string[] {
  const messages = isJsonObject(result) ? result["messages"] : undefined;

  return isJsonArray(messages)
    ? messages.flatMap((message) =>
        isJsonObject(message) && Predicate.isString(message["call_id"]) ? [message["call_id"]] : [],
      )
    : [];
}

/** Only explicit result reads consume reports. Listing threads and unfinished/partial reads do not. */
export function observedSummaryTurns(tool: string, result: JsonValue | undefined): string[] {
  const object = (value: JsonValue | undefined) => (isJsonObject(value) ? value : undefined);
  const root = object(result);
  const threads = root?.["threads"];

  const summaries =
    tool === "get_thread" ? [root] : tool === "wait_threads" && isJsonArray(threads) ? threads.map(object) : [];

  return summaries.flatMap((summary) => {
    const turn = object(summary?.["last_turn"]);
    const turnId = turn?.["turn_id"];
    const status = turn?.["status"];

    return Predicate.isString(summary?.["last_message"]) &&
      Predicate.isString(turnId) &&
      Predicate.isString(status) &&
      finishedTurn(status)
      ? [turnId]
      : [];
  });
}
