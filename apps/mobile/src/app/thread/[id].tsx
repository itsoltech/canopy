import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { applyThread } from "../../api/thread";
import { useSession } from "../../state/session";
import { useStream } from "../../state/stream";
import { Button, ConnectionNotice, Notice } from "../../ui/components";
import { TimelineTurn } from "../../ui/timeline";
import { styles, useColors } from "../../ui/theme";
import { MessageComposer } from "../../features/threads/MessageComposer";
import { ThreadPanel } from "../../features/threads/ThreadPanel";
import { InteractionCard } from "../../features/threads/InteractionCard";
import { useOverview } from "../../state/overview";
import { ThreadHeader } from "../../features/threads/ThreadHeader";

export default function ThreadRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <Thread key={id} id={id} />;
}

function Thread({ id }: { id: string }) {
  const { session, client, ready, online, expired } = useSession();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<ui.ThreadSnapshot>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const followLatest = useRef(true);
  const [details, setDetails] = useState(false);
  const { projects, workers, threads } = useOverview();
  const list = useRef<FlatList<ui.Turn>>(null);
  const sending = useRef(false);

  const pending = useRef<{
    text: string;
    delivery: ui.MessageDelivery;
    id: string;
  } | null>(null);

  const requestController = useRef(new AbortController());
  useEffect(() => {
    requestController.current = new AbortController();

    return () => requestController.current.abort();
  }, [id, client]);

  const stream = useStream(
    client ? (signal) => client.api.watchThread({ threadId: id }, { signal }) : null,
    (update: ui.ThreadUpdate) => setSnapshot((s) => applyThread(s, update)),
    `${session?.deviceId}:${id}`,
  );

  if (!ready) return <ActivityIndicator accessibilityLabel="Opening Canopy" />;

  if (!session) return <Redirect href="/pair" />;
  const thread = snapshot?.thread;
  const worker = workers.find((w) => w.id === thread?.workerId);
  const subagents = threads.filter((t) => t.parentThreadId === id && !t.archivedAt && !t.deletedAt);
  const interactions = snapshot?.interactions.filter((i) => i.status === "pending") ?? [];
  const turns = snapshot?.turns.filter((t) => !t.withdrawn).slice() ?? [];

  // Provider-origin events can arrive before a turn update. Keep those entries visible.
  for (const item of snapshot?.items ?? []) {
    if (!turns.some((t) => t.id === item.turnId && t.fromThreadId === item.fromThreadId)) {
      turns.push(
        create(ui.TurnSchema, {
          id: item.turnId,
          fromThreadId: item.fromThreadId,
          inherited: item.inherited,
          trigger: "provider",
        }),
      );
    }
  }

  async function send(delivery: ui.MessageDelivery) {
    if (!client || !text.trim() || sending.current) return;
    sending.current = true;
    followLatest.current = true;
    setAtBottom(true);
    setBusy(true);
    setError("");
    const value = text.trim();

    if (pending.current?.text !== value || pending.current.delivery !== delivery)
      pending.current = { text: value, delivery, id: Crypto.randomUUID() };

    try {
      const result = await client.api.sendMessage(
        {
          threadId: id,
          text: value,
          delivery,
          clientRequestId: pending.current.id,
        },
        { signal: requestController.current.signal, timeoutMs: 20_000 },
      );

      if (result.turn)
        setSnapshot((s) =>
          s?.turns.some((turn) => turn.id === result.turn!.id)
            ? s
            : applyThread(
                s,
                create(ui.ThreadUpdateSchema, {
                  change: { case: "turn", value: result.turn! },
                }),
              ),
        );

      if (result.steer)
        setSnapshot((s) =>
          s?.steers.some((steer) => steer.id === result.steer!.id)
            ? s
            : applyThread(
                s,
                create(ui.ThreadUpdateSchema, {
                  change: { case: "steer", value: result.steer! },
                }),
              ),
        );
      setText("");
      pending.current = null;
    } catch (e) {
      if (ConnectError.from(e).code === Code.Unauthenticated) await expired();
      else if (!requestController.current.signal.aborted)
        setError("Could not confirm delivery. Retry with the same text to send it only once.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const blocked =
    !online ||
    !thread ||
    Boolean(thread.archivedAt || thread.deletedAt) ||
    thread.status === "archived" ||
    busy ||
    stream.connection !== "live";

  return (
    <SafeAreaView style={styles.fill}>
      <ThreadHeader
        thread={thread}
        project={projects.find((p) => p.id === thread?.projectId)}
        turns={turns}
        onDetails={() => setDetails(true)}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={insets.top}
        style={styles.fill}
      >
        <FlatList
          ref={list}
          data={turns}
          keyExtractor={(turn) => `${turn.fromThreadId}:${turn.id}`}
          style={styles.fill}
          contentContainerStyle={[styles.page, { paddingTop: 24, flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            const bottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 100;

            if (bottom) followLatest.current = true;
            setAtBottom(bottom);
          }}
          onScrollBeginDrag={() => {
            followLatest.current = false;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (followLatest.current) list.current?.scrollToEnd({ animated: false });
          }}
          ListHeaderComponent={
            <View style={{ gap: 16 }}>
              <ConnectionNotice {...stream} />
              {!snapshot && <ActivityIndicator accessibilityLabel="Loading conversation" color={c.accent} />}
              {snapshot && !turns.length && <Notice>This thread is ready for your first message.</Notice>}
            </View>
          }
          renderItem={({ item }) => (
            <TimelineTurn
              turn={item}
              entries={
                snapshot?.items.filter((i) => i.turnId === item.id && i.fromThreadId === item.fromThreadId) ?? []
              }
            />
          )}
          ListFooterComponent={
            <View style={{ gap: 12 }}>
              {snapshot?.steers
                .filter((s) => ["pending", "accepted"].includes(s.status))
                .map((s) => (
                  <Notice key={s.id}>Sending to the current turn: {s.text}</Notice>
                ))}
              {snapshot?.notices.slice(-3).map((n) => (
                <Notice key={String(n.seq)}>{n.notice?.message}</Notice>
              ))}
            </View>
          }
        />
        {!atBottom && (
          <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}>
            <Button
              title="Latest messages"
              secondary
              onPress={() => {
                followLatest.current = true;
                list.current?.scrollToEnd({ animated: true });
                setAtBottom(true);
              }}
            />
          </View>
        )}
        <View
          style={{
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 4,
            gap: 8,
            backgroundColor: c.background,
          }}
        >
          {error ? <Notice error>{error}</Notice> : null}
          {interactions.slice(0, 1).map((i) => (
            <InteractionCard key={i.requestId} interaction={i} />
          ))}
          {interactions.length > 1 && (
            <Text style={[styles.meta, { color: c.warning }]}>+{interactions.length - 1} pending</Text>
          )}
          {subagents.length > 0 && (
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {subagents.map((t) => (
                <Button
                  key={t.id}
                  secondary
                  title={`${t.title} · ${t.status}`}
                  onPress={() =>
                    router.push({
                      pathname: "/thread/[id]",
                      params: { id: t.id },
                    })
                  }
                />
              ))}
            </View>
          )}
          <MessageComposer
            thread={thread}
            worker={worker}
            text={text}
            onChange={setText}
            send={(delivery) => void send(delivery)}
            stop={() =>
              void client!.api
                .interruptThread({ threadId: id })
                .catch(() => setError("Could not stop the turn. Try again."))
            }
            disabled={blocked}
            busy={busy}
            onDetails={() => setDetails(true)}
          />
        </View>
      </KeyboardAvoidingView>
      <ThreadPanel snapshot={snapshot} visible={details} onClose={() => setDetails(false)} />
    </SafeAreaView>
  );
}
