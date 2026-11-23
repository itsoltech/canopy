import { useRef, useState } from "react";
import { View, type TextInputProps } from "react-native";
import { Button, Field, IconButton, Notice } from "../../ui/components";
import { PickerSheet, type PickerOption } from "../../ui/Picker";
import { SettingsRow } from "./SettingsRow";

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
  const saved = secureTextEntry ? "" : value;
  const [edit, setEdit] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [choosing, setChoosing] = useState<boolean>();
  const saving = useRef(false);
  const draft = edit ?? saved;
  const changed = draft !== saved;

  function change(text: string) {
    setEdit(text === saved ? undefined : text);
    setFailed(false);
  }

  async function save() {
    if (!changed || saving.current || busy) return;
    saving.current = true;
    setPending(true);
    setFailed(false);

    try {
      if (await onSave(draft)) setEdit(undefined);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <SettingsRow
      title={title}
      description={description}
      controlWidth={multiline ? 336 : 288}
      control={
        <View style={{ minWidth: 0, gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: multiline ? "flex-start" : "center", gap: 4 }}>
            <View style={{ minWidth: 0, flex: 1 }}>
              <Field
                label={title}
                hideLabel
                value={draft}
                onChangeText={change}
                editable={!busy && !pending}
                multiline={multiline}
                secureTextEntry={secureTextEntry}
                keyboardType={keyboardType}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType={multiline ? "default" : "done"}
                submitBehavior={multiline ? "newline" : "blurAndSubmit"}
                onSubmitEditing={multiline ? undefined : () => void save()}
              />
            </View>
            <View
              pointerEvents={changed ? "auto" : "none"}
              style={{ opacity: changed || pending ? 1 : 0 }}
              accessibilityElementsHidden={!changed && !pending}
              importantForAccessibility={changed || pending ? "auto" : "no-hide-descendants"}
            >
              <IconButton
                icon="check"
                label={`Save ${title.toLowerCase()}`}
                disabled={busy || !changed}
                busy={pending}
                onPress={() => void save()}
              />
            </View>
          </View>
          {!!suggestions?.length && (
            <Button title="Choose a model" disabled={busy || pending} size="sm" onPress={() => setChoosing(true)} />
          )}
          {failed && <Notice error>Could not save. Check the value and connection, then retry.</Notice>}
        </View>
      }
    >
      {!!suggestions?.length && choosing !== undefined && (
        <PickerSheet
          title={title}
          visible={choosing}
          onClose={() => setChoosing(false)}
          onDismiss={() => setChoosing((visible) => visible || undefined)}
          value={draft}
          sections={[{ options: suggestions }]}
          search="Search models"
          onSelect={change}
        />
      )}
    </SettingsRow>
  );
}
