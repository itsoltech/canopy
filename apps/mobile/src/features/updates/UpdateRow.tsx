import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ReactNode } from "react";
import { updateCheckLabel } from "@canopy/domain/computer-presence";
import { isRateLimitMessage } from "@canopy/domain/release/http";
import { Badge } from "../../ui/Badge";
import { IconButton } from "../../ui/Button";
import { ProgressBar } from "../../ui/ProgressBar";
import { styles, useColors } from "../../ui/theme";
import { UpdateDetails } from "./UpdateDetails";

/** Compact overlay row: the action keeps its column, and long versions wrap below the name. */
export function UpdateRow({
  name,
  version,
  target,
  checkedAt,
  status,
  failed = false,
  busy = false,
  reason,
  notice,
  progress,
  action,
  children,
  style,
}: {
  name: string;
  version: string;
  target?: string | undefined;
  checkedAt?: number | undefined;
  status: string;
  failed?: boolean;
  busy?: boolean;
  reason?: string | undefined;
  notice?: string | undefined;
  progress?: number | undefined;
  action?: { label: string; disabled: boolean; run: () => void } | undefined;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  return (
    <View style={[{ gap: 6, paddingVertical: 10 }, style]}>
      <View style={[styles.row, { alignItems: "flex-start", gap: 8 }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text numberOfLines={1} accessibilityLabel={name} style={[styles.overlay, { color: c.strong }]}>
            {name}
          </Text>
          <Text selectable style={[styles.overlayMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
            {target && target !== version
              ? `${version || "Version unknown"} → ${target}`
              : version || "Version unknown"}
          </Text>
          {checkedAt !== undefined && (
            <Text style={[styles.overlayMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {updateCheckLabel(checkedAt)}
            </Text>
          )}
        </View>
        <Badge tone={failed ? "rose" : busy ? "amber" : status === "Up to date" ? "emerald" : "neutral"}>
          {status}
        </Badge>
        <View style={{ width: 40, alignItems: "flex-end" }}>
          {action && (
            <IconButton
              label={action.label}
              icon="arrow-up"
              size="sm"
              disabled={action.disabled}
              onPress={action.run}
            />
          )}
        </View>
      </View>
      {progress !== undefined && (
        <ProgressBar done={BigInt(Math.round(progress))} total={100n} label={`${name}: ${status}`} />
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
          {notice}
        </Text>
      )}
      {reason &&
        (isRateLimitMessage(reason) ? (
          <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
            {reason}
          </Text>
        ) : (
          <UpdateDetails text={reason} />
        ))}
      {children}
    </View>
  );
}
