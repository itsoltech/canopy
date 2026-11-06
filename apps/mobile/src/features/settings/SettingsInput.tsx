import { useState } from "react";
import { View, type TextInputProps } from "react-native";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { PickerSheet, SelectField, type PickerOption } from "../../ui/Picker";
import { SettingsRow } from "./SettingsGroup";

export function SettingsInput({
  title,
  description,
  value,
  onSave,
  busy,
  multiline,
  secureTextEntry,
  keyboardType,
  suggestions,
}: {
  title: string;
  description?: string;
  value: string;
  onSave: (value: string) => Promise<boolean>;
  busy?: boolean;
  multiline?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: TextInputProps["keyboardType"];
  suggestions?: PickerOption<string>[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);

  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <SelectField
          label={title}
          hideLabel
          value={secureTextEntry ? "Replace credential" : value || "Not set"}
          disabled={busy}
          onPress={() => {
            setDraft(value);
            setError("");
            setOpen(true);
          }}
        />
      }
    >
      <Sheet
        title={title}
        visible={open}
        onClose={() => {
          setOpen(false);
          setDraft("");
        }}
      >
        <Field
          label={title}
          value={draft}
          onChangeText={setDraft}
          multiline={multiline}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!!suggestions?.length && (
          <SelectField label="Suggestions" value="Choose a model" onPress={() => setChoosing(true)} />
        )}
        {error ? <Notice error>{error}</Notice> : null}
        <View>
          <Button
            variant="primary"
            title="Save"
            busy={busy}
            onPress={() => {
              setError("");
              void onSave(draft).then((saved) => {
                if (saved) {
                  setOpen(false);
                  setDraft("");
                } else setError("Could not save. Check the value and connection, then retry.");
              });
            }}
          />
        </View>
      </Sheet>
      <PickerSheet
        title="Suggestions"
        visible={choosing}
        onClose={() => setChoosing(false)}
        value={draft}
        sections={[{ options: suggestions ?? [] }]}
        search="Search models"
        onSelect={setDraft}
      />
    </SettingsRow>
  );
}
