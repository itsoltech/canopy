import { Option, Schema } from "effect";
import type { ToolResult, ToolSpec } from "./types.ts";

const resultEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.optional(Schema.String),
    isError: Schema.optional(Schema.Boolean),
    status: Schema.optional(Schema.String),
  }),
);

/** Only closed categories reach logs; connector names, arguments and results remain private. */
export function logBotToolResult(
  log: ((message: string) => void) | undefined,
  tool: ToolSpec | undefined,
  result: ToolResult,
): void {
  if (!log) return;
  const parsed = resultEnvelope(result);
  const envelope = Option.getOrUndefined(parsed);

  const outcome =
    envelope?.status === "discarded" || envelope?.status === "changes_requested"
      ? envelope.status
      : envelope?.error === "This request expired. Do not retry it."
        ? "expired"
        : envelope?.error?.startsWith("interrupted:")
          ? "interrupted"
          : envelope?.error !== undefined || envelope?.isError
            ? "failed"
            : "completed";

  const operation =
    tool?.source === "platform" &&
    (tool.name === "start_thread" || tool.name === "send_message" || tool.name === "send_bot_message")
      ? tool.name
      : "other";

  log(`bots: tool finished source ${tool?.source ?? "unknown"} operation ${operation} outcome ${outcome}`);
}
