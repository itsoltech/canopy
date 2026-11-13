import { Text, View } from "react-native";
import { Spinner } from "../../ui/Badge";
import { useColors, useTypography } from "../../ui/theme";
import type { StreamState } from "./ConnectionStatus";
import { Icon } from "../../ui/Icon";
import { useReducedMotion } from "../../ui/motion";
import { useLiveTime } from "../../ui/time";

export function ConnectionSpinner({ active }: { active: boolean }) {
  const c = useColors();
  const reduced = useReducedMotion();

  return (
    <View style={{ width: 14 }}>
      {active && (reduced ? <Icon name="arrow-path" size={14} color={c.muted} /> : <Spinner color={c.muted} />)}
    </View>
  );
}

/** The only changing retry text lives in a reserved line, outside the title and actions. */
export function ConnectionActivity({ stream, visible }: { stream: StreamState; visible: boolean }) {
  const c = useColors();
  const type = useTypography();
  const down = !["live", "paused", "offline", "error"].includes(stream.connection);
  const now = useLiveTime(visible && down && !!stream.retryAt);

  const seconds = Math.max(0, Math.ceil(((stream.retryAt ?? now) - now) / 1000));

  return (
    <View style={{ height: type.small.lineHeight, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <ConnectionSpinner active={visible && down && !!stream.retrying} />
      <Text style={[type.small, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
        {down ? (stream.retrying || !seconds ? "Retrying…" : `Retrying in ${seconds.toLocaleString()} s`) : ""}
      </Text>
    </View>
  );
}
