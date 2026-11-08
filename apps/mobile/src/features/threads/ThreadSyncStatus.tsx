import { Text } from "react-native";
import { styles, useColors } from "../../ui/theme";
import type { ThreadState } from "./ThreadScreen";

/** Connection status floats above the input, without an empty row in the conversation. */
export function ThreadSyncStatus({ state }: { state: ThreadState }) {
  const c = useColors();

  if (!state.snapshot || state.home.away || state.stream.connection === "live") return null;

  return (
    <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: c.muted, padding: 8 }]}>
      Syncing…
    </Text>
  );
}
