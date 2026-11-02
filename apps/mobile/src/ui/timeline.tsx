import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ItemStatus, type Item, ui } from '@open-agents/contracts';
import { Markdown } from './markdown';
import { styles, useColors } from './theme';

function workLabel(item: Item) {
  const content = item.content;
  switch (content.case) {
    case 'commandExecution': return content.value.command;
    case 'toolCall': return content.value.name;
    case 'reasoning': return 'Thinking';
    case 'fileChange': return `${content.value.changes.length} file changes`;
    case 'webSearch': return `Search: ${content.value.query}`;
    case 'backgroundTask': return 'Background task';
    case 'plan': return 'Plan';
    default: return content.case?.replace(/([A-Z])/g, ' $1') ?? 'Activity';
  }
}
function workDetail(item: Item) {
  const value = item.content.value;
  if (!value) return '';
  if ('output' in value) return String(value.output);
  if ('summary' in value && value.summary) return String(value.summary);
  if ('text' in value) return String(value.text);
  if ('changes' in value) return value.changes.map((c) => c.path).join('\n');
  return '';
}
function Work({ items }: { items: Item[] }) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const running = items.some((i) => i.status === ItemStatus.IN_PROGRESS);
  return <View style={{ gap: 12 }}><Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ paddingVertical: 12, minHeight: 44 }}><Text style={[styles.meta, { color: c.muted }]}>{expanded ? '⌄' : '›'} {running ? 'Working' : 'Work summary'} · {items.length} {items.length === 1 ? 'step' : 'steps'}</Text></Pressable>
    {expanded && items.map((item) => <View key={item.itemId} style={{ padding: 14, borderRadius: 10, gap: 8, backgroundColor: c.inset }}><Text selectable style={[styles.label, { color: item.status === ItemStatus.FAILED ? c.danger : c.muted }]}>{workLabel(item)}</Text>{workDetail(item) ? <Text selectable style={[styles.meta, { color: c.muted, fontFamily: 'monospace' }]}>{workDetail(item).slice(0, 12000)}{workDetail(item).length > 12000 ? '\n[Open Canopy on the web for the full output]' : ''}</Text> : null}</View>)}
  </View>;
}
export function TimelineTurn({ turn, entries }: { turn: ui.Turn; entries: ui.TimelineItem[] }) {
  const c = useColors();
  const items = entries.flatMap((e) => e.item ? [e.item] : []);
  const work = items.filter((i) => !['agentMessage', 'userMessage', 'interactionPrompt'].includes(i.content.case ?? ''));
  const message = turn.messageText || turn.inputText;
  return <View style={{ gap: 18, paddingBottom: 26 }}>
    {message ? <View style={{ padding: 16, borderRadius: 16, backgroundColor: c.softAccent, gap: 6 }}><Text style={[styles.meta, { color: c.muted }]}>{turn.trigger === 'user' ? 'You' : turn.trigger === 'agent_bus' ? 'Agent' : 'Canopy'}{turn.status === 'queued' ? ' · queued' : ''}{turn.inherited ? ' · inherited' : ''}</Text><Text selectable style={[styles.body, { color: c.text }]}>{message}</Text></View> : null}
    {items.map((item) => item.content.case === 'agentMessage' ? <View key={item.itemId} style={{ gap: 8 }}><Text style={[styles.meta, { color: c.muted }]}>Canopy{item.status === ItemStatus.IN_PROGRESS ? ' · writing' : ''}</Text><Markdown text={item.content.value.text} /></View> : item.content.case === 'userMessage' && item.content.value.text !== message ? <View key={item.itemId} style={{ padding: 16, borderRadius: 16, backgroundColor: c.softAccent }}><Text selectable style={[styles.body, { color: c.text }]}>{item.content.value.text}</Text></View> : null)}
    {work.length > 0 && <Work items={work} />}
    {turn.error ? <Text selectable accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{turn.error}</Text> : null}
    {turn.status === 'running' && !items.length ? <Text style={[styles.body, { color: c.muted }]}>Working…</Text> : null}
  </View>;
}
