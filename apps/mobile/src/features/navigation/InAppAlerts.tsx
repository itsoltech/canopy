import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { palette } from "@canopy/ui";
import { router, useGlobalSearchParams } from "expo-router";
import { useOverview } from "../../state/overview";
import { useDevicePreferences } from "../settings/device-preferences";
import { font, styles, useColors } from "../../ui/theme";
import { usePaneInsets } from "../../ui/ScreenFrame";

/** Alert only for live changes after the initial snapshot, never replay historical results. */
export function InAppAlerts() {
  const { threads, loaded } = useOverview();
  const { values } = useDevicePreferences();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const previous = useRef<Map<string, string> | null>(null);
  const [alert, setAlert] = useState<{ id: string; title: string; status: string }>();
  const c = useColors();
  const insets = usePaneInsets();

  useEffect(() => {
    if (!loaded) return;
    const current = new Map(threads.map((t) => [t.id, `${t.status}:${t.unseenResult}:${t.pendingInteractions}`]));

    const changed = threads.find(
      (t) =>
        t.id !== id &&
        previous.current?.has(t.id) &&
        previous.current.get(t.id) !== current.get(t.id) &&
        (t.unseenResult || t.pendingInteractions > 0),
    );

    previous.current = current;

    if (changed && values.inAppNotifications === "on")
      setAlert({
        id: changed.id,
        title: changed.title || "Untitled thread",
        status: changed.pendingInteractions ? "Needs input" : changed.unseenResult,
      });
  }, [threads, loaded, id, values.inAppNotifications]);
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(undefined), 6000);

    return () => clearTimeout(timer);
  }, [alert]);

  if (!alert || values.inAppNotifications !== "on") return null;

  // Web: Toaster. A dark pill under the top edge: what happened and one action.
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + 12,
        left: insets.left + 16,
        right: insets.right + 16,
        alignItems: "center",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${alert.title}, ${alert.status}. Open thread`}
        onPress={() => {
          router.push({ pathname: "/thread/[id]", params: { id: alert.id } });
          setAlert(undefined);
        }}
        style={({ pressed }) => [
          styles.row,
          {
            maxWidth: 480,
            minHeight: 44,
            paddingLeft: 14,
            paddingRight: 8,
            paddingVertical: 6,
            borderRadius: 22,
            backgroundColor: c.dark ? palette.zinc[800] : palette.zinc[950],
            borderWidth: c.dark ? 1 : 0,
            borderColor: "#ffffff1a",
            shadowColor: "#000000",
            shadowOpacity: c.dark ? 0 : 0.18,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
            elevation: 8,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, fontFamily: font.medium, color: "#ffffff" }]}>
          {alert.title} · {alert.status}
        </Text>
        <Text style={[styles.meta, { fontFamily: font.semibold, color: c.brandOnInk, paddingHorizontal: 6 }]}>
          Open
        </Text>
      </Pressable>
    </View>
  );
}
