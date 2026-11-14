import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatDateTime } from "#lib/shared/format.ts";
import { humanizeEnum } from "@canopy/domain/humanize";
import type { Tone } from "#lib/shared/ui/tone.ts";
import { describeCron } from "@canopy/domain/schedule-display";

export { describeCron } from "@canopy/domain/schedule-display";

/** A schedule that will not run again (it ran out or was cancelled). */
export const isFinished = (schedule: ui.Schedule): boolean =>
  schedule.status === "completed" || schedule.status === "cancelled";

/** Terminal (and unknown) states never offer mutating actions. Shared by both row variants. */
export function scheduleActions(status: string): readonly ("edit" | "pause" | "resume" | "cancel")[] {
  if (status === "active") return ["edit", "pause", "cancel"];

  if (status === "paused") return ["edit", "resume", "cancel"];

  return [];
}

export interface StatusLook {
  label: string;
  tone: Tone;
}

export function scheduleStatusLook(status: string): StatusLook {
  switch (status) {
    case "active":
      return { label: "Active", tone: "emerald" };
    case "paused":
      return { label: "Paused", tone: "amber" };
    case "completed":
      return { label: "Done", tone: "neutral" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    default:
      return { label: humanizeEnum(status) || "Unknown", tone: "neutral" };
  }
}

/** When it runs: "Once, Nov 3, 2026, 9:00 AM" or "Every day at 09:00 (Europe/Warsaw)". */
export function describeWhen(schedule: ui.Schedule): string {
  if (schedule.kind === "once") return `Once, ${formatDateTime(schedule.runAt)}`;

  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `${describeCron(schedule.cron)}${schedule.timezone && schedule.timezone !== localZone ? ` (${schedule.timezone})` : ""}`;
}

/** "3 runs", "1 of 5 runs". */
export const runsLabel = (schedule: ui.Schedule): string =>
  schedule.maxRuns > 0
    ? `${schedule.runs} of ${schedule.maxRuns} runs`
    : `${schedule.runs} ${schedule.runs === 1 ? "run" : "runs"}`;

const time = (schedule: ui.Schedule, field: "nextRunAt" | "createdAt") =>
  schedule[field] ? timestampDate(schedule[field]).getTime() : 0;

/** Upcoming first (soonest next run), then finished ones (newest first). */
export function sortSchedules(schedules: Iterable<ui.Schedule>): ui.Schedule[] {
  return [...schedules].sort((a, b) => {
    if (isFinished(a) !== isFinished(b)) return isFinished(a) ? 1 : -1;

    if (isFinished(a)) return time(b, "createdAt") - time(a, "createdAt");

    return (time(a, "nextRunAt") || Number.MAX_SAFE_INTEGER) - (time(b, "nextRunAt") || Number.MAX_SAFE_INTEGER);
  });
}

export function upsertSchedule(list: readonly ui.Schedule[], schedule: ui.Schedule): ui.Schedule[] {
  const index = list.findIndex((s) => s.id === schedule.id);

  // A save response can arrive after the stream already announced a later edit or execution.
  if (index >= 0 && list[index]!.version > schedule.version) return [...list];

  return index >= 0 ? list.with(index, schedule) : [...list, schedule];
}

export const placementLabels = new Map<string, string>([
  ["any", "Any available"],
  ["least_busy", "Least busy"],
  ["round_robin", "Round robin"],
  ["specific", "Specific worker"],
]);
