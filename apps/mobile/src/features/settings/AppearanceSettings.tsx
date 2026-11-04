import { Pressable, Text, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { ui } from "@canopy/contracts";
import { accents, palette } from "@canopy/ui";
import { useAppearance } from "../../state/appearance";
import { Segmented } from "../../ui/components";
import { colorsFor, styles, useColors } from "../../ui/theme";

function SchemePreview({ mode }: { mode: "light" | "dark" | "system" }) {
  const c = colorsFor(mode === "dark");

  return (
    <View
      style={{
        aspectRatio: 16 / 9,
        borderRadius: 8,
        overflow: "hidden",
        flexDirection: "row",
        backgroundColor: c.background,
        borderWidth: 1,
        borderColor: c.line,
      }}
    >
      <View style={{ width: "28%", padding: 4, gap: 4, backgroundColor: c.sidebar }}>
        {[1, 2, 3].map((i) => (
          <View key={i} style={{ height: 3, backgroundColor: c.line, borderRadius: 2 }} />
        ))}
      </View>
      <View style={{ flex: 1, padding: 6, gap: 5 }}>
        <View
          style={{
            height: 5,
            width: "70%",
            borderRadius: 2,
            backgroundColor: c.line,
          }}
        />
        <View style={{ height: 3, backgroundColor: c.line }} />
        <View style={{ height: 3, width: "75%", backgroundColor: c.line }} />
        <View style={{ flex: 1 }} />
        <View
          style={{
            height: 8,
            borderRadius: 3,
            borderWidth: 1,
            borderColor: c.line,
          }}
        />
      </View>
      {mode === "system" && (
        <View
          style={{
            position: "absolute",
            left: "50%",
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: "#09090b",
          }}
        >
          <View
            style={{
              margin: 6,
              marginTop: 12,
              height: 3,
              backgroundColor: "#ffffff33",
            }}
          />
          <View
            style={{
              marginHorizontal: 6,
              marginTop: 5,
              height: 3,
              backgroundColor: "#ffffff33",
            }}
          />
        </View>
      )}
    </View>
  );
}

function Orb({ color, dark, id }: { color: typeof palette.blue; dark: boolean; id: string }) {
  return (
    <Svg width={48} height={48} viewBox="0 0 48 48">
      <Defs>
        <RadialGradient id={id} cx="35%" cy="30%" r="75%">
          <Stop offset="0" stopColor={dark ? color[400] : "#ffffff"} />
          <Stop offset="0.6" stopColor={dark ? color[900] : color[100]} />
          <Stop offset="1" stopColor={dark ? "#000000" : color[300]} />
        </RadialGradient>
      </Defs>
      <Circle cx={24} cy={24} r={23} fill={`url(#${id})`} stroke="#71717a33" />
    </Svg>
  );
}

export function AppearanceSettings() {
  const c = useColors();
  const settings = useAppearance();
  const scheme = settings.appearance?.colorScheme ?? ui.ColorScheme.SYSTEM;
  const selected = scheme || ui.ColorScheme.SYSTEM;

  return (
    <View style={{ gap: 24 }}>
      <View style={{ gap: 12 }}>
        <Text style={[styles.meta, { color: c.text, fontFamily: "Inter_500Medium" }]}>Color scheme</Text>
        <View style={[styles.row, { alignItems: "stretch" }]}>
          {(
            [
              { value: ui.ColorScheme.SYSTEM, label: "System", mode: "system" },
              { value: ui.ColorScheme.LIGHT, label: "Light", mode: "light" },
              { value: ui.ColorScheme.DARK, label: "Dark", mode: "dark" },
            ] as const
          ).map((s) => (
            <Pressable
              key={s.value}
              accessibilityRole="radio"
              accessibilityLabel={s.label}
              accessibilityState={{
                checked: selected === s.value,
                disabled: settings.saving,
              }}
              disabled={settings.saving}
              onPress={() => void settings.updateAppearance({ colorScheme: s.value })}
              style={{
                flex: 1,
                gap: 8,
                padding: 8,
                borderRadius: 16,
                borderWidth: selected === s.value ? 2 : 1,
                borderColor: selected === s.value ? c.accent : c.line,
              }}
            >
              <SchemePreview mode={s.mode} />
              <Text style={[styles.meta, { textAlign: "center", color: c.text }]}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={{ gap: 12 }}>
        <View style={{ gap: 4 }}>
          <Text style={[styles.meta, { color: c.text, fontFamily: "Inter_500Medium" }]}>Themes</Text>
          <Text style={[styles.body, { color: c.muted }]}>The accent of buttons, focus rings and the send button.</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {accents.map((a, i) => (
            <Pressable
              key={a.name}
              accessibilityRole="radio"
              accessibilityLabel={a.label}
              accessibilityState={{
                checked: settings.accent === a.name,
                disabled: settings.saving,
              }}
              disabled={settings.saving}
              onPress={() => void settings.updateAppearance({ accent: i + 1 })}
              style={{
                width: "48%",
                flexGrow: 1,
                gap: 8,
                borderRadius: 16,
                padding: 16,
                borderWidth: settings.accent === a.name ? 2 : 1,
                borderColor: settings.accent === a.name ? c.accent : c.line,
              }}
            >
              <View style={[styles.row, { justifyContent: "center", gap: 12, paddingVertical: 8 }]}>
                <Orb id={`${a.name}-light`} color={palette[a.palette]} dark={false} />
                <Orb id={`${a.name}-dark`} color={palette[a.palette]} dark />
              </View>
              <Text style={[styles.label, { color: c.text }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={{ gap: 16 }}>
        <Text style={[styles.heading, { color: c.text }]}>Interface</Text>
        <View style={{ gap: 4 }}>
          <Text style={[styles.label, { color: c.text }]}>Time zone</Text>
          <Text style={[styles.body, { color: c.muted }]}>Bots use it for local times and scheduled tasks.</Text>
          <Text style={[styles.body, { color: c.text }]}>{settings.user?.timezone || "UTC"}</Text>
        </View>
        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.text }]}>Chat width</Text>
          <Text style={[styles.body, { color: c.muted }]}>How wide the conversation and the message box are.</Text>
          <Segmented
            value={String(settings.appearance?.chatWidth || ui.ChatWidth.COMFORTABLE)}
            options={[
              { value: "1", label: "Comfortable" },
              { value: "2", label: "Wide" },
              { value: "3", label: "Full width" },
            ]}
            onChange={(v) => void settings.updateAppearance({ chatWidth: Number(v) })}
          />
        </View>
      </View>
    </View>
  );
}
