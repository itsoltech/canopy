import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../state/session';
import { Button, Notice } from '../ui/components';
import { styles, useColors } from '../ui/theme';

export default function Settings() {
  const { session, client, forget } = useSession();
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!session) return <Redirect href="/pair" />;
  async function removeLocal() { try { await forget(); router.replace('/pair'); } catch { setError('Could not remove the pairing from secure storage. Try again.'); } }
  async function unpair() {
    setBusy(true); setError('');
    try { await client!.api.unpairMobileDevice({}, { timeoutMs: 10_000 }); await removeLocal(); }
    catch { setError('Could not revoke access on the gateway. Reconnect and retry, or revoke this phone in web Settings.'); }
    finally { setBusy(false); }
  }
  return <SafeAreaView edges={['bottom']} style={styles.fill}><ScrollView contentContainerStyle={styles.page}>
    <View style={{ gap: 8 }}><Text style={[styles.title, { color: c.text }]}>Your connection</Text><Text style={[styles.body, { color: c.muted }]}>Private by default. Connected through Tailscale.</Text></View>
    <View style={{ gap: 24, paddingVertical: 20 }}><View style={{ gap: 7 }}><Text style={[styles.meta, { color: c.muted }]}>Gateway</Text><Text selectable style={[styles.body, { color: c.text }]}>{session.gatewayUrl}</Text></View><View style={{ gap: 7 }}><Text style={[styles.meta, { color: c.muted }]}>Device name</Text><Text style={[styles.body, { color: c.text }]}>{session.deviceName}</Text></View><View style={{ gap: 7 }}><Text style={[styles.meta, { color: c.muted }]}>Appearance</Text><Text style={[styles.body, { color: c.text }]}>Follows your phone’s light or dark setting</Text></View></View>
    <Notice>To change gateway or device name, unpair and pair again. Device keys stay in your phone’s secure storage.</Notice>
    {error ? <Notice error>{error}</Notice> : null}
    <Button title="Unpair this phone" danger busy={busy} onPress={() => Alert.alert('Unpair this phone?', 'This revokes access on the gateway and removes the saved key.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Unpair', style: 'destructive', onPress: () => void unpair() }])} />
    {error ? <Button title="Forget pairing locally" secondary onPress={() => Alert.alert('Forget this pairing?', 'This removes the local key only. Revoke this phone in web Settings to end its gateway access.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Forget', style: 'destructive', onPress: () => void removeLocal() }])} /> : null}
    <Text style={[styles.meta, { color: c.muted, textAlign: 'center', marginTop: 16 }]}>Canopy · A quiet place for your agents</Text>
  </ScrollView></SafeAreaView>;
}
