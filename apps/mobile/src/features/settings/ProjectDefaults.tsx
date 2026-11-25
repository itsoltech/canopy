import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { SettingsGroup, SettingsRow, SettingChoice } from "./SettingsGroup";
import { useSettingsResource } from "./resource";
import { DefaultModels } from "./SettingsModels";
import { PullRequestSettings } from "./PullRequestSettings";
import { DefaultResets } from "./DefaultResets";
import { SelectField } from "../../ui/Picker";
import { availablePermission, PermissionPickerSheet, permissionLabel } from "../threads/permissions";
import { useWorkerOptions } from "../computers/worker-options";

export type ProjectResource = ReturnType<typeof useSettingsResource<ui.GetSettingsResponse>>;

export function ProjectDefaults({ project, resource }: { project: ui.Project; resource: ProjectResource }) {
  const { workers } = useOverview();
  const workerOptions = useWorkerOptions();
  const settings = useAppearance();
  const [permission, setPermission] = useState(false);
  const row = resource.data?.projects.find((p) => p.projectId === project.id);
  const value = create(ui.ThreadDefaultsSchema, row?.threadDefaults);

  const save = async (patch: Partial<ui.ThreadDefaults>) =>
    !!(await resource.run((api) =>
      api.updateProjectSettings({
        projectId: project.id,
        threadDefaults: create(ui.ThreadDefaultsSchema, { ...value, ...patch }),
        expectedVersion: row?.version ?? 0n,
      }),
    ));

  return (
    <>
      <DefaultResets value={value} onChange={save} inherited disabled={resource.busy}>
        <SettingsGroup title="Thread defaults" description="Use account defaults unless this project overrides them.">
          <SettingChoice
            title="Worker"
            disabled={resource.busy}
            value={value.workspaceId}
            onChange={(workspaceId) => save({ workspaceId })}
            options={[
              { value: "", label: "Use my default" },
              ...workerOptions(
                workers.filter((worker) => project.workspaces.some((w) => w.workerId === worker.id)),
                false,
              ).flatMap((option) =>
                project.workspaces.filter((w) => w.workerId === option.value).map((w) => ({ ...option, value: w.id })),
              ),
            ]}
          />
          <SettingChoice<Provider | "last" | "any">
            title="Agent"
            disabled={resource.busy}
            value={
              value.useLastAgent === true
                ? "last"
                : value.provider || (value.useLastAgent === false ? "any" : Provider.UNSPECIFIED)
            }
            onChange={(provider) =>
              save(
                provider === "last"
                  ? { provider: Provider.UNSPECIFIED, providerProfileId: "", useLastAgent: true }
                  : provider === "any"
                    ? { provider: Provider.UNSPECIFIED, providerProfileId: "", useLastAgent: false }
                    : {
                        provider,
                        providerProfileId: "",
                        permissionMode: availablePermission(provider, value.permissionMode),
                        useLastAgent: provider ? false : undefined,
                      },
              )
            }
            options={[
              { value: Provider.UNSPECIFIED, label: "Use my default" },
              { value: "last", label: "Last used" },
              { value: "any", label: "Any available" },
              { value: Provider.CLAUDE, label: "Claude" },
              { value: Provider.CODEX, label: "Codex" },
              { value: Provider.GROK, label: "Grok" },
              { value: Provider.ANTIGRAVITY, label: "Antigravity" },
            ]}
          />
          {value.useLastAgent !== true && !!value.provider && (
            <DefaultModels disabled={resource.busy} value={value} onChange={save} />
          )}
          <SettingsRow
            title="Permissions"
            description="New threads of this project use this approval policy."
            control={
              <SelectField
                label="Permissions"
                hideLabel
                disabled={resource.busy}
                value={
                  value.permissionMode
                    ? permissionLabel(value.permissionMode)
                    : `Use my default (${permissionLabel(settings.user?.threadDefaults?.permissionMode)})`
                }
                onPress={() => setPermission(true)}
              />
            }
          />
          <PermissionPickerSheet
            provider={value.useLastAgent ? undefined : value.provider}
            visible={permission}
            onClose={() => setPermission(false)}
            value={value.permissionMode}
            onSelect={(permissionMode) => save({ permissionMode })}
          />
          <Button
            title="Restore account defaults"
            disabled={resource.busy}
            onPress={() =>
              void resource.run((api) =>
                api.updateProjectSettings({
                  projectId: project.id,
                  threadDefaults: create(ui.ThreadDefaultsSchema, {
                    autoArchiveOnMerge: value.autoArchiveOnMerge,
                    notifyOnLinkedPullRequests: value.notifyOnLinkedPullRequests,
                  }),
                  expectedVersion: row?.version ?? 0n,
                }),
              )
            }
          />
        </SettingsGroup>
      </DefaultResets>
      <PullRequestSettings
        value={value}
        inherited={settings.user?.threadDefaults ?? create(ui.ThreadDefaultsSchema)}
        disabled={resource.busy}
        onChange={save}
      />
    </>
  );
}
