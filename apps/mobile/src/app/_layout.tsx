import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../state/session";
import { useColors } from "../ui/theme";
import { AppearanceProvider } from "../state/appearance";
import { OverviewProvider } from "../state/overview";
import { LayoutProvider, useLayout } from "../state/layout";
import { View } from "react-native";
import { AppSidebar } from "../features/navigation/AppSidebar";
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from "@expo-google-fonts/inter";

/** Wide windows keep the thread list beside the stack (collapsible); phones navigate list → thread. */
function Navigation() {
  const c = useColors();
  const { session } = useSession();
  const { sidebarOpen, sidebarWidth } = useLayout();

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.background }}>
      <StatusBar style={c.dark ? "light" : "dark"} />
      {session && sidebarOpen && (
        <View style={{ width: sidebarWidth, borderRightWidth: 1, borderRightColor: c.line }}>
          <AppSidebar />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Screens />
      </View>
    </View>
  );
}

function Screens() {
  const c = useColors();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        contentStyle: { backgroundColor: c.background },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Canopy" }} />
      <Stack.Screen name="pair" options={{ title: "Connect to Canopy", headerBackVisible: false }} />
      <Stack.Screen name="thread/[id]" options={{ title: "Thread", headerBackTitle: "Threads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
    </Stack>
  );
}

function SessionUI() {
  const { session } = useSession();

  return (
    <AppearanceProvider key={session?.deviceId ?? "unpaired"}>
      <OverviewProvider>
        <LayoutProvider>
          <Navigation />
        </LayoutProvider>
      </OverviewProvider>
    </AppearanceProvider>
  );
}

export default function Layout() {
  const [loaded, error] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <SessionUI />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
