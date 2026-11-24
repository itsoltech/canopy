import { useState } from "react";
import { View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { providerName } from "../models/catalog";
import { availablePermission, permissionLabel, permissionLook, PermissionPickerSheet } from "../threads/permissions";
import { DefaultModels } from "./SettingsModels";
import { DefaultResets } from "./DefaultResets";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { useOverview } from "../../state/overview";
import { useWorkerLabel } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
import { FollowUpSettings } from "./FollowUpSettings";
import { SubagentPermissionSettings } from "./SubagentPermissionSettings";
import { AccountConfigNotices } from "./AccountConfigNotices";
import { SandboxProfilesSettings } from "./SandboxProfilesSettings";
import { AutoArchiveSettings } from "./AutoArchiveSettings";
import { Button } from "../../ui/components";
import { ThreadRetentionSettings } from "./ThreadRetentionSettings";

type Settings = ReturnType<typeof useAppearance>;

export function ThreadDefaultsSettings({ settings }: { settings: Settings }) {
  const defaults = settings.user?.threadDefaults ?? create(ui.ThreadDefaultsSchema);

  return (
    <View style={{ gap: 24 }}>
      <FollowUpSettings settings={settings} />
      <SubagentPermissionSettings settings={settings} />
      <SandboxProfilesSettings />
      <AutoArchiveSettings
        value={defaults.autoArchiveOnMerge}
        disabled={!settings.user || settings.saving}
        onChange={(autoArchiveOnMerge) =>
          void settings.update({
            threadDefaults: create(ui.ThreadDefaultsSchema, { ...defaults, autoArchiveOnMerge }),
          })
        }
      />
      <ThreadRetentionSettings settings={settings} />
      <NewThreadSettings settings={settings} />
      <AccountConfigNotices sections={["threadDefaults", "composer", "threadRetention"]} />
    </View>
  );
}

function NewThreadSettings({ settings }: { settings: Settings }) {
  const { projects } = useOverview();
  const workerName = useWorkerLabel();
  const [picker, setPicker] = useState<"workspace" | "agent" | "permission" | null>(null);
  const defaults = settings.user?.threadDefaults ?? create(ui.ThreadDefaultsSchema);
  const useLastAgent = defaults.useLastAgent ?? !defaults.provider;
  const close = () => setPicker(null);

  const save = (patch: Partial<ui.ThreadDefaults>) =>
    settings.update({ threadDefaults: create(ui.ThreadDefaultsSchema, { ...defaults, ...patch }) });

  const available = projects
    .filter((project) => !project.archivedAt && !project.nodeId)
    .map((project) => ({
      ...project,
      workspaces: project.workspaces.filter((workspace) => !workspace.id.includes("~")),
    }));

  const project = available.find((project) => project.workspaces.some((w) => w.id === defaults.workspaceId));
  const workspace = project?.workspaces.find((w) => w.id === defaults.workspaceId);
  const look = permissionLook(defaults.permissionMode);
  const disabled = !settings.user || settings.saving;

  return (
    <>
      <DefaultResets value={defaults} onChange={save} disabled={!settings.user || settings.saving}>
        <SettingsGroup
          title="New threads"
          description="Defaults for new threads on all your computers and devices. Project defaults override them."
          actions={
            <Button
              title="Restore defaults"
              icon="arrow-path"
              disabled={disabled}
              onPress={() =>
                void settings.update({
                  threadDefaults: create(ui.ThreadDefaultsSchema, {
                    subagentPermissionMode: defaults.subagentPermissionMode,
                    autoArchiveOnMerge: defaults.autoArchiveOnMerge,
                  }),
                })
              }
            />
          }
        >
          <SettingsRow
            title="Project and worker"
            description="Where new threads start, unless you start them from a project."
            control={
              <SelectField
                label="Project and worker"
                hideLabel
                value={workspace ? `${project?.name ?? "Project"} · ${workerName(workspace.workerId)}` : "Last used"}
                onPress={() => setPicker("workspace")}
                disabled={disabled}
              />
            }
          />
          <SettingsRow
            title="Agent"
            description="Use the last agent and model settings, or set a default."
            control={
              <SelectField
                label="Agent"
                hideLabel
                value={
                  useLastAgent ? "Last used" : defaults.provider ? providerName(defaults.provider) : "Any available"
                }
                leading={
                  !useLastAgent && defaults.provider ? (
                    <ProviderIcon provider={defaults.provider} size={16} />
                  ) : undefined
                }
                onPress={() => setPicker("agent")}
                disabled={disabled}
              />
            }
          />
          {!useLastAgent && !!defaults.provider && (
            <DefaultModels disabled={disabled} value={defaults} onChange={save} />
          )}
          <SettingsRow
            title="Permissions"
            description="New threads use this approval policy unless the project overrides it."
            control={
              <SelectField
                label="Permissions"
                hideLabel
                value={permissionLabel(defaults.permissionMode)}
                tone={look.tone}
                onPress={() => setPicker("permission")}
                disabled={disabled}
              />
            }
          />
        </SettingsGroup>
      </DefaultResets>
      <DefaultWorkspacePicker
        projects={available}
        visible={picker === "workspace"}
        onClose={close}
        value={defaults.workspaceId ?? ""}
        onSelect={(workspaceId) => save({ workspaceId })}
      />
      <DefaultAgentPicker visible={picker === "agent"} onClose={close} defaults={defaults} onChange={save} />
      <PermissionPickerSheet
        provider={defaults.useLastAgent ? undefined : defaults.provider}
        visible={picker === "permission"}
        onClose={close}
        value={defaults.permissionMode}
        onSelect={(permissionMode) => save({ permissionMode })}
      />
    </>
  );
}

function DefaultWorkspacePicker({
  projects,
  visible,
  onClose,
  value,
  onSelect,
}: {
  projects: ui.Project[];
  visible: boolean;
  onClose: () => void;
  value: string;
  onSelect: (value: string) => void;
}) {
  const { workers } = useOverview();
  const workerOptions = useWorkerOptions();

  return (
    <PickerSheet
      title="Workspace"
      visible={visible}
      onClose={onClose}
      search={projects.length > 6 ? "Search projects" : undefined}
      value={value}
      onSelect={onSelect}
      sections={[
        { options: [{ value: "", label: "Last used", description: "Use the workspace you used last." }] },
        ...projects
          .filter((p) => p.workspaces.length)
          .map((p) => ({
            id: p.id,
            title: p.name,
            options: workerOptions(
              workers.filter((worker) => p.workspaces.some((w) => w.workerId === worker.id)),
              false,
            ).flatMap((option) =>
              p.workspaces.filter((w) => w.workerId === option.value).map((w) => ({ ...option, value: w.id })),
            ),
          })),
      ]}
    />
  );
}

function DefaultAgentPicker({
  visible,
  onClose,
  defaults,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  defaults: ui.ThreadDefaults;
  onChange: (patch: Partial<ui.ThreadDefaults>) => void;
}) {
  const useLastAgent = defaults.useLastAgent ?? !defaults.provider;

  return (
    <PickerSheet<Provider | "last">
      title="Agent"
      visible={visible}
      onClose={onClose}
      value={useLastAgent ? "last" : (defaults.provider ?? Provider.UNSPECIFIED)}
      onSelect={(provider) =>
        onChange(
          provider === "last"
            ? { provider: Provider.UNSPECIFIED, providerProfileId: "", useLastAgent: true }
            : {
                provider,
                providerProfileId: "",
                permissionMode: availablePermission(provider, defaults.permissionMode),
                useLastAgent: false,
              },
        )
      }
      sections={[
        {
          options: [
            {
              value: "last",
              label: "Last used",
              description: "Reuse the agent and model from your last message.",
            },
            { value: Provider.UNSPECIFIED, label: "Any available" },
            ...[Provider.CODEX, Provider.CLAUDE, Provider.GROK, Provider.ANTIGRAVITY].map((provider) => ({
              value: provider,
              label: providerName(provider),
              leading: <ProviderIcon provider={provider} size={18} />,
            })),
          ],
        },
      ]}
    />
  );
}
