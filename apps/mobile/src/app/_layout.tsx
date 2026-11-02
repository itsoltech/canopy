import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../state/session';
import { useColors } from '../ui/theme';

function Navigation() {
  const c = useColors();
  return <><StatusBar style="auto" /><Stack screenOptions={{ headerStyle: { backgroundColor: c.background }, headerTintColor: c.text, contentStyle: { backgroundColor: c.background }, headerShadowVisible: false }}>
    <Stack.Screen name="index" options={{ title: 'Canopy' }} />
    <Stack.Screen name="pair" options={{ title: 'Connect to Canopy', headerBackVisible: false }} />
    <Stack.Screen name="thread/[id]" options={{ title: 'Thread', headerBackTitle: 'Threads' }} />
    <Stack.Screen name="settings" options={{ title: 'Settings' }} />
  </Stack></>;
}
export default function Layout() { return <SafeAreaProvider><SessionProvider><Navigation /></SessionProvider></SafeAreaProvider>; }
