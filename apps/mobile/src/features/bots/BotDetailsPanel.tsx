import { Text, View } from "react-native";
import { useState } from "react";
import type { bots } from "@canopy/contracts";
import { learnFromConversation } from "@canopy/domain/bot-chat";
import { Button, Sheet } from "../../ui/components";
import { BotSettings } from "./BotSettings";
import { PanelRow } from "../threads/ThreadPanel";
import { ThreadPanelSection } from "../threads/ThreadPanelSection";
import { useAppearance } from "../../state/appearance";
import { styles, useColors, useTypography } from "../../ui/theme";
import { BotAvatar } from "./BotAvatar";
import { BotSchedules } from "./BotSchedules";
import { BotWaitingCards } from "./BotWaitingCards";

export function BotDetailsPanel({
  bot,
  conversation,
  delegatedThreads,
  visible,
  onClose,
  selectedRule = "",
  readOnly = true,
  onReveal,
  onLearn,
}: {
  bot: bots.Bot | undefined;
  conversation?: bots.BotConversation;
  delegatedThreads: bots.Bot["delegatedThreads"];
  visible: boolean;
  onClose: () => void;
  selectedRule?: string;
  readOnly?: boolean;
  onReveal?: (approvalId: string) => void;
  onLearn?: (() => void) | undefined;
}) {
  const c = useColors();
  const { threadsEnabled } = useAppearance();
  const settingsBot = conversation?.bot;
  const [settings, setSettings] = useState(false);

  if (settingsBot && visible && (settings || selectedRule))
    return (
      <BotSettings
        key={settingsBot.id}
        bot={settingsBot}
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
          {!bot.archived && !!conversation?.messages.length && (
            <Button
              title={learnFromConversation.label}
              icon="light-bulb"
              multiline
              disabled={!onLearn}
              onPress={() => onLearn?.()}
            />
          )}
          <PanelRow title="Model" value={bot.configuration?.model || "Default model"} icon="cpu-chip" />
          {threadsEnabled && <DelegatedThreadCounts counts={delegatedThreads} />}
          <PanelRow title="Instructions" value={bot.configuration?.instructions || "No instructions"} />
          {conversation && onReveal && <BotWaitingCards approvals={conversation.approvals} onReveal={onReveal} />}
          {conversation && <BotSchedules conversation={conversation} readOnly={readOnly} />}
          <Button title="Bot settings" disabled={readOnly} onPress={() => setSettings(true)} />
        </>
      )}
    </Sheet>
  );
}

function DelegatedThreadCounts({ counts }: { counts: bots.Bot["delegatedThreads"] }) {
  const c = useColors();
  const type = useTypography();

  return (
    <ThreadPanelSection title="Delegated threads">
      {[
        { label: "Working", count: counts?.working },
        { label: "Finished", count: counts?.finished },
      ].map(({ label, count }) => (
        <View key={label} style={[styles.row, { minHeight: 36 }]}>
          <Text style={[type.chrome, { color: c.text, flex: 1 }]}>{label}</Text>
          <Text style={[type.chrome, { color: c.text, fontVariant: ["tabular-nums"] }]}>
            {count?.toLocaleString() ?? "—"}
          </Text>
        </View>
      ))}
      {!counts && (
        <View style={[styles.row, { minHeight: 36 }]}>
          <Text style={[type.chrome, { color: c.muted }]}>Thread status unavailable</Text>
        </View>
      )}
    </ThreadPanelSection>
  );
}
