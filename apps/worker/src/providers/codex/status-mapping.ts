import type { v2 } from "@canopy/codex-protocol";
import { ThreadStatus, TurnEndSource, TurnOutcome } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { decodeJson, isNumber, isString, jsonObject } from "../json.ts";
import type { TurnEnd } from "../harness-record.ts";

/** Where a turn's end came from: Codex's errors are the harness's; an interruption is the user's when asked for. */
export function turnEndSource(turn: v2.Turn, asked: boolean): Pick<TurnEnd, "source" | "errorCode"> {
  switch (turn.status) {
    case "failed":
      return {
        source: TurnEndSource.HARNESS,
        ...(turn.error?.codexErrorInfo && { errorCode: codexErrorCode(decodeJson(turn.error.codexErrorInfo)) }),
      };
    case "interrupted":
      return { source: asked ? TurnEndSource.USER : TurnEndSource.SYSTEM };
    default:
      return { source: TurnEndSource.UNSPECIFIED };
  }
}

/** e.g. `{ httpConnectionFailed: { httpStatusCode: 401 } }` -> "httpConnectionFailed:401"; a string stays as is. */
export function codexErrorCode(info: JsonValue | undefined): string {
  if (isString(info)) return info;

  const object = jsonObject(info);

  if (!object) return "";
  const [key, detail] = Object.entries(object)[0] ?? [];

  if (!key) return "";

  const status = jsonObject(detail) ? Object.entries(detail ?? {}).find(([k]) => /status/i.test(k))?.[1] : undefined;

  return isNumber(status) ? `${key}:${status}` : key;
}

export function turnOutcome(status: v2.TurnStatus): TurnOutcome {
  switch (status) {
    case "completed":
      return TurnOutcome.COMPLETED;
    case "interrupted":
      return TurnOutcome.INTERRUPTED;
    case "failed":
      return TurnOutcome.FAILED;
    case "inProgress":
      return TurnOutcome.UNSPECIFIED;
  }
}

export function threadStatus(status: v2.ThreadStatus): ThreadStatus | undefined {
  switch (status.type) {
    case "idle":
      return ThreadStatus.IDLE;
    case "active":
      return status.activeFlags.length > 0 ? ThreadStatus.WAITING_INPUT : ThreadStatus.RUNNING;
    case "systemError":
      return ThreadStatus.FAILED;
    case "notLoaded":
      return undefined;
  }
}

export function usageOf(usage: v2.TokenUsageBreakdown) {
  return {
    inputTokens: BigInt(usage.inputTokens),
    outputTokens: BigInt(usage.outputTokens + usage.reasoningOutputTokens),
    cachedInputTokens: BigInt(usage.cachedInputTokens),
  };
}

export function snake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
