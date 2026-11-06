import { useState } from "react";
import { View, type TextInputProps } from "react-native";
import { Button, Field, Notice, Sheet } from "../../ui/components";
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
}: {
  title: string;
  description?: string;
  value: string;
  onSave: (value: string) => Promise<boolean>;
  busy?: boolean;
  multiline?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: TextInputProps["keyboardType"];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <Button
          secondary
          title={`Change ${title.toLowerCase()}`}
          disabled={busy}
          onPress={() => {
            setDraft(value);
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
        {error ? <Notice error>{error}</Notice> : null}
        <View>
          <Button
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
    </SettingsRow>
  );
}
