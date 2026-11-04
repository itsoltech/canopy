import { Text } from "react-native";
import type { bots } from "@canopy/contracts";
import { Sheet } from "../../ui/components";
import { PanelRow } from "../threads/ThreadPanel";
import { styles, useColors } from "../../ui/theme";
import { BotAvatar } from "./BotAvatar";

export function BotDetailsPanel({
  conversation,
  visible,
  onClose,
}: {
  conversation?: bots.BotConversation;
  visible: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const bot = conversation?.bot;

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
          <Text style={[styles.meta, { color: c.muted }]}>Manage routines and bot settings in Canopy on the web.</Text>
        </>
      )}
    </Sheet>
  );
}
