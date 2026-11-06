import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Button, EmptyState, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { ScheduleEditor } from "./ScheduleEditor";

export function ScheduleSettings() {
  const resource = useSettingsResource("schedules", (api) => api.listSchedules({ includeFinished: true }));
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
        <SettingsGroup key={s.id} title={s.name} description={s.status}>
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
            <>
              <Button title="Edit schedule" onPress={() => setEditing(s)} />
              <Button
                title={s.status === "paused" ? "Resume schedule" : "Pause schedule"}
                busy={resource.busy}
                onPress={() =>
                  void resource.run((api) =>
                    api.setScheduleStatus({ scheduleId: s.id, status: s.status === "paused" ? "active" : "paused" }),
                  )
                }
              />
              <Button
                variant="danger"
                title="Cancel schedule"
                busy={resource.busy}
                onPress={() =>
                  confirmAction(
                    "Cancel schedule",
                    "This stops future messages. Its run history stays.",
                    () => void resource.run((api) => api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" })),
                  )
                }
              />
            </>
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
