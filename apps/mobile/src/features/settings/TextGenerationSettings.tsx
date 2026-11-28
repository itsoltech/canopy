import { supportsIsolatedRuns } from "@canopy/domain/harnesses";
import { automaticTextGenerationDescription } from "@canopy/ui/providers";
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
import { SettingsTopics } from "./SettingsTopics";

export function TextGenerationSettings() {
  const settings = useAppearance();
  const value = create(ui.TextGenerationSettingsSchema, settings.user?.textGeneration);
  const disabled = !settings.user || settings.saving;

  const save = (patch: Partial<ui.TextGenerationSettings>) =>
    settings.update({ textGeneration: create(ui.TextGenerationSettingsSchema, { ...value, ...patch }) });

  return (
    <>
      <SettingsTopics
        topics={[
          { id: "model", label: "Model", content: <ModelSettings value={value} disabled={disabled} save={save} /> },
          {
            id: "title-instructions",
            label: "Title instructions",
            content: (
              <TitleInstructions
                value={value.threadTitleInstructions}
                disabled={disabled}
                save={(text) => save({ threadTitleInstructions: text })}
              />
            ),
          },
        ]}
      />
      <AccountConfigNotices sections={["textGeneration"]} />
    </>
  );
}

function ModelSettings({
  value,
  disabled,
  save,
}: {
  value: ui.TextGenerationSettings;
  disabled: boolean;
  save: (patch: Partial<ui.TextGenerationSettings>) => Promise<boolean>;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <SettingsGroup
      title="Text generation model"
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
      <SettingsRow title="Model and effort" description="Generate thread titles and branch names with this model.">
        <SettingsModel
          localWorkersOnly
          allowProvider={supportsIsolatedRuns}
          hideLabel
          value={value}
          disabled={disabled}
          resetEffort={() => void save({ effort: "" })}
          onChange={(c, effort) => void save({ provider: c.provider, profileId: c.profileId, model: c.model, effort })}
        />
        {!value.model && <Text style={[type.meta, { color: c.muted }]}>{automaticTextGenerationDescription}</Text>}
      </SettingsRow>
    </SettingsGroup>
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
      title="Thread titles"
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
