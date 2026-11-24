import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { normalizeColor } from "@canopy/ui/color";
import { IconButton } from "../../ui/components";
import { ProjectMark } from "../../ui/ProjectMark";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors } from "../../ui/theme";
import type { ProjectResource } from "./ProjectDefaults";
import { ResetSetting } from "./ResetSetting";
import { SettingsRow } from "./SettingsGroup";

export function ProjectColorSetting({ project, resource }: { project: ui.Project; resource: ProjectResource }) {
  const c = useColors();
  const { color } = project;
  const [edit, setEdit] = useState<{ source: string; draft: string }>();
  const draft = edit?.source === color ? edit.draft : color;
  const normalized = normalizeColor(draft);
  const preview = draft.trim() ? (normalized ?? color) : "";
  const canSave = !!normalized && normalized !== color;

  async function save(value: string) {
    const saved = await resource.run((api) => api.setProjectColor({ projectId: project.id, color: value }));

    if (saved) setEdit(undefined);
  }

  return (
    <SettingsRow
      title="Project color"
      description={
        project.imageBase64
          ? "The color applies to project initials when there is no image."
          : "Enter a hex color, such as #a3e635."
      }
      accessory={
        <ResetSetting
          label="Use automatic project color"
          changed={!!color}
          disabled={resource.busy}
          onReset={() => void save("")}
        />
      }
      control={
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ProjectMark project={project} color={preview} size={24} />
          </View>
          <TextInput
            accessibilityLabel="Project color"
            accessibilityHint="Enter a hex color, such as #a3e635."
            placeholder="Automatic"
            placeholderTextColor={c.muted}
            value={draft}
            onChangeText={(value) => setEdit({ source: color, draft: value })}
            editable={!resource.busy}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.input,
              styles.body,
              { flex: 1, minWidth: 0, color: c.text, borderColor: c.line, backgroundColor: c.surface },
            ]}
          />
          <IconButton
            icon="check"
            label="Save project color"
            color={canSave ? c.accent : c.faint}
            disabled={resource.busy || !canSave}
            onPress={() => {
              if (normalized) void save(normalized);
            }}
          />
        </View>
      }
    />
  );
}
