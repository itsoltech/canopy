import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useDevicePreferences } from "../../features/settings/device-preferences";
import { useColors, useTypography } from "../theme";
import { INLINE_PREVIEW } from "../../features/viewers/TextViewer";
import { TextViewerButton } from "../../features/viewers/TextViewerButton";
import { CopyAction } from "../../features/viewers/copy-action";

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
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 36,
          borderBottomWidth: 1,
          borderColor: c.rule,
          paddingHorizontal: 12,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: type.mono.fontFamily,
            fontSize: 12,
            lineHeight: 20,
            color: c.muted,
          }}
        >
          {lang || "Code"}
        </Text>
        <CopyAction text={code} label="Copy code" />
      </View>
      <SidewaysScroll wrap={values.wrapCode === "on"}>
        {/* An empty block keeps one line, so it reads as a code block rather than a stray box. */}
        <Text selectable style={[type.mono, { color: c.text }]}>
          {code.slice(0, INLINE_PREVIEW) || " "}
        </Text>
      </SidewaysScroll>
      {code.length > INLINE_PREVIEW ? <TextViewerButton text={code} label={lang ? `Code, ${lang}` : "Code"} /> : null}
    </View>
  );
}
