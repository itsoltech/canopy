import { useEffect, useState } from "react";
import { AccessibilityInfo, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";

/** Shared by viewer buttons and message action menus; clipboard access follows an explicit action. */
export function useCopyText(text: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [text]);

  async function copy() {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      AccessibilityInfo.announceForAccessibility("Copied");
    } catch {
      Alert.alert("Could not copy", "Try copying the text again.");
    }
  }

  return { copied, copy };
}
