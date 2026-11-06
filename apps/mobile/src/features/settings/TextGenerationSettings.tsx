import { useState } from "react";
import { View, Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button, Field, IconButton } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsModel } from "./SettingsModels";

export function TextGenerationSettings() {
  const settings = useAppearance();
  const c = useColors();
  const value = create(ui.TextGenerationSettingsSchema, settings.user?.textGeneration);
  const [instructions, setInstructions] = useState<string>();

  const save = (patch: Partial<ui.TextGenerationSettings>) =>
    void settings.update({ textGeneration: create(ui.TextGenerationSettingsSchema, { ...value, ...patch }) });

  return (
    <>
      <SettingsGroup
        title="Text generation"
        description="Account"
        actions={
          <IconButton
            icon="arrow-path"
            label="Reset text generation to default"
            disabled={!value.model || settings.saving}
            onPress={() => save({ provider: Provider.UNSPECIFIED, profileId: "", model: "", effort: "" })}
          />
        }
      >
        <SettingsRow
          title="Text generation model"
          description="Generate thread titles and branch names with this model."
        >
          <SettingsModel
            hideLabel
            value={value}
            onChange={(c, effort) => save({ provider: c.provider, profileId: c.profileId, model: c.model, effort })}
          />
          {!value.model && (
            <Text style={[styles.workMeta, { color: c.muted }]}>
              Automatic: a small, fast model from the thread’s provider instance at low effort when supported. Falls
              back to the thread’s model.
            </Text>
          )}
          {value.model && (
            <View style={{ alignItems: "flex-end" }}>
              <IconButton
                icon="arrow-path"
                label="Reset effort"
                disabled={!value.effort || settings.saving}
                onPress={() => save({ effort: "" })}
              />
            </View>
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="Advanced"
        description="Account"
        actions={
          <IconButton
            icon="arrow-path"
            label="Reset instructions"
            disabled={!value.threadTitleInstructions || settings.saving}
            onPress={() => {
              setInstructions("");
              save({ threadTitleInstructions: "" });
            }}
          />
        }
      >
        <View style={{ gap: 12 }}>
          <Field
            label="Thread title instructions"
            multiline
            maxLength={4000}
            value={instructions ?? value.threadTitleInstructions}
            onChangeText={setInstructions}
            placeholder="Keep titles to a few words. Lead with the main subject."
            style={{ minHeight: 112, textAlignVertical: "top" }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button
              title="Save instructions"
              busy={settings.saving}
              disabled={!settings.user || instructions === undefined || instructions === value.threadTitleInstructions}
              onPress={() => save({ threadTitleInstructions: instructions ?? value.threadTitleInstructions })}
            />
          </View>
        </View>
      </SettingsGroup>
    </>
  );
}
