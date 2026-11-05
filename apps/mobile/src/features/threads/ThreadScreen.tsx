import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { applyThread } from "../../api/thread";
import { useSession } from "../../state/session";
import { useStream } from "../../state/stream";
import { Button, ConnectionNotice, LatestButton, Notice } from "../../ui/components";
import { TimelineTurn } from "../../ui/timeline";
import { styles, useColors } from "../../ui/theme";
import { MessageComposer } from "./MessageComposer";
import { ThreadPanel } from "./ThreadPanel";
import { InteractionCard } from "./InteractionCard";
import { useOverview } from "../../state/overview";
import { ThreadHeader } from "./ThreadHeader";
import { useFollowingList } from "../../ui/useFollowingList";

function visibleTurns(snapshot: ui.ThreadSnapshot | undefined) {
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

  return turns;
}

function useThreadState(id: string) {
  const { session, client, ready, online, expired } = useSession();
  const [snapshot, setSnapshot] = useState<ui.ThreadSnapshot>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const following = useFollowingList<ui.Turn>();
  const [details, setDetails] = useState(false);
  const { projects, workers, threads } = useOverview();
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

  const thread = snapshot?.thread;
  const worker = workers.find((w) => w.id === thread?.workerId);
  const subagents = threads.filter((t) => t.parentThreadId === id && !t.archivedAt && !t.deletedAt);
  const interactions = snapshot?.interactions.filter((i) => i.status === "pending") ?? [];
  const turns = visibleTurns(snapshot);

  async function send(delivery: ui.MessageDelivery) {
    if (!client || !text.trim() || sending.current) return;
    sending.current = true;
    following.resumeFollowing();
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

  return {
    session,
    client,
    ready,
    snapshot,
    text,
    setText,
    busy,
    error,
    setError,
    following,
    details,
    setDetails,
    projects,
    stream,
    thread,
    worker,
    subagents,
    interactions,
    turns,
    send,
    blocked,
  };
}

export function ThreadScreen({ id }: { id: string }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const state = useThreadState(id);

  const {
    session,
    client,
    ready,
    snapshot,
    text,
    setText,
    busy,
    error,
    setError,
    following,
    details,
    setDetails,
    projects,
    thread,
    worker,
    subagents,
    interactions,
    turns,
    send,
    blocked,
  } = state;

  const { atBottom, showLatest } = following;

  if (!ready) return <ActivityIndicator accessibilityLabel="Opening Canopy" />;

  if (!session) return <Redirect href="/pair" />;

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
        <ThreadTimeline state={state} />
        <View
          style={{
            paddingHorizontal: 12,
            paddingTop: 8,
            paddingBottom: 4,
            gap: 8,
            backgroundColor: c.background,
          }}
        >
          <LatestButton visible={!atBottom} onPress={showLatest} />
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

function ThreadTimeline({ state }: { state: ReturnType<typeof useThreadState> }) {
  const c = useColors();
  const { turns, following, stream, snapshot } = state;
  const latestFirst = [...turns].reverse();

  return (
    <FlatList
      {...following.listProps}
      data={latestFirst}
      keyExtractor={(turn) => `${turn.fromThreadId}:${turn.id}`}
      style={styles.fill}
      contentContainerStyle={[styles.page, { paddingTop: 24, flexGrow: 1 }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      // Inverted: the footer is the top of the feed, the header sits under the latest turn.
      ListFooterComponent={
        <View style={{ gap: 16, paddingBottom: 16 }}>
          <ConnectionNotice {...stream} />
          {!snapshot && <ActivityIndicator accessibilityLabel="Loading conversation" color={c.accent} />}
          {snapshot && !turns.length && <Notice>This thread is ready for your first message.</Notice>}
        </View>
      }
      renderItem={({ item }) => (
        <TimelineTurn
          turn={item}
          entries={snapshot?.items.filter((i) => i.turnId === item.id && i.fromThreadId === item.fromThreadId) ?? []}
        />
      )}
      ListHeaderComponent={
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
  );
}
