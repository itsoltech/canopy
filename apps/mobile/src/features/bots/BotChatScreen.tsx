import { useRef, useState } from "react";
import { FlatList, Platform, Text, View } from "react-native";
import { ConversationSkeleton } from "../../ui/Skeleton";
import { Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import type { bots } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useStream } from "../../state/stream";
import { ConnectionNotice, IconButton, LatestButton, Notice, ScreenHeader } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { ComposerBox } from "../threads/ComposerBox";
import { ChatBubble } from "./ChatBubble";
import { ApprovalCard } from "./ApprovalCard";
import { BotDetailsPanel } from "./BotDetailsPanel";
import { BotAvatar } from "./BotAvatar";
import { useFollowingList } from "../../ui/useFollowingList";
import { useLayout } from "../../state/layout";
import { SidebarToggle } from "../navigation/SidebarToggle";

function useBotChat(id: string) {
  const { session, client, online } = useSession();
  const [conversation, setConversation] = useState<bots.BotConversation>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const following = useFollowingList<bots.BotMessage>();
  const sending = useRef(false);
  const pending = useRef({ text: "", id: "" });

  // Cards seen waiting stay on this visit when they expire, so the answer is not lost silently.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());

  const stream = useStream(
    client ? (signal) => client.api.watchBotConversation({ botId: id }, { signal }) : null,
    (next: bots.BotConversation) => {
      setConversation(next);
      setSeen((ids) => new Set([...ids, ...next.approvals.flatMap((a) => (a.status === "pending" ? [a.id] : []))]));
    },
    `bot:${session?.deviceId}:${id}`,
  );

  async function send() {
    if (!text.trim() || sending.current || !client) return;
    sending.current = true;
    following.resumeFollowing();
    setBusy(true);
    setError("");
    const value = text.trim();

    if (pending.current.text !== value) pending.current = { text: value, id: Crypto.randomUUID() };

    try {
      await client.api.sendBotMessage(
        { botId: id, text: value, clientRequestId: pending.current.id },
        { timeoutMs: 20_000 },
      );
      setText("");
      pending.current = { text: "", id: "" };
    } catch {
      setError("Could not confirm delivery. Retry with the same text to send it only once.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return {
    session,
    client,
    online,
    conversation,
    text,
    setText,
    busy,
    error,
    setError,
    details,
    setDetails,
    following,
    stream,
    send,
    seen,
  };
}

export function BotChatScreen({ id }: { id: string }) {
  const c = useColors();
  const { wide } = useLayout();

  const {
    session,
    client,
    online,
    conversation,
    text,
    setText,
    busy,
    error,
    setError,
    details,
    setDetails,
    following,
    stream,
    send,
    seen,
  } = useBotChat(id);

  const { atBottom, showLatest } = following;

  if (!session) return <Redirect href="/pair" />;

  return (
    <SafeAreaView style={styles.fill} edges={["top", "left", "right"]}>
      <ScreenHeader
        title={conversation?.bot?.configuration?.name || "Bot"}
        left={wide ? <SidebarToggle /> : undefined}
        right={
          <View style={styles.row}>
            {conversation?.bot && <BotAvatar bot={conversation.bot} size={32} />}
            <IconButton icon="ellipsis-horizontal" label="Bot details" onPress={() => setDetails(true)} />
          </View>
        }
      />
      <KeyboardArea>
        <FlatList
          {...following.listProps}
          data={[...(conversation?.messages ?? [])].reverse()}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[styles.page, { gap: 16, flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          renderItem={({ item }) => <ChatBubble message={item} bot={conversation?.bot} />}
          // Inverted: the footer is the top of the chat, the header sits under the latest message.
          ListFooterComponent={
            <View style={{ gap: 12 }}>
              {(conversation || stream.connection !== "connecting") && <ConnectionNotice {...stream} />}
              {!conversation && <ConversationSkeleton />}
              {conversation && !conversation.messages.length && (
                <Text style={[styles.meta, { color: c.muted, textAlign: "center" }]}>Start a conversation</Text>
              )}
            </View>
          }
          ListHeaderComponent={
            <View style={{ gap: 12 }}>
              {conversation?.approvals
                .filter((a) => a.status === "pending" || (a.status === "expired" && seen.has(a.id)))
                .map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              {conversation?.working && (
                <Text style={[styles.meta, { color: c.muted }]}>{conversation.statusLine || "Working…"}</Text>
              )}
            </View>
          }
        />
        <View style={{ padding: 12, gap: 8 }}>
          <LatestButton visible={!atBottom} onPress={showLatest} />
          {error ? <Notice error>{error}</Notice> : null}
          <ComposerBox
            compact
            placeholder={`Message ${conversation?.bot?.configuration?.name || "bot"}`}
            text={text}
            onChange={setText}
            onSend={() => void send()}
            running={conversation?.working}
            onStop={() => void client!.api.interruptBot({ botId: id }).catch(() => setError("Could not stop the bot."))}
            disabled={!online || !conversation || stream.connection !== "live"}
            busy={busy}
          />
        </View>
      </KeyboardArea>
      <BotDetailsPanel conversation={conversation} visible={details} onClose={() => setDetails(false)} />
    </SafeAreaView>
  );
}
