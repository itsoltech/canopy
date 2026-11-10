import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { palette } from "@canopy/ui";
import { subagentLook, subagentSummary, type Subagent } from "@canopy/domain/subagents";
import { firstLine } from "@canopy/domain/first-line";
import { StatusDot } from "../../../ui/Badge";
import { Icon } from "../../../ui/Icon";
import { Expand } from "../../../ui/MotionViews";
import { ProviderIcon } from "../../../ui/ProviderIcon";
import { font, styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { useDevicePreferences } from "../../settings/device-preferences";
import { TrayPanel } from "./ComposerTray";
import { TrayHeader, TrayIcon } from "./TrayHeader";

/**
 * The thread's working subagents in the tray (web: SubagentsPanel): one line that sums active work ("2 subagents
 * working · 1 needs you") with their providers, unfolding into a row per subagent that opens its thread. Finished
 * subagents leave it; thread details keep the whole lineage. The open state is this phone's preference.
 */
export function SubagentsPanel({ subagents, compact }: { subagents: readonly Subagent[]; compact: boolean }) {
  const c = useColors();
  const device = useDevicePreferences();
  const open = device.values.subagentsExpanded === "on";
  const expanded = open && !compact;
  const summary = subagentSummary(subagents);
  const providers = [...new Set(subagents.map((s) => s.thread.provider))];

  if (!subagents.length) return null;

  return (
    <TrayPanel>
      <TrayHeader
        label={summary}
        expanded={expanded}
        onPress={() => device.set("subagentsExpanded", expanded ? "off" : "on")}
      >
        <TrayIcon name="sparkles" color={c.dark ? palette.violet[400] : palette.violet[500]} />
        <Text
          numberOfLines={1}
          accessibilityLiveRegion="polite"
          style={[styles.meta, { flex: 1, minWidth: 0, color: c.soft, fontVariant: ["tabular-nums"] }]}
        >
          {summary}
        </Text>
        <View style={[styles.row, { gap: 4, opacity: 0.7 }]} accessibilityElementsHidden>
          {providers.map((provider) => (
            <ProviderIcon key={provider} provider={provider} />
          ))}
        </View>
      </TrayHeader>
      <Expand open={expanded}>
        <View style={{ paddingVertical: 4 }}>
          {subagents.map((subagent) => (
            <SubagentRow key={subagent.thread.id} subagent={subagent} />
          ))}
        </View>
      </Expand>
    </TrayPanel>
  );
}

/** One subagent (web: SubagentRow): its state, title and the start of its last message; a tap opens its thread. */
function SubagentRow({ subagent }: { subagent: Subagent }) {
  const c = useColors();
  const look = subagentLook(subagent.state);
  const tone = useTone(look.tone);
  const { thread } = subagent;
  const snippet = firstLine(thread.lastMessage).text;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${thread.title || "Subagent"}, ${look.label}`}
      onPress={() => router.push({ pathname: "/thread/[id]", params: { id: thread.id } })}
      style={({ pressed }) => ({
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: pressed ? c.pressed : undefined,
      })}
    >
      <View style={styles.row}>
        <StatusDot tone={look.tone} active={look.active} />
        <Text numberOfLines={1} style={[styles.meta, { flex: 1, minWidth: 0, color: c.text }]}>
          {thread.title || "Subagent"}
        </Text>
        <Text numberOfLines={1} style={[styles.overlayMeta, { flexShrink: 0, color: tone.text }]}>
          {look.label}
        </Text>
        <Icon name="chevron-right" size={12} color={c.faint} />
      </View>
      <Text
        numberOfLines={1}
        style={[
          styles.overlayMeta,
          { paddingLeft: 14, color: c.muted, lineHeight: 18 },
          !snippet && { fontFamily: font.regularItalic },
        ]}
      >
        {snippet || (subagent.state === "working" ? "Working on it…" : "No message yet")}
      </Text>
    </Pressable>
  );
}
