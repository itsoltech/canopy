import { useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import { router, useGlobalSearchParams } from "expo-router";
import { useOverview } from "../../state/overview";
import { useDevicePreferences } from "../settings/device-preferences";
import { styles, useColors } from "../../ui/theme";

/** Alert only for live changes after the initial snapshot, never replay historical results. */
export function InAppAlerts() {
  const { threads, loaded } = useOverview();
  const { values } = useDevicePreferences();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const previous = useRef<Map<string, string> | null>(null);
  const [alert, setAlert] = useState<{ id: string; title: string; status: string }>();
  const c = useColors();

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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLiveRegion="polite"
      onPress={() => {
        router.push({ pathname: "/thread/[id]", params: { id: alert.id } });
        setAlert(undefined);
      }}
      style={{
        position: "absolute",
        top: 52,
        left: 16,
        right: 16,
        borderWidth: 1,
        borderColor: c.line,
        borderRadius: 12,
        padding: 16,
        backgroundColor: c.overlay,
        elevation: 8,
      }}
    >
      <Text style={[styles.body, { color: c.text }]} numberOfLines={2}>
        {alert.title} · {alert.status}
      </Text>
    </Pressable>
  );
}
