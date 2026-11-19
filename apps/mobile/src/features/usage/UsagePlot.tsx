import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path } from "react-native-svg";
import { axisLabel, plotUsage, pointX } from "@canopy/domain/usage-chart";
import { dayLabel, type UsageDay, type UsageRow, type UsageView } from "@canopy/domain/usage-report";
import { usageSeriesColor } from "@canopy/ui/provider-icons";
import { useColors, useTypography } from "../../ui/theme";

export function UsagePlot({
  days,
  providers,
  view,
  index,
  onSelect,
}: {
  days: UsageDay[];
  providers: UsageRow[];
  view: UsageView;
  index: number;
  onSelect: (dayIndex: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const c = useColors();
  const type = useTypography();

  const plot = useMemo(
    () => (width > 0 ? plotUsage(days, providers, view, width) : undefined),
    [days, providers, view, width],
  );

  const first = days[0];
  const last = days.at(-1);
  const x = pointX(index, days.length, width);
  const tickStyle = [type.meta, { color: c.muted }] as const;

  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <View style={{ height: 200, justifyContent: "space-between", alignItems: "flex-end" }}>
        {plot &&
          [plot.maximum, plot.maximum / 2, 0].map((value) => (
            <Text key={value} style={tickStyle}>
              {axisLabel(value, view)}
            </Text>
          ))}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Pressable
          accessible={false}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          onPress={(event) => {
            if (!width) return;
            const dayIndex = Math.floor((event.nativeEvent.locationX / width) * days.length);

            onSelect(Math.max(0, Math.min(days.length - 1, dayIndex)));
          }}
          style={{ height: 200 }}
        >
          {plot && (
            <Svg width="100%" height={200} pointerEvents="none">
              {[4, 100, 196].map((y) => (
                <Line
                  key={y}
                  x1={0}
                  x2={width}
                  y1={y}
                  y2={y}
                  stroke={c.line}
                  strokeDasharray={y === 196 ? undefined : "3 4"}
                />
              ))}
              <Line x1={x} x2={x} y1={0} y2={200} stroke={c.faint} strokeDasharray="3 4" />
              {plot.series.map((series) => {
                const color = usageSeriesColor(series.key, c.dark ? "dark" : "light");
                const selected = series.points[index];

                return (
                  <G key={series.key}>
                    {series.paths.map((path) => (
                      <G key={path.line}>
                        {path.area !== "" && <Path d={path.area} fill={color} fillOpacity={0.08} />}
                        <Path
                          d={path.line}
                          fill="none"
                          stroke={color}
                          strokeWidth={path.single ? 5 : 2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </G>
                    ))}
                    {selected && (
                      <Circle cx={selected.x} cy={selected.y} r={3} fill={c.surface} stroke={color} strokeWidth={2} />
                    )}
                  </G>
                );
              })}
            </Svg>
          )}
        </Pressable>
        <View style={{ flexDirection: "row", justifyContent: days.length === 1 ? "center" : "space-between" }}>
          {first && <Text style={tickStyle}>{dayLabel(first.key)}</Text>}
          {last && days.length > 1 && <Text style={tickStyle}>{dayLabel(last.key)}</Text>}
        </View>
      </View>
    </View>
  );
}
