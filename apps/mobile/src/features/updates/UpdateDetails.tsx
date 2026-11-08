import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";

export function UpdateDetails({ text }: { text: string }) {
  const c = useColors();
  const [copied, setCopied] = useState("");

  return (
    <SettingsDisclosure title="Show details">
      <Text selectable style={[styles.overlayMeta, { color: c.muted }]}>
        {text}
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button
          title="Copy details"
          size="sm"
          variant="ghost"
          onPress={() => {
            void Clipboard.setStringAsync(text)
              .then(() => setCopied("Copied"))
              .catch(() => setCopied("Could not copy. Select the text to copy it."));
          }}
        />
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
          {copied}
        </Text>
      </View>
    </SettingsDisclosure>
  );
}
