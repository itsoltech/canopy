import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemStatus, type Mention } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { decodeJsonObject, isJsonObject, isNumber, isString, jsonObject } from "../json.ts";
import type { ThreadEventInit } from "../../journal/index.ts";
import type { GoalVerdict } from "./mapping.ts";

/** A goal_status attachment line of the transcript (the /goal evaluator's verdict). */
export function goalVerdictOf(line: string): GoalVerdict | undefined {
  if (!line.includes('"goal_status"')) return undefined;

  try {
    const entry = decodeJsonObject(JSON.parse(line));
    const a = jsonObject(entry["attachment"]);

    if (entry["type"] !== "attachment" || a?.["type"] !== "goal_status" || !isString(a["condition"])) return undefined;

    return {
      met: a["met"] === true,
      condition: a["condition"],
      ...(a["failed"] && { failed: true }),
      ...(a["sentinel"] && { sentinel: true }),
      ...(isString(a["reason"]) && { reason: a["reason"] }),
      ...(isNumber(a["iterations"]) && { iterations: a["iterations"] }),
    };
  } catch {
    return undefined;
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Bytes of a file from an offset (empty when it is missing or has not grown). */
export function readFrom(path: string, offset: number): Uint8Array {
  const size = fileSize(path);

  if (size <= offset) return new Uint8Array(0);
  const buffer = new Uint8Array(Math.min(size - offset, 1 << 20));
  const fd = openSync(path, "r");

  try {
    const read = readSync(fd, buffer, 0, buffer.length, offset);

    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Tool name and arguments with sorted keys: the MCP handler gets the arguments in schema order. */
export function callKey(tool: string, args: JsonValue): string {
  const sorted = (value: JsonValue): JsonValue =>
    Array.isArray(value)
      ? value.map(sorted)
      : isJsonObject(value)
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, sorted(v)]),
          )
        : value;

  return `${tool} ${JSON.stringify(sorted(args))}`;
}

export function userItem(
  turnId: string,
  itemId: string,
  clientId: string,
  text: string,
  authorUserId: string,
  mentions: readonly Mention[] = [],
): ThreadEventInit {
  return {
    turnId,
    body: {
      case: "itemCompleted",
      value: {
        item: {
          itemId,
          status: ItemStatus.COMPLETED,
          content: { case: "userMessage", value: { text, authorUserId, clientId, mentions: [...mentions] } },
        },
      },
    },
  };
}

export const userMessage = (
  content: SDKUserMessage["message"]["content"],
  extra: Partial<SDKUserMessage> = {},
): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  ...extra,
});

/** Launch arguments as the SDK takes them: `--name value` pairs and bare flags. */
export function claudeExtraArgs(args: readonly string[]): NonNullable<Options["extraArgs"]> {
  const extra: NonNullable<Options["extraArgs"]> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);

    if (!name) continue;

    if (inline !== undefined) extra[name] = inline;
    else if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) extra[name] = args[++i]!;
    else extra[name] = null;
  }

  return extra;
}
