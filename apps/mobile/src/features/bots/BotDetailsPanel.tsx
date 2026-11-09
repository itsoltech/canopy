import { Text } from "react-native";
import { useState } from "react";
import type { bots } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { BotSettings } from "./BotSettings";
import { PanelRow } from "../threads/ThreadPanel";
import { styles, useColors } from "../../ui/theme";
import { BotAvatar } from "./BotAvatar";
import { BotSchedules } from "./BotSchedules";

export function BotDetailsPanel({
  conversation,
  visible,
  onClose,
  selectedRule = "",
  readOnly = true,
}: {
  conversation?: bots.BotConversation;
  visible: boolean;
  onClose: () => void;
  selectedRule?: string;
  readOnly?: boolean;
}) {
  const c = useColors();
  const bot = conversation?.bot;
  const [settings, setSettings] = useState(false);

  if (bot && visible && (settings || selectedRule))
    return (
      <BotSettings
        key={bot.id}
        bot={bot}
        selectedRule={selectedRule}
        onClose={() => {
          setSettings(false);

          if (selectedRule) onClose();
        }}
      />
    );

  return (
    <Sheet title="Bot details" visible={visible} onClose={onClose}>
      {bot && (
        <>
          <BotAvatar bot={bot} size={64} />
          <Text style={[styles.heading, { color: c.text }]}>{bot.configuration?.name}</Text>
          <PanelRow title="Model" value={bot.configuration?.model || "Default model"} icon="cpu-chip" />
          <PanelRow title="Instructions" value={bot.configuration?.instructions || "No instructions"} />
          {conversation && <BotSchedules conversation={conversation} readOnly={readOnly} />}
          <Button title="Bot settings" disabled={readOnly} onPress={() => setSettings(true)} />
        </>
      )}
    </Sheet>
  );
}
