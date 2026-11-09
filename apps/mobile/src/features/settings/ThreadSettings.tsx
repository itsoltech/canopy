import { useState } from "react";
import { View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { providerName } from "../models/catalog";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "../threads/permissions";
import { DefaultModels } from "./SettingsModels";
import { DefaultResets } from "./DefaultResets";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { useOverview } from "../../state/overview";
import type { ProjectChoice } from "@canopy/domain/projects";
import { useWorkerLabel } from "../computers/presence";
import { FollowUpSettings } from "./FollowUpSettings";

type Settings = ReturnType<typeof useAppearance>;

export function ThreadDefaultsSettings({ settings }: { settings: Settings }) {
  const { projectChoices: projects } = useOverview();
  const workerName = useWorkerLabel();
  const [picker, setPicker] = useState<"workspace" | "agent" | "permission" | null>(null);
  const defaults = settings.user?.threadDefaults;
  const close = () => setPicker(null);

  const save = (patch: Partial<ui.ThreadDefaults>) =>
    void settings.update({ threadDefaults: Object.assign(create(ui.ThreadDefaultsSchema, defaults), patch) });

  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === defaults?.workspaceId);
  const project = projects.find((p) => p.projectIds.includes(workspace?.projectId ?? ""));
  const look = permissionLook(defaults?.permissionMode);

  return (
    <View style={{ gap: 20 }}>
      <FollowUpSettings settings={settings} />
      <DefaultResets
        value={create(ui.ThreadDefaultsSchema, defaults)}
        onChange={save}
        disabled={!settings.user || settings.saving}
      >
        <SettingsGroup title="New threads" description="Account">
          <SettingsRow
            title="Project and worker"
            description="Where new threads start, unless you start them from a project."
            control={
              <SelectField
                label="Project and worker"
                hideLabel
                value={workspace ? `${project?.name ?? "Project"} · ${workerName(workspace.workerId)}` : "Last used"}
                onPress={() => setPicker("workspace")}
                disabled={!settings.user}
              />
            }
          />
          <SettingsRow
            title="Agent"
            description="New threads use an agent available on the workspace's worker."
            control={
              <SelectField
                label="Agent"
                hideLabel
                value={defaults?.provider ? providerName(defaults.provider) : "Any available"}
                leading={defaults?.provider ? <ProviderIcon provider={defaults.provider} size={16} /> : undefined}
                onPress={() => setPicker("agent")}
                disabled={!settings.user}
              />
            }
          />
          {!!defaults?.provider && <DefaultModels value={create(ui.ThreadDefaultsSchema, defaults)} onChange={save} />}
          <SettingsRow
            title="Permissions"
            description="New threads use this approval policy unless the project overrides it."
            control={
              <SelectField
                label="Permissions"
                hideLabel
                value={permissionLabel(defaults?.permissionMode)}
                tone={look.tone}
                onPress={() => setPicker("permission")}
                disabled={!settings.user}
              />
            }
          />
        </SettingsGroup>
      </DefaultResets>
      <PickerSheet
        title="Workspace"
        visible={picker === "workspace"}
        onClose={close}
        search={projects.length > 6 ? "Search projects" : undefined}
        value={defaults?.workspaceId ?? ""}
        onSelect={(workspaceId) => save({ workspaceId })}
        sections={workspaceOptions(projects, workerName)}
      />
      <PickerSheet
        title="Agent"
        visible={picker === "agent"}
        onClose={close}
        value={defaults?.provider ?? Provider.UNSPECIFIED}
        onSelect={(provider) => save({ provider, providerProfileId: "" })}
        sections={[
          {
            options: [
              { value: Provider.UNSPECIFIED, label: "Any available" },
              ...[Provider.CODEX, Provider.CLAUDE, Provider.GROK].map((provider) => ({
                value: provider,
                label: providerName(provider),
                leading: <ProviderIcon provider={provider} size={18} />,
              })),
            ],
          },
        ]}
      />
      <PermissionPickerSheet
        visible={picker === "permission"}
        onClose={close}
        value={defaults?.permissionMode}
        onSelect={(permissionMode) => save({ permissionMode })}
      />
    </View>
  );
}

function workspaceOptions(projects: ProjectChoice[], workerName: (id: string) => string) {
  return [
    { options: [{ value: "", label: "Last used", description: "Use the workspace you used last." }] },
    ...projects.flatMap((p) =>
      !p.archivedAt && p.workspaces.length
        ? [
            {
              id: p.id,
              title: p.name,
              options: p.workspaces.map((w) => ({
                value: w.id,
                label: workerName(w.workerId),
                description: p.kind === "scratch" ? "Scratch folder" : w.label || w.rootPath,
                icon: "computer-desktop" as const,
              })),
            },
          ]
        : [],
    ),
  ];
}
