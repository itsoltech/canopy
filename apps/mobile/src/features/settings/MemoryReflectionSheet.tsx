import { useRef, useState } from "react";
import { ui } from "@canopy/contracts";
import {
  reflectionGatewayUpdate,
  reflectionModelChoices,
  reflectionWorkerForSave,
} from "@canopy/domain/reflection-models";
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

function useReflectionChoices(draft: Settings, snapshot: ui.MemoryHabitsSnapshot) {
  const overview = useOverview();
  const { projects, models } = snapshot;
  const workerId = reflectionWorkerForSave(snapshot, draft, overview.projects);
  const modelChoices = reflectionModelChoices(models, overview.workers);
  const projectOptions: AccessOption[] = [...projects];

  const chosenModel = modelChoices.find(
    (item) =>
      item.provider === draft.provider &&
      item.profileId === (draft.profileId || "native") &&
      item.model === draft.model,
  );

  const missingProjects = draft.projectIds.filter((id) => !projects.some((project) => project.id === id));

  for (const id of missingProjects) projectOptions.push({ id, name: "Unavailable project" });

  const valid =
    !draft.enabled ||
    (!!draft.projectIds.length &&
      !missingProjects.length &&
      !!chosenModel &&
      (!draft.effort || chosenModel.efforts.includes(draft.effort)));

  const projectHint = !projects.length
    ? "Add a project to turn on habit checks."
    : draft.enabled && !draft.projectIds.length
      ? "Choose at least one project to turn on habit checks."
      : draft.enabled && missingProjects.length
        ? "Remove unavailable projects to turn on habit checks."
        : undefined;

  return { modelChoices, chosenModel, projectOptions, projectHint, valid, workerId };
}

function hasChanges(saved: Settings, draft: Settings) {
  return (
    saved.enabled !== draft.enabled ||
    saved.intervalMinutes !== draft.intervalMinutes ||
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
  snapshot,
  onSave,
  onReload,
  onClose,
}: {
  settings: Settings;
  snapshot: ui.MemoryHabitsSnapshot;
  onSave: (draft: Settings) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const choices = useReflectionChoices(draft, snapshot);
  const changedElsewhere = draft.revision !== settings.revision;
  const changed = hasChanges(settings, draft);
  const needsUpdate = changed && choices.valid && choices.workerId === undefined;
  const canSave = !changedElsewhere && choices.valid && changed && !needsUpdate;

  function change(patch: Partial<Settings>) {
    setError("");
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save() {
    if (saving.current || !canSave || choices.workerId === undefined) return;
    saving.current = true;
    setBusy(true);
    setError("");

    try {
      await onSave({
        ...draft,
        workerId: choices.workerId,
        profileId: draft.provider ? draft.profileId || "native" : "",
      });
      onClose();
    } catch (cause) {
      const { code } = ConnectError.from(cause);

      if (code === Code.Aborted || code === Code.FailedPrecondition) {
        setError("Habit settings changed. Close this sheet and refresh habits.");
        await onReload();
      } else if (code === Code.InvalidArgument) {
        setError("Could not save habit settings. Check the projects, model and reasoning effort.");
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
        choices={choices.modelChoices}
        selected={choices.chosenModel}
        draft={draft}
        busy={busy}
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
      ) : needsUpdate ? (
        <Notice>{reflectionGatewayUpdate}</Notice>
      ) : error ? (
        <Notice error>{error}</Notice>
      ) : null}
    </Sheet>
  );
}
