import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
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
  color,
}: {
  verb?: string;
  botId: string;
  sender?: ui.AgentSender | undefined;
  color: string;
}) {
  const name = sender?.botId ? sender.title : "";

  return (
    <View style={[styles.row, { gap: 6, flexShrink: 1 }]}>
      <Text style={[styles.meta, { color }]}>{verb}</Text>
      {name ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={name}
          onPress={() => router.push({ pathname: "/bot/[id]", params: { id: botId } })}
          hitSlop={8}
          style={[styles.row, { gap: 4, flexShrink: 1 }]}
        >
          <MascotAvatar id={botId} name={name} shape={sender?.botShape} color={sender?.botColor} size={16} />
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
  const c = useColors();

  const quiet = [sender?.botId ? "" : sender?.model, sender?.computerName && `on ${sender.computerName}`, trailing]
    .filter(Boolean)
    .join(" · ");

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
      {quiet || (sender && !sender.botId) ? (
        <View style={[styles.row, { gap: 4, flexShrink: 1 }]}>
          {sender && !sender.botId ? <ProviderIcon provider={sender.provider} /> : null}
          {quiet ? (
            <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, color: c.muted }]}>
              {quiet}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
