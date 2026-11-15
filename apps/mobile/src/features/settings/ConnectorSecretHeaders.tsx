import { useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Field, Notice } from "../../ui/components";
import { SmallButton } from "../../ui/SmallButton";

/** Native password fields protect each line; raw newlines remain in the form's draft. */
export function ConnectorSecretHeaders({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState("");
  const lines = value.split("\n");

  async function paste() {
    setPasting(true);
    setError("");

    try {
      // Reading the clipboard directly preserves line breaks that a single-line native paste can discard.
      const text = await Clipboard.getStringAsync();

      if (text) onChange(text);
      else setError("No headers were pasted. Copy the headers and allow paste access, then retry.");
    } catch {
      setError("Could not paste headers. Check clipboard access and retry.");
    } finally {
      setPasting(false);
    }
  }

  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      {lines.map((line, index) => (
        <View key={index} style={{ gap: 8, minWidth: 0 }}>
          <Field
            label={index === 0 ? "Secret headers" : `Secret header ${index + 1}`}
            value={line}
            onChangeText={(text) => onChange(lines.map((current, i) => (i === index ? text : current)).join("\n"))}
            editable={!pasting}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
          />
          <View style={{ alignItems: "flex-end" }}>
            <SmallButton
              title={`Remove header ${index + 1}`}
              disabled={pasting}
              onPress={() => onChange(lines.filter((_, i) => i !== index).join("\n"))}
            />
          </View>
        </View>
      ))}
      <Notice>Enter one header per field: Header-Name: value. Pasting replaces all headers.</Notice>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <SmallButton title="Add header" disabled={pasting} onPress={() => onChange(`${value}\n`)} />
        <SmallButton title="Paste headers" busy={pasting} onPress={() => void paste()} />
      </View>
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
