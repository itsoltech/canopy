import { useRef } from "react";
import { router } from "expo-router";
import { FlatList, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../../ui/Icon";
import { KeyboardViewport } from "../../ui/KeyboardViewport";
import { ScreenFrame, useContentInsets, useContentPadding } from "../../ui/ScreenFrame";
import { SearchField } from "../../ui/SearchField";
import { EmptyState, ScreenHeader } from "../../ui/components";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { createSettingsViewState, useSettingsScrollPosition } from "../settings/SettingsScroll";
import notices from "./notices.generated.json";

const usePackageQuery = createSettingsViewState("");

type PackageNotice = (typeof notices)[number];

export function LicenseListScreen() {
  return (
    <ScreenFrame header={<ScreenHeader title="Open-source licenses" />}>
      <KeyboardViewport>
        <LicenseList />
      </KeyboardViewport>
    </ScreenFrame>
  );
}

export function LicenseList() {
  const [query, setQuery] = usePackageQuery();
  const list = useRef<FlatList<PackageNotice>>(null);

  const position = useSettingsScrollPosition("licenses", (offset) =>
    list.current?.scrollToOffset({ offset, animated: false }),
  );

  const padding = useContentPadding(20);
  const insets = useContentInsets();
  const terms = query.toLowerCase().match(/\S+/g) ?? [];

  const shown = terms.length
    ? notices.filter(({ name, version, license }) => {
        const searchable = `${name} ${version} ${license}`.toLowerCase();

        return terms.every((term) => searchable.includes(term));
      })
    : notices;

  return (
    <FlatList
      ref={list}
      {...position}
      data={shown}
      keyExtractor={({ name, version }) => JSON.stringify([name, version])}
      renderItem={({ item }) => <LicenseRow notice={item} />}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      scrollIndicatorInsets={insets}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.page, padding, { gap: 0 }]}
      ListHeaderComponentStyle={{ marginBottom: 12 }}
      ListHeaderComponent={<SearchField label="Search packages" value={query} onChange={setQuery} />}
      ListEmptyComponent={
        <EmptyState title={terms.length ? "No packages match your search" : "No licenses available"} />
      }
    />
  );
}

function LicenseRow({ notice: { name, version, license } }: { notice: PackageNotice }) {
  const c = useColors();
  const type = useTypography();

  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => {
        Keyboard.dismiss();
        router.push({ pathname: "/open-source-licenses/details", params: { name, version } });
      }}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: 48,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: c.line,
          backgroundColor: pressed ? c.inset : "transparent",
        },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={[type.chrome, { fontFamily: font.medium, color: c.text }]}>{name}</Text>
        <Text style={[type.meta, { color: c.muted }]}>{version ? `${version} · ${license}` : license}</Text>
      </View>
      <Icon name="chevron-right" color={c.icon} />
    </Pressable>
  );
}
