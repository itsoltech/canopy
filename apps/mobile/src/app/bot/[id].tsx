import { useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  View,
} from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import type { bots } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useStream } from "../../state/stream";
import {
  ConnectionNotice,
  Button,
  IconButton,
  Notice,
  ScreenHeader,
} from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { ComposerBox } from "../../features/threads/ComposerBox";
import { ChatBubble } from "../../features/bots/ChatBubble";
import { ApprovalCard } from "../../features/bots/ApprovalCard";
import { BotDetailsPanel } from "../../features/bots/BotDetailsPanel";
import { BotAvatar } from "../../features/bots/BotAvatar";

export default function BotRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <BotChat key={id} id={id} />;
}
function BotChat({ id }: { id: string }) {
  const c = useColors();
  const { session, client, online } = useSession();
  const insets = useSafeAreaInsets();
  const [conversation, setConversation] = useState<bots.BotConversation>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const followLatest = useRef(true);
  const sending = useRef(false);
  const pending = useRef({ text: "", id: "" });
  const list = useRef<FlatList<bots.BotMessage>>(null);
  const stream = useStream(
    client
      ? (signal) => client.api.watchBotConversation({ botId: id }, { signal })
      : null,
    setConversation,
    `bot:${session?.deviceId}:${id}`,
  );
  if (!session) return <Redirect href="/pair" />;
  async function send() {
    if (!text.trim() || sending.current || !client) return;
    sending.current = true;
    followLatest.current = true;
    setAtBottom(true);
    setBusy(true);
    setError("");
    const value = text.trim();
    if (pending.current.text !== value)
      pending.current = { text: value, id: Crypto.randomUUID() };
    try {
      await client.api.sendBotMessage(
        { botId: id, text: value, clientRequestId: pending.current.id },
        { timeoutMs: 20_000 },
      );
      setText("");
      pending.current = { text: "", id: "" };
    } catch {
      setError(
        "Could not confirm delivery. Retry with the same text to send it only once.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={styles.fill}>
      <ScreenHeader
        title={conversation?.bot?.configuration?.name || "Bot"}
        right={
          <View style={styles.row}>
            {conversation?.bot && (
              <BotAvatar bot={conversation.bot} size={32} />
            )}
            <IconButton
              icon="ellipsis-horizontal"
              label="Bot details"
              onPress={() => setDetails(true)}
            />
          </View>
        }
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={insets.top}
        style={styles.fill}
      >
        <FlatList
          ref={list}
          data={conversation?.messages ?? []}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[styles.page, { gap: 16, flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } =
              e.nativeEvent;
            const bottom =
              contentOffset.y + layoutMeasurement.height >=
              contentSize.height - 100;
            if (bottom) followLatest.current = true;
            setAtBottom(bottom);
          }}
          onScrollBeginDrag={() => {
            followLatest.current = false;
          }}
          onContentSizeChange={() => {
            if (followLatest.current)
              list.current?.scrollToEnd({ animated: false });
          }}
          renderItem={({ item }) => (
            <ChatBubble message={item} bot={conversation?.bot} />
          )}
          ListHeaderComponent={<ConnectionNotice {...stream} />}
          ListEmptyComponent={
            !conversation ? (
              <ActivityIndicator />
            ) : (
              <Text style={[styles.meta, { color: c.muted }]}>
                Start a conversation
              </Text>
            )
          }
          ListFooterComponent={
            <View style={{ gap: 12 }}>
              {conversation?.approvals
                .filter((a) => a.status === "pending")
                .map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              {conversation?.working && (
                <Text style={[styles.meta, { color: c.muted }]}>
                  {conversation.statusLine || "Working…"}
                </Text>
              )}
            </View>
          }
        />
        {!atBottom && (
          <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
            <Button
              secondary
              title="Latest messages"
              onPress={() => {
                followLatest.current = true;
                list.current?.scrollToEnd({ animated: true });
                setAtBottom(true);
              }}
            />
          </View>
        )}
        <View style={{ padding: 12, gap: 8 }}>
          {error ? <Notice error>{error}</Notice> : null}
          <ComposerBox
            compact
            placeholder={`Message ${conversation?.bot?.configuration?.name || "bot"}`}
            text={text}
            onChange={setText}
            onSend={() => void send()}
            running={conversation?.working}
            onStop={() =>
              void client!.api
                .interruptBot({ botId: id })
                .catch(() => setError("Could not stop the bot."))
            }
            disabled={!online || !conversation || stream.connection !== "live"}
            busy={busy}
          />
        </View>
      </KeyboardAvoidingView>
      <BotDetailsPanel
        conversation={conversation}
        visible={details}
        onClose={() => setDetails(false)}
      />
    </SafeAreaView>
  );
}
