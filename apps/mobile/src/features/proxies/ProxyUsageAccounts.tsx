import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { proxyAccountsHint } from "@canopy/domain/proxy-accounts";
import {
  proxyCapacityGroups,
  supportedProxyAccounts,
  unsupportedProxyAccountText,
} from "@canopy/domain/proxy-capacity";
import { styles, useColors } from "../../ui/theme";
import { SettingsDisclosure } from "../settings/SettingsDisclosure";
import { ProxyAccountRow } from "./ProxyAccountRow";
import { ProxyCapacitySummary } from "./ProxyCapacitySummary";

/**
 * One proxy in the provider usage sheet (web: ProxyUsageAccounts): weighted capacity per provider with its account
 * limits behind a disclosure. Cache only: the overview feed and the gateway's usage lease own the reads.
 */
export function ProxyUsageAccounts({ proxy, now, onOpen }: { proxy: ui.Proxy; now: number; onOpen: () => void }) {
  const c = useColors();
  const snapshot = proxy.accounts;
  const hint = proxyAccountsHint(snapshot, proxy.managementKeySet);
  const accounts = supportedProxyAccounts(snapshot?.accounts ?? []);
  const unsupported = (snapshot?.accounts.length ?? 0) - accounts.length;
  const groups = proxyCapacityGroups(accounts, now);
  const meta = [styles.overlayMeta, { color: c.muted }];

  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Through ${proxy.name}, open proxy settings`}
        onPress={onOpen}
        style={{ minHeight: 32, justifyContent: "center" }}
      >
        <Text numberOfLines={1} style={[styles.overlayHeading, { color: c.accent }]}>
          Through {proxy.name}
        </Text>
      </Pressable>
      {snapshot?.state === "ok" ? (
        <>
          {groups.map((group) => (
            <View
              key={group.mark}
              style={{ gap: 4, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.ring }}
            >
              <ProxyCapacitySummary group={group} now={now} />
              <SettingsDisclosure title="Account limits">
                {group.accounts.map((account, index) => (
                  <View
                    key={account.id}
                    style={{ borderTopWidth: index ? StyleSheet.hairlineWidth : 0, borderColor: c.ring }}
                  >
                    <ProxyAccountRow account={account} now={now} compact />
                  </View>
                ))}
              </SettingsDisclosure>
            </View>
          ))}
          {accounts.length && snapshot.total > snapshot.accounts.length ? (
            <Text style={meta}>
              Showing {snapshot.accounts.length} of {snapshot.total}.
            </Text>
          ) : null}
          {!accounts.length && !unsupported ? <Text style={meta}>The proxy has no accounts yet.</Text> : null}
          {unsupported ? <Text style={meta}>{unsupportedProxyAccountText(unsupported)}</Text> : null}
        </>
      ) : (
        <Text accessibilityLiveRegion="polite" style={meta}>
          {hint ?? "Checking accounts…"}
          {snapshot && proxy.managementKeySet ? " Open proxy settings to check access, then refresh." : ""}
        </Text>
      )}
      {snapshot?.checkedAt ? <Text style={meta}>Checked {formatRelative(snapshot.checkedAt)}</Text> : null}
    </View>
  );
}
