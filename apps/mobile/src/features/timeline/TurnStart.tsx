import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { silentTriggerLabel } from "@canopy/domain/turn-origin";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { useClock } from "../settings/display";

/**
 * Boundary before a turn (web: TurnStart): a pill with the day where a new day starts, a mark when it worked on a
 * goal and, for turns without an input (provider wake-up, recovery), what started it. The web shows the turn's
 * time on hover; a phone has no hover, so it stays hidden here too.
 */
export function TurnStart({ turn, newDay }: { turn: ui.Turn; newDay: boolean }) {
  const c = useColors();
  const sky = useTone("sky").text;
  const clock = useClock();
  const label = silentTriggerLabel(turn);
  const at = turn.startedAt ?? turn.queuedAt;

  // The web's row is 20 high even when empty (its time waits for hover): turns keep the same distance here.
  if (!(newDay && at) && !turn.goalId && !label) return <View style={{ height: 20 }} />;

  return (
    <View style={{ gap: 8, minHeight: 20 }}>
      {newDay && at && (
        <View style={{ alignItems: "center" }}>
          <Text
            style={[
              styles.meta,
              {
                fontFamily: font.medium,
                color: c.muted,
                paddingHorizontal: 10,
                paddingVertical: 2,
                borderRadius: 9999,
                overflow: "hidden",
                backgroundColor: c.dark ? "#ffffff14" : "#09090b0d",
              },
            ]}
          >
            {clock.day(new Date(Number(at.seconds) * 1000))}
          </Text>
        </View>
      )}
      {(turn.goalId || label) && (
        <View style={[styles.row, { gap: 12, minHeight: 20 }]}>
          {turn.goalId ? (
            <View style={[styles.row, { gap: 4 }]}>
              <Icon name="flag" size={14} color={sky} />
              <Text style={[styles.meta, { color: sky }]}>Goal</Text>
            </View>
          ) : null}
          {label ? (
            <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, color: c.muted }]}>
              {label}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
