import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { DEFAULT_BUS_LIMITS } from "@canopy/domain";
import type { NewSchedule } from "../store/agent-bus.ts";
import { cronProblem, nextCronRun } from "./cron.ts";

/** Shared create/update validation; pure so both paths use the same clock and timing rules. */
export function scheduleConfiguration(request: ui.CreateScheduleRequest, now: Date): NewSchedule {
  const prompt = request.prompt.trim();

  if (!prompt) throw new Error("prompt is required");
  const missedPolicy = request.missedPolicy || "run_once";

  if (missedPolicy !== "run_once" && missedPolicy !== "skip") throw new Error("missed_policy is run_once or skip");
  const concurrency = request.concurrency || "skip_if_running";

  if (concurrency !== "allow" && concurrency !== "skip_if_running")
    throw new Error("concurrency is allow or skip_if_running");

  const base = {
    threadId: request.threadId,
    prompt,
    missedPolicy,
    concurrency,
    name: request.name.trim().slice(0, 120),
    hops: 0,
  } as const;

  if (request.when.case === "runAt") {
    const runAt = timestampDate(request.when.value);

    if (!Number.isFinite(runAt.getTime())) throw new Error("invalid run_at");

    if (runAt.getTime() < now.getTime() - 60_000) throw new Error("run_at is in the past");

    if (request.until || request.maxRuns) throw new Error("once schedules cannot have until or max_runs");

    return { ...base, kind: "once", runAt, timezone: "UTC", nextRunAt: runAt };
  }

  if (request.when.case !== "cron") throw new Error("set run_at or cron");
  const cron = request.when.value.trim().replace(/\s+/g, " ");
  const timezone = request.timezone || "UTC";

  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
  } catch {
    throw new Error(`unknown time zone ${timezone}`);
  }

  const until = request.until ? timestampDate(request.until) : undefined;

  if (until && (!Number.isFinite(until.getTime()) || until <= now)) throw new Error("until must be in the future");

  if (!Number.isInteger(request.maxRuns) || request.maxRuns < 0 || request.maxRuns > 2_147_483_647)
    throw new Error("invalid max_runs");
  const problem = cronProblem(cron, timezone, DEFAULT_BUS_LIMITS.minCronMinutes, now);

  if (problem) throw new Error(problem);
  const nextRunAt = nextCronRun(cron, timezone, now);

  if (!nextRunAt) throw new Error("cron has no future runs");

  if (until && nextRunAt > until) throw new Error("until must include the next run");

  return {
    ...base,
    kind: "recurring",
    cron,
    timezone,
    ...(until && { until }),
    ...(request.maxRuns > 0 && { maxRuns: request.maxRuns }),
    nextRunAt,
  };
}
