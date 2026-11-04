import { Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { Button, Field, Segmented } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { PanelRow } from "../threads/ThreadPanel";

type Settings = ReturnType<typeof useAppearance>;

export function ThreadDefaultsSettings({ settings, projects }: { settings: Settings; projects: ui.Project[] }) {
  const c = useColors();

  return (
    <View style={{ gap: 20 }}>
      <Text style={[styles.heading, { color: c.text }]}>New thread defaults</Text>
      <PanelRow
        title="Workspace"
        value={
          projects.flatMap((p) => p.workspaces).find((w) => w.id === settings.user?.threadDefaults?.workspaceId)
            ?.label || "No preference"
        }
        icon="folder"
      />
      <PanelRow
        title="Model"
        value={settings.user?.threadDefaults?.models.map((m) => m.model).join(" · ") || "Default model"}
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
      <Text style={[styles.meta, { color: c.muted }]}>Edit new thread defaults in Canopy on the web.</Text>
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
