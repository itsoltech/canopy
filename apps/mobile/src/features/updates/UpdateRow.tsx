import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Reanimated from "react-native-reanimated";
import type { IconName } from "@canopy/ui/icons";
import { updateBadge, type UpdateStatus } from "@canopy/domain/release/update-status";
import { Badge } from "../../ui/Badge";
import { IconButton } from "../../ui/Button";
import { ProgressBar } from "../../ui/ProgressBar";
import { useMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";
import { UpdateDetails } from "./UpdateDetails";

/** One status word (web: UpdateBadge): settled is quiet text, attention gets a pill; a new word rises in. */
export function UpdateBadge({ status }: { status: UpdateStatus | string }) {
  const c = useColors();
  const m = useMotion();
  const badge = updateBadge(status);

  return (
    <Reanimated.View key={badge.label} entering={m.swap.entering}>
      {badge.tone === "quiet" ? (
        <Text numberOfLines={1} style={[styles.workMeta, { color: c.muted }]}>
          {badge.label}
        </Text>
      ) : (
        <Badge tone={badge.tone}>{badge.label}</Badge>
      )}
    </Reanimated.View>
  );
}

export interface UpdateRowAction {
  icon: IconName;
  label: string;
  disabled: boolean;
  busy?: boolean;
  run: () => void;
}

/**
 * One update row (web: UpdateItem): always two lines. A state change swaps the badge and the second line; the bar
 * sits in the bottom padding and the action keeps its slot, so nothing moves. Only an error expands, on request.
 */
export function UpdateRow({
  name,
  version,
  target,
  status,
  line,
  lineTone,
  error,
  busy = false,
  progress,
  action,
  errorActions,
  style,
}: {
  name: string;
  version: string;
  target?: string | undefined;
  status: UpdateStatus | string;
  line?: string | undefined;
  lineTone?: "amber" | undefined;
  error?: string | undefined;
  busy?: boolean;
  progress?: number | undefined;
  action?: UpdateRowAction | undefined;
  errorActions?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const m = useMotion();
  const [expanded, setExpanded] = useState(false);

  const second =
    line ||
    (target && target !== version ? `${version || "Version unknown"} → ${target}` : version || "Version unknown");

  return (
    <View style={[{ paddingVertical: 10 }, style]}>
      <View style={[styles.row, { gap: 8 }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={[styles.row, { gap: 8 }]}>
            <Text numberOfLines={1} accessibilityLabel={name} style={[styles.overlay, { color: c.strong, flex: 1 }]}>
              {name}
            </Text>
            {/* Every shared word fits the slot, so state changes never move the name; a rare long edge word widens it. */}
            <View style={{ minWidth: 96, alignItems: "flex-end" }}>
              <UpdateBadge status={status} />
            </View>
          </View>
          {error ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityHint="Shows the full error"
              onPress={() => setExpanded((value) => !value)}
            >
              <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.danger }]}>
                {error}
              </Text>
            </Pressable>
          ) : (
            <Reanimated.View key={second} entering={m.swap.entering}>
              <Text
                numberOfLines={1}
                selectable={!line}
                style={[
                  styles.overlayMeta,
                  { color: lineTone === "amber" ? c.warning : c.muted, fontVariant: ["tabular-nums"] },
                ]}
              >
                {second}
              </Text>
            </Reanimated.View>
          )}
        </View>
        <View style={{ width: 44, alignItems: "flex-end" }}>
          {action && (
            <IconButton
              icon={action.icon}
              label={action.label}
              size="sm"
              disabled={action.disabled}
              busy={action.busy}
              onPress={action.run}
            />
          )}
        </View>
      </View>
      {busy && progress !== undefined && (
        <Reanimated.View entering={m.rise.entering} style={{ position: "absolute", left: 0, right: 52, bottom: 3 }}>
          <ProgressBar
            done={BigInt(Math.round(progress))}
            total={100n}
            label={`${name}: ${updateBadge(status).label}`}
            style={{ height: 2 }}
          />
        </Reanimated.View>
      )}
      {error && expanded && (
        <View style={{ gap: 6, paddingTop: 6 }}>
          <UpdateDetails text={error} />
          {errorActions}
        </View>
      )}
    </View>
  );
}
