import { useEffect, useRef, useState } from "react";
import { FlatList, Platform, Text, View } from "react-native";
import { ConversationSkeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import type { bots } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { useComputerHome } from "../computers/presence";
import { botParticipant, type ChatRow } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { useStream } from "../../state/stream";
import { ConnectionNotice, IconButton, LatestButton, Notice, ScreenHeader } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { ComposerBox } from "../threads/ComposerBox";
import { ChatRowView, useChatRows } from "./ChatTimeline";
import { BotStatusRow } from "./ChatRows";
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
  const following = useFollowingList<ChatRow>();
  const [known, setKnown] = useState<bots.Bot[]>([]);
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

  // Your other bots name the counterparts of bot ⇄ bot exchanges.
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.api
      .listBots({})
      .then((result) => active && setKnown(result.bots))
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [client]);

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
    known,
  };
}

export function BotChatScreen({ id, rule = "" }: { id: string; rule?: string }) {
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
    known,
  } = useBotChat(id);

  const home = useComputerHome(conversation?.bot?.nodeId || splitId(id).node);

  const approvals =
    conversation?.approvals.filter(
      (a) => a.allowedByRule || a.status === "pending" || (a.status === "expired" && seen.has(a.id)),
    ) ?? [];

  const rows = useChatRows(conversation, approvals, known);
  const waiting = approvals.some((a) => a.status === "pending");

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
          data={[...rows].reverse()}
          keyExtractor={(row) => row.id}
          contentContainerStyle={[styles.page, { gap: 0, flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          renderItem={({ item }) => <ChatRowView row={item} approvals={approvals} readOnly={home.away} />}
          // Inverted: the footer is the top of the chat, the header sits under the latest message.
          ListFooterComponent={
            <View style={{ gap: 12 }}>
              {!home.away && (conversation || stream.connection !== "connecting") && <ConnectionNotice {...stream} />}
              {!conversation && <ConversationSkeleton />}
              {conversation && !conversation.messages.length && (
                <Text style={[styles.meta, { color: c.muted, textAlign: "center" }]}>Start a conversation</Text>
              )}
            </View>
          }
          ListHeaderComponent={
            conversation?.working && conversation.bot ? (
              <View style={{ paddingTop: 12 }}>
                <BotStatusRow
                  bot={botParticipant(conversation.bot)}
                  text={conversation.statusLine || (waiting ? "Waiting for you" : "Typing…")}
                  waiting={waiting}
                />
              </View>
            ) : undefined
          }
        />
        <View style={{ padding: 12, gap: 8 }}>
          <LatestButton visible={!atBottom} onPress={showLatest} />
          {error ? <Notice error>{error}</Notice> : null}
          {home.away && (
            <Notice>
              {home.name} · {home.status}. Read only until it reconnects.
            </Notice>
          )}
          <ComposerBox
            compact
            placeholder={`Message ${conversation?.bot?.configuration?.name || "bot"}`}
            text={text}
            onChange={setText}
            onSend={() => void send()}
            running={conversation?.working}
            onStop={() => void client!.api.interruptBot({ botId: id }).catch(() => setError("Could not stop the bot."))}
            disabled={home.away || !online || !conversation || stream.connection !== "live"}
            busy={busy}
          />
        </View>
      </KeyboardArea>
      <BotDetailsPanel
        conversation={conversation}
        visible={details || !!rule}
        selectedRule={rule}
        onClose={() => {
          setDetails(false);

          if (rule) router.setParams({ rule: "" });
        }}
      />
    </SafeAreaView>
  );
}
