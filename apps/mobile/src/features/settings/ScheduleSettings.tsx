import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, EmptyState, Sheet } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { ScheduleTaskRow } from "./ScheduleTaskRow";
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
  const [actions, setActions] = useState<ui.Schedule>();
  const upcoming = resource.data?.schedules.filter((s) => ["active", "paused"].includes(s.status)) ?? [];
  const finished = resource.data?.schedules.filter((s) => !["active", "paused"].includes(s.status)) ?? [];

  const rows = resource.initialLoading
    ? [create(ui.ScheduleSchema, { name: " ", status: "active" })]
    : tab === "upcoming"
      ? upcoming
      : finished;

  return (
    <ResourceState resource={resource} gap={12}>
      <Button variant="primary" title="New task" onPress={() => setEditing("new")} />
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
            tab === "upcoming" ? "Create a task to send a message later." : "Completed and cancelled tasks appear here."
          }
        />
      )}
      {rows.map((s) => (
        <ScheduleTaskRow key={s.id} schedule={s} reason={reason(s)} onActions={() => setActions(s)} />
      ))}
      <Sheet title="Scheduled task actions" visible={!!actions} onClose={() => setActions(undefined)}>
        {actions && (
          <ScheduleActions
            schedule={actions}
            resource={resource}
            disabled={Boolean(reason(actions))}
            onChanged={() => setActions(undefined)}
            onEdit={() => {
              setActions(undefined);
              setEditing(actions);
            }}
          />
        )}
      </Sheet>
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
  onChanged,
}: {
  schedule: ui.Schedule;
  resource: ReturnType<typeof useSettingsResource<ui.ListSchedulesResponse>>;
  disabled: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  async function change(status: string) {
    const result = await resource.run((api) => api.setScheduleStatus({ scheduleId: schedule.id, status }));

    if (result) onChanged();
  }

  return (
    <>
      <Button title="Edit schedule" disabled={disabled} onPress={onEdit} />
      <Button
        title={schedule.status === "paused" ? "Resume schedule" : "Pause schedule"}
        busy={resource.busy}
        disabled={disabled}
        onPress={() => void change(schedule.status === "paused" ? "active" : "paused")}
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
            () => void change("cancelled"),
          )
        }
      />
    </>
  );
}
