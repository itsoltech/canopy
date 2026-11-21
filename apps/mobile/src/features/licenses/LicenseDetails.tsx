import { useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { EmptyState, ScreenHeader } from "../../ui/components";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import notices from "./notices.generated.json";

export default function LicenseDetails() {
  const { name, version } = useLocalSearchParams<{ name?: string; version?: string }>();
  const notice = notices.find((item) => item.name === name && item.version === (version ?? ""));
  const c = useColors();
  const type = useTypography();

  return (
    <ScreenFrame header={<ScreenHeader title="License details" />}>
      <ScreenScroll space={20}>
        {notice ? (
          <>
            <View style={{ gap: 4 }}>
              <Text accessibilityRole="header" style={[styles.heading, { color: c.text }]}>
                {notice.name}
              </Text>
              <Text style={[type.small, { color: c.muted }]}>
                {notice.version ? `${notice.version} · ${notice.license}` : notice.license}
              </Text>
            </View>
            {notice.files.map((file, index) => (
              <View key={`${file.name}-${index}`} style={{ gap: 8 }}>
                <Text accessibilityRole="header" style={[type.chrome, { color: c.text, fontFamily: font.semibold }]}>
                  {file.name}
                </Text>
                <Text selectable style={[type.body, { color: c.text }]}>
                  {file.text}
                </Text>
              </View>
            ))}
            {!notice.files.length && <EmptyState title="License text unavailable" />}
          </>
        ) : (
          <EmptyState title="License unavailable" description="Go back and choose a license from the list." />
        )}
      </ScreenScroll>
    </ScreenFrame>
  );
}
