import { View } from "react-native";
import Svg, { Defs, Path, Pattern, Rect } from "react-native-svg";
import type { SummarySegment } from "@canopy/domain/usage-summary";
import { usageTone } from "@canopy/domain/sidebar-usage";
import { useColors } from "../../ui/theme";
import { usageColor } from "./usage-color";

/** A hatched track marks an uncapped plan. A dashed outline marks an absent reading. */
export function UsageSegmentTrack({ segment }: { segment: SummarySegment }) {
  const c = useColors();
  const track = { height: 6, borderRadius: 3, overflow: "hidden" as const };
  const left = segment.percentLeft;

  if (left !== undefined) {
    return (
      <View style={[track, { backgroundColor: c.ring }]}>
        <View style={[track, { width: `${left}%`, backgroundColor: usageColor(usageTone(100 - left), c) }]} />
      </View>
    );
  }

  if (!segment.noLimit)
    return <View style={[track, { borderWidth: 1, borderStyle: "dashed", borderColor: c.faint }]} />;

  return (
    <View style={[track, { backgroundColor: c.ring }]}>
      <Svg width="100%" height={6}>
        <Defs>
          <Pattern id="hatch" width={5} height={5} patternUnits="userSpaceOnUse">
            <Path d="M-1 1L1 -1 M0 5L5 0 M4 6L6 4" stroke={c.faint} strokeWidth={1} />
          </Pattern>
        </Defs>
        <Rect width="100%" height={6} fill="url(#hatch)" />
      </Svg>
    </View>
  );
}
