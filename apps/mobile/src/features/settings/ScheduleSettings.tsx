import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Button, EmptyState, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { ScheduleEditor } from "./ScheduleEditor";
import { useOverview } from "../../state/overview";
import { splitId } from "@canopy/domain/computers";
import { awayReason, formatPresenceTime } from "@canopy/domain/computer-presence";

export function ScheduleSettings() {
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();

  const resource = useSettingsResource(`ListSchedules:${threadId ?? ""}`, (api) =>
    api.listSchedules({ threadId, includeFinished: true }),
  );

  const { computers } = useOverview();

  const reason = (schedule: ui.Schedule) => {
    const node = splitId(schedule.id).node;

    return node
      ? awayReason(
          computers.find((computer) => computer.nodeId.startsWith(node)),
          formatPresenceTime,
        )
      : undefined;
  };

  const [tab, setTab] = useState("upcoming");
  const [editing, setEditing] = useState<ui.Schedule | "new">();
  const upcoming = resource.data?.schedules.filter((s) => ["active", "paused"].includes(s.status)) ?? [];
  const finished = resource.data?.schedules.filter((s) => !["active", "paused"].includes(s.status)) ?? [];

  const rows = resource.initialLoading
    ? [create(ui.ScheduleSchema, { name: " ", status: "active" })]
    : tab === "upcoming"
      ? upcoming
      : finished;

  return (
    <ResourceState resource={resource}>
      <Button variant="primary" title="Add schedule" onPress={() => setEditing("new")} />
      <SettingChoice
        title="Schedules"
        value={tab}
        onChange={setTab}
        options={[
          { value: "upcoming", label: `Upcoming (${upcoming.length})` },
          { value: "finished", label: `Finished (${finished.length})` },
        ]}
      />
      {resource.data && !rows.length && (
        <EmptyState
          icon="clock"
          title={tab === "upcoming" ? "Nothing scheduled" : "No finished tasks"}
          description={
            tab === "upcoming"
              ? "Send a message to a thread later, once or on repeat. Agents can schedule their own wake-ups too."
              : "Tasks that ran once or were cancelled appear here."
          }
        />
      )}
      {rows.map((s) => (
        <SettingsGroup
          key={s.id}
          title={s.name}
          description={reason(s) ?? s.status}
          style={reason(s) ? { opacity: 0.55 } : undefined}
        >
          <SettingsValue title="Message" value={s.prompt} />
          <SettingsValue
            title="When"
            value={
              s.kind === "recurring"
                ? `${s.cron} · ${s.timezone}`
                : s.runAt
                  ? timestampDate(s.runAt).toLocaleString()
                  : ""
            }
          />
          <SettingsValue
            title="Next run"
            value={s.nextRunAt ? timestampDate(s.nextRunAt).toLocaleString() : "No next run"}
          />
          <SettingsValue title="Target" value={s.target === "new_thread" ? "New thread" : s.threadId} />
          <SettingsValue title="Runs" value={String(s.runs)} />
          {s.recentRuns.map((r, index) => (
            <SettingsRow
              key={index}
              title={`Run ${r.number} · ${r.outcome}`}
              description={r.scheduledFor ? timestampDate(r.scheduledFor).toLocaleString() : ""}
            />
          ))}
          {["active", "paused"].includes(s.status) && (
            <ScheduleActions
              schedule={s}
              resource={resource}
              disabled={Boolean(reason(s))}
              onEdit={() => setEditing(s)}
            />
          )}
        </SettingsGroup>
      ))}
      <Sheet
        title={editing === "new" ? "Add schedule" : "Edit schedule"}
        visible={!!editing}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ScheduleEditor
            defaultThreadId={threadId}
            schedule={editing === "new" ? undefined : editing}
            onSaved={() => {
              setEditing(undefined);
              void resource.reload();
            }}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}

function ScheduleActions({
  schedule,
  resource,
  disabled,
  onEdit,
}: {
  schedule: ui.Schedule;
  resource: ReturnType<typeof useSettingsResource<ui.ListSchedulesResponse>>;
  disabled: boolean;
  onEdit: () => void;
}) {
  return (
    <>
      <Button title="Edit schedule" disabled={disabled} onPress={onEdit} />
      <Button
        title={schedule.status === "paused" ? "Resume schedule" : "Pause schedule"}
        busy={resource.busy}
        disabled={disabled}
        onPress={() =>
          void resource.run((api) =>
            api.setScheduleStatus({
              scheduleId: schedule.id,
              status: schedule.status === "paused" ? "active" : "paused",
            }),
          )
        }
      />
      <Button
        variant="danger"
        title="Cancel schedule"
        busy={resource.busy}
        disabled={disabled}
        onPress={() =>
          confirmAction(
            "Cancel schedule",
            "This stops future messages. Its run history stays.",
            () => void resource.run((api) => api.setScheduleStatus({ scheduleId: schedule.id, status: "cancelled" })),
          )
        }
      />
    </>
  );
}
