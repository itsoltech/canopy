import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { palette } from "@canopy/ui";
import { subagentLook, subagentSummary, type Subagent } from "@canopy/domain/subagents";
import { firstLine } from "@canopy/domain/first-line";
import { StatusDot } from "../../../ui/Badge";
import { Icon } from "../../../ui/Icon";
import { ProviderIcon } from "../../../ui/ProviderIcon";
import { font, styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { TrayPanel } from "./ComposerTray";
import { TrayHeader, TrayIcon } from "./TrayHeader";
import { TraySheet } from "./TraySheet";

/**
 * The thread's working subagents in the tray (web: SubagentsPanel): one line that sums active work ("2 subagents
 * working · 1 needs you") with their providers, opening a sheet of subagents. Finished
 * subagents leave it; thread details keep the whole lineage. Opening is local to this panel.
 */
export function useSubagentsPanel(subagents: readonly Subagent[]) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const destination = useRef<string | undefined>(undefined);
  const summary = subagentSummary(subagents);
  const providers = [...new Set(subagents.map((s) => s.thread.provider))];

  if (!subagents.length && open) setOpen(false);

  // Keep the sheet mounted when the tray empties: a selected thread still opens after dismissal.
  return {
    panel: subagents.length > 0 && (
      <TrayPanel>
        <TrayHeader label={summary} opens="sheet" onPress={() => setOpen(true)}>
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
      </TrayPanel>
    ),
    sheet: (
      <TraySheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Subagents"
        onDismiss={() => {
          const id = destination.current;
          destination.current = undefined;

          if (id) router.push({ pathname: "/thread/[id]", params: { id } });
        }}
      >
        {subagents.map((subagent) => (
          <SubagentRow
            key={subagent.thread.id}
            subagent={subagent}
            onOpen={() => {
              destination.current = subagent.thread.id;
              setOpen(false);
            }}
          />
        ))}
      </TraySheet>
    ),
  };
}

/** One subagent (web: SubagentRow): its state, title and the start of its last message; a tap opens its thread. */
function SubagentRow({ subagent, onOpen }: { subagent: Subagent; onOpen: () => void }) {
  const c = useColors();
  const look = subagentLook(subagent.state);
  const tone = useTone(look.tone);
  const { thread } = subagent;
  const snippet = firstLine(thread.lastMessage).text;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${thread.title || "Subagent"}, ${look.label}`}
      onPress={onOpen}
      style={({ pressed }) => ({
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: 8,
        paddingVertical: 12,
        backgroundColor: pressed ? c.pressed : undefined,
      })}
    >
      <View style={styles.row}>
        <StatusDot tone={look.tone} active={look.active} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text numberOfLines={2} style={[styles.overlay, { color: c.text }]}>
            {thread.title || "Subagent"}
          </Text>
          <Text style={[styles.overlayMeta, { color: tone.text }]}>{look.label}</Text>
          <Text
            numberOfLines={2}
            style={[styles.overlayMeta, { color: c.muted }, !snippet && { fontFamily: font.regularItalic }]}
          >
            {snippet || (subagent.state === "working" ? "Working on it…" : "No message yet")}
          </Text>
        </View>
        <Icon name="chevron-right" size={12} color={c.faint} />
      </View>
    </Pressable>
  );
}
