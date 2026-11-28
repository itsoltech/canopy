import { useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Reanimated from "react-native-reanimated";
import type { IconName } from "@canopy/ui/icons";
import { updateBadge, type UpdateStatus } from "@canopy/domain/release/update-status";
import { AnimatedNumber } from "../../ui/AnimatedNumber";
import { Badge } from "../../ui/Badge";
import { IconButton } from "../../ui/Button";
import { ProgressBar } from "../../ui/ProgressBar";
import { useMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";
import { CopyUpdateDetails } from "./UpdateDetails";

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

/** The action keeps its slot as status changes. Installer instructions wrap on narrow phones. */
export function UpdateRow({
  name,
  version,
  target,
  status,
  line,
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

  const installed = version || "Version unknown";
  const versions = target && target !== version ? `${installed} → ${target}` : installed;
  const percent = busy && progress !== undefined ? Math.max(0, Math.min(100, Math.round(progress))) : undefined;

  return (
    <View style={[{ paddingVertical: 10 }, style]}>
      <View style={[styles.row, { gap: 8 }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={[styles.row, { gap: 8 }]}>
            <Text numberOfLines={2} accessibilityLabel={name} style={[styles.overlay, { color: c.strong, flex: 1 }]}>
              {name}
            </Text>
            {/* Every shared word fits the slot, so state changes never move the name; a rare long edge word widens it. */}
            <View style={{ minWidth: 96, alignItems: "flex-end" }}>
              <UpdateBadge status={status} />
            </View>
          </View>
          <View style={styles.row}>
            <Text selectable style={[styles.overlayMeta, { flex: 1, color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {versions}
            </Text>
            {percent !== undefined && (
              <View aria-hidden style={{ alignItems: "flex-end", minWidth: 48 }}>
                <AnimatedNumber
                  value={`${percent}%`}
                  amount={percent}
                  animateOnMount={false}
                  style={[styles.overlayMeta, { color: c.muted }]}
                />
              </View>
            )}
          </View>
          {error ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityHint={expanded ? "Collapses the error" : "Shows the full error and its actions"}
              onPress={() => setExpanded((value) => !value)}
            >
              <Text
                numberOfLines={expanded ? undefined : 2}
                selectable={expanded}
                style={[styles.overlayMeta, { color: c.danger }]}
              >
                {error}
              </Text>
            </Pressable>
          ) : line ? (
            <Reanimated.View key={line} entering={m.swap.entering}>
              <Text style={[styles.overlayMeta, { color: c.muted }]}>{line}</Text>
            </Reanimated.View>
          ) : null}
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
      {percent !== undefined && (
        <Reanimated.View entering={m.rise.entering} style={{ position: "absolute", left: 0, right: 52, bottom: 3 }}>
          <ProgressBar
            done={BigInt(percent)}
            total={100n}
            label={`${name}: ${updateBadge(status).label}`}
            style={{ height: 2 }}
          />
        </Reanimated.View>
      )}
      {error && expanded && (
        <View style={{ gap: 6, paddingTop: 6 }}>
          <CopyUpdateDetails text={error} />
          {errorActions}
        </View>
      )}
    </View>
  );
}
