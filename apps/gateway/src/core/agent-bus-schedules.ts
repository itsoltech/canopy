import { type JsonValue } from "@bufbuild/protobuf";
import { DEFAULT_BUS_LIMITS, type AgentBusCall } from "@canopy/domain";
import { type Effect } from "effect";
import { AgentBusStore, truncate, type CallSource, type ThreadRow } from "../store/index.ts";
import { BusRefusal, busState } from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";
import { busAnnounced } from "./agent-bus-tools.ts";
import { cronProblem, nextCronRun } from "./cron.ts";

export async function busScheduleTool(
  hostContext: AgentBus,
  call: Extract<
    AgentBusCall,
    { tool: "schedule_wakeup" | "schedule_recurring" | "list_schedules" | "cancel_schedule" }
  >,
  source: CallSource,
  caller: ThreadRow,
  hops: number,
): Promise<JsonValue> {
  const store = <A, E>(use: (s: AgentBusStore["Service"]) => Effect.Effect<A, E>) =>
    hostContext[busState].host.run(AgentBusStore.use(use));

  switch (call.tool) {
    case "schedule_wakeup": {
      const now = Date.now();

      const runAt =
        call.args.at !== undefined ? new Date(call.args.at) : new Date(now + (call.args.delay_seconds ?? 60) * 1000);

      return await busAnnounced(
        hostContext,
        store((s) =>
          s.createSchedule({
            source,
            tool: call.tool,
            args: call.args,
            schedule: {
              threadId: call.args.thread_id ?? caller.id,
              kind: "once",
              prompt: call.args.prompt,
              runAt,
              timezone: "UTC",
              nextRunAt: runAt,
              hops,
            },
          }),
        ),
      );
    }

    case "schedule_recurring": {
      const now = new Date();
      const timezone = call.args.timezone ?? "UTC";
      const problem = cronProblem(call.args.cron, timezone, DEFAULT_BUS_LIMITS.minCronMinutes, now);

      if (problem) throw new BusRefusal(problem);
      const nextRunAt = nextCronRun(call.args.cron, timezone, now);

      if (!nextRunAt) throw new BusRefusal("cron has no future runs");

      return await busAnnounced(
        hostContext,
        store((s) =>
          s.createSchedule({
            source,
            tool: call.tool,
            args: call.args,
            schedule: {
              threadId: call.args.thread_id ?? caller.id,
              kind: "recurring",
              prompt: call.args.prompt,
              cron: call.args.cron,
              timezone,
              ...(call.args.until !== undefined && { until: new Date(call.args.until) }),
              ...(call.args.max_runs !== undefined && { maxRuns: call.args.max_runs }),
              nextRunAt,
              hops,
            },
          }),
        ),
      );
    }

    case "list_schedules": {
      const rows = await store((s) => s.listSchedules(caller.id));

      return {
        schedules: rows.map((r) => ({
          schedule_id: r.id,
          thread_id: r.thread_id,
          kind: r.kind,
          prompt: truncate(r.prompt, 500),
          status: r.status,
          next_run_at: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
          runs: r.runs,
          ...(r.cron && { cron: r.cron, timezone: r.timezone }),
          ...(r.max_runs !== null && { max_runs: r.max_runs }),
          ...(r.until && { until: new Date(r.until).toISOString() }),
        })),
      };
    }

    case "cancel_schedule":
      await store((s) => s.cancelSchedule(call.args.schedule_id));
      await hostContext[busState].host.scheduleChanged(call.args.schedule_id);

      return { schedule_id: call.args.schedule_id, cancelled: true };
  }
}
