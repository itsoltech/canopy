import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useDevicePreferences } from "../../features/settings/device-preferences";
import { useColors, useTypography } from "../theme";

/**
 * A wide block in a message (code, display math): long lines scroll sideways inside it, never widening the
 * message. The scroller must not grow (React Native's default `flexGrow: 1`): in a fit-content parent, such as a
 * chat bubble, iOS then gives it a runaway height and the block shows as a tall empty box.
 */
export function SidewaysScroll({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  if (wrap) return <View style={{ padding: 12 }}>{children}</View>;

  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 12 }}>
      {children}
    </ScrollView>
  );
}

/**
 * A fenced code block of markdown (web: CodeFence, CodeFrame): a faint wash with a ring, the language above a
 * divider, then the code in the reader's monospace. Lines scroll sideways unless Wrap code is on.
 */
export function CodeFence({ code, lang }: { code: string; lang: string | undefined }) {
  const c = useColors();
  const type = useTypography();
  const { values } = useDevicePreferences();

  return (
    <View
      accessibilityLabel={lang ? `Code, ${lang}` : "Code"}
      style={{ overflow: "hidden", borderRadius: 8, borderWidth: 1, borderColor: c.rule, backgroundColor: c.well }}
    >
      {lang ? (
        <View style={{ borderBottomWidth: 1, borderColor: c.rule, paddingHorizontal: 12, paddingVertical: 4 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: type.mono.fontFamily, fontSize: 12, lineHeight: 20, color: c.muted }}
          >
            {lang}
          </Text>
        </View>
      ) : null}
      <SidewaysScroll wrap={values.wrapCode === "on"}>
        {/* An empty block keeps one line, so it reads as a code block rather than a stray box. */}
        <Text selectable style={[type.mono, { color: c.text }]}>
          {code || " "}
        </Text>
      </SidewaysScroll>
    </View>
  );
}
