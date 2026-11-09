import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import {
  exchangePhrases,
  type ChatErrorView,
  type ChatEventView,
  type ExchangeSegment,
  type ParticipantView,
} from "@canopy/domain/bot-chat";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { LiveText } from "../../ui/LiveText";
import { font, styles, useColors } from "../../ui/theme";
import { useClock } from "../settings/display";
import { FailureNotice } from "../timeline/FailureNotice";
import { MascotAvatar } from "./BotAvatar";
import { botInk } from "./bot-ink";
import { BotFailureActions } from "./BotFailureActions";

/** Centered time between messages: "Today 8:44 PM" (web: ChatDateLine). */
export function ChatDateLine({ at }: { at: Date }) {
  const c = useColors();

  return <Text style={[styles.meta, { color: c.muted, textAlign: "center" }]}>{useClock().dateLine(at)}</Text>;
}

/** A bot's avatar and name in its colour; opens its chat when it is known (web: BotChip). */
export function BotChip({ bot, exchangeId }: { bot: ParticipantView | undefined; exchangeId?: string }) {
  const c = useColors();
  const ink = botInk(bot?.color, c.dark, c.soft);
  const name = bot?.name ?? "a deleted bot";

  const content = (
    <View style={[styles.row, { gap: 4, flexShrink: 1 }]}>
      <MascotAvatar id={bot?.id ?? ""} name={name} shape={bot?.shape} color={bot?.color ?? "#71717a"} size={16} />
      <Text numberOfLines={1} style={[styles.body, { flexShrink: 1, fontFamily: font.medium, color: ink }]}>
        {name}
      </Text>
    </View>
  );

  return bot ? (
    <Pressable
      accessibilityRole="link"
      onPress={() =>
        router.push(
          exchangeId
            ? { pathname: "/bot-exchange/[id]", params: { id: exchangeId, botId: bot.id } }
            : { pathname: "/bot/[id]", params: { id: bot.id } },
        )
      }
      hitSlop={8}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}

/** Bot ⇄ bot messages as one quiet line: "Messaged ‹A› and ‹B›", "Message from ‹A›", "2 messages with ‹A›". */
export function ExchangeLine({ segments }: { segments: readonly ExchangeSegment[] }) {
  const c = useColors();
  const quiet = [styles.body, { color: c.muted }];

  return (
    <View style={[styles.row, { flexWrap: "wrap", columnGap: 6, rowGap: 4 }]}>
      <Icon name="arrows-right-left" color={c.faint} />
      {exchangePhrases(segments).map((phrase, index) => (
        <View key={index} style={[styles.row, { flexWrap: "wrap", columnGap: 6, rowGap: 4 }]}>
          {index > 0 && <Text style={quiet}>·</Text>}
          {phrase.kind === "sent" ? (
            <>
              <Text style={quiet}>Messaged</Text>
              {phrase.segments.map((segment, i) => (
                <View key={segment.exchangeId + segment.botId} style={[styles.row, { gap: 6 }]}>
                  {i > 0 && <Text style={quiet}>{i === phrase.segments.length - 1 ? "and" : ","}</Text>}
                  <BotChip bot={segment.bot} exchangeId={segment.exchangeId} />
                </View>
              ))}
            </>
          ) : phrase.kind === "received" ? (
            <>
              <Text style={quiet}>Message from</Text>
              <BotChip bot={phrase.segment.bot} exchangeId={phrase.segment.exchangeId} />
            </>
          ) : (
            <>
              <Text style={quiet}>{phrase.count} messages with</Text>
              <BotChip bot={phrase.segment.bot} exchangeId={phrase.segment.exchangeId} />
            </>
          )}
        </View>
      ))}
    </View>
  );
}

const EVENT_ICONS: Record<ChatEventView["kind"], IconName> = {
  routine_created: "arrow-path-rounded-square",
  routine_deleted: "trash",
  routines_disabled: "no-symbol",
  relayed_message: "chat-bubble-left",
  joined: "user-group",
  info: "information-circle",
};

/** Something that happened rather than something said, centered (web: ChatEventLine). */
export function ChatEventLine({ event }: { event: ChatEventView }) {
  const c = useColors();

  return (
    <View style={[styles.row, { justifyContent: "center", flexWrap: "wrap", gap: 6, paddingHorizontal: 12 }]}>
      <Icon name={EVENT_ICONS[event.kind]} size={14} color={c.faint} />
      <Text style={[styles.meta, { flexShrink: 1, color: c.muted, textAlign: "center" }]}>
        {event.text}
        {event.detail ? (
          <>
            <Text style={{ color: c.faint }}> · </Text>
            <Text style={{ color: c.soft }}>{event.detail}</Text>
          </>
        ) : null}
      </Text>
    </View>
  );
}

/** A failed reply with recovery actions, matching the web chat. */
export function ChatErrorLine({
  error,
  sender,
  readOnly,
}: {
  error: ChatErrorView;
  sender: ParticipantView | undefined;
  readOnly: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <FailureNotice
        heading={`${sender?.name ?? "The bot"} couldn't reply`}
        message={error.detail}
        code={error.code}
        source={error.source}
        authHint="Sign in to the provider on the bot's worker using this instance's CLI home, then retry."
      />
      <BotFailureActions botId={error.botId} retryable={error.retryable} disabled={readOnly} />
    </View>
  );
}

/** What the bot is doing now under its last message: "Typing…", "Checking Notion" (web: BotStatusRow). */
export function BotStatusRow({ bot, text, waiting }: { bot: ParticipantView; text: string; waiting: boolean }) {
  const c = useColors();

  return (
    <View accessibilityRole="text" accessibilityLabel={`${bot.name}: ${text}`} style={styles.row}>
      <MascotAvatar id={bot.id} name={bot.name} shape={bot.shape} color={bot.color} size={28} />
      {waiting ? (
        <Text numberOfLines={1} style={[styles.body, { flex: 1, color: c.muted }]}>
          {text}
        </Text>
      ) : (
        <LiveText containerStyle={{ flex: 1 }} style={styles.body}>
          {text}
        </LiveText>
      )}
    </View>
  );
}
