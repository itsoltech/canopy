import { useState, type ReactNode } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useLayout } from "../../state/layout";
import { IconButton, Sheet } from "../../ui/components";
import { StatusDot } from "../../ui/Badge";
import { Icon } from "../../ui/Icon";
import { KeyboardViewport } from "../../ui/KeyboardViewport";
import { ContentInsets, PaneInsets, ScreenFrame, usePaneInsets } from "../../ui/ScreenFrame";
import { styles, useColors, useTypography } from "../../ui/theme";
import { ConnectionBanner } from "../navigation/ConnectionStatus";
import { SettingsCatalog, useSettingsCatalog } from "./section-catalog";
import { SettingsNavigation, useWorkerUpdateHint } from "./SettingsNavigation";
import { SettingsSearch } from "./SettingsSearch";
import { SettingsOffsets } from "./SettingsScroll";
import { habitSuggestionLabel, usePendingHabitReviews } from "./memory-habits";

const SIDEBAR_WIDTH = 256;

/** The native stack changes only the panel; both navigation surfaces belong to the Settings window. */
export function SettingsLayout({
  selected,
  scoped,
  close,
  children,
}: {
  selected: string | undefined;
  scoped: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  const { wide } = useLayout();
  const insets = usePaneInsets();
  const catalog = useSettingsCatalog();
  const [offsets] = useState(() => new Map<string, number>());
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const section = selected || "general";
  const current = catalog.sections.find((entry) => entry.href === `/settings/${section}`);
  const updates = useWorkerUpdateHint() && catalog.available.some((entry) => entry.href === "/settings/workers");
  const pendingHabits = usePendingHabitReviews();
  const memoryAvailable = catalog.available.some((entry) => entry.href === "/settings/memory");

  if (wide && menu) setMenu(false);

  function select(next: string) {
    Keyboard.dismiss();
    setMenu(false);

    if (next === section && !scoped) return;

    if (next === "general") {
      router.dismissTo("/settings");

      return;
    }

    const href = { pathname: "/settings/[section]" as const, params: { section: next } };

    if (selected) router.replace(href);
    else router.push(href);
  }

  const nav = (
    <SettingsNavigation
      section={section}
      onSelect={select}
      query={query}
      onQuery={setQuery}
      compact={!wide}
      updates={updates}
      pendingHabits={pendingHabits}
    />
  );

  return (
    <SettingsOffsets.Provider value={offsets}>
      <SettingsCatalog.Provider value={catalog}>
        <View style={{ flex: 1, flexDirection: "row" }}>
          {wide && (
            <PaneInsets.Provider value={{ left: insets.left, right: 0 }}>
              <View
                style={{
                  width: SIDEBAR_WIDTH + insets.left,
                  paddingTop: insets.top,
                  backgroundColor: c.sidebar,
                  borderRightWidth: 1,
                  borderColor: c.line,
                }}
              >
                <ContentInsets.Provider value={{ ...insets, top: 0, right: 0 }}>
                  <KeyboardViewport>{nav}</KeyboardViewport>
                </ContentInsets.Provider>
              </View>
            </PaneInsets.Provider>
          )}
          <PaneInsets.Provider value={{ left: wide ? 0 : insets.left, right: insets.right }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ScreenFrame
                header={
                  <SettingsHeader
                    wide={wide}
                    label={current?.label ?? "Settings"}
                    updates={updates}
                    pendingHabits={section !== "memory" && memoryAvailable ? pendingHabits : 0}
                    menu={menu}
                    openMenu={() => setMenu(true)}
                    general={section === "general"}
                    openGeneral={() => select("general")}
                    close={close}
                  />
                }
              >
                <KeyboardViewport>
                  <SettingsSearch query={wide ? query : ""}>{children}</SettingsSearch>
                </KeyboardViewport>
              </ScreenFrame>
            </View>
          </PaneInsets.Provider>
        </View>
        {!wide && (
          <Sheet title="Settings sections" compact visible={menu} scroll={false} onClose={() => setMenu(false)}>
            {nav}
          </Sheet>
        )}
      </SettingsCatalog.Provider>
    </SettingsOffsets.Provider>
  );
}

function SettingsHeader({
  wide,
  label,
  updates,
  pendingHabits,
  menu,
  openMenu,
  general,
  openGeneral,
  close,
}: {
  wide: boolean;
  label: string;
  updates: boolean;
  pendingHabits: number;
  menu: boolean;
  openMenu: () => void;
  general: boolean;
  openGeneral: () => void;
  close: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  const hint = [
    "Choose a section.",
    updates && "Worker updates available.",
    pendingHabits > 0 && `${habitSuggestionLabel(pendingHabits)} to review.`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <View style={[styles.row, { minHeight: 48, paddingHorizontal: 8, borderBottomWidth: 1, borderColor: c.line }]}>
        {wide ? (
          <View style={[styles.row, { flex: 1, paddingHorizontal: 8 }]}>
            <Pressable
              accessibilityRole="link"
              disabled={general}
              accessibilityState={{ disabled: general }}
              onPress={openGeneral}
              style={{ justifyContent: "center", minHeight: 44 }}
            >
              <Text style={[type.chrome, { color: c.muted }]}>Settings</Text>
            </Pressable>
            <Icon name="chevron-right" size={14} color={c.faint} />
            <Text accessibilityRole="header" numberOfLines={1} style={[type.chrome, { color: c.text, flexShrink: 1 }]}>
              {label}
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Settings section: ${label}`}
              accessibilityState={{ expanded: menu }}
              accessibilityHint={hint}
              onPress={openMenu}
              style={({ pressed }) => [
                styles.row,
                {
                  maxWidth: "100%",
                  minHeight: 44,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  backgroundColor: pressed ? c.inset : "transparent",
                },
              ]}
            >
              <Text numberOfLines={1} style={[type.chrome, { color: c.text, flexShrink: 1 }]}>
                {label}
              </Text>
              <Icon name="chevron-up-down" color={c.icon} />
              {(updates || pendingHabits > 0) && <StatusDot tone="amber" />}
            </Pressable>
          </View>
        )}
        <IconButton icon="x-mark" label="Close Settings" onPress={close} />
      </View>
      <ConnectionBanner />
    </>
  );
}
