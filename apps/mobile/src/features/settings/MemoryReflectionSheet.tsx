import { useRef, useState } from "react";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { useOverview } from "../../state/overview";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingAccess, type AccessOption } from "./SettingAccess";
import { SettingChoice, SettingsGroup, SettingToggle } from "./SettingsGroup";
import { MemoryReflectionModelFields } from "./MemoryReflectionModelFields";

const intervals = [
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" },
  { value: 4320, label: "Every 3 days" },
  { value: 10080, label: "Every 7 days" },
];

type Settings = ui.MemoryReflectionSettings;

function useReflectionChoices(
  draft: Settings,
  projects: ui.MemoryReflectionProject[],
  models: ui.MemoryReflectionModel[],
) {
  const overview = useOverview();
  const projectOptions: AccessOption[] = [...projects];
  const selectedProjects = overview.projects.filter(({ id }) => draft.projectIds.includes(id));

  const availableModels = models.filter(({ workerId }) =>
    selectedProjects.every(({ workspaces }) => workspaces.some((workspace) => workspace.workerId === workerId)),
  );

  const profileModels = availableModels.filter(
    (item) =>
      item.workerId === draft.workerId && item.provider === draft.provider && item.profileId === draft.profileId,
  );

  const chosenModel = profileModels.find(({ model }) => model === draft.model);
  const missingProjects = draft.projectIds.filter((id) => !projects.some((project) => project.id === id));

  for (const id of missingProjects) projectOptions.push({ id, name: "Unavailable project" });

  const valid =
    !draft.enabled ||
    (!!draft.projectIds.length &&
      !missingProjects.length &&
      !!profileModels.length &&
      (!draft.model || !!chosenModel) &&
      (!draft.effort || chosenModel?.efforts.includes(draft.effort)));

  const projectHint = !projects.length
    ? "Add a project to turn on habit checks."
    : draft.enabled && !draft.projectIds.length
      ? "Choose at least one project to turn on habit checks."
      : draft.enabled && missingProjects.length
        ? "Remove unavailable projects to turn on habit checks."
        : undefined;

  return { availableModels, projectOptions, projectHint, valid };
}

function hasChanges(saved: Settings, draft: Settings) {
  return (
    saved.enabled !== draft.enabled ||
    saved.intervalMinutes !== draft.intervalMinutes ||
    saved.workerId !== draft.workerId ||
    saved.provider !== draft.provider ||
    saved.profileId !== draft.profileId ||
    saved.model !== draft.model ||
    saved.effort !== draft.effort ||
    saved.projectIds.length !== draft.projectIds.length ||
    saved.projectIds.some((id) => !draft.projectIds.includes(id))
  );
}

export function MemoryReflectionSheet({
  settings,
  projects,
  models,
  onSave,
  onReload,
  onClose,
}: {
  settings: Settings;
  projects: ui.MemoryReflectionProject[];
  models: ui.MemoryReflectionModel[];
  onSave: (draft: Settings) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const choices = useReflectionChoices(draft, projects, models);
  const changedElsewhere = draft.revision !== settings.revision;
  const canSave = !changedElsewhere && choices.valid && hasChanges(settings, draft);

  function change(patch: Partial<Settings>) {
    setError("");
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save() {
    if (saving.current || !canSave) return;
    saving.current = true;
    setBusy(true);
    setError("");

    try {
      await onSave(draft);
      onClose();
    } catch (cause) {
      const { code } = ConnectError.from(cause);

      if (code === Code.Aborted || code === Code.FailedPrecondition) {
        setError("Habit settings changed. Close this sheet and refresh habits.");
        await onReload();
      } else if (code === Code.InvalidArgument) {
        setError("Could not save habit settings. Check the projects, provider profile and model.");
        await onReload();
      } else {
        setError("Could not save habit settings. Check the connection and retry.");
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Configure habits"
      visible
      onClose={onClose}
      footer={
        <Button title="Save changes" variant="primary" busy={busy} disabled={!canSave} onPress={() => void save()} />
      }
    >
      <SettingsGroup>
        <SettingToggle
          title="Learn from repeated requests"
          value={draft.enabled}
          disabled={busy}
          onChange={(enabled) => change({ enabled })}
        />
        <SettingAccess
          title="Projects"
          description={choices.projectHint}
          options={choices.projectOptions}
          ids={draft.projectIds}
          allowAll={false}
          disabled={busy || !choices.projectOptions.length}
          onChange={({ ids }) => change({ projectIds: [...ids] })}
        />
        <SettingChoice
          title="Check for habits"
          value={draft.intervalMinutes}
          options={intervals}
          disabled={busy}
          onChange={(intervalMinutes) => change({ intervalMinutes })}
        />
      </SettingsGroup>
      <MemoryReflectionModelFields
        models={choices.availableModels}
        draft={draft}
        busy={busy}
        hasProfiles={!!models.length}
        onChange={change}
      />
      {changedElsewhere ? (
        <>
          <Notice error>Habit settings changed. Review the latest version before saving.</Notice>
          <Button
            title="Use latest settings"
            disabled={busy}
            onPress={() => {
              setDraft(settings);
              setError("");
            }}
          />
        </>
      ) : error ? (
        <Notice error>{error}</Notice>
      ) : null}
    </Sheet>
  );
}
