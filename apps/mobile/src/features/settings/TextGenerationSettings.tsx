import { useRef, useState } from "react";
import { View, Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button, Field } from "../../ui/components";
import { useTypography, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsModel } from "./SettingsModels";
import { AccountConfigNotices } from "./AccountConfigNotices";

export function TextGenerationSettings() {
  const settings = useAppearance();
  const c = useColors();
  const type = useTypography();
  const value = create(ui.TextGenerationSettingsSchema, settings.user?.textGeneration);
  const disabled = !settings.user || settings.saving;

  const save = (patch: Partial<ui.TextGenerationSettings>) =>
    settings.update({ textGeneration: create(ui.TextGenerationSettingsSchema, { ...value, ...patch }) });

  return (
    <>
      <SettingsGroup
        title="Text generation"
        description="Account"
        actions={
          <Button
            title="Reset to default"
            icon="arrow-path"
            disabled={!value.model || disabled}
            onPress={() => void save({ provider: Provider.UNSPECIFIED, profileId: "", model: "", effort: "" })}
          />
        }
      >
        <SettingsRow
          title="Text generation model"
          description="Generate thread titles and branch names with this model."
        >
          <SettingsModel
            localWorkersOnly
            hideLabel
            value={value}
            disabled={disabled}
            resetEffort={() => void save({ effort: "" })}
            onChange={(c, effort) =>
              void save({ provider: c.provider, profileId: c.profileId, model: c.model, effort })
            }
          />
          {!value.model && (
            <Text style={[type.meta, { color: c.muted }]}>
              Canopy uses a small, fast model from the thread’s provider instance at low effort when available.
              Otherwise it uses the thread’s model.
            </Text>
          )}
        </SettingsRow>
      </SettingsGroup>
      <TitleInstructions
        value={value.threadTitleInstructions}
        disabled={disabled}
        save={(text) => save({ threadTitleInstructions: text })}
      />
      <AccountConfigNotices sections={["textGeneration"]} />
    </>
  );
}

function TitleInstructions({
  value,
  disabled,
  save,
}: {
  value: string;
  disabled: boolean;
  save: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string>();
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const c = useColors();
  const type = useTypography();

  async function apply(next: string) {
    if (disabled || pending.current) return;
    pending.current = true;
    setDraft(next);

    try {
      if (next === value || (await save(next))) {
        setDraft(undefined);
        setFailed(false);
      } else setFailed(true);
    } finally {
      pending.current = false;
    }
  }

  return (
    <SettingsGroup
      title="Advanced"
      description="Account"
      actions={
        !!value && (
          <Button icon="arrow-path" title="Reset instructions" disabled={disabled} onPress={() => void apply("")} />
        )
      }
    >
      <View style={{ gap: 8 }}>
        <Field
          label="Thread title instructions"
          multiline
          maxLength={4000}
          value={draft ?? value}
          editable={!disabled}
          onChangeText={(text) => {
            setDraft(text);
            setFailed(false);
          }}
          onEndEditing={(event) => {
            if (draft !== undefined) void apply(event.nativeEvent.text);
          }}
          placeholder="Keep titles to a few words. Lead with the main subject."
          style={{ minHeight: 96, textAlignVertical: "top" }}
        />
        <Text style={[type.meta, { color: c.muted }]}>Add guidance for new and regenerated thread titles.</Text>
        {draft !== undefined && draft !== value && (
          <Button
            title={failed ? "Retry saving instructions" : "Save instructions"}
            disabled={disabled}
            size="sm"
            style={{ alignSelf: "flex-end" }}
            onPress={() => void apply(draft ?? value)}
          />
        )}
      </View>
    </SettingsGroup>
  );
}
