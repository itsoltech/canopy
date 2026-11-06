import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsModel } from "./SettingsModels";

export function TextGenerationSettings() {
  const settings = useAppearance();
  const value = create(ui.TextGenerationSettingsSchema, settings.user?.textGeneration);
  const [instructions, setInstructions] = useState<string>();

  const save = (patch: Partial<ui.TextGenerationSettings>) =>
    void settings.update({ textGeneration: create(ui.TextGenerationSettingsSchema, { ...value, ...patch }) });

  return (
    <>
      <SettingsGroup title="Text generation" description="Account">
        <SettingsModel
          value={value}
          onChange={(c, effort) => save({ provider: c.provider, profileId: c.profileId, model: c.model, effort })}
        />
        {!value.model && (
          <Notice>
            Automatic: a small, fast model from the thread’s provider instance at low effort when supported. Falls back
            to the thread’s model.
          </Notice>
        )}
        <Button
          secondary
          title="Reset to default"
          disabled={!value.model}
          onPress={() => save({ provider: Provider.UNSPECIFIED, profileId: "", model: "", effort: "" })}
        />
        <Button secondary title="Reset effort" disabled={!value.effort} onPress={() => save({ effort: "" })} />
      </SettingsGroup>
      <SettingsGroup title="Advanced" description="Account">
        <Field
          label="Thread title instructions"
          multiline
          maxLength={4000}
          value={instructions ?? value.threadTitleInstructions}
          onChangeText={setInstructions}
          placeholder="Keep titles to a few words. Lead with the main subject."
        />
        <Button
          title="Save instructions"
          busy={settings.saving}
          disabled={!settings.user}
          onPress={() => save({ threadTitleInstructions: instructions ?? value.threadTitleInstructions })}
        />
        <Button
          secondary
          title="Reset instructions"
          onPress={() => {
            setInstructions("");
            save({ threadTitleInstructions: "" });
          }}
        />
      </SettingsGroup>
    </>
  );
}
