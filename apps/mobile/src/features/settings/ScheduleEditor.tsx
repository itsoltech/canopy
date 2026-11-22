import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { PermissionMode, ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsModel } from "./SettingsModels";
import { ScheduleDate } from "./ScheduleDate";
import { ScheduleRecurrence } from "./ScheduleRecurrence";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";
import { useComputerHome } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { splitId } from "@canopy/domain/computers";
import { awayReason, formatPresenceTime } from "@canopy/domain/computer-presence";
import {
  scheduleSandboxChoices,
  scheduledSandboxLabel,
  scheduleThreadWorkers,
  type ScheduleSandboxChoices,
} from "./schedule-sandbox";
import {
  duplicateSchedulePermission,
  duplicateScheduleTimes,
  scheduledFullAccessDescription,
  scheduledFullAccessUnavailable,
} from "@canopy/domain/schedule-display";

/** Edits `schedule`, or creates a task: empty, or with the settings of `template` (Duplicate). */
export function ScheduleEditor({
  schedule,
  template,
  defaultThreadId,
  onSaved,
}: {
  schedule?: ui.Schedule;
  template?: ui.Schedule;
  defaultThreadId?: string;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("ListSchedules", (api) => api.listSchedules({}));
  const overview = useOverview();
  const home = useComputerHome(schedule ? splitId(schedule.id).node : undefined);

  const from = schedule ?? template;
  const [start] = useState(() => startTimes(schedule, template));

  const [draft, setDraft] = useState(() =>
    create(ui.CreateScheduleRequestSchema, {
      threadId: from?.threadId || defaultThreadId,
      ...scheduleDraft(from, Boolean(template && !schedule)),
    }),
  );

  const [kind, setKind] = useState(from?.kind || "once");
  const [date, setDate] = useState(start.date);
  const [cron, setCron] = useState(from?.cron || "0 9 * * 1-5");
  const [until, setUntil] = useState(start.until);

  const change = (patch: Partial<ui.CreateScheduleRequest>) =>
    setDraft(create(ui.CreateScheduleRequestSchema, { ...draft, ...patch }));

  const project = overview.projects.find((row) => row.id === draft.newThread?.projectId);
  const sandbox = useScheduleSandbox(draft, project, schedule, template);
  const threadHome = useComputerHome(splitId(draft.threadId).node);

  const workspace =
    draft.newThread?.placement === "specific"
      ? project?.workspaces.find((row) => row.id === draft.newThread?.workspaceId)
      : undefined;

  const workspaceHome = useComputerHome(splitId(workspace?.workerId ?? "").node);

  const removed =
    draft.target === "thread" &&
    Boolean(overview.threads.find((row) => row.id === draft.threadId)?.worktree?.removedAt);

  const targetAway =
    draft.target === "thread"
      ? threadHome.away
      : workspaceHome.away || Boolean(project && projectAwayReason(project, overview.workers, overview.computers));

  const save = () => {
    if (removed || sandbox?.blocked) return;

    const configuration = scheduleRequest({ draft, kind, date, cron, until });

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
      <ScheduleTarget draft={draft} change={change} sandbox={sandbox} />
      {removed && <Notice>This worktree was removed. Choose another thread or continue in a new worktree.</Notice>}
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
        title={schedule ? "Save schedule" : template ? "Duplicate schedule" : "Create schedule"}
        busy={resource.busy}
        disabled={
          home.away || targetAway || removed || sandbox?.blocked || !complete({ draft, kind, date, cron, until })
        }
        onPress={save}
      />
    </ResourceState>
  );
}

function useScheduleSandbox(
  draft: ui.CreateScheduleRequest,
  project: ui.Project | undefined,
  schedule: ui.Schedule | undefined,
  template: ui.Schedule | undefined,
) {
  const { workers } = useOverview();
  const { user } = useAppearance();
  const spec = draft.newThread;

  if (draft.target !== "new_thread" || spec?.permissionMode !== PermissionMode.FULL_AUTO) return undefined;

  return scheduleSandboxChoices({
    spec,
    workers: scheduleThreadWorkers(project, workers, spec),
    profiles: user?.sandboxProfiles?.profiles ?? [],
    saved: schedule?.newThread?.sandboxProfile?.profile,
    template: template?.newThread?.sandboxProfile?.profile,
  });
}

const validDate = (text: string) => Number.isFinite(Date.parse(text));

type ScheduleForm = { draft: ui.CreateScheduleRequest; kind: string; date: string; cron: string; until: string };

function scheduleRequest({ draft, kind, date, cron, until }: ScheduleForm) {
  const spec = draft.target === "new_thread" ? draft.newThread : undefined;

  return create(ui.CreateScheduleRequestSchema, {
    ...draft,
    threadId: draft.target === "thread" ? draft.threadId : "",
    newThread: spec && { ...spec, workspaceId: spec.placement === "specific" ? spec.workspaceId : "" },
    when:
      kind === "recurring"
        ? { case: "cron", value: cron }
        : { case: "runAt", value: timestampFromDate(new Date(date)) },
    until: kind === "recurring" && until ? timestampFromDate(new Date(until)) : undefined,
    maxRuns: kind === "recurring" ? draft.maxRuns : 0,
  });
}

/** The form has everything a save needs (the gateway still validates it). */
function complete({ draft, kind, date, cron, until }: ScheduleForm) {
  return (
    !!draft.prompt.trim() &&
    (kind !== "once" || validDate(date)) &&
    (kind !== "recurring" || !!cron) &&
    (!until || validDate(until)) &&
    (draft.target !== "thread" || !!draft.threadId)
  );
}

/** The run time and end date the form starts with; a duplicate never starts or ends in the past. */
function startTimes(schedule?: ui.Schedule, template?: ui.Schedule) {
  const copied = template && !schedule ? duplicateScheduleTimes(template, new Date()) : undefined;
  const iso = (time?: Timestamp) => (time ? timestampDate(time).toISOString() : "");

  return {
    date: copied?.runAt.toISOString() ?? iso(schedule?.runAt),
    until: copied?.until?.toISOString() ?? iso(schedule?.until),
  };
}

function scheduleDraft(schedule: ui.Schedule | undefined, duplicate: boolean) {
  const newThread = schedule?.newThread;
  const savedId = newThread?.sandboxProfile?.profile?.id;

  return {
    prompt: schedule?.prompt,
    name: schedule?.configuredName,
    timezone: schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    target: schedule?.target || "thread",
    newThread: newThread && {
      ...newThread,
      permissionMode: duplicate ? duplicateSchedulePermission(newThread.permissionMode) : newThread.permissionMode,
      sandboxProfileId: savedId ? (duplicate ? savedId : undefined) : newThread.sandboxProfileId,
      sandboxProfile: undefined,
    },
    concurrency: schedule?.concurrency || "skip_if_running",
    missedPolicy: schedule?.missedPolicy || "run_once",
    maxRuns: schedule?.maxRuns,
  };
}

function ScheduleTarget({
  draft,
  change,
  sandbox,
}: {
  draft: ui.CreateScheduleRequest;
  change: (v: Partial<ui.CreateScheduleRequest>) => void;
  sandbox?: ScheduleSandboxChoices;
}) {
  const { threads, computers } = useOverview();
  const thread = draft.target === "thread" ? threads.find((entry) => entry.id === draft.threadId) : undefined;

  const permissions =
    thread &&
    (thread.sandboxProfile || thread.permissionMode === PermissionMode.FULL_AUTO
      ? scheduledSandboxLabel(thread.sandboxProfile)
      : permissionLabel(thread.permissionMode));

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
            .filter((t) => !t.archivedAt && !t.worktree?.removedAt)
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
        <ScheduleThread value={draft.newThread} sandbox={sandbox} onChange={(newThread) => change({ newThread })} />
      )}
      {permissions && <Notice>Uses thread permissions · {permissions}</Notice>}
    </>
  );
}

function ScheduleThread({
  value,
  sandbox,
  onChange,
}: {
  value?: ui.NewThreadSchedule;
  sandbox?: ScheduleSandboxChoices;
  onChange: (v: ui.NewThreadSchedule) => void;
}) {
  const { projects, workers, computers } = useOverview();
  const workerOptions = useWorkerOptions();
  const draft = create(ui.NewThreadScheduleSchema, value);

  const change = (patch: Partial<ui.NewThreadSchedule>) =>
    onChange(create(ui.NewThreadScheduleSchema, { ...draft, ...patch }));

  const project = projects.find((p) => p.id === draft.projectId);

  const candidates = scheduleThreadWorkers(project, workers, draft);

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
          options={workerOptions(workers.filter((w) => project?.workspaces.some((ws) => ws.workerId === w.id))).flatMap(
            (option) =>
              (project?.workspaces.filter((w) => w.workerId === option.value) ?? []).map((w) => ({
                ...option,
                value: w.id,
              })),
          )}
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
      <SchedulePermissions draft={draft} change={change} sandbox={sandbox} />
      {draft.permissionMode === PermissionMode.FULL_ACCESS &&
        candidates.length > 0 &&
        !candidates.some((worker) => worker.fullAccess) && <Notice>{scheduledFullAccessUnavailable}</Notice>}
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

function SchedulePermissions({
  draft,
  change,
  sandbox,
}: {
  draft: ui.NewThreadSchedule;
  change: (patch: Partial<ui.NewThreadSchedule>) => void;
  sandbox?: ScheduleSandboxChoices;
}) {
  const [permission, setPermission] = useState(false);

  function pickPermission(permissionMode: PermissionMode) {
    const sandboxProfileId =
      sandbox && permissionMode !== PermissionMode.FULL_AUTO ? sandbox.selectionId("") : draft.sandboxProfileId;

    change({ permissionMode, sandboxProfileId });
  }

  return (
    <>
      <Button title={`Permissions: ${permissionLabel(draft.permissionMode)}`} onPress={() => setPermission(true)} />
      <PermissionPickerSheet
        visible={permission}
        onClose={() => setPermission(false)}
        value={draft.permissionMode}
        onSelect={pickPermission}
        fullAccessDescription={scheduledFullAccessDescription}
      />
      {sandbox && (
        <SettingChoice
          title="Sandbox profile"
          value={sandbox.value}
          onChange={(id) => change({ sandboxProfileId: sandbox.selectionId(id) })}
          options={sandbox.options}
          description={sandbox.problem}
        />
      )}
    </>
  );
}
