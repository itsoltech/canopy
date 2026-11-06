import { useState, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { useEffect } from "react";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { settingsGroups, settingsSections, type SettingsSection } from "@canopy/ui/settings";
import { useLayout } from "../../state/layout";
import { useSession } from "../../state/session";
import { IconButton, Notice } from "../../ui/components";
import { SearchField } from "../../ui/SearchField";
import { SettingsDensity } from "../../ui/density";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function SettingsLayout({
  section,
  onSelect,
  children,
}: {
  section: string;
  onSelect: (section: string) => void;
  children: ReactNode;
}) {
  const c = useColors();
  const { wide } = useLayout();
  const { client } = useSession();
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const current = settingsSections.find((s) => s.href.endsWith(`/${section}`));

  useEffect(() => {
    let active = true;
    void client?.api
      .getClientCapabilities({})
      .then((r) => {
        if (active) setLinked(r.linkedComputers);
      })
      .catch(() => {
        if (active) setError("Could not check available settings. Reopen Settings to retry.");
      });

    return () => {
      active = false;
    };
  }, [client]);
  useEffect(() => {
    if (wide || !section) return;

    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      onSelect("");

      return true;
    });

    return () => listener.remove();
  }, [wide, section, onSelect]);

  const sections = settingsSections.filter(
    (s) =>
      (linked || s.href !== "/settings/computers") &&
      `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.background }]}>
      <View style={[styles.row, { minHeight: 48, paddingHorizontal: 4, borderBottomWidth: 1, borderColor: c.line }]}>
        {!wide && section && <IconButton icon="chevron-left" label="All settings" onPress={() => onSelect("")} />}
        <Text style={[styles.chrome, { color: c.muted, paddingLeft: wide || !section ? 16 : 0 }]}>Settings</Text>
        {current && (
          <Text numberOfLines={1} style={[styles.chrome, { flex: 1, color: c.text }]}>
            / {current.label}
          </Text>
        )}
        {!current && <View style={{ flex: 1 }} />}
        <IconButton
          icon="x-mark"
          label="Close Settings"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
      </View>
      <ConnectionBanner />
      <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
        {(wide || !section) && (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={{
              width: wide ? 216 : undefined,
              flex: wide ? undefined : 1,
              flexGrow: wide ? 0 : 1,
              borderRightWidth: wide ? 1 : 0,
              borderColor: c.line,
              backgroundColor: c.sidebar,
            }}
            contentContainerStyle={{ padding: 12, gap: 16 }}
          >
            <SearchField label="Search settings" placeholder="Search" value={query} onChange={setQuery} />
            {settingsGroups.map((group) => (
              <SettingsNavGroup
                key={group}
                group={group}
                sections={sections.filter((s) => s.group === group)}
                section={section}
                onSelect={onSelect}
              />
            ))}
            {!sections.length && <Text style={[styles.chrome, { color: c.muted }]}>No setting matches “{query}”.</Text>}
            {error && <Notice error>{error}</Notice>}
            <Text style={[styles.chromeMeta, { color: c.muted, paddingHorizontal: 10 }]}>Canopy {CANOPY_VERSION}</Text>
          </ScrollView>
        )}
        {(wide || section) && (
          <ScrollView
            key={section}
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1, minWidth: 0 }}
            contentContainerStyle={{ width: "100%", maxWidth: 1024, alignSelf: "center", padding: 20, gap: 24 }}
          >
            <SettingsDensity.Provider value={true}>
              {current ? children : <Text style={[styles.chrome, { color: c.muted }]}>Choose a section.</Text>}
            </SettingsDensity.Provider>
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

function SettingsNavGroup({
  group,
  sections,
  section,
  onSelect,
}: {
  group: string;
  sections: SettingsSection[];
  section: string;
  onSelect: (section: string) => void;
}) {
  const c = useColors();

  if (!sections.length) return null;

  return (
    <View style={{ gap: 2 }}>
      <Text
        accessibilityRole="header"
        style={[styles.chromeMeta, { paddingHorizontal: 10, paddingVertical: 4, color: c.muted }]}
      >
        {group}
      </Text>
      {sections.map((s) => {
        const key = s.href.split("/").pop()!;
        const active = section === key;

        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(key)}
            style={({ pressed }) => [
              styles.row,
              {
                minHeight: 44,
                paddingHorizontal: 10,
                borderRadius: 8,
                backgroundColor: active || pressed ? c.inset : "transparent",
              },
            ]}
          >
            <Icon name={s.icon} color={active ? c.text : c.muted} />
            <Text style={[styles.chrome, { color: active ? c.text : c.muted, flex: 1 }]}>{s.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
