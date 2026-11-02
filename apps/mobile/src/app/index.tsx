import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ui } from '@open-agents/contracts';
import { useSession } from '../state/session';
import { useStream } from '../state/stream';
import { Button, ConnectionNotice, Notice } from '../ui/components';
import { styles, useColors } from '../ui/theme';
import { threadStatus } from '../api/thread';

export default function Threads() {
  const c = useColors();
  const { session, client, ready } = useSession();
  const [threads, setThreads] = useState<ui.Thread[]>([]);
  const [projects, setProjects] = useState<ui.Project[]>([]);
  const [workers, setWorkers] = useState<ui.Worker[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const stream = useStream(client ? (signal) => client.api.watchOverview({ includeSnapshot: true }, { signal }) : null, (update: ui.OverviewUpdate) => {
    const change = update.change;
    if (change.case === 'mobileSnapshot') {
      setProjects(change.value.overview?.projects ?? []); setWorkers(change.value.overview?.workers ?? []);
      setThreads(change.value.threads); setLoaded(true);
    }
    if (change.case === 'thread') setThreads((rows) => [...rows.filter((r) => r.id !== change.value.id), change.value]);
    if (change.case === 'project') setProjects((rows) => [...rows.filter((r) => r.id !== change.value.id), change.value]);
    if (change.case === 'worker') setWorkers((rows) => [...rows.filter((r) => r.id !== change.value.id), change.value]);
    if (change.case === 'workerRemoved') setWorkers((rows) => rows.filter((r) => r.id !== change.value));
  }, session?.deviceId ?? '');
  if (!ready) return <ActivityIndicator accessibilityLabel="Opening Canopy" />;
  if (!session) return <Redirect href="/pair" />;
  const visible = threads.filter((t) => !t.archivedAt && !t.deletedAt && t.status !== 'archived');
  const attention = visible.filter((t) => threadStatus(t).tone === 'attention').length;
  const sorted = visible.filter((t) => filter !== 'attention' || threadStatus(t).tone === 'attention').sort((a, b) => {
    const at = a.lastActivityAt?.seconds ?? a.createdAt?.seconds ?? 0n;
    const bt = b.lastActivityAt?.seconds ?? b.createdAt?.seconds ?? 0n;
    return at === bt ? a.id.localeCompare(b.id) : at > bt ? -1 : 1;
  });
  return <SafeAreaView edges={['bottom']} style={styles.fill}><FlatList data={sorted} keyExtractor={(t) => t.id} contentContainerStyle={styles.page}
    ListHeaderComponent={<View style={{ gap: 20 }}>
      <View style={[styles.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}><View style={{ gap: 6, flex: 1 }}><Text style={[styles.title, { color: c.text }]}>Threads</Text><Text style={[styles.body, { color: c.muted }]}>{attention ? `${attention} need${attention === 1 ? 's' : ''} your attention` : 'A little closer to your work.'}</Text></View><Button title="Settings" secondary onPress={() => router.push('/settings')} /></View>
      <ConnectionNotice {...stream} />
      <View style={styles.row}>{(['all', 'attention'] as const).map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: value === filter }} onPress={() => setFilter(value)} style={{ minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: filter === value ? c.softAccent : 'transparent', borderRadius: 22 }}><Text style={[styles.label, { color: filter === value ? c.text : c.muted }]}>{value === 'all' ? 'All threads' : 'Needs input'}</Text></Pressable>)}</View>
    </View>}
    ListEmptyComponent={!loaded ? <ActivityIndicator accessibilityLabel="Loading threads" color={c.accent} /> : <Notice>{filter === 'attention' ? 'Nothing needs your attention right now.' : 'No threads yet. Start a conversation in Canopy on the web, and it will appear here.'}</Notice>}
    renderItem={({ item: thread }) => {
      const status = threadStatus(thread);
      const color = status.tone === 'active' ? c.accent : status.tone === 'attention' ? c.warning : c.muted;
      const worker = workers.find((w) => w.id === thread.workerId);
      return <Pressable accessibilityRole="button" accessibilityLabel={`${thread.title || 'Untitled thread'}, ${status.label}`} onPress={() => router.push({ pathname: '/thread/[id]', params: { id: thread.id } })} style={({ pressed }) => ([styles.divider, { paddingVertical: 20, gap: 8, borderBottomColor: c.line, opacity: pressed ? 0.65 : 1 }])}>
        <View style={[styles.row, { justifyContent: 'space-between' }]}><Text numberOfLines={2} style={[styles.heading, { color: c.text, flex: 1 }]}>{thread.title || 'Untitled thread'}</Text><Text style={{ color: c.muted, fontSize: 24 }}>›</Text></View>
        <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>{projects.find((p) => p.id === thread.projectId)?.name || 'No project'} · {worker?.name || (thread.runtime === 'gateway' ? 'Gateway' : 'Worker')}{worker && !worker.online ? ' · offline' : ''}</Text>
        <View style={styles.row}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} /><Text style={[styles.meta, { color }]}>{status.label}</Text>{thread.model ? <Text numberOfLines={1} style={[styles.meta, { color: c.muted, flex: 1 }]}>· {thread.model}</Text> : null}</View>
      </Pressable>;
    }} />
  </SafeAreaView>;
}
