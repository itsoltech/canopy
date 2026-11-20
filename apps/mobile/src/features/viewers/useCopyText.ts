import { useState } from "react";
import { AccessibilityInfo, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";

export async function copyText(text: string) {
  try {
    await Clipboard.setStringAsync(text);
    AccessibilityInfo.announceForAccessibility("Copied");

    return true;
  } catch {
    Alert.alert("Could not copy", "Try copying the text again.");

    return false;
  }
}

/** Shared by viewer buttons and message action menus; clipboard access follows an explicit action. */
export function useCopyText(text: string) {
  const [copiedText, setCopiedText] = useState<string>();

  if (copiedText !== undefined && copiedText !== text) setCopiedText(undefined);

  return { copied: copiedText === text, copy: async () => setCopiedText((await copyText(text)) ? text : undefined) };
}
