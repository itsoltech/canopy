import { useState, type ComponentRef, type RefObject } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Field } from "../../ui/components";
import { SmallButton } from "../../ui/SmallButton";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors } from "../../ui/theme";

/**
 * The write-only value of a project secret. A secure native field cannot be multiline and may drop line breaks
 * from a paste, so Paste reads the clipboard directly into `value` and keeps it exactly (a key file stays
 * intact). The field then stands in with "Value pasted" and Clear; the value itself is never shown.
 */
export function ProjectSecretValueField({
  value,
  input,
  label,
  editable,
  error,
  onChange,
}: {
  value: RefObject<string>;
  input: RefObject<ComponentRef<typeof TextInput> | null>;
  label: string;
  editable: boolean;
  error: string;
  onChange: (filled: boolean) => void;
}) {
  const c = useColors();
  const [pasted, setPasted] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const message = error || pasteError;

  async function paste() {
    setPasting(true);
    setPasteError("");

    try {
      const text = await Clipboard.getStringAsync();

      if (!text) {
        setPasteError("Nothing to paste. Copy the value and allow paste access, then retry.");

        return;
      }

      value.current = text;
      setPasted(true);
      onChange(true);
    } catch {
      setPasteError("Could not paste the value. Check clipboard access, then retry.");
    } finally {
      setPasting(false);
    }
  }

  function clear() {
    value.current = "";
    setPasted(false);
    onChange(false);
  }

  return (
    <View style={{ gap: 4 }}>
      {pasted ? (
        <Field label={label} value="Value pasted" editable={false} />
      ) : (
        <Field
          ref={input}
          label={label}
          secureTextEntry
          autoComplete="off"
          textContentType="none"
          importantForAutofill="noExcludeDescendants"
          autoCorrect={false}
          spellCheck={false}
          autoCapitalize="none"
          smartInsertDelete={false}
          editable={editable && !pasting}
          onChangeText={(next) => {
            value.current = next;
            setPasteError("");
            onChange(Boolean(next.length));
          }}
        />
      )}
      <Text
        accessibilityRole={message ? "alert" : undefined}
        style={[styles.meta, { color: message ? c.danger : c.muted }]}
      >
        {message || "Canopy never shows the value again. Use Paste for a value with several lines."}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {pasted ? (
          <SmallButton title="Clear value" disabled={!editable} onPress={clear} />
        ) : (
          <SmallButton title="Paste value" busy={pasting} disabled={!editable} onPress={() => void paste()} />
        )}
      </View>
    </View>
  );
}
