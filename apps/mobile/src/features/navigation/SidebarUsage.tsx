import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { ui } from "@canopy/contracts";
import { sidebarUsageAccounts } from "@canopy/domain/sidebar-usage";
import { usageSummary, usageSummaryGlance, usageSummaryNotes } from "@canopy/domain/usage-summary";
import { Icon } from "../../ui/Icon";
import { useSettingsResource } from "../settings/resource";
import { Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { SheetCloseButton, SheetDragArea } from "../../ui/SheetDragArea";
import { styles, useColors } from "../../ui/theme";
import { useTimeLabel } from "../../ui/time";
import { openSettingsSection } from "../settings/navigation";
import { UsageSummaryRow } from "./UsageSummaryRow";
import { usageColor } from "./usage-color";

/** Fixed slot: incremental overview reports never move adjacent footer actions. */
export function SidebarUsage({ workers }: { workers: readonly ui.Worker[] }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const { height } = useWindowDimensions();
  const minute = useTimeLabel((now) => String(Math.floor(now / 60_000)), true);
  const now = Number(minute) * 60_000;
  const accounts = useMemo(() => sidebarUsageAccounts(workers, now), [workers, now]);
  // Accounts the gateway read from proxies in use; reading the list never calls a proxy (web: SidebarUsage).
  const proxies = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const rows = useMemo(() => usageSummary(accounts, proxies.data?.proxies ?? [], now), [accounts, proxies.data, now]);
  const glance = useMemo(() => usageSummaryGlance(rows, now), [rows, now]);
  const notes = useMemo(() => usageSummaryNotes(proxies.data?.proxies ?? []), [proxies.data]);

  const usageProxies = useMemo(
    () => (proxies.data?.proxies ?? []).filter((proxy) => proxy.kind === "cliproxyapi" && proxy.usedBy.length),
    [proxies.data],
  );

  const label = `Show provider usage. ${[...glance.map((item) => `${item.label}.`), ...notes.map((note) => note.text)].join(" ")}`;

  return (
    <View style={{ width: 44, height: 44, flexShrink: 0 }}>
      {glance.length > 0 || usageProxies.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(true)}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              borderRadius: 8,
              backgroundColor: pressed ? c.pressed : "transparent",
            })}
          >
            {glance.length === 0 && <Icon name="link" color={c.muted} />}
            {glance.map((item) => (
              <View
                key={item.provider}
                style={{ width: 20, height: 4, borderRadius: 2, backgroundColor: c.ring, overflow: "hidden" }}
              >
                <View
                  style={{
                    width: `${item.tone === "extra" ? 100 : (item.percentLeft ?? 0)}%`,
                    minWidth: 2,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: usageColor(item.tone, c),
                  }}
                />
                {item.tone === "extra" ? (
                  <View style={{ position: "absolute", left: 8, width: 2, height: 4, backgroundColor: c.sidebar }} />
                ) : null}
              </View>
            ))}
          </Pressable>
          <Overlay visible={open} onClose={() => setOpen(false)} label="Provider usage">
            <View style={{ padding: 12, gap: 12 }}>
              <SheetDragArea style={[styles.row, { justifyContent: "space-between" }]}>
                <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
                  Provider usage
                </Text>
                <SheetCloseButton label="Close provider usage" />
              </SheetDragArea>
              <ScrollView
                style={{ maxHeight: Math.min(420, height * 0.55) }}
                contentContainerStyle={{ gap: 12 }}
                nestedScrollEnabled
              >
                {rows.map((row) => (
                  <UsageSummaryRow key={row.provider} row={row} now={now} />
                ))}
                {!rows.length && !notes.length ? (
                  <Text style={[styles.overlayMeta, { color: c.muted }]}>No limit readings yet.</Text>
                ) : null}
                {notes.map((note) => (
                  <View key={note.proxyId} style={{ gap: 4 }}>
                    <Text
                      accessibilityLiveRegion={note.checking ? "polite" : "none"}
                      style={[styles.overlayMeta, { color: c.muted }]}
                    >
                      {note.text}
                    </Text>
                    {note.checking ? null : (
                      <Button
                        title="Check proxy settings"
                        variant="text"
                        size="sm"
                        onPress={() => {
                          setOpen(false);
                          openSettingsSection("proxies");
                        }}
                      />
                    )}
                  </View>
                ))}
              </ScrollView>
              <Button
                title="Open provider settings"
                variant="ghost"
                onPress={() => {
                  setOpen(false);
                  openSettingsSection("providers");
                }}
              />
            </View>
          </Overlay>
        </>
      ) : null}
    </View>
  );
}
