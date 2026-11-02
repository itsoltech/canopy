import type { JsonValue } from "@bufbuild/protobuf";

export const finishedTurn = (status: string): boolean => ["completed", "interrupted", "failed", "cancelled"].includes(status);

/** Only explicit result reads consume reports. Listing threads and unfinished/partial reads do not. */
export function observedSummaryTurns(tool: string, result: JsonValue | undefined): string[] {
  const object = (value: JsonValue | undefined) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  const root = object(result);
  const summaries = tool === "get_thread" ? [root] : tool === "wait_threads" && Array.isArray(root?.["threads"]) ? root["threads"].map(object) : [];
  return summaries.flatMap((summary) => {
    const turn = object(summary?.["last_turn"]);
    return typeof summary?.["last_message"] === "string" && typeof turn?.["turn_id"] === "string" && typeof turn["status"] === "string" && finishedTurn(turn["status"])
      ? [turn["turn_id"]] : [];
  });
}
