import { useState } from "react";
import { View } from "react-native";
import { TextInput } from "../../ui/TextInput";
import { IconButton } from "../../ui/components";
import { Skeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { SettingsRow } from "./SettingsGroup";

/** Text edits are text fields; keep the save action's space when the value is unchanged. */
export function SettingsTextInput({
  title,
  value,
  busy,
  onSave,
}: {
  title: string;
  value: string;
  busy: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const c = useColors();
  const [edit, setEdit] = useState<{ source: string; draft: string }>();
  const draft = edit?.source === value ? edit.draft : value;

  return (
    <SettingsRow
      title={title}
      control={
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Skeleton style={{ flex: 1, minWidth: 0 }}>
            <TextInput
              accessibilityLabel={title}
              value={draft}
              onChangeText={(text) => setEdit({ source: value, draft: text })}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, styles.body, { color: c.text, borderColor: c.line, backgroundColor: c.surface }]}
            />
          </Skeleton>
          <IconButton
            icon="check"
            label={`Save ${title.toLowerCase()}`}
            color={draft === value ? c.faint : c.accent}
            disabled={busy || draft === value}
            onPress={() =>
              void onSave(draft).then((saved) => {
                if (saved) setEdit(undefined);
              })
            }
          />
        </View>
      }
    />
  );
}
