import { useState } from "react";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { IconButton } from "../../ui/Button";

export function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
    } catch {
      Alert.alert("Could not copy", "Try copying the text again.");
    }
  }

  return (
    <IconButton
      icon={copied ? "check" : "clipboard-document"}
      label={copied ? "Copied" : label}
      size="sm"
      onPress={() => void copy()}
    />
  );
}
