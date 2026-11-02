import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { styles, useColors } from './theme';
import type { Connection } from '../state/stream';

export function Button({ title, onPress, disabled, busy, secondary, danger }: { title: string; onPress: () => void; disabled?: boolean; busy?: boolean; secondary?: boolean; danger?: boolean }) {
  const c = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: disabled || busy ? 0.45 : pressed ? 0.75 : 1, backgroundColor: secondary || danger ? c.inset : c.accent })}>
    {busy && <ActivityIndicator color={secondary ? c.text : c.onAccent} />}
    <Text style={[styles.label, { color: danger ? c.danger : secondary ? c.text : c.onAccent }]}>{title}</Text>
  </Pressable>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColors();
  return <View style={{ gap: 8 }}><Text style={[styles.label, { color: c.text }]}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor={c.muted} {...props} style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.surface }, props.style]} /></View>;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const c = useColors();
  return <View accessibilityRole={error ? 'alert' : 'text'} accessibilityLiveRegion="polite" style={{ padding: 16, borderRadius: 12, backgroundColor: c.inset }}><Text style={[styles.body, { color: error ? c.danger : c.muted }]}>{children}</Text></View>;
}
export function ConnectionNotice({ connection, retry, issue }: { connection: Connection; retry: () => void; issue?: string }) {
  if (connection === 'live') return null;
  return <View style={{ gap: 10 }}><Notice error={connection === 'error'}>{issue || (connection === 'offline' ? 'You’re offline. Your conversation will reconnect when the network returns.' : connection === 'paused' ? 'Updates paused while Canopy is in the background.' : connection === 'reconnecting' ? 'Connection lost. Reconnecting automatically…' : 'Connecting to your Canopy…')}</Notice>{['reconnecting', 'error'].includes(connection) && <Button title="Reconnect now" secondary onPress={retry} />}</View>;
}
