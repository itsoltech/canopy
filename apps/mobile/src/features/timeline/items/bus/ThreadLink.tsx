import { Pressable, Text } from "react-native";
import { statusLook } from "@canopy/domain/status-look";
import { StatusDot } from "../../../../ui/Badge";
import { font, styles } from "../../../../ui/theme";
import { useTone } from "../../../../ui/tone";
import { openThread, useTimelineDirectory } from "../../directory";

/** Violet pill to another thread with its live status (web: ThreadLink); opens that thread. */
export function ThreadLink({ threadId, fallback = "Thread" }: { threadId: string; fallback?: string }) {
  const directory = useTimelineDirectory();
  const thread = directory.thread(threadId);
  const look = thread ? statusLook(thread.status) : undefined;
  const violet = useTone("violet").badge;
  const title = thread?.title || fallback;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={look ? `${title} (${look.label})` : title}
      onPress={() => openThread(threadId)}
      hitSlop={8}
      style={({ pressed }) => [
        styles.row,
        {
          flexShrink: 1,
          minWidth: 0,
          gap: 6,
          paddingHorizontal: 8,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: violet.ring,
          backgroundColor: violet.background,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {look && <StatusDot tone={look.tone} />}
      <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, fontFamily: font.medium, color: violet.text }]}>
        {title}
      </Text>
    </Pressable>
  );
}
