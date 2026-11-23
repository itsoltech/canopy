import { useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { useColors, useTypography } from "../../ui/theme";
import { ResetSetting } from "./ResetSetting";
import { deviceChoices, deviceDefaults, useDevicePreferences } from "./device-preferences";
import { SettingsRow } from "./SettingsGroup";

const steps = deviceChoices.contrast;
const labels = { standard: "Standard", strong: "Strong", maximum: "Maximum" };
const inset = 10;

export function ContrastSetting() {
  const device = useDevicePreferences();
  const c = useColors();
  const type = useTypography();
  const [width, setWidth] = useState(0);

  const index = Math.max(
    0,
    steps.findIndex((value) => device.values.contrast === value),
  );

  const track = Math.max(0, width - 2 * inset);

  function select(position: number) {
    const value = steps[Math.max(0, Math.min(steps.length - 1, position))];

    if (device.loaded && value && value !== device.values.contrast) device.set("contrast", value);
  }

  function move(event: GestureResponderEvent) {
    if (track > 0) select(Math.round(((event.nativeEvent.locationX - inset) / track) * (steps.length - 1)));
  }

  return (
    <SettingsRow
      controlWidth={256}
      title="Contrast"
      description="Strengthen muted text and borders in both color schemes."
      accessory={
        <ResetSetting
          label="Reset contrast"
          changed={device.values.contrast !== deviceDefaults.contrast}
          disabled={!device.loaded}
          onReset={() => device.set("contrast", deviceDefaults.contrast)}
        />
      }
      control={
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Interface contrast"
          accessibilityValue={{ min: 0, max: steps.length - 1, now: index, text: labels[steps[index]!] }}
          accessibilityState={{ disabled: !device.loaded }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) => select(index + (event.nativeEvent.actionName === "increment" ? 1 : -1))}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => device.loaded}
          onResponderGrant={move}
          onResponderMove={move}
          style={{ minHeight: 44, justifyContent: "center", opacity: device.loaded ? 1 : 0.5 }}
        >
          <View pointerEvents="none" style={{ height: 20, marginHorizontal: inset, justifyContent: "center" }}>
            <View style={{ height: 4, backgroundColor: c.ring, borderRadius: 2 }}>
              <View
                style={{
                  height: 4,
                  width: (track * index) / (steps.length - 1),
                  backgroundColor: c.text,
                  borderRadius: 2,
                }}
              />
            </View>
            {steps.map((value, i) => (
              <View
                key={value}
                style={{
                  position: "absolute",
                  left: (track * i) / (steps.length - 1) - (i === index ? 8 : 2),
                  width: i === index ? 16 : 4,
                  height: i === index ? 16 : 4,
                  borderRadius: 8,
                  backgroundColor: i === index ? c.surface : c.muted,
                  borderWidth: i === index ? 1 : 0,
                  borderColor: c.text,
                }}
              />
            ))}
          </View>
          <View pointerEvents="none" style={{ flexDirection: "row", justifyContent: "space-between", gap: 2 }}>
            {steps.map((value, i) => (
              <Text key={value} style={[type.meta, { color: i === index ? c.text : c.muted, flexShrink: 1 }]}>
                {labels[value]}
              </Text>
            ))}
          </View>
        </View>
      }
    />
  );
}
