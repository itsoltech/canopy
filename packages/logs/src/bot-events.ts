import type { LogSource } from "./limits.ts";

const failureSources = "provider|harness|platform";

const failureClasses =
  "auth_required|cli_missing|model_unavailable|usage_limit|network|stream_cut_off|process_exit|configuration|connection_changed|tool_approval|provider_unavailable|internal";

const toolSources = "platform|mcp|unknown";
const operations = "start_thread|send_message|send_bot_message|other";
const outcomes = "completed|failed|discarded|changes_requested|expired|interrupted";

const turnFailed = new RegExp(`^bots: turn failed source (${failureSources}) class (${failureClasses})$`);

const toolFinished = new RegExp(
  `^bots: tool finished source (${toolSources}) operation (${operations}) outcome (${outcomes})$`,
);

/** Source projection and coordinator validation share only closed, local vocabularies. */
export function botEvent(message: string, source: LogSource) {
  if (source !== "gateway" && source !== "worker") return undefined;
  const failed = turnFailed.exec(message);

  if (failed) return { event: "bot_turn_failed", failureSource: failed[1], failureClass: failed[2] };

  if (/^bots: turn failed \([^\r\n]*\)$/.test(message)) return { event: "bot_turn_failed" };

  if (source === "worker")
    return message === "bots: harness journal failed" ? { event: "bot_harness_journal_failed" } : undefined;
  const finished = toolFinished.exec(message);

  if (finished)
    return { event: "bot_tool_finished", toolSource: finished[1], operation: finished[2], outcome: finished[3] };

  switch (message) {
    case "bots: queue tick failed":
      return { event: "bot_queue_tick_failed" };
    case "bots: queue wake failed":
      return { event: "bot_queue_wake_failed" };
    case "bots: turn could not be settled; lease recovery will resume it":
      return { event: "bot_turn_settlement_failed" };
    default:
      return undefined;
  }
}

const prefix = '\\{"at":\\d{1,16},"source":';
const legacy = ',"legacy":(?:true|false)';
const suffix = "\\}\\n$";

const botRecords = [
  new RegExp(
    `^${prefix}"(gateway|worker)","event":"bot_turn_failed"${legacy}(?:,"failureSource":"(?:${failureSources})","failureClass":"(?:${failureClasses})")?${suffix}`,
  ),
  new RegExp(
    `^${prefix}"(gateway)","event":"bot_tool_finished"${legacy},"toolSource":"(?:${toolSources})","operation":"(?:${operations})","outcome":"(?:${outcomes})"${suffix}`,
  ),
  new RegExp(
    `^${prefix}"(gateway)","event":"(?:bot_queue_tick_failed|bot_queue_wake_failed|bot_turn_settlement_failed)"${legacy}${suffix}`,
  ),
  new RegExp(`^${prefix}"(worker)","event":"bot_harness_journal_failed"${legacy}${suffix}`),
];

export function verifiedBotRecord(line: string, source: LogSource) {
  return botRecords.some((record) => record.exec(line)?.[1] === source);
}
