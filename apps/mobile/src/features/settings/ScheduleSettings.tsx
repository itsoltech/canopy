import { useState } from "react";
import { createSettingsViewState } from "./SettingsScroll";
import { useLocalSearchParams } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, EmptyState, Notice, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsGroupHeader } from "./SettingsGroup";
import { Segmented } from "../../ui/Segmented";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ScheduleTaskRow } from "./ScheduleTaskRow";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { ScheduleEditor } from "./ScheduleEditor";
import { useOverview } from "../../state/overview";
import { splitId } from "@canopy/domain/computers";
import { awayReason, formatPresenceTime } from "@canopy/domain/computer-presence";

const useScheduleTab = createSettingsViewState("upcoming");

export function ScheduleSettings() {
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();

  const resource = useSettingsResource(`ListSchedules:${threadId ?? ""}`, (api) =>
    api.listSchedules({ threadId, includeFinished: true }),
  );

  const { computers, threads } = useOverview();

  const reason = (schedule: ui.Schedule) => {
    if (threads.find((row) => row.id === schedule.threadId)?.worktree?.removedAt)
      return "This worktree was removed. Continue in a new worktree.";

    const node = splitId(schedule.id).node;

    return node
      ? awayReason(
          computers.find((computer) => computer.nodeId.startsWith(node)),
          formatPresenceTime,
        )
      : undefined;
  };

  const [tab, setTab] = useScheduleTab();
  // Edit `schedule`, or create a task, empty or from `template` (Duplicate).
  const [editing, setEditing] = useState<{ schedule?: ui.Schedule; template?: ui.Schedule }>();
  const [actionId, setActionId] = useState("");
  const schedules = resource.data?.schedules ?? [];
  const actions = schedules.find((schedule) => schedule.id === actionId);
  const upcoming = schedules.filter((s) => !isFinished(s)).sort((a, b) => nextRun(a) - nextRun(b));

  const finished = schedules.filter(isFinished).sort((a, b) => created(b) - created(a));

  const rows = resource.initialLoading
    ? [create(ui.ScheduleSchema, { name: " ", status: "active" })]
    : tab === "upcoming"
      ? upcoming
      : finished;

  return (
    <ResourceState resource={resource} gap={12}>
      <SettingsGroupHeader
        title="Scheduled tasks"
        description={
          threadId
            ? threads.find((thread) => thread.id === threadId)?.title || "Tasks for this thread"
            : "Messages sent once or on repeat."
        }
        actions={<Button size="sm" icon="plus" variant="primary" title="New task" onPress={() => setEditing({})} />}
      />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "upcoming", label: `Upcoming ${upcoming.length}` },
          { value: "finished", label: `Finished ${finished.length}` },
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
      {!!rows.length && (
        <SettingsGroup>
          {rows.map((s) => (
            <ScheduleTaskRow
              key={s.id}
              schedule={s}
              reason={reason(s)}
              onActions={() => setActionId(s.id)}
              onDuplicate={() => setEditing({ template: s })}
            />
          ))}
        </SettingsGroup>
      )}
      <Sheet title="Scheduled task actions" visible={!!actions} onClose={() => setActionId("")}>
        {actions && (
          <ScheduleActions
            schedule={actions}
            resource={resource}
            disabled={Boolean(reason(actions))}
            onChanged={() => setActionId("")}
            onEdit={() => {
              setActionId("");
              setEditing({ schedule: actions });
            }}
            onDuplicate={() => {
              setActionId("");
              setEditing({ template: actions });
            }}
          />
        )}
      </Sheet>
      <Sheet
        title={editing?.schedule ? "Edit schedule" : editing?.template ? "Duplicate schedule" : "Add schedule"}
        visible={!!editing}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ScheduleEditor
            defaultThreadId={threadId}
            schedule={editing.schedule}
            template={editing.template}
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

const created = (s: ui.Schedule) => (s.createdAt ? timestampDate(s.createdAt).getTime() : 0);
const isFinished = (s: ui.Schedule) => s.status === "completed" || s.status === "cancelled";
const nextRun = (s: ui.Schedule) => (s.nextRunAt ? timestampDate(s.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER);

function ScheduleActions({
  schedule,
  resource,
  disabled,
  onEdit,
  onDuplicate,
  onChanged,
}: {
  schedule: ui.Schedule;
  resource: ReturnType<typeof useSettingsResource<ui.ListSchedulesResponse>>;
  disabled: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onChanged: () => void;
}) {
  async function change(status: string) {
    const result = await resource.run((api) => api.setScheduleStatus({ scheduleId: schedule.id, status }));

    if (result) onChanged();
  }

  const live = ["active", "paused"].includes(schedule.status);

  return (
    <>
      {resource.error && <Notice error>{resource.error}</Notice>}
      {live && <Button title="Edit schedule" disabled={disabled} onPress={onEdit} />}
      <Button title="Duplicate schedule" disabled={disabled} onPress={onDuplicate} />
      {live && (
        <Button
          title={schedule.status === "paused" ? "Resume schedule" : "Pause schedule"}
          busy={resource.busy}
          disabled={disabled}
          onPress={() => void change(schedule.status === "paused" ? "active" : "paused")}
        />
      )}
      {live && (
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
      )}
    </>
  );
}
