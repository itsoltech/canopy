import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { Button, Field, Notice } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsModel } from "./SettingsModels";
import { PermissionPickerSheet, permissionLabel } from "../threads/permissions";

export function ScheduleEditor({ schedule, onSaved }: { schedule?: ui.Schedule; onSaved: () => void }) {
  const resource = useSettingsResource("schedule-editor", (api) => api.listSchedules({}));

  const [draft, setDraft] = useState(() =>
    create(ui.CreateScheduleRequestSchema, {
      threadId: schedule?.threadId,
      prompt: schedule?.prompt,
      name: schedule?.configuredName,
      timezone: schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      target: schedule?.target || "thread",
      newThread: schedule?.newThread,
      concurrency: schedule?.concurrency || "skip_if_running",
      missedPolicy: schedule?.missedPolicy || "run_once",
      maxRuns: schedule?.maxRuns,
    }),
  );

  const [kind, setKind] = useState(schedule?.kind || "once");
  const [date, setDate] = useState(schedule?.runAt ? timestampDate(schedule.runAt).toISOString() : "");
  const [cron, setCron] = useState(schedule?.cron || "0 9 * * 1-5");
  const [until, setUntil] = useState(schedule?.until ? timestampDate(schedule.until).toISOString() : "");

  const change = (patch: Partial<ui.CreateScheduleRequest>) =>
    setDraft(create(ui.CreateScheduleRequestSchema, { ...draft, ...patch }));

  const validDate = (text: string) => Number.isFinite(Date.parse(text));

  const save = () => {
    const configuration = create(ui.CreateScheduleRequestSchema, {
      ...draft,
      when:
        kind === "recurring"
          ? { case: "cron", value: cron }
          : { case: "runAt", value: timestampFromDate(new Date(date)) },
      until: until ? timestampFromDate(new Date(until)) : undefined,
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
          { value: "recurring", label: "Recurring" },
        ]}
      />
      {kind === "once" ? (
        <Field
          label="Date and time (ISO 8601, with time zone)"
          value={date}
          onChangeText={setDate}
          placeholder="2026-12-01T09:00:00+01:00"
          autoCapitalize="none"
        />
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
        title="After downtime"
        value={draft.missedPolicy}
        onChange={(missedPolicy) => change({ missedPolicy })}
        options={[
          { value: "run_once", label: "Run once" },
          { value: "skip", label: "Skip missed messages" },
        ]}
      />
      <SettingChoice
        title="When the previous run is active"
        value={draft.concurrency}
        onChange={(concurrency) => change({ concurrency })}
        options={[
          { value: "skip_if_running", label: "Skip this run" },
          { value: "allow", label: "Allow another run" },
        ]}
      />
      <Button
        title={schedule ? "Save schedule" : "Create schedule"}
        busy={resource.busy}
        disabled={
          !draft.prompt.trim() ||
          (kind === "once" && !validDate(date)) ||
          (!!until && !validDate(until)) ||
          (draft.target === "thread" && !draft.threadId)
        }
        onPress={save}
      />
    </ResourceState>
  );
}

function ScheduleTarget({
  draft,
  change,
}: {
  draft: ui.CreateScheduleRequest;
  change: (v: Partial<ui.CreateScheduleRequest>) => void;
}) {
  const { threads } = useOverview();

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
            .map((t) => ({ value: t.id, label: t.title || "Untitled thread" }))}
        />
      ) : (
        <ScheduleThread value={draft.newThread} onChange={(newThread) => change({ newThread })} />
      )}
    </>
  );
}

function ScheduleRecurrence({
  cron,
  setCron,
  timezone,
  setTimezone,
  until,
  setUntil,
  maxRuns,
  setMaxRuns,
}: {
  cron: string;
  setCron: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  until: string;
  setUntil: (v: string) => void;
  maxRuns: number;
  setMaxRuns: (v: number) => void;
}) {
  const resource = useSettingsResource("schedule-preview", (api) => api.listSchedules({}));
  const [preview, setPreview] = useState<ui.PreviewScheduleResponse>();

  return (
    <ResourceState resource={resource}>
      <Field
        label="Cron expression"
        value={cron}
        onChangeText={(v) => {
          setCron(v);
          setPreview(undefined);
        }}
        autoCapitalize="none"
      />
      <Field
        label="Time zone"
        value={timezone}
        onChangeText={(v) => {
          setTimezone(v);
          setPreview(undefined);
        }}
        autoCapitalize="none"
      />
      <Button
        secondary
        title="Preview occurrences"
        busy={resource.busy}
        onPress={() =>
          void resource
            .run((api) => api.previewSchedule({ cron, timezone, count: 5 }))
            .then((r) => {
              if (r) setPreview(r);
            })
        }
      />
      {preview?.nextRuns.map((v, index) => (
        <Notice key={index}>{timestampDate(v).toLocaleString()}</Notice>
      ))}
      <Field label="End date (optional ISO 8601)" value={until} onChangeText={setUntil} autoCapitalize="none" />
      <Field
        label="Maximum runs (0 means no limit)"
        value={String(maxRuns)}
        keyboardType="number-pad"
        onChangeText={(v) => setMaxRuns(Number(v))}
      />
    </ResourceState>
  );
}

function ScheduleThread({
  value,
  onChange,
}: {
  value?: ui.NewThreadSchedule;
  onChange: (v: ui.NewThreadSchedule) => void;
}) {
  const { projects } = useOverview();
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
        options={projects.filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name }))}
      />
      <SettingChoice
        title="Placement"
        value={draft.placement || "any"}
        onChange={(placement) => change({ placement })}
        options={[
          { value: "any", label: "Any available computer" },
          { value: "least_busy", label: "Least busy" },
          { value: "round_robin", label: "Round robin" },
          { value: "specific", label: "Specific computer" },
        ]}
      />
      {draft.placement === "specific" && (
        <SettingChoice
          title="Workspace"
          value={draft.workspaceId}
          onChange={(workspaceId) => change({ workspaceId })}
          options={project?.workspaces.map((w) => ({ value: w.id, label: w.label || w.rootPath })) ?? []}
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
      <Button
        secondary
        title={`Permissions: ${permissionLabel(draft.permissionMode)}`}
        onPress={() => setPermission(true)}
      />
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
