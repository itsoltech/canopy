import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Schema } from "effect";
import { BotStore, type WakeupRow } from "../store.ts";
import { Invalid, NotFound } from "../../store/store.ts";
import { automationMode } from "../../worktrees/automation.ts";
import { botThreadPermission } from "../thread-permission.ts";
import { bool, decoded, define, json, object, provider, providerSchema, str, type ToolContext } from "./shared.ts";

const fields = {
  thread_id: str,
  prompt: str,
  run_at: str,
  cron: str,
  timezone: str,
  until: str,
  max_runs: { type: "integer" },
  missed_policy: { type: "string", enum: ["run_once", "skip"] },
  name: str,
  target: { type: "string", enum: ["thread", "new_thread"] },
  concurrency: { type: "string", enum: ["allow", "skip_if_running"] },
  new_thread: object(
    {
      project_id: str,
      placement: { type: "string", enum: ["specific", "any", "least_busy", "round_robin"] },
      workspace_id: str,
      provider: providerSchema,
      provider_instance: str,
      model: str,
      effort: str,
      title: str,
      workspace_mode: { type: "string", enum: ["default", "checkout", "new_worktree", "inherit_parent"] },
      base_ref: str,
      parent_thread_id: str,
    },
    ["project_id", "provider", "provider_instance"],
  ),
};

function date(value: string) {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Invalid("timestamps must be ISO dates with timezone");

  return timestampFromDate(new Date(value));
}

const NewThread = Schema.Struct({
  project_id: Schema.String,
  placement: Schema.optional(Schema.String),
  workspace_id: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.Json),
  provider_instance: Schema.String,
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  workspace_mode: Schema.optional(Schema.String),
  base_ref: Schema.optional(Schema.String),
  parent_thread_id: Schema.optional(Schema.String),
});

/** A wakeup as the model reads it: the timestamp in the ISO form `JSON.stringify` gives a Date. */
export const wakeupView = (w: WakeupRow) => ({ ...w, run_at: w.run_at.toISOString() });

async function configuration(c: ToolContext) {
  if (Boolean(c.optional("run_at")) === Boolean(c.optional("cron")))
    throw new Invalid("provide exactly one of run_at or cron");
  const n = c.args["new_thread"] === undefined ? undefined : decoded(NewThread, c.args["new_thread"]);
  const bot = n ? await c.core.bots.get(c.turn.bot_id) : undefined;
  const defaults = n ? await c.core.settings() : undefined;

  return create(ui.CreateScheduleRequestSchema, {
    threadId: c.optional("thread_id"),
    prompt: c.string("prompt"),
    target: c.optional("target"),
    name: c.optional("name"),
    when: c.optional("run_at")
      ? { case: "runAt", value: date(c.string("run_at")) }
      : { case: "cron", value: c.string("cron") },
    timezone: c.optional("timezone") || (await c.core.settings()).user?.timezone || "UTC",
    ...(c.optional("until") && { until: date(c.string("until")) }),
    maxRuns: c.integer("max_runs") ?? 0,
    missedPolicy: c.optional("missed_policy"),
    concurrency: c.optional("concurrency"),
    ...(n && {
      newThread: {
        projectId: n.project_id,
        placement: n.placement ?? "any",
        workspaceId: n.workspace_id ?? "",
        provider: provider(n.provider),
        providerProfileId: n.provider_instance,
        model: n.model ?? "",
        effort: n.effort ?? "",
        permissionMode: botThreadPermission(bot!.configuration!, defaults?.user?.threadDefaults?.permissionMode),
        title: n.title ?? "",
        workspaceMode: automationMode(n.workspace_mode ?? ""),
        baseRef: n.base_ref ?? "",
        parentThreadId: n.parent_thread_id ?? "",
      },
    }),
  });
}

const description =
  "Schedules: create a user platform schedule, separate from your own schedule_wakeup reminders. target=thread uses thread_id; target=new_thread uses new_thread configuration and placement (specific/any/least_busy/round_robin). Supply exactly run_at (ISO with the user's offset at that date) or cron (5 fields, minimum interval 5 minutes). timezone is IANA and defaults to the user's timezone (UTC only if none is stored). Optional until/max_runs bound cron runs. New-thread permissions come from the owner's bot settings, limited to sandboxed modes. Returns the UI schedule and version.";

export const scheduleTools = [
  define("create_schedule", description, object(fields, ["prompt"]), "Creating a schedule", (c) =>
    c.action(async () => json(ui.ScheduleSchema, await c.core.createSchedule(await configuration(c)))),
  ),
  define(
    "list_schedules",
    "Schedules: list all platform schedules owned by the user, optionally by project/thread and including finished/cancelled. Also returns this bot's own one-shot wakeups separately; scope= wakeup for reminders only.",
    object({
      project_id: str,
      thread_id: str,
      include_finished: bool,
      scope: { type: "string", enum: ["platform", "wakeup", "all"] },
    }),
    "Checking schedules",
    async ({ core, optional, args, turn }) => ({
      schedules:
        optional("scope") === "wakeup"
          ? []
          : (
              await core.listSchedules(
                create(ui.ListSchedulesRequestSchema, {
                  projectId: optional("project_id"),
                  threadId: optional("thread_id"),
                  includeFinished: args["include_finished"] === true,
                }),
              )
            ).map((s) => json(ui.ScheduleSchema, s)),
      wakeups:
        optional("scope") === "platform" ? [] : (await core.bots.run((s) => s.wakeups(turn.bot_id))).map(wakeupView),
    }),
    "read",
  ),
  define(
    "update_schedule",
    "Schedules: replace the full configuration of an active or paused user schedule using its expected_version from list_schedules. Same fields and validation as create_schedule, including the user's timezone default; retains status/history/runs. New-thread permissions come from the owner's bot settings, limited to sandboxed modes.",
    object({ ...fields, schedule_id: str, expected_version: { type: "integer", minimum: 1 } }, [
      "schedule_id",
      "expected_version",
      "prompt",
    ]),
    "Updating a schedule",
    (c) =>
      c.action(async () =>
        json(
          ui.ScheduleSchema,
          await c.core.updateSchedule(
            create(ui.UpdateScheduleRequestSchema, {
              scheduleId: c.string("schedule_id"),
              expectedVersion: c.integer("expected_version") ?? 0,
              configuration: await configuration(c),
            }),
          ),
        ),
      ),
  ),
  define(
    "set_schedule_status",
    "Schedules: pause or resume a user platform schedule. Finished and cancelled schedules cannot resume. Use cancel_schedule to cancel.",
    object({ schedule_id: str, status: { type: "string", enum: ["active", "paused"] } }, ["schedule_id", "status"]),
    (a) => (a["status"] === "paused" ? "Pausing a schedule" : "Resuming a schedule"),
    ({ core, string, action }) =>
      action(async () =>
        json(
          ui.ScheduleSchema,
          await core.setScheduleStatus(
            create(ui.SetScheduleStatusRequestSchema, { scheduleId: string("schedule_id"), status: string("status") }),
          ),
        ),
      ),
  ),
  define(
    "cancel_schedule",
    "Schedules: cancel a user platform schedule or this bot's one-shot wakeup. scope=platform/wakeup disambiguates (default auto-detect). Other bots' wakeups are inaccessible. Requires approval.",
    object({ schedule_id: str, scope: { type: "string", enum: ["platform", "wakeup"] } }, ["schedule_id"]),
    "Cancelling a schedule",
    async (c) => {
      const id = c.string("schedule_id");
      const owned = await c.core.bots.run((s) => s.wakeups(c.turn.bot_id));

      if (c.optional("scope") !== "platform" && owned.some((w) => w.id === id))
        return c.options.runtime.runPromise(
          BotStore.use((s) => s.action(c.turn, c.call, s.cancelWakeup(c.turn.bot_id, id))),
        );

      if (c.optional("scope") === "wakeup") throw new NotFound("wakeup not found");

      return c.action(async () =>
        json(
          ui.ScheduleSchema,
          await c.core.setScheduleStatus(
            create(ui.SetScheduleStatusRequestSchema, { scheduleId: id, status: "cancelled" }),
          ),
        ),
      );
    },
    "approval",
  ),
];
