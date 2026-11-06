import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { humanizeSeconds, plural } from "@canopy/domain/humanize";
import { num, objectsOf, str, type JsonObject } from "#lib/shared/json.ts";
import { formatDateTime } from "#lib/shared/format.ts";
import { describeCron } from "#lib/features/schedules/schedules.ts";

/** Schedules from agent bus calls (docs/agent-bus.md) in words: when they run, their limits and next run. */
export interface ScheduleView {
  /** When it runs, in words ("In 1 minute", "Weekdays at 09:00 (Europe/Warsaw)"). */
  readonly when: string;
  /** The next run, formatted; "" when unknown. */
  readonly next: string;
  readonly prompt: string;
  readonly threadId: string;
  /** Limits ("until Nov 3, 2026", "up to 5 runs"), "" without. */
  readonly limits: string;
  readonly status: string;
}

const dateWords = (iso: string) => {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? iso : formatDateTime(timestampFromDate(date));
};

/** A schedule from schedule_wakeup / schedule_recurring (arguments and result) or a list_schedules row. */
export function scheduleOf(args: JsonObject, result: JsonObject = {}): ScheduleView {
  const cron = str(args["cron"]) || str(result["cron"]);
  const timezone = str(args["timezone"]) || str(result["timezone"]);
  const at = str(args["at"]) || str(args["run_at"]);
  const delay = num(args["delay_seconds"]);

  const when = cron
    ? `${describeCron(cron)}${timezone && timezone !== "UTC" ? ` (${timezone})` : ""}`
    : at
      ? `Once, ${dateWords(at)}`
      : delay
        ? `In ${humanizeSeconds(delay)}`
        : "Once";

  const until = str(args["until"]);
  const maxRuns = num(args["max_runs"]);
  const next = str(result["next_run_at"]) || str(args["next_run_at"]);

  return {
    when,
    next: next ? dateWords(next) : "",
    prompt: str(args["prompt"]),
    threadId: str(args["thread_id"]) || str(result["thread_id"]),
    limits: [until && `until ${dateWords(until)}`, maxRuns && `up to ${plural(maxRuns, "run")}`]
      .filter(Boolean)
      .join(", "),
    status: str(args["status"]),
  };
}

/** list_schedules rows. */
export function schedulesOf(result: JsonObject): ScheduleView[] {
  return objectsOf(result["schedules"]).map((row) => scheduleOf(row));
}
