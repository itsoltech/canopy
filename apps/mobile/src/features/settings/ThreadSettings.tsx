import { useState } from "react";
import { Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { Button, Field, Segmented } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { PanelRow } from "../threads/ThreadPanel";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { providerName } from "../models/catalog";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "../threads/permissions";

type Settings = ReturnType<typeof useAppearance>;

export function ThreadDefaultsSettings({
  settings,
  projects,
  workers,
}: {
  settings: Settings;
  projects: ui.Project[];
  workers: ui.Worker[];
}) {
  const c = useColors();
  const [picker, setPicker] = useState<"workspace" | "agent" | "permission" | null>(null);
  const defaults = settings.user?.threadDefaults;
  const close = () => setPicker(null);

  const save = (patch: Partial<ui.ThreadDefaults>) =>
    void settings.update({ threadDefaults: Object.assign(create(ui.ThreadDefaultsSchema, defaults), patch) });

  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === defaults?.workspaceId);
  const project = projects.find((p) => p.id === workspace?.projectId);
  const workerName = (id: string) => workers.find((w) => w.id === id)?.name ?? "Unknown worker";
  const look = permissionLook(defaults?.permissionMode);

  return (
    <View style={{ gap: 20 }}>
      <Text style={[styles.heading, { color: c.text }]}>New thread defaults</Text>
      <SelectField
        label="Workspace"
        value={workspace ? `${project?.name ?? "Project"} · ${workerName(workspace.workerId)}` : "No preference"}
        onPress={() => setPicker("workspace")}
        disabled={!settings.user}
      />
      <SelectField
        label="Agent"
        value={defaults?.provider ? providerName(defaults.provider) : "No preference"}
        leading={defaults?.provider ? <ProviderIcon provider={defaults.provider} size={16} /> : undefined}
        onPress={() => setPicker("agent")}
        disabled={!settings.user}
      />
      <SelectField
        label="Permissions"
        value={permissionLabel(defaults?.permissionMode)}
        tone={look.tone}
        onPress={() => setPicker("permission")}
        disabled={!settings.user}
      />
      <PanelRow
        title="Model"
        value={defaults?.models.map((m) => m.model).join(" · ") || "Default model"}
        icon="cpu-chip"
      />
      <Text style={[styles.label, { color: c.text }]}>While a turn runs</Text>
      <Segmented
        value={String(settings.user?.composer?.runningDelivery || ui.MessageDelivery.STEER)}
        options={[
          { value: "2", label: "Steer" },
          { value: "1", label: "Queue" },
        ]}
        onChange={(v) =>
          void settings.update({ composer: create(ui.ComposerSettingsSchema, { runningDelivery: Number(v) }) })
        }
      />
      <Text style={[styles.meta, { color: c.muted }]}>Choose default models per agent in Canopy on the web.</Text>
      <PickerSheet
        title="Workspace"
        visible={picker === "workspace"}
        onClose={close}
        search={projects.length > 6 ? "Search projects" : undefined}
        value={defaults?.workspaceId ?? ""}
        onSelect={(workspaceId) => save({ workspaceId })}
        sections={[
          { options: [{ value: "", label: "No preference", description: "Use the workspace you used last." }] },
          ...projects
            .filter((p) => !p.archivedAt && p.workspaces.length)
            .map((p) => ({
              title: p.name,
              options: p.workspaces.map((w) => ({
                value: w.id,
                label: workerName(w.workerId),
                description: p.kind === "scratch" ? "Scratch folder" : w.label || w.rootPath,
                icon: "computer-desktop" as const,
              })),
            })),
        ]}
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
              { value: Provider.UNSPECIFIED, label: "No preference" },
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

export function ThreadTitleSettings({
  settings,
  instructions,
  onChange,
}: {
  settings: Settings;
  instructions: string;
  onChange: (value: string) => void;
}) {
  const c = useColors();

  return (
    <View style={{ gap: 16 }}>
      <Text style={[styles.heading, { color: c.text }]}>Thread titles</Text>
      <PanelRow title="Model" value={settings.user?.textGeneration?.model || "Automatic"} icon="cpu-chip" />
      <Field
        label="Instructions"
        multiline
        value={instructions}
        onChangeText={onChange}
        placeholder="Additional instructions for thread titles"
        style={{ minHeight: 120, textAlignVertical: "top" }}
      />
      <Button
        title="Save"
        busy={settings.saving}
        disabled={!settings.user}
        onPress={() =>
          void settings.update({
            textGeneration: Object.assign(create(ui.TextGenerationSettingsSchema, settings.user?.textGeneration), {
              threadTitleInstructions: instructions,
            }),
          })
        }
      />
    </View>
  );
}
