import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { ui } from '@open-agents/contracts';
import { applyThread, threadStatus } from '../../api/thread';
import { useSession } from '../../state/session';
import { useStream } from '../../state/stream';
import { Button, ConnectionNotice, Notice } from '../../ui/components';
import { TimelineTurn } from '../../ui/timeline';
import { styles, useColors } from '../../ui/theme';

export default function ThreadRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Thread key={id} id={id} />;
}

function Thread({ id }: { id: string }) {
  const { session, client, ready, online, expired } = useSession();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<ui.ThreadSnapshot>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<FlatList<ui.Turn>>(null);
  const sending = useRef(false);
  const pending = useRef<{ text: string; delivery: ui.MessageDelivery; id: string } | null>(null);
  const requestController = useRef(new AbortController());
  useEffect(() => { requestController.current = new AbortController(); return () => requestController.current.abort(); }, [id, client]);
  const stream = useStream(client ? (signal) => client.api.watchThread({ threadId: id }, { signal }) : null,
    (update: ui.ThreadUpdate) => setSnapshot((s) => applyThread(s, update)), `${session?.deviceId}:${id}`);
  if (!ready) return <ActivityIndicator accessibilityLabel="Opening Canopy" />;
  if (!session) return <Redirect href="/pair" />;
  const thread = snapshot?.thread;
  const status = thread ? threadStatus(thread) : null;
  const interactions = snapshot?.interactions.filter((i) => i.status === 'pending') ?? [];
  const turns = snapshot?.turns.filter((t) => !t.withdrawn).slice() ?? [];
  // Provider-origin events can arrive before a turn update. Keep those entries visible.
  for (const item of snapshot?.items ?? []) {
    if (!turns.some((t) => t.id === item.turnId && t.fromThreadId === item.fromThreadId)) {
      turns.push(create(ui.TurnSchema, { id: item.turnId, fromThreadId: item.fromThreadId, inherited: item.inherited, trigger: 'provider' }));
    }
  }
  async function send(delivery: ui.MessageDelivery) {
    if (!client || !text.trim() || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    const value = text.trim();
    if (pending.current?.text !== value || pending.current.delivery !== delivery) pending.current = { text: value, delivery, id: Crypto.randomUUID() };
    try {
      const result = await client.api.sendMessage({ threadId: id, text: value, delivery, clientRequestId: pending.current.id }, { signal: requestController.current.signal, timeoutMs: 20_000 });
      if (result.turn) setSnapshot((s) => applyThread(s, create(ui.ThreadUpdateSchema, { change: { case: 'turn', value: result.turn! } })));
      if (result.steer) setSnapshot((s) => applyThread(s, create(ui.ThreadUpdateSchema, { change: { case: 'steer', value: result.steer! } })));
      setText(''); pending.current = null;
    } catch (e) {
      if (ConnectError.from(e).code === Code.Unauthenticated) await expired();
      else if (!requestController.current.signal.aborted) setError('Could not confirm delivery. Retry with the same text to send it only once.');
    } finally { sending.current = false; setBusy(false); }
  }
  const blocked = !online || !thread || Boolean(thread.archivedAt || thread.deletedAt) || thread.status === 'archived' || busy || stream.connection !== 'live';
  return <SafeAreaView edges={['bottom']} style={styles.fill}><Stack.Screen options={{ title: thread?.title || 'Thread' }} /><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0} style={styles.fill}>
    <FlatList ref={list} data={turns} keyExtractor={(turn) => `${turn.fromThreadId}:${turn.id}`} style={styles.fill} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled"
      onScroll={(e) => { const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent; setAtBottom(contentOffset.y + layoutMeasurement.height >= contentSize.height - 100); }} scrollEventThrottle={100}
      onContentSizeChange={() => { if (atBottom) list.current?.scrollToEnd({ animated: false }); }}
      ListHeaderComponent={<View style={{ gap: 16, marginBottom: 16 }}><Text style={[styles.meta, { color: c.muted }]}>{status?.label ?? 'Loading thread'}{thread?.model ? ` · ${thread.model}` : ''}</Text><ConnectionNotice {...stream} />{!snapshot && <ActivityIndicator accessibilityLabel="Loading conversation" color={c.accent} />}{snapshot && !turns.length && <Notice>This thread is ready for your first message.</Notice>}</View>}
      renderItem={({ item }) => <TimelineTurn turn={item} entries={snapshot?.items.filter((i) => i.turnId === item.id && i.fromThreadId === item.fromThreadId) ?? []} />}
      ListFooterComponent={<View style={{ gap: 12 }}>{snapshot?.steers.filter((s) => ['pending', 'accepted'].includes(s.status)).map((s) => <Notice key={s.id}>Sending to the current turn: {s.text}</Notice>)}{snapshot?.notices.slice(-3).map((n) => <Notice key={String(n.seq)}>{n.notice?.message}</Notice>)}{interactions.map((i) => <View key={i.requestId} style={{ padding: 16, gap: 8, borderRadius: 12, backgroundColor: c.inset }}><Text style={[styles.label, { color: c.warning }]}>Needs your input{i.toolName ? ` · ${i.toolName}` : ''}</Text><Text selectable style={[styles.body, { color: c.text }]}>{i.requestJson}</Text><Text style={[styles.meta, { color: c.muted }]}>Open this thread in Canopy on the web to respond.</Text></View>)}</View>} />
    {!atBottom && <View style={{ paddingHorizontal: 24, paddingBottom: 8 }}><Button title="Latest messages" secondary onPress={() => { list.current?.scrollToEnd({ animated: true }); setAtBottom(true); }} /></View>}
    <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: c.line, gap: 10, backgroundColor: c.background }}>
      {error ? <Notice error>{error}</Notice> : null}
      <TextInput accessibilityLabel="Message to your agent" value={text} onChangeText={setText} editable={!busy} multiline maxLength={32000} placeholder="Keep the conversation going…" placeholderTextColor={c.muted} style={[styles.input, { maxHeight: 150, color: c.text, borderColor: c.line, backgroundColor: c.surface, textAlignVertical: 'top' }]} />
      <View style={[styles.row, { justifyContent: 'flex-end' }]}>{thread?.status === 'running' && <Button title="Send now" secondary onPress={() => void send(ui.MessageDelivery.STEER)} disabled={blocked || !text.trim()} /> }<Button title={thread?.status === 'running' ? 'Queue message' : 'Send message'} onPress={() => void send(ui.MessageDelivery.QUEUE)} disabled={blocked || !text.trim()} busy={busy} /></View>
    </View>
  </KeyboardAvoidingView></SafeAreaView>;
}
