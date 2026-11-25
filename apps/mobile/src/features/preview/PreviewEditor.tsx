import { useState } from "react";
import { Text, View } from "react-native";
import type { AgentPreviewInput } from "@canopy/contracts";
import { Button, IconButton } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors } from "../../ui/theme";
import { sendPreviewInputs } from "./preview-commands";

export type PreviewEditorKind = "address" | "text";

export function PreviewEditor({
  kind,
  url,
  enabled,
  input,
  onClose,
}: {
  kind?: PreviewEditorKind;
  url: string;
  enabled: boolean;
  input: (value: AgentPreviewInput) => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState<{ url: string; value: string }>();
  const [text, setText] = useState("");

  if (!kind) return null;
  const value = kind === "address" ? (address?.url === url ? address.value : url) : text;

  function submit(value: string) {
    if (kind === "address") {
      const destination = previewAddress(value, url);

      if (!destination) return false;
      sendPreviewInputs(input, [{ kind: "navigate", text: destination }]);
    } else {
      sendPreviewInputs(input, [{ kind: "text", text: value }]);
      setText("");
    }

    onClose();

    return true;
  }

  return (
    <PreviewInputField
      key={kind}
      kind={kind}
      initialValue={value}
      enabled={enabled}
      onChange={(next) => {
        if (kind === "address") setAddress({ url, value: next });
        else setText(next);
      }}
      onSubmit={submit}
      onCancel={onClose}
    />
  );
}

function PreviewInputField({
  kind,
  initialValue,
  enabled,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: PreviewEditorKind;
  initialValue: string;
  enabled: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => boolean;
  onCancel: () => void;
}) {
  const c = useColors();
  const [value, setValue] = useState(initialValue);
  const [invalid, setInvalid] = useState(false);
  const address = kind === "address";
  const canSubmit = enabled && (address ? Boolean(value.trim()) : Boolean(value));

  const submit = () => {
    if (canSubmit && !onSubmit(value)) setInvalid(true);
  };

  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <IconButton icon="x-mark" label={address ? "Cancel address edit" : "Cancel typing"} onPress={onCancel} />
        <TextInput
          accessibilityLabel={address ? "Page address" : "Text to type"}
          placeholder={address ? "https://example.com" : "Text to type"}
          placeholderTextColor={c.muted}
          autoFocus
          selectTextOnFocus={address}
          autoCorrect={!address}
          autoCapitalize={address ? "none" : "sentences"}
          keyboardType={address ? "url" : "default"}
          returnKeyType={address ? "go" : "send"}
          submitBehavior="submit"
          onSubmitEditing={submit}
          editable={enabled}
          value={value}
          onChangeText={(next) => {
            setValue(next);
            setInvalid(false);
            onChange(next);
          }}
          style={[
            styles.input,
            { flex: 1, minWidth: 0, color: c.text, borderColor: c.line, backgroundColor: c.surface },
          ]}
        />
        <Button title={address ? "Go" : "Send"} disabled={!canSubmit} onPress={submit} />
      </View>
      {invalid ? (
        <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger, paddingHorizontal: 8 }]}>
          Enter a valid page address, then choose Go.
        </Text>
      ) : null}
    </View>
  );
}

export function previewAddress(address: string, current: string): string | undefined {
  const value = address.trim();
  const relative = /^[/.?#]/.test(value);
  const local = /^(localhost|127\.|0\.|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/.test(value);
  const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(value) || value === "about:blank";

  try {
    const destination = new URL(
      relative ? value : explicit ? value : `${local ? "http" : "https"}://${value}`,
      relative ? current : undefined,
    );

    if (["http:", "https:"].includes(destination.protocol) || destination.href === "about:blank")
      return destination.href;
  } catch {
    return;
  }
}
