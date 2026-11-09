import { useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import Animated from "react-native-reanimated";
import { palette } from "@canopy/ui";
import { router, useGlobalSearchParams } from "expo-router";
import { useOverview } from "../../state/overview";
import { useDevicePreferences } from "../settings/device-preferences";
import { font, styles, useColors } from "../../ui/theme";
import { usePaneInsets } from "../../ui/ScreenFrame";
import { useMotion } from "../../ui/motion";
import { needsYou } from "@canopy/domain/thread-activity";
import { sidebarChildren } from "@canopy/domain/sidebar-threads";
import { useSession } from "../../state/session";
import { useBotAlerts, type InAppAlert } from "./useBotAlerts";

/** Alert only for live changes after the initial snapshot, never replay historical results. */
export function InAppAlerts() {
  const { threads, loaded } = useOverview();
  const { active } = useSession();
  const { values } = useDevicePreferences();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const previous = useRef<Map<string, string> | null>(null);
  const [alert, setAlert] = useState<InAppAlert>();
  useBotAlerts(id, setAlert);
  const c = useColors();
  const insets = usePaneInsets();
  const { banner } = useMotion();

  useEffect(() => {
    if (!loaded || !active) {
      previous.current = null;

      return;
    }

    // A subagent's result belongs inside its parent. Questions routed to the user alert once on that parent.
    const notices = threads
      .filter((t) => !t.spawnedByAgent && !t.deletedAt && t.status !== "archived")
      .map((t) => {
        const { subagentsNeedingInput } = sidebarChildren(threads.filter((child) => child.parentThreadId === t.id));
        const needs = needsYou(t) || subagentsNeedingInput.length > 0;

        return {
          thread: t,
          status: needs ? "Needs input" : t.unseenResult,
          revision: `${t.status}:${t.unseenResult}:${needsYou(t) ? t.pendingInteractions : 0}:${subagentsNeedingInput
            .map((child) => child.id)
            .sort()
            .join(",")}`,
        };
      });

    const current = new Map(notices.map((notice) => [notice.thread.id, notice.revision]));

    const changed = notices.find(
      (notice) =>
        notice.thread.id !== id &&
        previous.current?.has(notice.thread.id) &&
        previous.current.get(notice.thread.id) !== notice.revision &&
        notice.status,
    );

    previous.current = current;

    if (changed && values.inAppNotifications === "on")
      setAlert({
        id: changed.thread.id,
        kind: "thread",
        title: changed.thread.title || "Untitled thread",
        status: changed.status,
      });
  }, [threads, loaded, id, active, values.inAppNotifications]);
  useEffect(() => {
    if (!active) setAlert(undefined);
  }, [active]);
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(undefined), 6000);

    return () => clearTimeout(timer);
  }, [alert]);

  if (!alert || !active || values.inAppNotifications !== "on") return null;

  // Web: Toaster. A dark pill under the top edge: what happened and one action. It comes down and leaves the same
  // way; a newer alert replaces it (web `t-toast`, from the top edge).
  return (
    <Animated.View
      key={`${alert.id}:${alert.status}`}
      entering={banner.entering}
      exiting={banner.exiting}
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
        accessibilityLabel={`${alert.title}, ${alert.status}. ${alert.kind === "bot" ? "Open chat" : "Open thread"}`}
        onPress={() => {
          router.push({ pathname: alert.kind === "bot" ? "/bot/[id]" : "/thread/[id]", params: { id: alert.id } });
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
    </Animated.View>
  );
}
