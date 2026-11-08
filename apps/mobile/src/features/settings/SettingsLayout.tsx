import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useEffect } from "react";
import { router, useNavigation } from "expo-router";
import { ScreenFrame, usePaneInsets } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { KeyboardViewport } from "../../ui/KeyboardViewport";
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

const SIDEBAR_WIDTH = 256;

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
  const insets = usePaneInsets();
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

  const sections = settingsSections.filter(
    (s) =>
      (linked || s.href !== "/settings/computers") &&
      `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <ScreenFrame header={<SettingsHeader section={section} current={current} onSelect={onSelect} />}>
      <KeyboardViewport style={{ flexDirection: "row", minWidth: 0 }}>
        {(wide || !section) && (
          <ScreenScroll
            space={12}
            innerRight={wide}
            keyboardShouldPersistTaps="handled"
            style={{
              // The safe-area gutter extends the column; it must not consume the navigation width.
              width: wide ? SIDEBAR_WIDTH + insets.left : undefined,
              flex: wide ? undefined : 1,
              flexGrow: wide ? 0 : 1,
              borderRightWidth: wide ? 1 : 0,
              borderColor: c.line,
              backgroundColor: c.sidebar,
            }}
            contentContainerStyle={{ maxWidth: undefined, gap: 16 }}
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
          </ScreenScroll>
        )}
        {(wide || section) && (
          <ScreenScroll
            space={20}
            innerLeft={wide}
            key={section}
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1, minWidth: 0 }}
            contentContainerStyle={{ maxWidth: 1024, gap: 24 }}
          >
            <SettingsDensity.Provider value={true}>
              {current ? children : <Text style={[styles.chrome, { color: c.muted }]}>Choose a section.</Text>}
            </SettingsDensity.Provider>
          </ScreenScroll>
        )}
      </KeyboardViewport>
    </ScreenFrame>
  );
}

function SettingsHeader({
  section,
  current,
  onSelect,
}: {
  section: string;
  current: SettingsSection | undefined;
  onSelect: (section: string) => void;
}) {
  const c = useColors();
  const { wide } = useLayout();
  const settingsNavigation = useNavigation("/settings");

  return (
    <>
      <View
        style={[
          styles.row,
          {
            minHeight: 48,
            paddingHorizontal: wide ? 0 : 4,
            gap: wide ? 0 : 8,
            borderBottomWidth: 1,
            borderColor: c.line,
          },
        ]}
      >
        {!wide && section && <IconButton icon="chevron-left" label="All settings" onPress={() => onSelect("")} />}
        <Text
          numberOfLines={1}
          style={[
            styles.chrome,
            {
              color: c.muted,
              width: wide ? SIDEBAR_WIDTH : undefined,
              paddingLeft: wide ? 22 : !section ? 16 : 0,
            },
          ]}
        >
          Settings
        </Text>
        {current && (
          <Text numberOfLines={1} style={[styles.chrome, { flex: 1, color: c.text, paddingLeft: wide ? 20 : 0 }]}>
            / {current.label}
          </Text>
        )}
        {!current && <View style={{ flex: 1 }} />}
        <IconButton
          icon="x-mark"
          label="Close Settings"
          onPress={() => {
            const parent = settingsNavigation.getParent();

            if (parent?.canGoBack()) parent.goBack();
            else router.replace("/");
          }}
        />
      </View>
      <ConnectionBanner />
    </>
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
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={[styles.chrome, { color: active ? c.text : c.muted, flex: 1 }]}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
