import { useAppearance } from "../../state/appearance";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { bots, ui } from "@canopy/contracts";
import { useBotList } from "../../state/bot-list";
import { router } from "expo-router";
import { MascotAvatar } from "../bots/BotAvatar";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { font, styles, useColors } from "../../ui/theme";
import { ThreadLink } from "./items/bus/ThreadLink";

/** "Message from ‹avatar› ‹Bot›" over input a bot sent; the bot opens its chat (web: BotSenderLabel). */
export function BotSender({
  verb = "Message from",
  botId,
  sender,
  bot,
  color,
}: {
  verb?: string;
  botId: string;
  sender?: ui.AgentSender | undefined;
  bot?: bots.BotConfiguration | undefined;
  color: string;
}) {
  const { botsEnabled } = useAppearance();
  const name = sender?.botId ? sender.title : bot?.name;

  return (
    <View style={[styles.row, { gap: 6, flexShrink: 1 }]}>
      {verb ? <Text style={[styles.meta, { color }]}>{verb}</Text> : null}
      {name ? (
        <Pressable
          disabled={!botsEnabled}
          accessibilityRole={botsEnabled ? "link" : "text"}
          accessibilityLabel={name}
          onPress={() => router.push({ pathname: "/bot/[id]", params: { id: botId } })}
          hitSlop={8}
          style={[styles.row, { gap: 4, flexShrink: 1 }]}
        >
          <MascotAvatar
            id={botId}
            name={name}
            shape={sender?.botShape ?? bot?.shape}
            color={sender?.botColor ?? bot?.color}
            size={16}
          />
          <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, fontFamily: font.medium, color }]}>
            {name}
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.meta, { color }]}>a bot</Text>
      )}
    </View>
  );
}

/** A local bot can start a thread with only its ID in the turn history. */
export function LocalBotSender({ botId, color }: { botId: string; color: string }) {
  const bot = useBotList().data?.bots.find((entry) => entry.id === botId);

  return <BotSender verb="" botId={botId} bot={bot?.configuration} color={color} />;
}

/**
 * Who sent an agent's input (a task, a message, a report, a steer): its bot or thread, and the model and computer it
 * runs on as quiet details (web: AgentSenderLabel). Text colour comes from the line it sits in.
 */
export function SenderLabel({
  verb,
  threadId,
  sender,
  fallback = "another thread",
  color,
  leading,
  trailing,
}: {
  verb: string;
  threadId: string;
  sender?: ui.AgentSender | undefined;
  fallback?: string;
  color: string;
  /** Before the verb, in its group (a note's icon), so it never stands alone on a line. */
  leading?: ReactNode;
  trailing?: string;
}) {
  return (
    <View
      style={[styles.row, { flexWrap: "wrap", justifyContent: "flex-end", columnGap: 6, rowGap: 4, maxWidth: "100%" }]}
    >
      {sender?.botId ? (
        <View style={[styles.row, { gap: 6, flexShrink: 1 }]}>
          {leading}
          <BotSender verb={verb} botId={sender.botId} sender={sender} color={color} />
        </View>
      ) : (
        <View style={[styles.row, { gap: 6, flexShrink: 1 }]}>
          {leading}
          <Text style={[styles.meta, { color }]}>{verb}</Text>
          <ThreadLink threadId={threadId} fallback={sender?.title || fallback} />
        </View>
      )}
      <SenderDetails sender={sender} trailing={trailing} />
    </View>
  );
}

/** Provider, model and computer of a sender, followed by delivery details when supplied. */
export function SenderDetails({
  sender,
  trailing,
  wrap = false,
}: {
  sender?: ui.AgentSender | undefined;
  trailing?: string | undefined;
  wrap?: boolean;
}) {
  const c = useColors();

  const quiet = [sender?.botId ? "" : sender?.model, sender?.computerName && `on ${sender.computerName}`, trailing]
    .filter(Boolean)
    .join(" · ");

  if (!quiet && (!sender || sender.botId)) return null;

  return (
    <View style={[styles.row, { gap: 4, flexShrink: 1 }]}>
      {sender && !sender.botId ? <ProviderIcon provider={sender.provider} /> : null}
      {quiet ? (
        <Text numberOfLines={wrap ? undefined : 1} style={[styles.meta, { flexShrink: 1, color: c.muted }]}>
          {!wrap && sender?.botId && !sender.computerName ? "· " : ""}
          {quiet}
        </Text>
      ) : null}
    </View>
  );
}
