import { Text } from "react-native";
import { useState } from "react";
import type { bots } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { BotSettings } from "./BotSettings";
import { PanelRow } from "../threads/ThreadPanel";
import { styles, useColors } from "../../ui/theme";
import { BotAvatar } from "./BotAvatar";

export function BotDetailsPanel({
  conversation,
  visible,
  onClose,
  selectedRule = "",
}: {
  conversation?: bots.BotConversation;
  visible: boolean;
  onClose: () => void;
  selectedRule?: string;
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
          <Text style={[styles.heading, { color: c.text }]}>Routines</Text>
          {conversation?.routines.length ? (
            conversation.routines.map((r) => (
              <PanelRow
                key={r.id}
                title={r.title}
                value={`${r.enabled ? "Active" : "Paused"} · ${r.scheduleText || r.cron}`}
                icon="clock"
              />
            ))
          ) : (
            <Text style={[styles.meta, { color: c.muted }]}>No routines</Text>
          )}
          <Text style={[styles.heading, { color: c.text }]}>Reminders</Text>
          {conversation?.reminders.length ? (
            conversation.reminders.map((r) => (
              <PanelRow
                key={r.id}
                title={r.prompt}
                value={r.runAt ? new Date(Number(r.runAt.seconds) * 1000).toLocaleString() : ""}
                icon="clock"
              />
            ))
          ) : (
            <Text style={[styles.meta, { color: c.muted }]}>No reminders</Text>
          )}
          <Button title="Bot settings" secondary onPress={() => setSettings(true)} />
        </>
      )}
    </Sheet>
  );
}
