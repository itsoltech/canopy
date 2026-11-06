import { useEffect, useRef, useState } from "react";
import { FlatList, Platform, Text, View } from "react-native";
import { ConversationSkeleton, Skeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { splitId } from "@canopy/domain/computers";
import { useComputerHome } from "../computers/presence";
import { botParticipant, type ChatRow } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { useBotSnapshot } from "../../state/bot";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { IconButton, LatestButton, Notice, ScreenHeader } from "../../ui/components";
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
  const { session, client, online, bots: known, updateBots } = useSession();
  const history = useBotSnapshot(id);
  const { snapshot: conversation, stream } = history;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const following = useFollowingList<ChatRow>();
  const sending = useRef(false);
  const pending = useRef({ text: "", id: "" });

  // Your other bots name the counterparts of bot ⇄ bot exchanges.
  useEffect(() => {
    if (!client) return;
    let active = true;
    client.api
      .listBots({})
      .then((result) => active && updateBots(result.bots))
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [client, updateBots]);

  async function send() {
    if (!text.trim() || sending.current || !client || stream.connection !== "live") return;
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
    seen: history.seen,
    known,
    answer: history.answer,
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
    answer,
  } = useBotChat(id);

  const home = useComputerHome(conversation?.bot?.nodeId || splitId(id).node);
  const bot = conversation?.bot ?? known.find((bot) => bot.id === id);
  const live = stream.connection === "live" && !home.away;

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
        title={bot?.configuration?.name ?? ""}
        loading={!bot}
        subtitle={conversation && !live ? "Syncing…" : undefined}
        left={wide ? <SidebarToggle /> : undefined}
        right={
          <View style={styles.row}>
            {bot ? <BotAvatar bot={bot} size={32} /> : <Skeleton style={{ width: 32, height: 32, borderRadius: 16 }} />}
            <IconButton icon="ellipsis-horizontal" label="Bot details" onPress={() => setDetails(true)} />
          </View>
        }
      />
      <ConnectionBanner stream={home.away ? undefined : stream} />
      <KeyboardArea>
        <FlatList
          {...following.listProps}
          data={[...rows].reverse()}
          keyExtractor={(row) => row.id}
          contentContainerStyle={[styles.page, { gap: 0, flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          renderItem={({ item }) => <ChatRowView row={item} approvals={approvals} readOnly={!live} onAnswer={answer} />}
          // Inverted: the footer is the top of the chat, the header sits under the latest message.
          ListFooterComponent={
            <View style={{ gap: 12 }}>
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
            placeholder={bot?.configuration?.name ? `Message ${bot.configuration.name}` : ""}
            text={text}
            onChange={setText}
            onSend={() => void send()}
            running={conversation?.working}
            onStop={() => {
              if (live) void client!.api.interruptBot({ botId: id }).catch(() => setError("Could not stop the bot."));
            }}
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
