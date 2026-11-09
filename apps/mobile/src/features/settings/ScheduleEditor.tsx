import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Field } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsModel } from "./SettingsModels";
import { ScheduleDate } from "./ScheduleDate";
import { ScheduleRecurrence } from "./ScheduleRecurrence";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";
import { useComputerHome, useWorkerPresence } from "../computers/presence";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { splitId } from "@canopy/domain/computers";
import { awayReason, formatPresenceTime } from "@canopy/domain/computer-presence";

export function ScheduleEditor({
  schedule,
  defaultThreadId,
  onSaved,
}: {
  schedule?: ui.Schedule;
  defaultThreadId?: string;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("schedule-editor", (api) => api.listSchedules({}), "ListSchedules");
  const overview = useOverview();
  const home = useComputerHome(schedule ? splitId(schedule.id).node : undefined);

  const [draft, setDraft] = useState(() =>
    create(ui.CreateScheduleRequestSchema, {
      threadId: schedule?.threadId ?? defaultThreadId,
      ...scheduleDraft(schedule),
    }),
  );

  const [kind, setKind] = useState(schedule?.kind || "once");
  const [date, setDate] = useState(schedule?.runAt ? timestampDate(schedule.runAt).toISOString() : "");
  const [cron, setCron] = useState(schedule?.cron || "0 9 * * 1-5");
  const [until, setUntil] = useState(schedule?.until ? timestampDate(schedule.until).toISOString() : "");

  const change = (patch: Partial<ui.CreateScheduleRequest>) =>
    setDraft(create(ui.CreateScheduleRequestSchema, { ...draft, ...patch }));

  const project = overview.projects.find((row) => row.id === draft.newThread?.projectId);
  const threadHome = useComputerHome(splitId(draft.threadId).node);
  const workspace = project?.workspaces.find((row) => row.id === draft.newThread?.workspaceId);
  const workspaceHome = useComputerHome(splitId(workspace?.workerId ?? "").node);

  const targetAway =
    draft.target === "thread"
      ? threadHome.away
      : workspaceHome.away || Boolean(project && projectAwayReason(project, overview.workers, overview.computers));

  const validDate = (text: string) => Number.isFinite(Date.parse(text));

  const save = () => {
    const configuration = create(ui.CreateScheduleRequestSchema, {
      ...draft,
      when:
        kind === "recurring"
          ? { case: "cron", value: cron }
          : { case: "runAt", value: timestampFromDate(new Date(date)) },
      until: kind === "recurring" && until ? timestampFromDate(new Date(until)) : undefined,
      maxRuns: kind === "recurring" ? draft.maxRuns : 0,
    });

    void resource
      .run(async (api) =>
        schedule
          ? api.updateSchedule({ scheduleId: schedule.id, expectedVersion: schedule.version, configuration })
          : api.createSchedule(configuration),
      )
      .then((r) => {
        if (r) onSaved();
      });
  };

  return (
    <ResourceState resource={resource}>
      <Field label="Name" value={draft.name} onChangeText={(name) => change({ name })} />
      <Field label="Message" multiline value={draft.prompt} onChangeText={(prompt) => change({ prompt })} />
      <ScheduleTarget draft={draft} change={change} />
      <SettingChoice
        title="When"
        value={kind}
        onChange={setKind}
        options={[
          { value: "once", label: "Once" },
          { value: "recurring", label: "Repeat" },
        ]}
      />
      {kind === "once" ? (
        <ScheduleDate title="Run at" value={date} onChange={setDate} />
      ) : (
        <ScheduleRecurrence
          cron={cron}
          setCron={setCron}
          timezone={draft.timezone}
          setTimezone={(timezone) => change({ timezone })}
          until={until}
          setUntil={setUntil}
          maxRuns={draft.maxRuns}
          setMaxRuns={(maxRuns) => change({ maxRuns })}
        />
      )}
      <SettingChoice
        title="If a run is missed"
        description="After a gateway outage, or after 2 minutes without an eligible worker for a pool."
        value={draft.missedPolicy}
        onChange={(missedPolicy) => change({ missedPolicy })}
        options={[
          { value: "run_once", label: "Run once when back" },
          { value: "skip", label: "Skip it" },
        ]}
      />
      {draft.target === "new_thread" && kind === "recurring" && (
        <SettingChoice
          title="While a previous run is working"
          value={draft.concurrency}
          onChange={(concurrency) => change({ concurrency })}
          options={[
            { value: "skip_if_running", label: "Skip the next run" },
            { value: "allow", label: "Start another thread" },
          ]}
        />
      )}
      <Button
        variant="primary"
        title={schedule ? "Save schedule" : "Create schedule"}
        busy={resource.busy}
        disabled={
          home.away ||
          targetAway ||
          !draft.prompt.trim() ||
          (kind === "once" && !validDate(date)) ||
          (kind === "recurring" && !cron) ||
          (!!until && !validDate(until)) ||
          (draft.target === "thread" && !draft.threadId)
        }
        onPress={save}
      />
    </ResourceState>
  );
}

function scheduleDraft(schedule?: ui.Schedule) {
  return {
    prompt: schedule?.prompt,
    name: schedule?.configuredName,
    timezone: schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    target: schedule?.target || "thread",
    newThread: schedule?.newThread,
    concurrency: schedule?.concurrency || "skip_if_running",
    missedPolicy: schedule?.missedPolicy || "run_once",
    maxRuns: schedule?.maxRuns,
  };
}

function ScheduleTarget({
  draft,
  change,
}: {
  draft: ui.CreateScheduleRequest;
  change: (v: Partial<ui.CreateScheduleRequest>) => void;
}) {
  const { threads, computers } = useOverview();

  return (
    <>
      <SettingChoice
        title="Target"
        value={draft.target}
        onChange={(target) => change({ target })}
        options={[
          { value: "thread", label: "Existing thread" },
          { value: "new_thread", label: "New thread" },
        ]}
      />
      {draft.target === "thread" ? (
        <SettingChoice
          title="Thread"
          value={draft.threadId}
          onChange={(threadId) => change({ threadId })}
          options={threads
            .filter((t) => !t.archivedAt)
            .map((t) => {
              const reason = t.nodeId
                ? awayReason(
                    computers.find((computer) => computer.nodeId === t.nodeId),
                    formatPresenceTime,
                  )
                : undefined;

              return {
                value: t.id,
                label: t.title || "Untitled thread",
                disabled: Boolean(reason),
                description: reason,
              };
            })}
        />
      ) : (
        <ScheduleThread value={draft.newThread} onChange={(newThread) => change({ newThread })} />
      )}
    </>
  );
}

function ScheduleThread({
  value,
  onChange,
}: {
  value?: ui.NewThreadSchedule;
  onChange: (v: ui.NewThreadSchedule) => void;
}) {
  const { projects, workers, computers } = useOverview();
  const presence = useWorkerPresence();
  const [permission, setPermission] = useState(false);
  const draft = create(ui.NewThreadScheduleSchema, value);

  const change = (patch: Partial<ui.NewThreadSchedule>) =>
    onChange(create(ui.NewThreadScheduleSchema, { ...draft, ...patch }));

  const project = projects.find((p) => p.id === draft.projectId);

  return (
    <>
      <SettingChoice
        title="Project"
        value={draft.projectId}
        onChange={(projectId) => change({ projectId, workspaceId: "" })}
        options={projects
          .filter((p) => !p.archivedAt)
          .map((p) => ({
            value: p.id,
            label: p.name,
            disabled: Boolean(projectAwayReason(p, workers, computers)),
            description: projectAwayReason(p, workers, computers),
          }))}
      />
      <SettingChoice
        title="Placement"
        value={draft.placement || "any"}
        onChange={(placement) => change({ placement })}
        options={[
          { value: "any", label: "Any available computer" },
          { value: "least_busy", label: "Least busy" },
          { value: "round_robin", label: "Round robin" },
          { value: "specific", label: "Specific worker" },
        ]}
      />
      {draft.placement === "specific" && (
        <SettingChoice
          title="Workspace"
          value={draft.workspaceId}
          onChange={(workspaceId) => change({ workspaceId })}
          options={
            project?.workspaces.map((w) => {
              const state = presence(workers.find((worker) => worker.id === w.workerId));

              return {
                value: w.id,
                label: w.label || w.rootPath,
                disabled: !state.online,
                description: state.reason ?? state.status,
              };
            }) ?? []
          }
        />
      )}
      <SettingsModel
        value={{
          provider: draft.provider,
          profileId: draft.providerProfileId,
          model: draft.model,
          effort: draft.effort,
        }}
        onChange={(c, effort) =>
          change({ provider: c.provider, providerProfileId: c.profileId, model: c.model, effort })
        }
      />
      <Button title={`Permissions: ${permissionLabel(draft.permissionMode)}`} onPress={() => setPermission(true)} />
      <PermissionPickerSheet
        visible={permission}
        onClose={() => setPermission(false)}
        value={draft.permissionMode}
        onSelect={(permissionMode) => change({ permissionMode })}
      />
      <Field label="Thread title" value={draft.title} onChangeText={(title) => change({ title })} />
      <SettingChoice
        title="Workspace mode"
        value={draft.workspaceMode}
        onChange={(workspaceMode) => change({ workspaceMode })}
        options={[
          { value: ui.WorkspaceMode.UNSPECIFIED, label: "Use project default" },
          { value: ui.WorkspaceMode.CHECKOUT, label: "Current checkout" },
          { value: ui.WorkspaceMode.NEW_WORKTREE, label: "New worktree" },
        ]}
      />
      <Field label="Base ref" value={draft.baseRef} onChangeText={(baseRef) => change({ baseRef })} />
    </>
  );
}
